const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');
const { isOfficialStation, officialAccounts } = require('../public/monitor-channels');

const deepseek = { id: 'direct', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' };
const relay = { id: 'relay', name: 'DeepSeek reseller', baseUrl: 'https://api.deepseek.com.example.org' };
test('official mode identifies the actual DeepSeek host and distinguishes missing, zero and stale readings', () => {
  assert.equal(isOfficialStation(relay), false);
  assert.equal(isOfficialStation({ ...deepseek, ghost: true }), false);
  const accounts = officialAccounts([{ ...deepseek, balance: 0, balanceKnown: true, balanceUnit: 'CNY', usageStatus: 'error' }, relay], {
    status: 'connected', windows: [{ bucket: 'codex', kind: 'primary', minutes: 10080, remaining: 0 }]
  });
  assert.deepEqual(accounts.map(a => a.value), ['0%', '¥0.00']);
  assert.equal(accounts[1].label, '上次余额');
  const [loggedOut] = officialAccounts([], { status: 'login-required' });
  assert.equal(loggedOut.value, '—');
  assert.match(loggedOut.details[0], /登录/);
});

test('scoped refreshes select only the requested channel including paused and legacy stations', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-channels-'));
  fs.writeFileSync(path.join(dataDir, 'stations.json'), JSON.stringify({ stations: [
    { ...deepseek, disabled: true }, { ...relay }, { id: 'ghost', name: 'OpenAI Official', ghost: true, disabled: true }
  ] }));
  const app = createServer({ dataDir, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await app.ready;
  const refresh = async scope => fetch('http://127.0.0.1:' + app.port + '/api/stations/refresh-all' + scope, { method: 'POST' });
  for (const [scope, ids] of [['?channel=official', ['direct']], ['?channel=relay', ['ghost', 'relay']], ['', ['direct', 'ghost', 'relay']]]) {
    const result = await (await refresh(scope)).json();
    assert.deepEqual(result.refreshResults.map(x => x.id).sort(), ids);
  }
  assert.equal((await refresh('?channel=typo')).status, 400);
});
