const stationAccounting = require('./station-accounting');

function overviewStats(state, { days = 7, timeZone = 'UTC', now = new Date(), priceCall } = {}) {
  if (![7, 30].includes(days)) throw new Error('图表范围只支持 7 或 30 天');
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { throw new Error('图表时区无效'); }
  const dateKey = (date) => {
    const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const last = dateKey(now);
  const midnight = Date.parse(`${last}T00:00:00Z`);
  const trend = Array.from({ length: days }, (_, index) => ({
    date: new Date(midnight - (days - 1 - index) * 86400000).toISOString().slice(0, 10),
    input: 0, output: 0, cacheCreation: 0, cacheRead: 0, requests: 0, cacheHitRate: null
  }));
  const buckets = new Map(trend.map(bucket => [bucket.date, bucket]));
  const models = new Map();
  const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const addCost = (groups, unit, value) => { groups[unit] = Number(((groups[unit] || 0) + value).toFixed(6)); };
  const add = (rawCall, station = {}) => {
    const call = priceCall ? priceCall(rawCall, station) : rawCall;
    const unit = station.balanceUnit;
    if (call.sourceType === 'manual-adjustment') return;
    if (call.model === 'GET /models') return;
    const timestamp = new Date(call.timestamp || '');
    if (!Number.isFinite(timestamp.getTime()) || timestamp > now) return;
    const bucket = buckets.get(dateKey(timestamp));
    if (!bucket) return;
    const parts = stationAccounting.tokenBreakdown(call);
    const input = number(parts.input), output = number(parts.output);
    const cacheRead = number(parts.cacheRead), cacheCreation = number(parts.cacheWrite);
    const tokens = parts.total;
    bucket.input += input; bucket.output += output; bucket.cacheRead += cacheRead; bucket.cacheCreation += cacheCreation; bucket.requests += 1;
    const name = String(call.model || '未知模型');
    if (!models.has(name)) models.set(name, { model: name, requests: 0, tokens: 0, actualCostByUnit: {}, estimatedCostByUnit: {} });
    const model = models.get(name);
    model.requests += 1; model.tokens += tokens;
    if (call.cost !== null && call.cost !== undefined && call.cost !== '' && Number.isFinite(Number(call.cost))) {
      const currency = call.costUnit || unit || 'USD';
      addCost(call.costSource === 'estimated' || !call.costSource ? model.estimatedCostByUnit : model.actualCostByUnit, currency, Number(call.cost));
    }
  };
  for (const station of state.stations || []) for (const call of station.calls || []) add(call, station);
  for (const call of state.cliCalls || []) if (call.sourceType !== 'workbuddy') add(call);
  for (const bucket of trend) {
    const denominator = bucket.input + bucket.cacheRead;
    bucket.cacheHitRate = denominator > 0 ? bucket.cacheRead / denominator * 100 : null;
  }
  const sorted = [...models.values()].sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  return { days, timeZone, from: trend[0].date, to: last, trend, models: sorted,
    requests: sorted.reduce((n, model) => n + model.requests, 0), tokens: sorted.reduce((n, model) => n + model.tokens, 0) };
}
module.exports = { overviewStats };
