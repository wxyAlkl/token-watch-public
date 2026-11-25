const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageStore } = require('../usage-store');
const { decorateCall, publicLogs, createServer } = require('../server');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-sqlite-'));
  const calls = Array.from({ length: 230 }, (_, i) => ({ id: `log-${i}`, importKey: `usage-${i}`, timestamp: new Date(Date.now() - i * 1000).toISOString(),
    sourceType: i % 2 ? 'codex-cli' : 'deepseek-harness', model: 'test-model', source: 'Relay', tokens: i + 1,
    inputTokens: i + 1, cost: i / 100, costUnit: 'USD', stream: null }));
  const state = { settings: { refreshMinutes: 5 }, stations: [{ id: 'relay', name: 'Relay', baseUrl: 'https://example.com/v1', calls, apiKey: 'secret' }],
    cliCalls: [{ id: 'adjust', timestamp: '1999-12-31T16:00:00Z', sourceType: 'manual-adjustment', cost: -3, costUnit: 'USD', tokens: -10 }], cliImportedKeys: calls.map(c => c.importKey) };
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify(state));
  return { root, state };
}
function cleanup(root) { for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)); fs.rmdirSync(root); }

test('SQLite migration preserves full state, backup, indexed filtering, pagination and full-result sums', t => {
  const { root, state } = fixture();
  const original = fs.readFileSync(path.join(root, 'stations.json'));
  const store = new UsageStore(root, { normalize: value => value, decorate: decorateCall });
  t.after(() => { store.close(); cleanup(root); });
  assert.deepEqual(store.load(), { ...state, quotaSnapshots: {}, quotaConsumptionLogs: [], historyCorrections: [] });
  const backup = fs.readdirSync(root).find(name => name.startsWith('stations.pre-sqlite-'));
  assert.ok(fs.readFileSync(path.join(root, backup)).equals(original));
  assert.ok(fs.readFileSync(path.join(root, 'stations.json')).equals(original));
  const url = new URL('http://localhost/api/logs?range=all');
  const result = store.query(url);
  assert.equal(result.logs.length, 100); assert.equal(result.pagination.total, 231);
  const expected = publicLogs(state, url);
  assert.deepEqual(result.summary.usageByUnit, expected.summary.usageByUnit);
  assert.equal(result.summary.tokenCount, expected.summary.tokenCount);
  assert.equal(result.summary.requestCount, 230);
  const second = store.query(new URL(`${url}&page=2`));
  assert.equal(second.logs.length, 100);
  assert.ok(!second.logs.some(log => result.logs.some(first => first.id === log.id)));
  assert.equal(store.query(new URL(`${url}&pageSize=all`)).logs.length, 231);
  const filteredUrl = new URL(`${url}&sourceApp=DeepSeek%20Harness&type=usage&source=Relay&model=test`);
  assert.equal(store.query(filteredUrl).pagination.total, publicLogs(state, filteredUrl).logs.length);
  assert.equal(store.query(new URL(`${url}&source=quote%27%20OR%201%3D1`)).pagination.total, 0);
  assert.ok(store.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM logs WHERE app=? ORDER BY timestamp DESC").all('Codex').some(row => /logs_app_time/.test(row.detail)));
});

test('SQLite incremental writes are atomic, prevent duplicate imports and persist independently of old JSON', t => {
  const { root } = fixture(); let store = new UsageStore(root, { normalize: value => value, decorate: decorateCall });
  t.after(() => { store.close(); cleanup(root); });
  const state = store.load(); state.settings.refreshMinutes = 10;
  state.stations[0].calls.unshift({ id: 'new', importKey: 'new', timestamp: new Date().toISOString(), tokens: 7, model: 'new' });
  store.save(state); store.save(state);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM logs').get().n, 232);
  const bad = store.load(); bad.settings.refreshMinutes = 60;
  bad.cliCalls.push({ id: 'duplicate', importKey: 'new', timestamp: new Date().toISOString() });
  assert.throws(() => store.save(bad), /UNIQUE/);
  assert.equal(store.load().settings.refreshMinutes, 10);
  store.close(); store = new UsageStore(root, { normalize: value => value, decorate: decorateCall });
  assert.equal(store.load().settings.refreshMinutes, 10);
  assert.equal(store.query(new URL('http://localhost/api/logs?range=all')).pagination.total, 232);
});

test('SQLite quota migration preserves original snapshots and event payloads, and ledger writes roll back atomically', t => {
  const { root, state } = fixture();
  state.quotaSnapshots = { relay: { balance: 450, unit: 'USD', observedAt: '2026-11-01T08:00:00-05:00', source: 'account', accountKey: 'opaque-account', extra: 'preserve me' } };
  state.quotaConsumptionLogs = [{ id: 'historical', stationId: 'relay', stationName: 'Original name', periodStartAt: '2026-11-01T07:00:00-05:00',
    periodEndAt: '2026-11-01T08:00:00-05:00', previousBalance: 500, currentBalance: 450, amount: 50, unit: 'USD', source: 'account', accountKey: 'opaque-account', note: 'preserve audit metadata' }];
  const file = path.join(root, 'stations.json');
  fs.writeFileSync(file, JSON.stringify(state));
  const original = fs.readFileSync(file);
  let store = new UsageStore(root, { normalize: value => value, decorate: decorateCall });
  t.after(() => { store.close(); cleanup(root); });
  const restored = store.load();
  assert.deepEqual(restored, { ...state, quotaConsumptionLogs: [], historyCorrections: [] });
  assert.deepEqual(store.quotaConsumptionLogs(), state.quotaConsumptionLogs);
  assert.ok(fs.readFileSync(file).equals(original));
  const invalid = store.load(); invalid.settings.refreshMinutes = 60;
  invalid.stations[0].calls.push({ id: 'must-rollback', tokens: 100 });
  invalid.quotaConsumptionLogs.push({ ...state.quotaConsumptionLogs[0], id: 'invalid', amount: 0 });
  assert.throws(() => store.save(invalid), /CHECK/);
  assert.deepEqual(store.load(), { ...state, quotaConsumptionLogs: [], historyCorrections: [] });
  store.close(); store = new UsageStore(root, { normalize: value => value, decorate: decorateCall });
  assert.deepEqual(store.load(), { ...state, quotaConsumptionLogs: [], historyCorrections: [] });
  const { accountKey, ...publicEvent } = state.quotaConsumptionLogs[0];
  assert.deepEqual(store.queryQuotaHistory(new URL('http://localhost/api/history/quota')).logs[0], publicEvent);
});

test('SQLite correction ledger preserves signed audit records, filters and sums all matches, and saves atomically', t => {
  const { root, state } = fixture();
  const timestamp = new Date().toISOString();
  const historical = { id: 'up', stationId: 'relay', stationName: 'Relay', createdAt: '2000-01-01T00:00:00-05:00', unit: 'USD',
    amount: 100, tokens: 200, previousAmount: 50, targetAmount: 150, previousTokens: 100, targetTokens: 300,
    source: 'legacy', accountKey: 'internal-key', note: 'preserve audit metadata' };
  state.historyCorrections = [historical];
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify(state));
  let store = new UsageStore(root, { normalize: value => value, decorate: decorateCall });
  t.after(() => { store.close(); cleanup(root); });
  assert.deepEqual(store.load().historyCorrections, [historical]);
  assert.equal('historyCorrections' in store.metadata(), false);
  const changed = store.load();
  changed.historyCorrections.push({ ...historical, id: 'down', createdAt: timestamp, amount: -25, tokens: -30, source: 'manual' });
  changed.historyCorrections.push({ ...historical, id: 'cny', createdAt: timestamp, unit: 'CNY', amount: 10, tokens: 0, source: 'manual' });
  store.save(changed); store.save(changed);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM history_corrections').get().n, 3);
  const page = store.queryCorrections(new URL('http://localhost/api/history/corrections?stationId=relay&pageSize=1'));
  assert.equal(page.logs.length, 1);
  assert.deepEqual(page.summary, { amountByUnit: { CNY: 10, USD: 75 }, tokens: 170, count: 3 });
  assert.deepEqual(page.pagination, { page: 1, pageSize: 1, total: 3, pages: 3 });
  assert.equal('accountKey' in page.logs[0], false);
  assert.deepEqual(store.queryCorrections(new URL('http://localhost/api/history/corrections?range=24h')).summary,
    { amountByUnit: { CNY: 10, USD: -25 }, tokens: -30, count: 2 });
  assert.equal(store.queryCorrections(new URL('http://localhost/api/history/corrections?stationId=absent')).summary.count, 0);
  assert.equal(store.queryCorrections(new URL('http://localhost/api/history/corrections?to=2001-01-01')).summary.count, 1);
  const invalid = store.load(); invalid.settings.refreshMinutes = 60;
  invalid.stations[0].calls.push({ id: 'rollback-correction-call', tokens: 10 });
  invalid.historyCorrections.push({ ...historical, id: 'invalid', tokens: 1.5 });
  assert.throws(() => store.save(invalid), /CHECK/);
  assert.equal(store.load().settings.refreshMinutes, 5);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE key='relay:rollback-correction-call'").get().n, 0);
  store.close(); store = new UsageStore(root, { normalize: value => value, decorate: decorateCall });
  assert.deepEqual(store.load().historyCorrections, changed.historyCorrections);
  const deleted = store.load(); deleted.stations = [];
  store.save(deleted);
  assert.deepEqual(store.load().historyCorrections, []);
  assert.equal(store.queryCorrections(new URL('http://localhost/api/history/corrections')).summary.count, 0);
});

test('Web SQLite API pages logs but aggregates every matching event and keeps settings response small', async t => {
  const { root } = fixture();
  const app = createServer({ runtime: 'web', dataDir: root, sqliteEnabled: true, port: 0 }); await app.ready;
  t.after(async () => { await app.close(); cleanup(root); });
  const base = `http://127.0.0.1:${app.port}`;
  const result = await (await fetch(base + '/api/logs?range=all&page=2')).json();
  assert.equal(result.pagination.page, 2); assert.equal(result.logs.length, 100);
  assert.equal(result.summary.requestCount, 230);
  const settings = await (await fetch(base + '/api/stations')).json();
  assert.equal('calls' in settings.stations[0], false); assert.equal('apiKey' in settings.stations[0], false);
  const patch = await fetch(base + '/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshMinutes: 10 }) });
  assert.equal(patch.status, 200);
  assert.equal((await (await fetch(base + '/api/logs?range=all')).json()).pagination.total, 231);
});

test('recent station activity ignores pagination and non-call records', async t => {
  const { root, state } = fixture();
  const now = Date.now();
  state.stations[0].calls.push({ id: 'probe', model: 'GET /models', timestamp: new Date(now + 10000).toISOString() });
  state.stations[0].calls.push({ id: 'adjustment', model: 'manual', sourceType: 'manual-adjustment', timestamp: new Date(now + 11000).toISOString() });
  state.stations.push({ id: 'second', name: 'Renamed relay', baseUrl: 'https://second.example/v1', calls: [
    { id: 'older', model: 'real', timestamp: new Date(now - 300000).toISOString() }
  ] });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify(state));
  const app = createServer({ runtime: 'web', dataDir: root, sqliteEnabled: true, port: 0 }); await app.ready;
  t.after(async () => { await app.close(); cleanup(root); });
  const base = `http://127.0.0.1:${app.port}`;
  const result = await (await fetch(base + '/api/stations/recent-activity')).json();
  assert.equal(result.stations.length, 2);
  const first = result.stations.find(item => item.stationId === 'relay');
  const second = result.stations.find(item => item.stationId === 'second');
  assert.equal(first.lastCallAt, Date.parse(state.stations[0].calls[0].timestamp));
  assert.equal(second.lastCallAt, Date.parse(state.stations[1].calls[0].timestamp));
});
