const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { overviewStats } = require('../overview-stats');
const alerts = require('../public/balance-alerts');
const { compact, money } = require('../public/dashboard-format');
const { present } = require('../public/quota-policy');
const { createServer } = require('../server');

test('dashboard formats exact currencies and integer K/M/G/T/P abbreviations', () => {
  for (const [n, expected] of [[0, '0'], [999, '999'], [1000, '1K'], [999999, '999K'], [123456789, '123M'], [1e9, '1G'], [1e12, '1T'], [1e15, '1P']]) assert.equal(compact(n), expected);
  assert.equal(money(1234.5, 'USD'), '$ 1,234.50');
  assert.equal(money(12, 'CNY'), '¥ 12.00');
  assert.equal(money(null, 'USD'), '--');
});

test('overview aggregates calendar days, real token buckets and weighted cache-hit rate', () => {
  const call = { timestamp: '2026-10-25T02:00:00Z', model: 'model-A', tokens: 100, inputTokens: 10, outputTokens: 0, cacheReadTokens: 90, cacheWriteTokens: 0, cost: 1, costUnit: 'USD', costSource: 'estimated' };
  const state = { stations: [{ calls: [call, { ...call, inputTokens: 90, cacheReadTokens: 10, cost: 2, costUnit: 'CNY', costSource: 'remote' },
    { ...call, timestamp: '2026-09-01T00:00:00Z' }, { ...call, timestamp: '2026-10-26T00:00:00Z' },
    { ...call, timestamp: 'invalid' }, { ...call, model: 'GET /models' }] }],
    cliCalls: [{ ...call, model: 'CLI model', timestamp: '2026-10-25T05:00:00Z', cost: null, cacheWriteTokens: 4 }]
  };
  const result = overviewStats(state, { days: 7, timeZone: 'America/New_York', now: new Date('2026-10-25T12:00:00Z') });
  assert.equal(result.from, '2026-10-19');
  assert.equal(result.to, '2026-10-25');
  assert.equal(result.trend.length, 7);
  assert.equal(result.trend[5].requests, 2);
  assert.equal(result.trend[5].cacheHitRate, 50);
  assert.equal(result.trend[6].cacheCreation, 4);
  assert.equal(result.trend[0].cacheHitRate, null);
  assert.equal(result.requests, 3);
  assert.equal(result.tokens, 304);
  const model = result.models.find(model => model.model === 'model-A');
  assert.deepEqual(model.actualCostByUnit, { CNY: 2 });
  assert.deepEqual(model.estimatedCostByUnit, { USD: 1 });
  assert.deepEqual(result.models.find(model => model.model === 'CLI model').actualCostByUnit, {});
  assert.throws(() => overviewStats(state, { days: 8 }), /范围/);
  assert.throws(() => overviewStats(state, { timeZone: 'invalid' }), /时区/);
});

test('overview handles empty data, zero usage, fallback totals, and missing dates honestly', () => {
  const empty = overviewStats({ stations: [] }, { now: new Date('2026-10-25T12:00:00Z'), days: 30 });
  assert.equal(empty.trend.length, 30);
  assert.equal(empty.models.length, 0);
  assert.equal(empty.tokens, 0);
  assert.ok(empty.trend.every(bucket => bucket.cacheHitRate === null));
  const result = overviewStats({ cliCalls: [{ timestamp: '2026-10-25T00:00:00Z', inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }, { model: 'Missing date', tokens: 100 }] }, { now: new Date('2026-10-25T12:00:00Z') });
  assert.equal(result.tokens, 100);
  assert.equal(result.requests, 1);
  assert.equal(result.models[0].model, '未知模型');
  assert.equal(result.trend.at(-1).cacheHitRate, 75);
});

test('balance warnings use strict thresholds, OR logic, overrides and currency separation', () => {
  const quota = (extra = {}) => ({ remaining: 10, percent: 50, unit: 'USD', lowBalanceThreshold: null, stale: false, ...extra });
  assert.equal(alerts.evaluate(quota(), { USD: 10, percent: 50 }).active, false);
  assert.equal(alerts.evaluate(quota(), { USD: 11 }).active, true);
  assert.equal(alerts.evaluate(quota(), { percent: 51 }).active, true);
  assert.equal(alerts.evaluate(quota({ unit: 'CNY' }), { USD: 11 }).active, false);
  assert.equal(alerts.evaluate(quota({ unit: 'CNY' }), { CNY: 11 }).active, true);
  assert.equal(alerts.evaluate(quota({ lowBalanceThreshold: 5 }), { USD: 20 }).active, false);
  assert.equal(alerts.evaluate(quota({ lowBalanceThreshold: 15 }), { USD: 5 }).active, true);
  assert.equal(alerts.evaluate(quota({ percent: null }), { percent: 99 }).active, false);
  assert.equal(alerts.evaluate(quota({ remaining: null }), { USD: 100 }).active, false);
  assert.equal(alerts.evaluate(quota({ remaining: 0 }), {}).active, true);
  assert.equal(alerts.evaluate(quota({ remaining: 0 }), { enabled: false }).active, false);
  assert.equal(alerts.evaluate(quota({ stale: true }), { USD: 11 }).stale, true);
  const missing = present({ balance: 20, balanceKnown: true, quotaPolicy: { mode: 'daily', limit: 20, source: 'plan:missing' } });
  assert.equal(alerts.evaluate(missing, { percent: 100 }).active, false);
});

test('balance warning settings validate blank versus zero and reject invalid fields', () => {
  assert.deepEqual(alerts.normalize(), { enabled: true, USD: null, CNY: null, percent: null });
  assert.equal(alerts.normalize({ USD: '' }).USD, null);
  assert.equal(alerts.normalize({ USD: 0 }).USD, 0);
  for (const input of [null, [], { enabled: 'yes' }, { USD: -1 }, { CNY: false }, { percent: 101 }, { percent: 'bad' }, { USD: ' ' }]) assert.throws(() => alerts.normalize(input));
});

test('overview endpoint, vendor assets and alert settings survive restart without changing station policy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-overview-'));
  const file = path.join(root, 'stations.json');
  fs.writeFileSync(file, JSON.stringify({ settings: { refreshMinutes: 10 }, stations: [{
    id: 'test', name: 'Test', baseUrl: 'https://example.com/v1', balance: 5, spendSource: 'remote', balanceKnown: true,
    quotaPolicy: { mode: 'daily', limit: 20 }, apiKey: 'never-return-this', calls: [{ timestamp: new Date().toISOString(), tokens: 123, model: 'real-model', inputTokens: 100, outputTokens: 23 }]
  }] }));
  let app = createServer({ runtime: 'web', dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); fs.unlinkSync(file); fs.rmdirSync(root); });
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${app.port}${route}`, { method: body === undefined ? 'GET' : 'PATCH', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const result = await call('/api/overview?days=7&timeZone=UTC&model=does-not-filter');
  assert.equal(result.status, 200);
  assert.equal(result.data.tokens, 123);
  assert.equal(result.data.models[0].model, 'real-model');
  assert.doesNotMatch(JSON.stringify(result.data), /never-return-this/);
  assert.equal((await call('/api/overview?days=0')).status, 400);
  assert.equal((await call('/api/overview?timeZone=invalid')).status, 400);
  for (const route of ['/vendor/chart.js', '/vendor/lucide.js', '/balance-alerts.js']) {
    const response = await fetch(`http://127.0.0.1:${app.port}${route}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    await response.text();
  }
  assert.equal((await call('/api/settings', { balanceAlerts: { percent: 200 } })).status, 400);
  const saved = await call('/api/settings', { balanceAlerts: { enabled: true, USD: 8, CNY: 20, percent: 25 } });
  assert.equal(saved.data.settings.refreshMinutes, 10);
  await call('/api/settings', { refreshMinutes: 60 });
  await app.close();
  app = createServer({ runtime: 'web', dataDir: root, port: 0 }); await app.ready;
  const current = (await call('/api/stations')).data;
  assert.deepEqual(current.settings.balanceAlerts, { enabled: true, USD: 8, CNY: 20, percent: 25 });
  assert.equal(current.settings.refreshMinutes, 60);
  assert.equal(current.stations[0].quotaPolicy.limit, 20);
});
