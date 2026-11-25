const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const session = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const count = n => Number.isSafeInteger(n) && n >= 0;

// JSONL uses LF. Unicode line separators are legal inside JSON strings.
async function* jsonLines(stream) {
  let tail = '';
  for await (const chunk of stream) {
    const parts = chunk.split('\n');
    if (parts.length === 1) { tail += chunk; continue; }
    yield tail + parts[0];
    for (let i = 1; i < parts.length - 1; i++) yield parts[i];
    tail = parts.at(-1);
  }
  if (tail) yield tail;
}

function requestRecord(row) {
  const d = row?.providerData;
  if (!(row?.type === 'function_call' || (row?.type === 'message' && row.role === 'assistant')) || !d?.rawUsage) return;
  const u = d.rawUsage;
  const input = u.prompt_tokens, output = u.completion_tokens;
  const read = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? 0;
  const write = u.prompt_cache_write_tokens || u.cache_creation_input_tokens || 0;
  const total = input + output;
  const timestamp = new Date(row.timestamp);
  if (![input, output, read, write, total].every(count) || read + write > input || (u.total_tokens != null && u.total_tokens !== total)
    || !total || !row.timestamp || !Number.isFinite(timestamp.getTime()) || typeof d.messageId !== 'string' || !d.messageId.trim()) return null;
  return { importKey: 'workbuddy:' + createHash('sha256').update(d.messageId).digest('hex'), source: 'WorkBuddy',
    model: typeof d.model === 'string' && d.model || '未知模型', timestamp: timestamp.toISOString(),
    usage: { inputTokens: input - read - write, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: output, totalTokens: total },
    sourceType: 'workbuddy', sourceApp: 'WorkBuddy', detail: 'WorkBuddy 会话同步' };
}

async function readWorkBuddyUsage(root, cache = new Map()) {
  const records = new Map(), visited = new Set();
  const diagnostics = { status: 'online', scanned: 0, files: 0, skippedRows: 0, failedFiles: 0 };
  const entries = dir => fs.promises.readdir(dir, { withFileTypes: true });
  async function visit(file) {
    visited.add(file);
    try {
      const { size, mtimeMs } = await fs.promises.stat(file);
      let batch = cache.get(file);
      if (!batch || batch.size !== size || batch.mtimeMs !== mtimeMs) {
        batch = { size, mtimeMs, skipped: 0, rows: [] };
        const stream = fs.createReadStream(file, { encoding: 'utf8' });
        try {
          for await (const line of jsonLines(stream)) {
            if (!line.trim()) continue;
            let row;
            try { row = JSON.parse(line); } catch { batch.skipped++; continue; }
            const record = requestRecord(row);
            if (record) batch.rows.push(record);
            else if (record === null) batch.skipped++;
          }
        } finally { stream.destroy(); }
        cache.set(file, batch);
      }
      diagnostics.files++;
      diagnostics.skippedRows += batch.skipped;
      for (const row of batch.rows) if (!records.has(row.importKey)) records.set(row.importKey, row);
    } catch { diagnostics.failedFiles++; }
  }
  let projects;
  try { projects = await entries(root); }
  catch (err) { return { records: [], diagnostics: { ...diagnostics, status: err.code === 'ENOENT' ? 'missing' : 'error' } }; }
  for (const project of projects.filter(e => e.isDirectory())) {
    const dir = path.join(root, project.name);
    try {
      for (const entry of await entries(dir)) {
        if (entry.isFile() && entry.name.endsWith('.jsonl') && session.test(entry.name.slice(0, -6))) await visit(path.join(dir, entry.name));
        if (!entry.isDirectory() || !session.test(entry.name)) continue;
        const agents = path.join(dir, entry.name, 'subagents');
        try {
          if (!(await fs.promises.lstat(agents)).isDirectory()) continue;
          for (const agent of await entries(agents)) if (agent.isFile() && /^agent-[\w-]+\.jsonl$/.test(agent.name)) await visit(path.join(agents, agent.name));
        } catch (err) { if (err.code !== 'ENOENT') diagnostics.failedFiles++; }
      }
    } catch { diagnostics.failedFiles++; }
  }
  for (const file of cache.keys()) if (!visited.has(file)) cache.delete(file);
  diagnostics.scanned = records.size;
  if (diagnostics.failedFiles || diagnostics.skippedRows) diagnostics.status = 'partial';
  return { records: [...records.values()], diagnostics };
}

module.exports = { readWorkBuddyUsage };
