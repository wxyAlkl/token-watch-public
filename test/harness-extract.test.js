const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { extract } = require('../scripts/extract-harness-usage');

test('Harness inspection selects highest generation and counts message usage once without exporting content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-inspection-'));
  const oldFile = path.join(root, 'session.jsonl');
  const current = path.join(root, 'session.v4.jsonl.zstd');
  t.after(() => { fs.unlinkSync(oldFile); fs.unlinkSync(current); fs.rmdirSync(root); });
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 30, totalTokens: 42 };
  const rows = [
    { type: 'session', id: 'test-session', version: 4, isSeeded: true },
    { type: 'request/header', seq: 0, data: { header: { config: { model: 'deepseek-flash', provider: 'deepseek' } } } },
    { type: 'assistant/message', seq: 1, time: 1700000000000, data: { usage, message: { content: 'PRIVATE-CONTENT' }, stream: [{ chunk: { type: 'usage', usage } }] } },
    { type: 'session/end-seed', seq: 2 },
    { type: 'assistant/message', seq: 3, time: 1700000001000, data: { usage, message: { content: 'PRIVATE-CONTENT' }, stream: [{ chunk: { type: 'usage', usage } }] } },
    { type: 'assistant/attempt', seq: 4, time: 1700000002000, data: { stream: [{ chunk: { type: 'usage', usage } }] } }
  ];
  fs.writeFileSync(oldFile, JSON.stringify({ type: 'session', id: 'test-session', version: 0 }));
  fs.writeFileSync(current, zlib.zstdCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n'))));
  const report = extract(root);
  assert.equal(report.summary.filesFound, 2);
  assert.equal(report.summary.selectedFiles, 1);
  assert.equal(report.summary.inheritedRecords, 1);
  assert.equal(report.summary.nonInheritedRecords, 2);
  assert.equal(report.summary.totalTokens, 84);
  assert.equal(report.records[1].model, 'deepseek-flash');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-CONTENT|header.*config|replayState/);
});
