const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../server');

async function fixture(t, overrides = {}, calls = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-ledger-'));
  const context = { response: { balance: 500, unit: 'USD', totalSpend: 999, tokens: 999999 }, handler: null };
  const upstream = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test' }] }));
    const result = context.handler ? await context.handler(req) : context.response;
    res.statusCode = result.status || 200;
    res.end(JSON.stringify(result));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ stations: [{ id: 'relay', name: 'Relay',
    baseUrl: `${origin}/v1`, statsUrl: `${origin}/balance`, apiKey: 'key', balanceUnit: 'USD', balanceUnitCustomized: true,
    calls, ...overrides }] }));
  let app;
  const start = async () => { app = createServer({ runtime: 'web', sqliteEnabled: true, dataDir: root, port: 0,
    cliPaths: { codexSessions: path.join(root, 'cli'), codexConfig: path.join(root, 'config.toml'), claudeProjects: path.join(root, 'missing-claude') } }); await app.ready; };
  await start();
  t.after(async () => { await app.close(); await new Promise(resolve => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const api = async (route, method = 'GET', body, expectedStatus = 200) => {
    const response = await fetch(`http://127.0.0.1:${app.port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, expectedStatus, await response.clone().text());
    return response.json();
  };
  return { context, root, api, restart: async () => { await app.close(); await start(); },
    refresh: async balance => { context.response = { balance, unit: 'USD', totalSpend: 999, tokens: 999999 }; return api('/api/stations/relay/refresh', 'POST', {}); } };
}

test('SQLite ledger accumulates only balance decreases, preserving intervals, restart and independent token buckets', async t => {
  const timestamp = new Date().toISOString();
  const f = await fixture(t, {}, [
    { id: 'real', timestamp, model: 'test', tokens: 99999, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5 },
    { id: 'legacy', timestamp, model: 'old', tokens: 7 },
    { id: 'adjust', timestamp, sourceType: 'manual-adjustment', model: '历史补录', tokens: 100000 },
    { id: 'health', timestamp, model: 'GET /models', tokens: 100000 }
  ]);
  const initial = await f.refresh(500);
  assert.equal(initial.stations[0].totalSpend, 0);
  assert.deepEqual(initial.aggregate.totalSpendByUnit, { USD: 0 });
  const baselineAt = initial.stations[0].balanceUpdatedAt;
  let state = await f.refresh(450);
  assert.equal(state.stations[0].totalSpend, 50);
  await f.refresh(450); await f.refresh(600);
  state = await f.refresh(580);
  assert.deepEqual(state.aggregate.totalSpendByUnit, { USD: 70 });
  assert.deepEqual(state.stations[0].tokenBreakdown, { input: 17, output: 20, cacheRead: 30, cacheWrite: 5, cache: 35, total: 72 });
  assert.equal(state.aggregate.totalTokens, 72);
  const quota = await f.api('/api/history/quota?stationId=relay&range=all&pageSize=1');
  assert.equal(quota.logs.length, 1); assert.equal(quota.pagination.total, 2);
  assert.deepEqual(quota.summary.amountByUnit, { USD: 70 });
  const earlier = await f.api('/api/history/quota?stationId=relay&pageSize=1&page=2');
  assert.equal(earlier.logs[0].amount, 50); assert.equal(earlier.logs[0].periodStartAt, baselineAt);
  assert.equal(earlier.logs[0].previousBalance, 500); assert.equal(earlier.logs[0].currentBalance, 450);
  const tokens = await f.api('/api/history/tokens?stationId=relay&pageSize=1');
  assert.equal(tokens.summary.total, 72); assert.equal(tokens.summary.count, 2);
  const allTokens = await f.api('/api/history/tokens?stationId=relay&pageSize=10');
  assert.equal(allTokens.logs.find(log => log.id === 'real').tokens, 65);
  assert.equal(allTokens.logs.find(log => log.id === 'legacy').breakdownEstimated, true);
  assert.equal((await f.api('/api/history/quota?stationId=missing')).summary.count, 0);
  assert.equal((await f.api('/api/history/tokens?from=2100-01-01')).summary.count, 0);
  await f.restart();
  assert.deepEqual((await f.api('/api/stations')).aggregate.totalSpendByUnit, { USD: 70 });
  await f.refresh(580);
  assert.equal((await f.api('/api/history/quota')).summary.count, 2);
  await f.api('/api/stations/relay', 'DELETE');
  assert.equal((await f.api('/api/history/quota')).summary.count, 0);
  assert.equal((await f.api('/api/history/tokens')).summary.count, 0);
});

test('manual correction ledger supports increases, decreases, retries and growth without changing measured histories', async t => {
  const f = await fixture(t, {}, [{ id: 'base', model: 'test', timestamp: new Date().toISOString(), inputTokens: 60, outputTokens: 20, cacheReadTokens: 15, cacheWriteTokens: 5 }]);
  await f.refresh(500); await f.refresh(450);
  const snapshot = () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(f.root, 'usage.db'), { readOnly: true });
    try { return db.prepare('SELECT payload FROM quota_snapshots WHERE station_id=?').get('relay').payload; }
    finally { db.close(); }
  };
  const before = snapshot();
  const up = { amount: 300, tokens: 300, unit: 'USD', expectedAmount: 50, expectedTokens: 100 };
  let state = await f.api('/api/stations/relay/calibrate', 'POST', up);
  assert.equal(state.adjustment.amount, 250); assert.equal(state.adjustment.tokens, 200);
  assert.equal(state.aggregate.totalTokens, 300); assert.deepEqual(state.aggregate.totalSpendByUnit, { USD: 300 });
  assert.equal(state.stations[0].tokenBreakdown.total, 100);
  assert.equal(state.stations[0].balance, 450); assert.equal(snapshot(), before);
  assert.equal((await f.api('/api/stations/relay/calibrate', 'POST', up)).adjustment, null);
  const stale = await f.api('/api/stations/relay/calibrate', 'POST', { ...up, amount: 301 }, 400);
  assert.match(stale.error, /已变化/);
  assert.equal((await f.api('/api/history/corrections')).summary.count, 1);
  const quota = await f.api('/api/history/quota'), tokens = await f.api('/api/history/tokens');
  assert.deepEqual(quota.summary, { count: 1, amountByUnit: { USD: 50 } });
  assert.equal(tokens.summary.total, 100); assert.equal(tokens.summary.count, 1);
  await f.restart();
  state = await f.refresh(440);
  assert.equal(state.stations[0].totalSpend, 310); assert.equal(state.stations[0].tokens, 300);
  const down = { amount: 20, tokens: 10, unit: 'USD', expectedAmount: 310, expectedTokens: 300 };
  state = await f.api('/api/stations/relay/calibrate', 'POST', down);
  assert.equal(state.adjustment.amount, -290); assert.equal(state.adjustment.tokens, -290);
  assert.equal(state.stations[0].totalSpend, 20); assert.equal(state.stations[0].tokens, 10);
  assert.equal(state.stations[0].tokenBreakdown.total, 100);
  fs.mkdirSync(path.join(f.root, 'cli'));
  fs.writeFileSync(path.join(f.root, 'config.toml'), `[model_providers.custom]\nname="Relay"\nbase_url="${state.stations[0].baseUrl}"\n`);
  fs.writeFileSync(path.join(f.root, 'cli', 'rollout.jsonl'), [
    { type: 'session_meta', payload: { session_id: 'calibration-growth', model_provider: 'custom' } },
    { type: 'token_usage_record', timestamp: new Date().toISOString(), payload: { session_id: 'calibration-growth', response_id: 'new', usage: { input_tokens: 20, output_tokens: 5 } } }
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  state = await f.api('/api/logs/sync-cli', 'POST', {});
  assert.equal(state.stations[0].tokens, 35); assert.equal(state.stations[0].tokenBreakdown.total, 125);
  await f.api('/api/stations/relay', 'PATCH', { balanceUnit: 'CNY' });
  state = await f.api('/api/stations/relay/calibrate', 'POST', { amount: 7, tokens: 35, unit: 'CNY', expectedAmount: 0, expectedTokens: 35 });
  assert.deepEqual(state.aggregate.totalSpendByUnit, { USD: 20, CNY: 7 });
  await f.api('/api/stations/relay/calibrate', 'POST', { amount: 9, tokens: 35, unit: 'EUR', expectedAmount: 0, expectedTokens: 35 }, 400);
  await f.restart();
  state = await f.api('/api/stations');
  assert.deepEqual(state.aggregate.totalSpendByUnit, { USD: 20, CNY: 7 }); assert.equal(state.aggregate.totalTokens, 35);
  const corrections = await f.api('/api/history/corrections?stationId=relay&pageSize=1');
  assert.equal(corrections.logs.length, 1); assert.equal(corrections.pagination.total, 3);
  assert.deepEqual(corrections.summary, { amountByUnit: { CNY: 7, USD: -40 }, tokens: -90, count: 3 });
  await f.api('/api/stations/relay', 'DELETE');
  assert.equal((await f.api('/api/history/corrections')).summary.count, 0);
});

test('legacy calibrated totals migrate once and continue accumulating after restart', async t => {
  const f = await fixture(t, { historyCalibration: { version: 2, amount: 300, tokens: 300, loggedTokens: 20,
    remoteGrowth: 5, remoteTokenGrowth: 0, unit: 'USD', updatedAt: '2026-01-01T00:00:00.000Z' } }, [
    { id: 'old', timestamp: '2025-12-01T00:00:00.000Z', model: 'test', tokens: 100 },
    { id: 'new', timestamp: '2026-02-01T00:00:00.000Z', model: 'test', tokens: 20 }
  ]);
  let state = await f.api('/api/stations');
  assert.equal(state.stations[0].totalSpend, 305); assert.equal(state.stations[0].tokens, 320);
  let corrections = await f.api('/api/history/corrections');
  assert.equal(corrections.logs[0].source, 'legacy'); assert.equal(corrections.summary.count, 1);
  await f.refresh(500); await f.refresh(450); await f.restart();
  state = await f.api('/api/stations');
  assert.equal(state.stations[0].totalSpend, 355); assert.equal(state.stations[0].tokens, 320);
  assert.equal((await f.api('/api/history/corrections')).summary.count, 1);
});

test('invalid readings, failed queries, recharges and subprecision deltas never invent expenditure', async t => {
  const f = await fixture(t);
  await f.refresh(500);
  for (const balance of [null, '', false]) await f.refresh(balance);
  f.context.response = { status: 503, error: 'unavailable' };
  await f.api('/api/stations/relay/refresh', 'POST', {});
  assert.equal((await f.api('/api/history/quota')).summary.count, 0);
  await f.refresh(500 - 0.00000001);
  assert.equal((await f.api('/api/history/quota')).summary.count, 0);
  await f.refresh(550);
  assert.equal((await f.refresh(500)).stations[0].totalSpend, 50);
});

test('a legacy saved balance establishes the first history baseline without backfilling old spend', async t => {
  const f = await fixture(t, { balance: 500, balanceKnown: true, balanceUpdatedAt: '2026-10-01T00:00:00.000Z', spendSource: 'remote' });
  const first = await f.refresh(450);
  assert.equal(first.stations[0].totalSpend, 0);
  assert.equal((await f.api('/api/history/quota')).summary.count, 0);
  assert.equal((await f.refresh(440)).stations[0].totalSpend, 10);
});

test('overlapping refreshes and account changes cannot commit stale balances or duplicate events', async t => {
  const f = await fixture(t); await f.refresh(500);
  const pending = [];
  let arrived;
  f.context.handler = () => new Promise(resolve => { pending.push(resolve); arrived?.(); });
  const waitFor = count => pending.length >= count ? Promise.resolve() : new Promise(resolve => { arrived = resolve; });
  const first = f.api('/api/stations/relay/refresh', 'POST', {}); await waitFor(1);
  const second = f.api('/api/stations/relay/refresh', 'POST', {}); await waitFor(2);
  pending[1]({ balance: 430, unit: 'USD' }); await second;
  pending[0]({ balance: 440, unit: 'USD' }); await first;
  assert.equal((await f.api('/api/stations')).stations[0].balance, 430);
  assert.deepEqual((await f.api('/api/history/quota')).summary, { amountByUnit: { USD: 70 }, count: 1 });
  const stale = f.api('/api/stations/relay/refresh', 'POST', {}); await waitFor(3);
  await f.api('/api/stations/relay', 'PATCH', { apiKey: 'different-account' });
  pending[2]({ balance: 100, unit: 'USD' }); await stale;
  f.context.handler = null;
  await f.refresh(100);
  assert.equal((await f.api('/api/history/quota')).summary.count, 1);
  assert.equal((await f.refresh(90)).stations[0].totalSpend, 80);
});

test('quota events follow the displayed selected plan and reset baselines across source and currency changes', async t => {
  const usageScript = `({request:{url:'{{baseUrl}}/balance'},extractor:function(response){return response.plans;}})`;
  const f = await fixture(t, { usageScriptEnabled: true, usageScript, quotaPolicy: { mode: 'daily', limit: 500, source: 'plan:Daily' } });
  const refreshPlans = async (wallet, daily, unit = 'USD') => {
    f.context.response = { plans: [{ planName: '钱包', remaining: wallet, unit }, { planName: 'Daily', remaining: daily, unit }] };
    return f.api('/api/stations/relay/refresh', 'POST', {});
  };
  await refreshPlans(1000, 500); await refreshPlans(900, 450);
  let history = await f.api('/api/history/quota');
  assert.equal(history.logs[0].amount, 50); assert.equal(history.logs[0].source, 'plan:Daily');
  await f.api('/api/stations/relay', 'PATCH', { quotaPolicy: { source: 'account' } });
  await refreshPlans(800, 400);
  assert.equal((await f.api('/api/history/quota')).summary.count, 1);
  await refreshPlans(790, 300);
  await f.api('/api/stations/relay', 'PATCH', { balanceUnit: 'CNY' });
  await refreshPlans(100, 100, 'CNY'); await refreshPlans(90, 90, 'CNY');
  history = await f.api('/api/history/quota');
  assert.deepEqual(history.summary.amountByUnit, { USD: 60, CNY: 10 });
  assert.deepEqual((await f.api('/api/stations')).aggregate.totalSpendByUnit, { USD: 60, CNY: 10 });
});

test('SQLite CLI synchronization reports fresh bucket totals immediately and deduplicates repeated imports', async t => {
  const f = await fixture(t);
  const station = (await f.api('/api/stations')).stations[0];
  fs.mkdirSync(path.join(f.root, 'cli'));
  fs.writeFileSync(path.join(f.root, 'config.toml'), `[model_providers.custom]\nname="Relay"\nbase_url="${station.baseUrl}"\n`);
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(f.root, 'cli', 'rollout.jsonl'), [
    { type: 'session_meta', payload: { session_id: 'session', model_provider: 'custom' }, timestamp },
    { type: 'token_usage_record', timestamp, payload: { session_id: 'session', response_id: 'response',
      usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5, output_tokens: 20 } } }
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  const response = await f.api('/api/logs/sync-cli', 'POST', {});
  const expected = { input: 60, output: 20, cacheRead: 40, cacheWrite: 5, cache: 45, total: 125 };
  assert.deepEqual(response.stations[0].tokenBreakdown, expected);
  assert.deepEqual(response.aggregate.tokenBreakdown, expected);
  const repeated = await f.api('/api/logs/sync-cli', 'POST', {});
  assert.deepEqual(repeated.stations[0].tokenBreakdown, expected);
  assert.equal((await f.api('/api/history/tokens')).summary.count, 1);
});
