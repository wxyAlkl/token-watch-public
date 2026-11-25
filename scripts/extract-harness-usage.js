// Read-only Harness usage inspection. Export only allowlisted accounting fields.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

function filesIn(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesIn(file));
    else if (entry.isFile() && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(entry.name)) result.push(file);
  }
  return result;
}

function number(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function parseUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = number(usage.inputTokens), output = number(usage.outputTokens);
  if (input === null || output === null) return null;
  const cacheRead = number(usage.cacheReadTokens) ?? 0;
  const cacheWrite = number(usage.cacheWriteTokens) ?? 0;
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
    totalTokens: number(usage.totalTokens) ?? input + output + cacheRead + cacheWrite };
}

function extract(root) {
  if (!fs.existsSync(root)) return { summary: { filesFound: 0, selectedFiles: 0, records: 0, nonInheritedRecords: 0, totalTokens: 0 }, warnings: [], records: [] };
  const files = filesIn(root);
  const groups = new Map();
  for (const file of files) {
    const dir = path.dirname(file);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }
  const records = [], warnings = [], seen = new Set();
  let selectedFiles = 0, malformedLines = 0, attemptsWithoutUsage = 0, duplicateEvents = 0;
  for (const candidates of groups.values()) {
    const version = file => Number(path.basename(file).match(/\.v(\d+)\./)?.[1] || 0);
    candidates.sort((a, b) => version(b) - version(a));
    const file = candidates[0];
    const fileId = crypto.createHash('sha256').update(path.relative(root, file)).digest('hex').slice(0, 16);
    if (candidates.length > 1 && version(candidates[1]) === version(file)) {
      warnings.push({ fileId, reason: '同一会话最高版本存在多个文件，已跳过' }); continue;
    }
    try {
      if (fs.statSync(file).size > 128 * 1024 * 1024) throw new Error('文件超过试读大小限制');
      let buffer = fs.readFileSync(file);
      if (file.endsWith('.zstd')) {
        if (!zlib.zstdDecompressSync) throw new Error('当前 Node 不支持 Zstandard 解压');
        buffer = zlib.zstdDecompressSync(buffer, { maxOutputLength: 256 * 1024 * 1024 });
      }
      const rows = [];
      let fileMalformedLines = 0;
      for (const line of buffer.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { malformedLines++; fileMalformedLines++; }
      }
      const header = rows[0];
      if (header?.type !== 'session' || !header.id) throw new Error('缺少会话文件头');
      if (version(file) > 4 || Number(header.version || 0) > 4) throw new Error('未支持的会话版本');
      if (Number(header.version || 0) !== version(file)) throw new Error('会话版本与文件名不一致');
      if (fileMalformedLines) warnings.push({ fileId, reason: `${fileMalformedLines} 行格式无效，已跳过` });
      selectedFiles++;
      const seedMarker = rows.find(row => row.type === 'session/end-seed');
      let route = {};
      for (const row of rows) {
        const data = row.data || {};
        if (row.type === 'request/header') route = data.header?.config || route;
        if (!['assistant/message', 'assistant/attempt'].includes(row.type)) continue;
        const embedded = Array.isArray(data.stream) ? data.stream.filter(item => item?.chunk?.type === 'usage').at(-1)?.chunk?.usage : null;
        const usage = parseUsage(data.usage || embedded);
        if (!usage) { if (row.type === 'assistant/attempt') attemptsWithoutUsage++; continue; }
        const source = data.message?.source || {};
        const timestamp = new Date(row.time);
        if (!Number.isFinite(timestamp.getTime()) || !Number.isInteger(row.seq)) continue;
        const inherited = !!header.isSeeded && (!seedMarker || row.seq < seedMarker.seq)
          || Number.isInteger(header.seedLength) && row.seq < header.seedLength;
        const key = `${header.id}:${row.seq}`;
        if (seen.has(key)) { duplicateEvents++; continue; }
        seen.add(key);
        // Time, settlement type and provider message ID survive format-generation sequence remapping.
        const identity = crypto.createHash('sha256').update(JSON.stringify([String(header.id), row.time, row.type,
          data.message?.id || '', source.provider || route.provider || '', source.model || route.model || '', usage])).digest('hex');
        const originKey = data.message?.id ? crypto.createHash('sha256').update(JSON.stringify([data.message.id, row.time, source.provider || route.provider || '', usage])).digest('hex') : null;
        records.push({ id: key, importKey: `harness:${identity}`, originKey, sessionId: String(header.id), fileId, formatVersion: Number(header.version || 0),
          timestamp: timestamp.toISOString(), sourceApp: 'DeepSeek Harness',
          eventType: row.type, inherited, model: String(source.model || route.model || '未知模型'),
          provider: String(source.provider || route.provider || '未知来源'), ...usage });
      }
    } catch (error) {
      warnings.push({ fileId, reason: error.code ? `文件读取失败：${error.code}` : /限制|不支持|缺少|版本/.test(error.message) ? error.message : '文件解压或解析失败' });
    }
  }
  const eligible = records.filter(record => !record.inherited);
  const models = {};
  for (const record of eligible) {
    const group = models[record.model] ||= { records: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
    group.records++;
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) group[key] += record[key];
  }
  const dates = eligible.map(record => record.timestamp).sort();
  return { inspectionOnly: true, scope: '仅会话 assistant/message 和 assistant/attempt；不包含独立标题、搜索等辅助请求',
    summary: { filesFound: files.length, sessionDirectories: groups.size, selectedFiles, records: records.length,
      nonInheritedRecords: eligible.length, inheritedRecords: records.length - eligible.length,
      settledMessages: eligible.filter(record => record.eventType === 'assistant/message').length,
      attemptsWithUsage: eligible.filter(record => record.eventType === 'assistant/attempt').length,
      attemptsWithoutUsage, duplicateEvents, malformedLines, first: dates[0] || null, last: dates.at(-1) || null,
      totalTokens: eligible.reduce((sum, record) => sum + record.totalTokens, 0), models }, warnings, records };
}

function main(args) {
  if (args.includes('--help')) {
    console.log('node scripts/extract-harness-usage.js [--root SESSION_DIRECTORY] [--out OUTPUT.json]'); return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--root', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('参数无效，使用 --help 查看用法');
    options[args[i]] = args[i + 1];
  }
  const root = path.resolve(options['--root'] || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions'));
  const output = options['--out'] ? path.resolve(options['--out']) : null;
  if (output && (output === root || output.startsWith(root + path.sep))) throw new Error('输出文件不能写入原始会话目录');
  const report = extract(root);
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ ...report.summary, warnings: report.warnings, output }, null, 2));
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { extract, parseUsage };
