const crypto = require('node:crypto');
const { tokenBreakdown } = require('./station-accounting');

const sourceName = (call, station) => String(call.source || station?.name || '未知来源').trim() || '未知来源';
const isUsage = call => call.model !== 'GET /models' && call.sourceType !== 'manual-adjustment';
function rules(state) { return Array.isArray(state.sourceMappings) ? state.sourceMappings : []; }
function mappedStation(state, source) {
  const rule = rules(state).find(item => item.source === String(source || '').trim());
  return rule ? state.stations.find(station => station.id === rule.stationId) || null : null;
}
function attributionStatus(state) {
  const names = new Set(state.stations.map(station => station.name));
  const pending = new Map();
  const collect = (call, station) => {
    if (!isUsage(call)) return;
    const source = sourceName(call, station);
    if (station && names.has(source)) return;
    if (!pending.has(source)) pending.set(source, { source, count: 0, tokens: 0, lastSeenAt: null, apps: new Set() });
    const group = pending.get(source);
    group.count++; group.tokens += tokenBreakdown(call).total;
    if (call.timestamp && (!group.lastSeenAt || Date.parse(call.timestamp) > Date.parse(group.lastSeenAt))) group.lastSeenAt = call.timestamp;
    group.apps.add(call.sourceApp || call.sourceType || '本地代理');
  };
  for (const station of state.stations) for (const call of station.calls || []) collect(call, station);
  for (const call of state.cliCalls || []) collect(call, null);
  const unresolved = [...pending.values()].map(group => ({ ...group, apps: [...group.apps] })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  return { unresolved, unresolvedCount: unresolved.length, recordCount: unresolved.reduce((sum, group) => sum + group.count, 0),
    mappings: rules(state).map(rule => ({ source: rule.source, stationId: rule.stationId,
      stationName: state.stations.find(station => station.id === rule.stationId)?.name || '目标站点已删除', updatedAt: rule.updatedAt })) };
}

function assignSource(state, source, target) {
  const selected = String(source || '').trim();
  if (!selected) throw new Error('请选择需要处理的陌生来源');
  const status = attributionStatus(state);
  if (!status.unresolved.some(group => group.source === selected) && !rules(state).some(rule => rule.source === selected)) {
    throw new Error('该来源已变化，请刷新归属列表后重试');
  }
  const moved = [];
  const take = (calls, owner) => (calls || []).filter(call => {
    if (!isUsage(call) || !(call.mappingSource === selected || (!call.mappingSource && sourceName(call, owner) === selected))) return true;
    call.originalSource ||= sourceName(call, owner);
    call.mappingSource = selected;
    call.source = target.name;
    moved.push(call);
    return false;
  });
  for (const station of state.stations) station.calls = take(station.calls, station);
  state.cliCalls = take(state.cliCalls, null);
  const ids = new Set(target.calls.map(call => call.id).filter(Boolean));
  for (const call of moved) {
    if (call.id && ids.has(call.id)) { call.originalLogId ||= call.id; call.id = crypto.randomUUID(); }
    if (call.id) ids.add(call.id);
    target.calls.push(call);
  }
  const rule = { source: selected, stationId: target.id, updatedAt: new Date().toISOString() };
  state.sourceMappings = [...rules(state).filter(item => item.source !== selected), rule];
  return moved.length;
}

function renameSources(station, previousName) {
  for (const call of station.calls || []) {
    if (call.source === previousName || call.mappingSource) {
      call.originalSource ||= call.source;
      call.source = station.name;
    }
  }
}

module.exports = { attributionStatus, mappedStation, assignSource, renameSources };
