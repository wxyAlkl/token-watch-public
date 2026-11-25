const crypto = require('node:crypto');
const HISTORY_TIME = '1999-12-31T16:00:00.000Z';
const round = value => Number(value.toFixed(6));
const accounting = require('./station-accounting');
function totals(station) {
  const calibration = station.historyCalibration;
  if (!calibration) return { amount: accounting.remoteAmount(station), tokens: accounting.remoteTokens(station) ?? accounting.logTokens(station) };
  return { amount: round(calibration.amount + (calibration.frozenLegacyCost || 0) + calibration.remoteGrowth),
    tokens: calibration.tokens + Math.max(calibration.remoteTokenGrowth || 0, calibration.loggedTokens) };
}
function trackCall(station, call) {
  const calibration = station.historyCalibration;
  if (!calibration) return;
  calibration.loggedTokens += Number(call.tokens || 0);
}
function trackRemote(station) {
  const calibration = station.historyCalibration;
  if (!calibration) return;
  const current = accounting.remoteAmount(station);
  if (current !== null) {
    if (calibration.lastRemote !== null) calibration.remoteGrowth = round(calibration.remoteGrowth + Math.max(0, current - calibration.lastRemote));
    calibration.lastRemote = current;
  }
  const tokens = accounting.remoteTokens(station);
  if (tokens !== null) {
    if (calibration.lastRemoteTokens != null) calibration.remoteTokenGrowth = (calibration.remoteTokenGrowth || 0) + Math.max(0, tokens - calibration.lastRemoteTokens);
    calibration.lastRemoteTokens = tokens;
  }
}
function migrate(station) {
  const c = station.historyCalibration;
  if (!c || c.version === 2) return;
  c.frozenLegacyCost = Math.max(0, (c.loggedCost || 0) - (c.remoteGrowth || 0));
  c.remoteTokenGrowth = 0; c.lastRemoteTokens = accounting.remoteTokens(station); c.version = 2;
}
function calibrate(station, input, unit) {
  const amount = input.amount;
  const tokens = input.tokens;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new Error('金额必须为 0 至 1 万亿之间的数字');
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Token 数必须为非负安全整数');
  if (input.unit !== unit) throw new Error('额度单位已变化，请重新打开校准窗口');
  const current = totals(station);
  const targetAmount = round(amount);
  if (current.amount === targetAmount && current.tokens === tokens) return null;
  if (input.expectedAmount !== current.amount || input.expectedTokens !== current.tokens) throw new Error('累计用量已变化，请重新打开校准窗口后保存');
  const cost = round(targetAmount - (current.amount ?? 0));
  const deltaTokens = tokens - current.tokens;
  const record = {
    id: crypto.randomUUID(), timestamp: HISTORY_TIME, createdAt: new Date().toISOString(),
    source: station.name, sourceType: 'manual-adjustment', sourceApp: '手动补录', dataSource: '历史消耗校准',
    model: '历史补录', token: '手动校准', tokens: deltaTokens, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, cost, costUnit: unit, costSource: 'manual', stream: null,
    duration: null, ttft: null, tps: null, statusCode: null, result: '历史补录',
    detail: '历史差额补录 · 不计入调用次数', previousAmount: current.amount, previousTokens: current.tokens,
    targetAmount, targetTokens: tokens
  };
  station.calls = [record, ...(station.calls || [])];
  station.historyCalibration = { version: 2, amount: targetAmount, tokens, unit, loggedTokens: 0, loggedCost: 0, frozenLegacyCost: 0,
    remoteTokenGrowth: 0, lastRemoteTokens: accounting.remoteTokens(station),
    remoteGrowth: 0, lastRemote: station.spendSource === 'remote' && station.totalSpend != null ? Number(station.totalSpend) : null,
    updatedAt: record.createdAt };
  return record;
}
// Manual corrections are separate from measured quota events and token buckets.
function ledgerSummary(state, station) {
  const amountByUnit = {};
  let tokens = 0;
  for (const record of state.historyCorrections || []) {
    if (record.stationId !== station.id) continue;
    amountByUnit[record.unit] = round((amountByUnit[record.unit] || 0) + record.amount);
    tokens += record.tokens;
  }
  return { amountByUnit, tokens };
}

function calibrateLedger(state, station, input, current, units) {
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 0 || input.amount > 1e12) throw new Error('金额必须为 0 至 1 万亿之间的数字');
  if (!Number.isSafeInteger(input.tokens) || input.tokens < 0) throw new Error('Token 数必须为非负安全整数');
  if (!units.includes(input.unit)) throw new Error('额度单位已变化，请重新打开校准窗口');
  const amount = round(input.amount);
  if (current.amount === amount && current.tokens === input.tokens) return null;
  if (input.expectedAmount !== current.amount || input.expectedTokens !== current.tokens) throw new Error('累计用量已变化，请重新打开校准窗口后保存');
  const record = { id: crypto.randomUUID(), stationId: station.id, stationName: station.name,
    createdAt: new Date().toISOString(), unit: input.unit, amount: round(amount - current.amount), tokens: input.tokens - current.tokens,
    previousAmount: current.amount, targetAmount: amount, previousTokens: current.tokens, targetTokens: input.tokens, source: 'manual' };
  state.historyCorrections ||= [];
  state.historyCorrections.push(record);
  return record;
}

function migrateLedger(state) {
  state.historyCorrections ||= [];
  let changed = false;
  for (const station of state.stations || []) {
    const c = station.historyCalibration;
    if (!c || station.historyCorrectionMigrated) continue;
    const id = `legacy-calibration:${station.id}`;
    if (!state.historyCorrections.some(record => record.id === id)) {
      const old = totals(station);
      const rawTokens = accounting.logTokens(station);
      const sinceCalibration = accounting.logTokens({ calls: (station.calls || []).filter(call => Date.parse(call.timestamp) > Date.parse(c.updatedAt)) });
      const targetTokens = c.tokens + Math.max(c.remoteTokenGrowth || 0, c.loggedTokens || 0, sinceCalibration);
      state.historyCorrections.push({ id, stationId: station.id, stationName: station.name,
        createdAt: c.updatedAt || new Date().toISOString(), unit: c.unit || station.balanceUnit || 'USD',
        amount: old.amount, tokens: targetTokens - rawTokens,
        previousAmount: 0, targetAmount: old.amount, previousTokens: rawTokens, targetTokens, source: 'legacy' });
    }
    station.historyCorrectionMigrated = true;
    changed = true;
  }
  if (changed) Object.defineProperty(state, '_correctionsMigrated', { value: true, configurable: true });
  return changed;
}

module.exports = { totals, trackCall, trackRemote, calibrate, migrate, HISTORY_TIME, ledgerSummary, calibrateLedger, migrateLedger };
