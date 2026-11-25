const { tokenBreakdown, breakdownEstimated } = require('./station-accounting');

const definitions = {
  summary: [['stationId', '站点 ID'], ['stationName', '中转站'], ['monitoring', '监控状态'],
    ['measuredUSD', '实测额度消耗 USD'], ['correctionUSD', '额度校正 USD'], ['totalUSD', '历史额度消耗 USD'],
    ['measuredCNY', '实测额度消耗 CNY'], ['correctionCNY', '额度校正 CNY'], ['totalCNY', '历史额度消耗 CNY'],
    ['inputTokens', '普通输入'], ['outputTokens', '普通输出'], ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存创建'],
    ['measuredTokens', '实测 Token'], ['correctionTokens', 'Token 校正'], ['totalTokens', '历史 Token 合计'], ['callCount', '调用记录数']],
  quota: [['id', '记录 ID'], ['stationId', '站点 ID'], ['stationName', '中转站'], ['periodStartAt', '统计开始时间'],
    ['periodEndAt', '统计结束时间'], ['previousBalance', '刷新前余额'], ['currentBalance', '刷新后余额'], ['amount', '消耗额度'], ['unit', '币种']],
  tokens: [['id', '记录 ID'], ['stationId', '站点 ID'], ['stationName', '中转站'], ['originalSource', '原始来源'], ['timestamp', '调用时间'], ['model', '模型'],
    ['inputTokens', '普通输入'], ['outputTokens', '普通输出'], ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存创建'],
    ['tokens', 'Token 合计'], ['breakdownEstimated', '旧记录分项估算']],
  corrections: [['id', '记录 ID'], ['stationId', '站点 ID'], ['stationName', '中转站'], ['createdAt', '校正时间'], ['source', '校正来源'],
    ['unit', '币种'], ['previousAmount', '校正前金额'], ['targetAmount', '校正后金额'], ['amount', '额度差额'],
    ['previousTokens', '校正前 Token'], ['targetTokens', '校正后 Token'], ['tokens', 'Token 差额']]
};

function buildHistoryExport(state, url, now = Date.now()) {
  const kind = url.searchParams.get('kind') || 'summary';
  if (kind === 'all') {
    const datasets = Object.fromEntries(Object.keys(definitions).map(type => {
      const query = new URL(url); query.searchParams.set('kind', type);
      return [type, buildHistoryExport(state, query, now)];
    }));
    return { schemaVersion: 1, kind: 'all', exportedAt: new Date(now).toISOString(),
      count: datasets.summary.count, filters: datasets.summary.filters, datasets };
  }
  if (!Object.hasOwn(definitions, kind)) throw new Error('不支持的历史导出类型');
  const range = url.searchParams.get('range') || 'all';
  if (!['all', '24h', '7d', '30d'].includes(range)) throw new Error('不支持的导出时间范围');
  const stationId = url.searchParams.get('stationId') || '';
  if (stationId && !state.stations.some(station => station.id === stationId)) throw new Error('找不到这个中转站，请刷新后重试');
  const from = range === 'all' ? null : now - ({ '24h': 1, '7d': 7, '30d': 30 }[range] * 86400000);
  const inRange = timestamp => from === null || (Date.parse(timestamp) >= from && Date.parse(timestamp) <= now);
  const stations = state.stations.filter(station => !stationId || station.id === stationId);
  const ids = new Set(stations.map(station => station.id));
  const names = new Map(stations.map(station => [station.id, station.name]));
  const quota = (state.quotaConsumptionLogs || []).filter(event => ids.has(event.stationId) && inRange(event.periodEndAt));
  const corrections = (state.historyCorrections || []).filter(event => ids.has(event.stationId) && inRange(event.createdAt));
  const sources = stations.map(station => ({ id: station.id, name: station.name, calls: station.calls || [] }));
  if (!stationId) sources.push({ id: null, name: '未匹配 CLI 来源', calls: state.cliCalls || [] });
  const tokens = sources.flatMap(station => station.calls.filter(call => call.sourceType !== 'manual-adjustment'
    && call.model !== 'GET /models' && inRange(call.timestamp)).map(call => {
    const parts = tokenBreakdown(call);
    return { id: call.id ?? null, stationId: station.id, stationName: station.name, originalSource: call.originalSource || call.source || station.name, timestamp: call.timestamp ?? null,
      model: call.model || '未知模型', inputTokens: parts.input, outputTokens: parts.output,
      cacheReadTokens: parts.cacheRead, cacheWriteTokens: parts.cacheWrite, tokens: parts.total,
      breakdownEstimated: breakdownEstimated(call) };
  }));
  let rows;
  if (kind === 'summary') {
    const groups = new Map(stations.map(station => [station.id, summaryRow(station.id, station.name, station.ghost ? '幽灵（仅记录）' : station.disabled ? '已暂停' : '监控中')]));
    for (const call of tokens) {
      if (!groups.has(call.stationId)) groups.set(call.stationId, summaryRow(null, '未匹配 CLI 来源', '未归属'));
      const row = groups.get(call.stationId);
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) row[key] += call[key];
      row.measuredTokens += call.tokens; row.callCount++;
    }
    for (const event of quota) {
      const row = groups.get(event.stationId), key = `measured${event.unit}`;
      if (Object.hasOwn(row, key)) row[key] = rounded(row[key] + event.amount);
    }
    for (const event of corrections) {
      const row = groups.get(event.stationId), key = `correction${event.unit}`;
      if (Object.hasOwn(row, key)) row[key] = rounded(row[key] + event.amount);
      row.correctionTokens += event.tokens;
    }
    rows = [...groups.values()].map(row => ({ ...row, totalUSD: rounded(row.measuredUSD + row.correctionUSD),
      totalCNY: rounded(row.measuredCNY + row.correctionCNY), totalTokens: row.measuredTokens + row.correctionTokens }));
  } else {
    const dateKey = { quota: 'periodEndAt', tokens: 'timestamp', corrections: 'createdAt' }[kind];
    rows = (kind === 'quota' ? quota : kind === 'tokens' ? tokens : corrections)
      .map(event => ({ ...event, stationName: names.get(event.stationId) || event.stationName }))
      .sort((a, b) => (Date.parse(b[dateKey]) || 0) - (Date.parse(a[dateKey]) || 0) || String(a.id).localeCompare(String(b.id)));
  }
  const columns = definitions[kind].map(([key, label]) => ({ key, label }));
  // Explicit allowlist: never export credentials, account keys, URLs or raw provider payloads.
  rows = rows.map(row => Object.fromEntries(columns.map(({ key }) => [key, row[key] ?? null])));
  return { schemaVersion: 1, exportedAt: new Date(now).toISOString(), kind,
    filters: { stationId: stationId || null, range, from: from === null ? null : new Date(from).toISOString(), to: range === 'all' ? null : new Date(now).toISOString() },
    notes: ['额度消耗为两次成功刷新之间的余额净下降，不是调用估算费用；USD 与 CNY 分开统计。',
      '历史合计 = 所选时间内实测记录 + 同期校正差额；分项只含实测。校正不改写原始记录。',
      '包含已暂停站点；未匹配 CLI 用量单独列示。时间为 ISO 8601，缺失时间保持为空。'],
    columns, count: rows.length, rows };
}

function rounded(value) { return Number(value.toFixed(6)); }
function summaryRow(stationId, stationName, monitoring) {
  return { stationId, stationName, monitoring, measuredUSD: 0, correctionUSD: 0, totalUSD: 0,
    measuredCNY: 0, correctionCNY: 0, totalCNY: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, measuredTokens: 0, correctionTokens: 0, totalTokens: 0, callCount: 0 };
}

module.exports = { buildHistoryExport };
