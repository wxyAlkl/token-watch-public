const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWorkBuddyUsage } = require('../workbuddy-usage');
const { createServer } = require('../server');

const session = '00000000-0000-4000-8000-000000000001';
function row(id) {
  return { type: 'message', role: 'assistant', timestamp: 1700000000123, content: 'PRIVATE-CONTENT\u2028continued',
    providerData: { model: 'test-model', messageId: id, conversationRequestId: 'shared-turn', rawUsage: {
      prompt_tokens: 100, completion_tokens: 12, total_tokens: 112, cache_read_input_tokens: 0,
      prompt_tokens_details: { cached_tokens: 70 }, prompt_cache_hit_tokens: 70 } } };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-workbuddy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects'), dir = path.join(projects, 'project');
  const agents = path.join(dir, session, 'subagents');
  fs.mkdirSync(agents, { recursive: true });
  const file = path.join(dir, session + '.jsonl');
  fs.writeFileSync(file, JSON.stringify(row('one')) + '\n');
  return { root, projects, agents, file };
}

test('WorkBuddy scans only sessions, deduplicates tool rows, and retries an appended partial line', async t => {
  const { root, projects, agents, file } = fixture(t);
  const tool = { ...row('two'), type: 'function_call' };
  fs.writeFileSync(path.join(agents, 'agent-abcd1234.jsonl'), [row('one'), tool, { ...row('ignored'), type: 'credit-usage' },
    { ...row('ignored-user'), role: 'user' }].map(r => JSON.stringify(r)).join('\n'));
  fs.appendFileSync(file, '{');
  const cache = new Map();
  assert.equal((await readWorkBuddyUsage(path.join(root, 'absent'))).diagnostics.status, 'missing');
  const first = await readWorkBuddyUsage(projects, cache);
  assert.equal(first.records.length, 2);
  assert.equal(first.diagnostics.skippedRows, 1);
  assert.deepEqual(first.records[0].usage, { inputTokens: 30, outputTokens: 12, cacheReadTokens: 70, cacheWriteTokens: 0, totalTokens: 112 });
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE-CONTENT|shared-turn/);
  fs.appendFileSync(file, JSON.stringify(row('three')).slice(1));
  assert.equal((await readWorkBuddyUsage(projects, cache)).diagnostics.scanned, 3);
});

for (const sqliteEnabled of [false, true]) test(`WorkBuddy sync is idempotent across restarts and filterable (sqlite=${sqliteEnabled})`, async t => {
  const { root, projects } = fixture(t);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'stations.json'), JSON.stringify({ stations: [{ id: 'relay', name: 'WorkBuddy', tokens: 0, calls: [] }] }));
  const options = { runtime: 'web', dataDir, port: 0, sqliteEnabled, workBuddyEnabled: true,
    cliPaths: { workBuddyProjects: projects, codexSessions: path.join(root, 'none'), claudeProjects: path.join(root, 'none'), codexConfig: path.join(root, 'none') } };
  for (const expected of [1, 0]) {
    const app = createServer(options);
    try {
      await app.ready;
      const base = `http://127.0.0.1:${app.port}`;
      const sync = await fetch(base + '/api/logs/sync-cli', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(sync.status, 200);
      const result = await sync.json();
      assert.equal(result.cliSync.workBuddy.importedCount, expected);
      assert.equal(result.aggregate.totalTokens, 0);
      const page = await (await fetch(base + '/api/logs?range=all&type=usage&sourceApp=WorkBuddy')).json();
      assert.equal(page.logs.length, 1);
      assert.equal(page.summary.tokenCount, 112);
      assert.equal(page.logs[0].stationId, null);
      assert.equal(page.logs[0].stream, null);
      assert.equal(page.logs[0].statusCode, null);
    } finally { await app.close(); }
  }
});
