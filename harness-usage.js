const fs = require('node:fs');
const { extract } = require('./scripts/extract-harness-usage');

async function readHarnessUsage(root) {
  try {
    if (!fs.existsSync(root)) return { records: [], diagnostics: { status: 'missing', scanned: 0, warnings: [] } };
    const report = extract(root);
    const origins = new Set();
    let duplicateOrigins = 0;
    const records = report.records.filter(record => {
      if (record.inherited || record.totalTokens <= 0) return false;
      if (record.originKey && origins.has(record.originKey)) { duplicateOrigins++; return false; }
      if (record.originKey) origins.add(record.originKey);
      return true;
    }).map(record => ({
      importKey: record.importKey, source: `DeepSeek Harness · ${record.provider}`,
      providerId: record.provider, baseUrl: '', model: record.model, timestamp: record.timestamp,
      usage: { inputTokens: record.inputTokens, outputTokens: record.outputTokens,
        cacheReadTokens: record.cacheReadTokens, cacheWriteTokens: record.cacheWriteTokens, totalTokens: record.totalTokens },
      sourceType: 'deepseek-harness', sourceApp: 'DeepSeek Harness',
      detail: record.eventType === 'assistant/attempt' ? 'Harness 会话同步 · 尝试记录（含用量）' : 'Harness 会话同步',
      eventType: record.eventType
    }));
    return { records, diagnostics: { status: report.warnings.length ? 'partial' : 'online', ...report.summary,
      scanned: records.length, duplicateOrigins, warnings: report.warnings } };
  } catch (error) {
    return { records: [], diagnostics: { status: 'error', scanned: 0, warnings: [{ reason: error.code ? `读取失败：${error.code}` : 'Harness 会话读取失败' }] } };
  }
}
module.exports = { readHarnessUsage };
