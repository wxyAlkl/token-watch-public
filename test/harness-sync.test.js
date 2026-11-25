const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createServer } = require('../server');
const { readHarnessUsage } = require('../harness-usage');

function rows(version = 4, shift = 0) {
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 0, totalTokens: 42 };
  return [
    { type: 'session', id: 'sample-session', version, isSeeded: true },
    { type: 'request/header', seq: shift, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 1 + shift, time: 1700000000000, data: { usage, message: { id: 'inherited', content: 'PRIVATE-TEXT' } } },
    { type: 'session/end-seed', seq: 2 + shift },
    { type: 'assistant/message', seq: 3 + shift, time: 1700000001000, data: { usage, message: { id: 'real', content: 'PRIVATE-TEXT', source: { model: 'deepseek-flash', provider: 'deepseek-account', replayState: { secret: 'PRIVATE-SECRET' } } } } },
    { type: 'assistant/attempt', seq: 4 + shift, time: 1700000002000, data: { stream: [{ chunk: { type: 'usage', usage } }] } },
    { type: 'assistant/attempt', seq: 5 + shift, time: 1700000003000, data: {} },
    { type: 'assistant/message', seq: 6 + shift, time: 1700000004000, data: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }
  ];
}
function writeRows(file, value) { const data = Buffer.from(value.map(row => JSON.stringify(row)).join('\n')); fs.writeFileSync(file, file.endsWith('.zstd') ? zlib.zstdCompressSync(data) : data); }

test('Harness API sync imports once, preserves identity across generation changes and does not misattribute accounts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-harness-'));
  const stateDir = path.join(root, 'state'), sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions); fs.mkdirSync(stateDir);
  const old = path.join(sessions, 'session.jsonl'); writeRows(old, rows(0));
  const stateFile = path.join(stateDir, 'stations.json');
  fs.writeFileSync(stateFile, JSON.stringify({ stations: [{ id: 'relay', name: 'Deepseek', baseUrl: 'https://api.deepseek.com/v1', tokens: 0, calls: [] }] }));
  let app = createServer({ runtime: 'web', dataDir: stateDir, port: 0, harnessEnabled: true,
    cliPaths: { harnessSessions: sessions, codexSessions: path.join(root, 'none'), claudeProjects: path.join(root, 'none'), codexConfig: path.join(root, 'none') } });
  await app.ready;
  const current = path.join(sessions, 'session.v4.jsonl.zstd');
  t.after(async () => { await app.close(); for (const file of [old, current, stateFile]) if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(sessions); fs.rmdirSync(stateDir); fs.rmdirSync(root); });
  const sync = async () => { const r = await fetch(`http://127.0.0.1:${app.port}/api/logs/sync-cli`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(r.status, 200); return r.json(); };
  const first = await sync();
  assert.equal(first.unmatched.length, 2);
  assert.equal(first.cliSync.harness.importedCount, 2);
  assert.equal(first.cliSync.harness.inheritedRecords, 1);
  assert.equal(first.stations[0].tokens, 0);
  assert.equal(first.aggregate.totalTokens, 84);
  assert.equal((await sync()).unmatched.length, 0);
  writeRows(current, rows(4, 10));
  const migrated = await sync();
  assert.equal(migrated.unmatched.length, 0);
  assert.equal(migrated.cliSync.harness.selectedFiles, 1);
  const logs = await (await fetch(`http://127.0.0.1:${app.port}/api/logs?range=all&sourceApp=DeepSeek%20Harness`)).json();
  assert.equal(logs.logs.length, 2);
  assert.equal(logs.summary.tokenCount, 84);
  assert.ok(logs.logs.every(log => log.sourceType === 'deepseek-harness' && log.stream === null && log.statusCode === null));
  assert.match(logs.logs[0].source, /deepseek-account/);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE-TEXT|PRIVATE-SECRET/);
  assert.doesNotMatch(fs.readFileSync(stateFile, 'utf8'), /PRIVATE-TEXT|PRIVATE-SECRET/);
  assert.ok(fs.readFileSync(old).equals(Buffer.from(rows(0).map(row => JSON.stringify(row)).join('\n'))));
});

test('Harness reader handles missing roots and reports unsupported or corrupt generations', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-harness-errors-'));
  const future = path.join(root, 'session.v5.jsonl'); writeRows(future, rows(5));
  t.after(() => { fs.unlinkSync(future); fs.rmdirSync(root); });
  assert.equal((await readHarnessUsage(path.join(root, 'missing'))).diagnostics.status, 'missing');
  const result = await readHarnessUsage(root);
  assert.equal(result.diagnostics.status, 'partial'); assert.equal(result.records.length, 0);
  assert.match(result.diagnostics.warnings[0].reason, /版本/);
});
