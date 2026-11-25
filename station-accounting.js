function remoteAmount(station) {
  return station.spendSource === 'remote' && station.totalSpend != null && Number.isFinite(Number(station.totalSpend)) ? Number(station.totalSpend) : null;
}
function remoteTokens(station) {
  return station.remoteTokens != null && Number.isFinite(Number(station.remoteTokens)) ? Number(station.remoteTokens) : null;
}
function logTokens(station) {
  return (station.calls || []).filter(call => call.sourceType !== 'manual-adjustment' && call.model !== 'GET /models')
    .reduce((sum, call) => sum + tokenBreakdown(call).total, 0);
}
function tokenBreakdown(call = {}) {
  const hasBuckets = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .some(key => call[key] !== null && call[key] !== undefined && call[key] !== '');
  const value = key => Number.isFinite(Number(call[key])) ? Math.max(0, Number(call[key])) : 0;
  const input = call.inputTokens === null || call.inputTokens === undefined || call.inputTokens === ''
    ? (hasBuckets ? 0 : value('tokens')) : value('inputTokens');
  const output = value('outputTokens');
  const cacheRead = value('cacheReadTokens');
  const cacheWrite = value('cacheWriteTokens');
  return { input, output, cacheRead, cacheWrite, cache: cacheRead + cacheWrite, total: input + output + cacheRead + cacheWrite };
}
function breakdownEstimated(call = {}) {
  return !['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .some(key => call[key] !== null && call[key] !== undefined && call[key] !== '') && Number(call.tokens) > 0;
}
function logBreakdown(station) {
  return (station.calls || []).filter(call => call.sourceType !== 'manual-adjustment' && call.model !== 'GET /models')
    .reduce((total, call) => {
      const buckets = tokenBreakdown(call);
      total.input += buckets.input; total.output += buckets.output;
      total.cacheRead += buckets.cacheRead; total.cacheWrite += buckets.cacheWrite;
      total.cache += buckets.cache; total.total += buckets.total;
      return total;
    }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cache: 0, total: 0 });
}
module.exports = { remoteAmount, remoteTokens, logTokens, logBreakdown, tokenBreakdown, breakdownEstimated };
