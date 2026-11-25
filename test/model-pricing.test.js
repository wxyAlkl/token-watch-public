const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compile, priceCall, loadCatalog } = require('../model-pricing');
const { createServer, publicLogs } = require('../server');
const { overviewStats } = require('../overview-stats');
const catalog = { models: compile({ openai: { models: { 'gpt-test': { cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5,
  tiers: [{ tier: { type: 'context', size: 272000 }, input: 4, output: 15, cache_read: 0.2, cache_write: 5 }] } } } },
  anthropic: { models: { 'claude-opus-5-5': { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } } } } }), updatedAt: '2026-10-27T00:00:00Z' };
const fallback = { balanceUnit: 'CNY', multiplier: 2, pricing: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1.25 } };

test('catalog prices each token bucket in USD and matches exact normalized vendor models', () => {
  const call = { model: 'openai/gpt-test', inputTokens: 100000, outputTokens: 20000, cacheReadTokens: 50000, cacheWriteTokens: 10000 };
  const result = priceCall(call, fallback, catalog);
  assert.equal(result.cost, 0.43); assert.equal(result.costUnit, 'USD');
  assert.equal(result.pricingSource, 'models.dev'); assert.equal(result.costSource, 'estimated');
  assert.equal(priceCall({ ...call, model: 'claude-opus-5.5' }, fallback, catalog).pricingModel, 'anthropic/claude-opus-5-5');
  const tier = priceCall({ ...call, inputTokens: 300000 }, fallback, catalog);
  assert.equal(tier.cost, 1.56);
});

test('unknown and incomplete prices fall back without fabricating unmatched zero costs', () => {
  const call = { model: 'unknown', inputTokens: 1e6 };
  const fallbackResult = priceCall(call, fallback, catalog);
  assert.equal(fallbackResult.cost, 2); assert.equal(fallbackResult.costUnit, 'CNY');
  assert.equal(fallbackResult.pricingSource, 'station');
  assert.equal(priceCall(call, {}, catalog).cost, null);
  const manual = { ...call, sourceType: 'manual-adjustment', cost: 200 };
  assert.equal(priceCall(manual, fallback, catalog), manual);
  assert.throws(() => compile({}));
});

test('catalog downloads are cached and failed updates retain previous validated rates', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-price-cache-'));
  t.after(() => { fs.unlinkSync(path.join(root, 'model-pricing.json')); fs.rmdirSync(root); });
  let downloads = 0;
  const fetchCatalog = async () => {
    downloads++;
    return new Response(JSON.stringify({ openai: { models: { 'gpt-test': { cost: { input: 2, output: 10 } } } } }));
  };
  const initial = await loadCatalog(root, { fetchCatalog });
  assert.ok(initial.models['gpt-test']);
  await loadCatalog(root, { fetchCatalog }); assert.equal(downloads, 1);
  const failed = await loadCatalog(root, { force: true, fetchCatalog: async () => { throw new Error('offline'); } });
  assert.ok(failed.models['gpt-test']); assert.match(failed.error, /同步失败/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'model-pricing.json'), 'utf8'));
  assert.equal(saved.data.openai.models['gpt-test'].cost.input, 2);
});

test('log summaries exclude calibration and pricing neither changes records nor station amounts', () => {
  const call = { id: 'real', model: 'gpt-test', timestamp: new Date().toISOString(), inputTokens: 100000, outputTokens: 20000, cacheReadTokens: 50000, cacheWriteTokens: 10000, tokens: 180000, cost: 99, costUnit: 'CNY' };
  const station = { ...fallback, id: 'relay', name: 'Relay', totalSpend: 300, tokens: 900000, spendSource: 'remote', calls: [call,
    { timestamp: '1999-12-31T16:00:00Z', sourceType: 'manual-adjustment', cost: 200, tokens: 200000, costUnit: 'CNY' }] };
  const state = { stations: [station] };
  const result = publicLogs(state, new URL('http://localhost/api/logs?range=all'), catalog);
  assert.equal(result.summary.usageByUnit.USD, 0.43); assert.equal(result.summary.tokenCount, 180000);
  assert.equal(result.summary.requestCount, 1); assert.equal(result.logs.length, 2);
  assert.equal(call.cost, 99); assert.equal(station.totalSpend, 300);
  const chart = overviewStats(state, { priceCall: (c, s) => priceCall(c, s, catalog) });
  assert.equal(chart.models[0].estimatedCostByUnit.USD, 0.43);
});

test('overview ignores remote totals and estimates, using only quota ledger and call token buckets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-accounting-'));
  const file = path.join(root, 'stations.json');
  const call = { model: 'gpt-test', timestamp: new Date().toISOString(), tokens: 100, inputTokens: 100, cost: 10000 };
  fs.writeFileSync(file, JSON.stringify({ stations: [
    { id: 'remote', name: 'Remote', baseUrl: 'https://example.com/v1', balanceUnit: 'USD', totalSpend: 300, spendSource: 'remote', remoteTokens: 1000, calls: [call] },
    { id: 'fallback', name: 'Fallback', baseUrl: 'https://example.com/v1', balanceUnit: 'USD', totalSpend: 5000, spendSource: 'local-proxy', tokens: 8000, calls: [call] },
    { id: 'zero', name: 'Zero', baseUrl: 'https://example.com/v1', remoteTokens: 0, calls: [call] }
  ] }));
  const app = createServer({ runtime: 'web', dataDir: root, port: 0, pricingCatalog: catalog }); await app.ready;
  t.after(async () => { await app.close(); fs.unlinkSync(file); fs.rmdirSync(root); });
  const state = await (await fetch(`http://127.0.0.1:${app.port}/api/stations`)).json();
  assert.equal(state.aggregate.totalSpendByUnit.USD, 0);
  assert.equal(state.aggregate.totalTokens, 300);
  assert.equal(state.stations[1].totalSpend, 0);
  assert.equal(state.stations[0].reportedTotalSpend, 300);
  assert.equal(state.stations[0].reportedTotalTokens, 1000);
  assert.equal('remoteTokens' in state.stations[0], false);
  assert.equal(state.stations[0].tokenStatsSource, '调用日志累计');
  const logs = await (await fetch(`http://127.0.0.1:${app.port}/api/logs?range=all`)).json();
  assert.equal(logs.summary.tokenCount, 300);
  assert.equal(logs.summary.pricing.source, 'models.dev');
});
