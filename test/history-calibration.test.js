const test = require('node:test');
const assert = require('node:assert/strict');
const { calibrate, totals, trackCall, trackRemote, HISTORY_TIME } = require('../history-calibration');
const { publicLogs, createServer } = require('../server');
const { overviewStats } = require('../overview-stats');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('history calibration adds auditable signed differences and is idempotent', () => {
  const station = { name: 'Relay', totalSpend: 100, tokens: 100000000, remoteTokens: 100000000, spendSource: 'remote', calls: [] };
  const input = { amount: 300, tokens: 300000000, unit: 'USD', expectedAmount: 100, expectedTokens: 100000000 };
  const record = calibrate(station, input, 'USD');
  assert.equal(record.cost, 200); assert.equal(record.tokens, 200000000);
  assert.equal(record.timestamp, HISTORY_TIME);
  assert.deepEqual(totals(station), { amount: 300, tokens: 300000000 });
  assert.equal(calibrate(station, input, 'USD'), null);
  assert.equal(station.calls.length, 1);
  assert.throws(() => calibrate(station, { ...input, amount: 400 }, 'USD'), /已变化/);
  const down = calibrate(station, { amount: 50, tokens: 50000000, unit: 'USD', expectedAmount: 300, expectedTokens: 300000000 }, 'USD');
  assert.equal(down.cost, -250); assert.equal(down.tokens, -250000000);
  assert.equal(station.calls.length, 2);
  assert.equal(station.totalSpend, 100); assert.equal(station.tokens, 100000000);
});

test('calibrated totals survive refresh, grow on new calls and do not double remote growth', () => {
  const station = { totalSpend: 100, tokens: 100, remoteTokens: 100, spendSource: 'remote' };
  calibrate(station, { amount: 300, tokens: 300, unit: 'USD', expectedAmount: 100, expectedTokens: 100 }, 'USD');
  trackCall(station, { cost: 2, tokens: 20 });
  assert.deepEqual(totals(station), { amount: 300, tokens: 320 });
  station.totalSpend = 102; trackRemote(station); trackRemote(station);
  assert.deepEqual(totals(station), { amount: 302, tokens: 320 });
  station.totalSpend = 105; trackRemote(station);
  assert.equal(totals(station).amount, 305);
  station.totalSpend = null; trackRemote(station);
  assert.equal(totals(station).amount, 305);
  station.totalSpend = 0; trackRemote(station);
  station.totalSpend = 1; trackRemote(station);
  assert.equal(totals(station).amount, 306);
});

test('manual corrections do not change recent logs, request counts or trend data', () => {
  const station = { id: 'one', name: 'Relay', totalSpend: 100, tokens: 100, spendSource: 'remote', calls: [
    { id: 'real', timestamp: new Date().toISOString(), model: 'real', tokens: 100, cost: 100, costUnit: 'USD' }
  ] };
  calibrate(station, { amount: 300, tokens: 300, unit: 'USD', expectedAmount: 100, expectedTokens: 100 }, 'USD');
  const state = { stations: [station] };
  const all = publicLogs(state, new URL('http://localhost/api/logs?range=all'));
  assert.equal(all.logs.length, 2); assert.equal(all.summary.requestCount, 1);
  assert.equal(all.summary.tokenCount, 100); assert.equal(all.summary.usageByUnit.USD, 100);
  const recent = publicLogs(state, new URL('http://localhost/api/logs?range=30d'));
  assert.equal(recent.logs.length, 1); assert.equal(recent.summary.usageByUnit.USD, 100);
  assert.equal(overviewStats(state).requests, 1); assert.equal(overviewStats(state).tokens, 100);
  for (const input of [{ amount: -1, tokens: 1 }, { amount: NaN, tokens: 1 }, { amount: 1, tokens: 1.5 }, { amount: 1, tokens: -1 }]) {
    assert.throws(() => calibrate(station, { ...input, unit: 'USD' }, 'USD'));
  }
});

test('calibration API restores totals across restart without altering balances', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-history-'));
  const file = path.join(root, 'stations.json');
  fs.writeFileSync(file, JSON.stringify({ stations: [{ id: 'relay', name: 'Relay', baseUrl: 'https://example.com/v1',
    totalSpend: 100, tokens: 100000000, remoteTokens: 100000000, balance: 50, balanceLimit: 150, balanceKnown: true, spendSource: 'remote', balanceUnit: 'USD' }] }));
  let app = createServer({ runtime: 'web', dataDir: root, port: 0 }); await app.ready;
  t.after(async () => { await app.close(); fs.unlinkSync(file); fs.rmdirSync(root); });
  const payload = { amount: 300, tokens: 300000000, unit: 'USD', expectedAmount: 0, expectedTokens: 0 };
  const response = await fetch(`http://127.0.0.1:${app.port}/api/stations/relay/calibrate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.aggregate.totalSpendByUnit.USD, 300); assert.equal(result.aggregate.totalTokens, 300000000);
  await app.close(); app = createServer({ runtime: 'web', dataDir: root, port: 0 }); await app.ready;
  const current = await (await fetch(`http://127.0.0.1:${app.port}/api/stations`)).json();
  assert.equal(current.stations[0].totalSpend, 300); assert.equal(current.stations[0].tokens, 300000000);
  assert.equal(current.stations[0].balance, 50); assert.equal(current.stations[0].balanceLimit, 150);
  assert.equal(current.stations[0].quotaConsumed, 100);
});
