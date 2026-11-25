const test = require('node:test');
const assert = require('node:assert/strict');
const { publicLogs } = require('../server');

test('all log range includes old history and application filters update totals', () => {
  const state = { stations: [{ id: 'one', name: 'opus5', calls: [
    { id: 'old', timestamp: '2020-01-01T00:00:00Z', sourceType: 'claude-cli', tokens: 100, cost: 2, costUnit: 'USD' },
    { id: 'new', timestamp: new Date().toISOString(), sourceType: 'codex-cli', tokens: 50, cost: 1, costUnit: 'CNY' },
    { id: 'proxy', timestamp: new Date().toISOString(), tokens: 20, cost: 0.5, costUnit: 'USD' }
  ] }], cliCalls: [{ id: 'unmatched', source: 'Other', sourceType: 'claude-cli', timestamp: '2021-01-01T00:00:00Z', tokens: 30 }] };
  const query = params => publicLogs(state, new URL(`http://localhost/api/logs?${params}`));
  assert.equal(query('range=all').logs.length, 4);
  assert.equal(query('range=30d').logs.length, 2);
  const claude = query('range=all&source=opus5&sourceApp=Claude%20Code');
  assert.deepEqual(claude.logs.map(log => log.id), ['old']);
  assert.equal(claude.logs[0].sourceApp, 'Claude Code');
  assert.equal(claude.summary.tokenCount, 100);
  assert.deepEqual(claude.summary.usageByUnit, { USD: 2 });
  assert.equal(query('range=all&sourceApp=Codex').summary.requestCount, 1);
  assert.equal(query('range=all&sourceApp=本地代理').logs[0].id, 'proxy');
  assert.equal(query('range=all&from=2022-01-01').logs.length, 2);
  assert.equal(query('range=all&source=none').summary.count, 0);
});
