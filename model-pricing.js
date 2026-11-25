const fs = require('node:fs');
const path = require('node:path');
const network = require('./outbound-network');
const SOURCE = 'https://models.dev/api.json';
const caches = new Map();
const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function normalizeModel(id) { return String(id || '').toLowerCase().replace(/^(openai|anthropic|deepseek)\//, '').replace(/\./g, '-'); }
function compile(data) {
  const models = {};
  for (const provider of ['openai', 'anthropic', 'deepseek']) {
    for (const [id, model] of Object.entries(data[provider]?.models || {})) {
      if (!valid(model.cost?.input) || !valid(model.cost?.output)) continue;
      const key = normalizeModel(id);
      const entry = { provider, id, cost: model.cost };
      if (models[key] && JSON.stringify(models[key].cost) !== JSON.stringify(entry.cost)) models[key] = { ambiguous: true };
      else if (!models[key]) models[key] = entry;
    }
  }
  if (!Object.keys(models).length) throw new Error('模型价格目录为空');
  return models;
}
async function loadCatalog(dataDir, { force = false, fetchCatalog } = {}) {
  let cache = caches.get(dataDir);
  if (!cache) {
    cache = { checked: 0, models: {}, updatedAt: null, error: '' }; caches.set(dataDir, cache);
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'model-pricing.json'), 'utf8'));
      cache.models = compile(saved.data); cache.updatedAt = saved.updatedAt;
      cache.checked = Date.parse(saved.updatedAt) || 0;
    } catch {}
  }
  if (cache.pending) return cache.pending;
  if (!force && Date.now() - cache.checked < (cache.error ? 60000 : 86400000)) return cache;
  cache.pending = (async () => {
    try {
      const response = fetchCatalog ? await fetchCatalog(SOURCE) : await network.fetch(SOURCE, { dispatcher: await network.dispatcher(SOURCE), signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error('价格目录过大'); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const models = compile(data);
      const updatedAt = new Date().toISOString();
      const reduced = Object.fromEntries(['openai', 'anthropic', 'deepseek'].map(provider => [provider, { models: data[provider]?.models || {} }]));
      fs.mkdirSync(dataDir, { recursive: true });
      const file = path.join(dataDir, 'model-pricing.json');
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ updatedAt, data: reduced })); fs.renameSync(`${file}.tmp`, file);
      Object.assign(cache, { models, updatedAt, error: '' });
    } catch { cache.error = '价格同步失败，使用缓存或站点价格'; }
    finally { cache.checked = Date.now(); cache.pending = null; }
    return cache;
  })();
  return cache.pending;
}
function priceCall(call, station = {}, catalog = {}) {
  if (call.sourceType === 'manual-adjustment') return call;
  const entry = catalog.models?.[normalizeModel(call.model)];
  const quantities = [call.inputTokens, call.outputTokens, call.cacheReadTokens, call.cacheWriteTokens].map(value => Number(value || 0));
  let cost, unit, pricingSource, pricingModel;
  const context = quantities[0] + quantities[2] + quantities[3];
  let selectedCost = entry && !entry.ambiguous ? entry.cost : null;
  if (selectedCost) {
    const tiers = (selectedCost.tiers || []).filter(t => t.tier?.type === 'context' && context > t.tier.size).sort((a, b) => b.tier.size - a.tier.size);
    if (tiers.length) selectedCost = { ...selectedCost, ...tiers[0] };
    else if (!selectedCost.tiers && context > 200000 && selectedCost.context_over_200k) selectedCost = { ...selectedCost, ...selectedCost.context_over_200k };
  }
  const prices = selectedCost ? [selectedCost.input, selectedCost.output, selectedCost.cache_read, selectedCost.cache_write] : [];
  if (prices.length && quantities.every((q, i) => q === 0 || valid(prices[i])) && quantities.every(q => Number.isFinite(q) && q >= 0)) {
    cost = quantities.reduce((sum, q, i) => sum + q * (prices[i] || 0), 0) / 1e6;
    unit = 'USD'; pricingSource = 'models.dev'; pricingModel = `${entry.provider}/${entry.id}`;
  } else if (station.pricing) {
    const fallback = station.pricing;
    const values = [fallback.input, fallback.output, fallback.cacheRead, fallback.cacheWrite];
    if (values.every(valid) && quantities.every(q => Number.isFinite(q) && q >= 0)) {
      cost = quantities.reduce((sum, q, i) => sum + q * values[i], 0) / 1e6 * Number(station.multiplier || 1);
      unit = station.balanceUnit || call.costUnit || 'USD'; pricingSource = 'station';
    }
  }
  return { ...call, cost: cost === undefined ? null : Number(cost.toFixed(8)), costUnit: unit || 'USD', costSource: 'estimated',
    pricingSource: pricingSource || 'unavailable', pricingModel: pricingModel || null, pricingUpdatedAt: catalog.updatedAt || null };
}
module.exports = { compile, normalizeModel, loadCatalog, priceCall };
