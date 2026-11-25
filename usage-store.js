const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const accounting = require('./station-accounting');

class UsageStore {
  constructor(dataDir, { normalize, decorate }) {
    const { DatabaseSync } = require('node:sqlite');
    this.decorate = decorate;
    this.normalize = normalize;
    this.dataDir = dataDir;
    this.db = new DatabaseSync(path.join(dataDir, 'usage.db'));
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS logs (
          key TEXT PRIMARY KEY, station_id TEXT, position INTEGER NOT NULL, import_key TEXT UNIQUE,
          timestamp REAL, source TEXT, app TEXT, model TEXT, source_type TEXT, stream INTEGER,
          payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS logs_time ON logs(timestamp DESC, key);
        CREATE INDEX IF NOT EXISTS logs_source_time ON logs(source, timestamp DESC);
        CREATE INDEX IF NOT EXISTS logs_app_time ON logs(app, timestamp DESC);
        CREATE INDEX IF NOT EXISTS logs_station ON logs(station_id);
        CREATE TABLE IF NOT EXISTS imported_keys (key TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS quota_snapshots (
          station_id TEXT PRIMARY KEY, balance REAL NOT NULL, unit TEXT NOT NULL, observed_at REAL NOT NULL, payload TEXT);
        CREATE TABLE IF NOT EXISTS quota_consumption_logs (
          id TEXT PRIMARY KEY, station_id TEXT NOT NULL, station_name TEXT NOT NULL,
          period_start REAL, period_end REAL NOT NULL, previous_balance REAL NOT NULL,
          current_balance REAL NOT NULL, amount REAL NOT NULL CHECK(amount > 0), unit TEXT NOT NULL, payload TEXT);
        CREATE INDEX IF NOT EXISTS quota_logs_station_time ON quota_consumption_logs(station_id, period_end DESC, id);
        CREATE INDEX IF NOT EXISTS quota_logs_time ON quota_consumption_logs(period_end DESC, id);
        CREATE TABLE IF NOT EXISTS history_corrections (
          id TEXT PRIMARY KEY, station_id TEXT NOT NULL, created_at REAL NOT NULL,
          unit TEXT NOT NULL, amount REAL NOT NULL, tokens INTEGER NOT NULL CHECK(typeof(tokens)='integer'), payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS corrections_station_time ON history_corrections(station_id, created_at DESC, id);
        CREATE INDEX IF NOT EXISTS corrections_time ON history_corrections(created_at DESC, id);`);
      for (const table of ['quota_snapshots', 'quota_consumption_logs']) {
        if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'payload')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN payload TEXT`);
      }
      this.db.function('token_buckets', payload => JSON.stringify(accounting.tokenBreakdown(JSON.parse(payload))));
      if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='migration'").get()) {
        const file = path.join(dataDir, 'stations.json');
        const original = fs.readFileSync(file);
        const backup = path.join(dataDir, `stations.pre-sqlite-${Date.now()}.json`);
        fs.writeFileSync(backup, original, { flag: 'wx' });
        const state = normalize(JSON.parse(original.toString('utf8')));
        state.cliImportedKeys ||= [];
        state.quotaSnapshots ||= {};
        state.quotaConsumptionLogs ||= [];
        state.historyCorrections ||= [];
        this.db.exec('DELETE FROM logs; DELETE FROM imported_keys;');
        this.save(state);
        const restored = this.load();
        restored.quotaConsumptionLogs = this.quotaConsumptionLogs();
        if (!isDeepStrictEqual(restored, state)) throw new Error('SQLite 迁移核对失败，原 JSON 备份已保留');
        this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)').run('migration', JSON.stringify({
          backup, createdAt: new Date().toISOString(), sha256: crypto.createHash('sha256').update(original).digest('hex'),
          records: this.db.prepare('SELECT COUNT(*) AS n FROM logs').get().n
        }));
      }
    } catch (error) { this.db.close(); throw error; }
  }

  save(state) {
    const metadata = { ...state, stations: state.stations.map(({ calls, ...station }) => station) };
    delete metadata.cliCalls; delete metadata.cliImportedKeys;
    delete metadata.quotaConsumptionLogs; delete metadata.quotaSnapshots;
    delete metadata.historyCorrections;
    const quotaLogs = state.quotaConsumptionLogs || [];
    const quotaSnapshots = state.quotaSnapshots || this.quotaSnapshots();
    const entries = [];
    const append = (calls, station) => (calls || []).forEach((call, index) => {
      const owner = station?.id || null;
      const key = `${owner || '@cli'}:${call.id || call.importKey || index}`;
      const view = this.decorate(call, station || { id: 'cli', name: call.source || '未匹配 CLI 来源' }, index);
      entries.push({ key, owner, index, call, view });
    });
    for (const station of state.stations) append(station.calls, station);
    append(state.cliCalls, null);
    const existing = new Map(this.db.prepare('SELECT key,payload,position,station_id,source,app,model FROM logs').all().map(row => [row.key, row]));
    const upsert = this.db.prepare(`INSERT INTO logs VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET station_id=excluded.station_id, position=excluded.position,
      import_key=excluded.import_key,timestamp=excluded.timestamp,source=excluded.source,app=excluded.app,
      model=excluded.model,source_type=excluded.source_type,stream=excluded.stream,payload=excluded.payload`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Moving a call changes its owner-prefixed key. Remove stale keys before
      // reinserting, inside the same transaction, to preserve unique import keys.
      const incomingKeys = new Set(entries.map(entry => entry.key));
      const remove = this.db.prepare('DELETE FROM logs WHERE key=?');
      for (const key of existing.keys()) if (!incomingKeys.has(key)) { remove.run(key); existing.delete(key); }
      for (const entry of entries) {
        const { key, owner, index, call, view } = entry;
        const payload = JSON.stringify(call);
        const old = existing.get(key); existing.delete(key);
        if (old?.payload === payload && old.position === index && old.source === view.source && old.app === view.sourceApp && old.model === view.model) continue;
        upsert.run(key, owner, index, call.importKey || null, Number.isFinite(Date.parse(view.timestamp)) ? Date.parse(view.timestamp) : null,
          view.source, view.sourceApp, view.model, view.sourceType, view.stream == null ? null : Number(view.stream), payload);
      }
      for (const key of existing.keys()) remove.run(key);
      const insertKey = this.db.prepare('INSERT OR IGNORE INTO imported_keys VALUES (?)');
      for (const key of state.cliImportedKeys || []) insertKey.run(key);
      const stationIds = new Set(state.stations.map(station => station.id));
      for (const table of ['quota_snapshots', 'quota_consumption_logs', 'history_corrections']) {
        const removeStation = this.db.prepare(`DELETE FROM ${table} WHERE station_id=?`);
        for (const row of this.db.prepare(`SELECT DISTINCT station_id FROM ${table}`).all()) if (!stationIds.has(row.station_id)) removeStation.run(row.station_id);
      }
      const insertQuota = this.db.prepare('INSERT INTO quota_consumption_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');
      for (const event of quotaLogs) insertQuota.run(event.id, event.stationId, event.stationName, event.periodStartAt ? Date.parse(event.periodStartAt) : null,
        Date.parse(event.periodEndAt), event.previousBalance, event.currentBalance, event.amount, event.unit, JSON.stringify(event));
      const insertCorrection = this.db.prepare('INSERT INTO history_corrections VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');
      for (const event of state.historyCorrections || []) {
        if (stationIds.has(event.stationId)) insertCorrection.run(event.id, event.stationId, Date.parse(event.createdAt), event.unit,
          event.amount, event.tokens, JSON.stringify(event));
      }
      const saveSnapshot = this.db.prepare('INSERT INTO quota_snapshots VALUES (?, ?, ?, ?, ?) ON CONFLICT(station_id) DO UPDATE SET balance=excluded.balance,unit=excluded.unit,observed_at=excluded.observed_at,payload=excluded.payload');
      for (const [stationId, snapshot] of Object.entries(quotaSnapshots)) {
        if (snapshot && snapshot.balance != null && snapshot.balance !== '' && Number.isFinite(Number(snapshot.balance)) && snapshot.unit && Number.isFinite(Date.parse(snapshot.observedAt))) {
          saveSnapshot.run(stationId, Number(snapshot.balance), snapshot.unit, Date.parse(snapshot.observedAt), JSON.stringify(snapshot));
        }
      }
      this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)').run('state', JSON.stringify(metadata));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  metadata() { return JSON.parse(this.db.prepare("SELECT value FROM metadata WHERE key='state'").get().value); }
  load() {
    const state = this.metadata();
    const stations = new Map(state.stations.map(station => { station.calls = []; return [station.id, station]; }));
    state.cliCalls = [];
    for (const row of this.db.prepare('SELECT station_id,payload FROM logs ORDER BY position,key').all()) {
      const call = JSON.parse(row.payload);
      if (row.station_id !== null && stations.has(row.station_id)) stations.get(row.station_id).calls.push(call);
      else state.cliCalls.push(call);
    }
    state.cliImportedKeys = this.db.prepare('SELECT key FROM imported_keys ORDER BY rowid').all().map(row => row.key);
    state.quotaSnapshots = this.quotaSnapshots();
    state.quotaConsumptionLogs = [];
    state.historyCorrections = this.db.prepare('SELECT payload FROM history_corrections ORDER BY rowid').all().map(row => JSON.parse(row.payload));
    Object.defineProperty(state, '_quotaTotals', { value: this.quotaTotals(), writable: true });
    Object.defineProperty(state, '_sqlite', { value: true });
    return this.normalize(state);
  }

  quotaSnapshots() {
    return Object.fromEntries(this.db.prepare('SELECT * FROM quota_snapshots').all()
      .map(row => [row.station_id, row.payload ? JSON.parse(row.payload) : { balance: row.balance, unit: row.unit, observedAt: new Date(row.observed_at).toISOString() }]));
  }

  quotaConsumptionLogs() {
    return this.db.prepare('SELECT * FROM quota_consumption_logs ORDER BY rowid').all().map(decodeQuota);
  }

  quotaTotals() {
    const byStation = {};
    for (const row of this.db.prepare('SELECT station_id,unit,SUM(amount) AS amount FROM quota_consumption_logs GROUP BY station_id,unit').all()) {
      byStation[row.station_id] ||= {};
      byStation[row.station_id][row.unit] = Number(row.amount.toFixed(6));
    }
    return { byStation };
  }

  queryQuotaHistory(url) {
    const { where, params } = historyWhere(url, 'period_end');
    const clause = where.join(' AND ');
    const pageSize = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get('pageSize'))) || 100));
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM quota_consumption_logs WHERE ${clause}`).get(...params).n;
    const page = Math.min(Math.max(1, Math.trunc(Number(url.searchParams.get('page')) || 1)), Math.max(1, Math.ceil(count / pageSize)));
    const summary = this.db.prepare(`SELECT unit,SUM(amount) AS amount FROM quota_consumption_logs WHERE ${clause} GROUP BY unit`).all(...params)
      .reduce((groups, row) => { groups[row.unit] = Number(row.amount.toFixed(6)); return groups; }, {});
    const logs = this.db.prepare(`SELECT * FROM quota_consumption_logs WHERE ${clause} ORDER BY period_end DESC,id LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize).map(row => publicHistoryEvent(decodeQuota(row)));
    return { logs, summary: { amountByUnit: summary, count }, pagination: { page, pageSize, total: count, pages: Math.max(1, Math.ceil(count / pageSize)) } };
  }

  queryCorrections(url) {
    const { where, params } = historyWhere(url, 'created_at');
    const clause = where.join(' AND ');
    const pageSize = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get('pageSize'))) || 100));
    const totals = this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(tokens),0) AS tokens FROM history_corrections WHERE ${clause}`).get(...params);
    const pages = Math.max(1, Math.ceil(totals.count / pageSize));
    const page = Math.min(Math.max(1, Math.trunc(Number(url.searchParams.get('page')) || 1)), pages);
    const amountByUnit = this.db.prepare(`SELECT unit,SUM(amount) AS amount FROM history_corrections WHERE ${clause} GROUP BY unit`).all(...params)
      .reduce((groups, row) => { groups[row.unit] = Number(row.amount.toFixed(6)); return groups; }, {});
    const logs = this.db.prepare(`SELECT payload FROM history_corrections WHERE ${clause} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize).map(row => publicHistoryEvent(JSON.parse(row.payload)));
    return { logs, summary: { amountByUnit, tokens: totals.tokens, count: totals.count },
      pagination: { page, pageSize, total: totals.count, pages } };
  }

  queryTokenHistory(url) {
    const { where, params } = historyWhere(url, 'timestamp');
    where.push("COALESCE(source_type,'local-proxy')!='manual-adjustment'", "COALESCE(model,'')!='GET /models'");
    const clause = where.join(' AND ');
    const pageSize = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get('pageSize'))) || 100));
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM logs WHERE ${clause}`).get(...params).n;
    const page = Math.min(Math.max(1, Math.trunc(Number(url.searchParams.get('page')) || 1)), Math.max(1, Math.ceil(count / pageSize)));
    const totals = this.db.prepare(`WITH buckets AS MATERIALIZED (SELECT token_buckets(payload) AS parts FROM logs WHERE ${clause})
      SELECT SUM(json_extract(parts,'$.input')) AS input, SUM(json_extract(parts,'$.output')) AS output,
      SUM(json_extract(parts,'$.cacheRead')) AS cacheRead, SUM(json_extract(parts,'$.cacheWrite')) AS cacheWrite FROM buckets`).get(...params);
    const state = this.metadata(), stations = new Map(state.stations.map(station => [station.id, station]));
    const logs = this.db.prepare(`SELECT station_id AS stationId,position,source,payload FROM logs WHERE ${clause} ORDER BY timestamp DESC,key LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize).map(row => {
        const station = stations.get(row.stationId) || { id: 'cli', name: row.source || '未匹配 CLI 来源' };
        return this.decorate(JSON.parse(row.payload), station, row.position);
      });
    const input = Number(totals.input || 0), output = Number(totals.output || 0);
    const cacheRead = Number(totals.cacheRead || 0), cacheWrite = Number(totals.cacheWrite || 0);
    return { logs, summary: { input, output, cacheRead, cacheWrite, cache: cacheRead + cacheWrite, total: input + output + cacheRead + cacheWrite, count },
      pagination: { page, pageSize, total: count, pages: Math.max(1, Math.ceil(count / pageSize)) } };
  }

  recentActivity() {
    return this.db.prepare(`SELECT station_id AS stationId, MAX(timestamp) AS lastCallAt
      FROM logs WHERE station_id IS NOT NULL AND timestamp IS NOT NULL
      AND source_type != 'manual-adjustment' AND model != 'GET /models'
      GROUP BY station_id`).all();
  }

  query(url, catalog) {
    const state = this.metadata();
    const stations = new Map(state.stations.map(station => [station.id, station]));
    const params = [], where = ["model != 'GET /models'"];
    const add = (sql, value) => { where.push(sql); params.push(value); };
    const range = url.searchParams.get('range') || '24h';
    let from = null;
    if (url.searchParams.has('from')) from = Date.parse(url.searchParams.get('from'));
    else if (range !== 'all') {
      if (range === 'today') { const date = new Date(); date.setHours(0, 0, 0, 0); from = date.getTime(); }
      else from = Date.now() - ({ '7d': 7, '30d': 30 }[range] || 1) * 86400000;
    }
    if (Number.isFinite(from)) add('timestamp>=?', from);
    const to = url.searchParams.has('to') ? Date.parse(url.searchParams.get('to')) : Date.now();
    if (Number.isFinite(to)) add('timestamp<=?', to);
    for (const [field, column] of [['source', 'source'], ['sourceApp', 'app']]) if (url.searchParams.get(field)) add(`${column}=?`, url.searchParams.get(field));
    if (url.searchParams.get('model')) add('instr(lower(model),lower(?))>0', url.searchParams.get('model'));
    const type = url.searchParams.get('type');
    if (type === 'usage') where.push("source_type IN ('codex-cli','claude-cli','deepseek-harness','workbuddy')");
    if (type === 'stream') where.push('stream=1');
    if (type === 'complete') where.push('stream=0');
    const clause = where.join(' AND ');
    const decode = row => this.decorate(JSON.parse(row.payload), stations.get(row.station_id) || { id: 'cli', name: row.source }, row.position, catalog);
    this.db.function('priced_log', (payload, stationId, position, source) => JSON.stringify(decode({ payload, station_id: stationId, position, source })));
    const totals = this.db.prepare(`WITH selected AS (SELECT *,json_extract(token_buckets(payload),'$.total') AS tokens FROM logs WHERE ${clause})
      SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN source_type!='manual-adjustment' THEN 1 ELSE 0 END),0) AS requests,
      COALESCE(SUM(CASE WHEN source_type!='manual-adjustment' THEN tokens ELSE 0 END),0) AS tokens FROM selected`).get(...params);
    const costs = this.db.prepare(`WITH priced AS MATERIALIZED (SELECT priced_log(payload,station_id,position,source) AS value FROM logs
      WHERE ${clause} AND source_type!='manual-adjustment') SELECT json_extract(value,'$.costUnit') AS unit,
      SUM(json_extract(value,'$.cost')) AS amount, SUM(CASE WHEN json_extract(value,'$.cost') IS NULL THEN 1 ELSE 0 END) AS missing
      FROM priced GROUP BY json_extract(value,'$.costUnit')`).all(...params);
    const usageByUnit = {}; let unpricedCount = 0;
    for (const cost of costs) { if (cost.amount != null) usageByUnit[cost.unit || 'USD'] = Number(cost.amount.toFixed(6)); unpricedCount += cost.missing; }
    const all = url.searchParams.get('pageSize') === 'all';
    const pageSize = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get('pageSize'))) || 100));
    const pages = Math.max(1, Math.ceil(totals.count / pageSize));
    const page = Math.min(pages, Math.max(1, Math.trunc(Number(url.searchParams.get('page')) || 1)));
    const rows = this.db.prepare(`SELECT * FROM logs WHERE ${clause} ORDER BY timestamp DESC,key ${all ? '' : 'LIMIT ? OFFSET ?'}`).all(...params, ...(all ? [] : [pageSize, (page - 1) * pageSize]));
    return { logs: rows.map(decode), sources: this.db.prepare("SELECT DISTINCT source FROM logs WHERE model!='GET /models' ORDER BY source").all().map(row => row.source),
      pagination: { page, pageSize: all ? totals.count : pageSize, total: totals.count, pages: all ? 1 : pages },
      summary: { count: totals.count, requestCount: totals.requests, tokenCount: totals.tokens, usageByUnit,
        usage: Object.keys(usageByUnit).length === 1 ? Object.values(usageByUnit)[0] : null, unpricedCount,
        pricing: catalog ? { source: 'models.dev', updatedAt: catalog.updatedAt, error: catalog.error || '' } : null } };
  }
  close() { this.db.close(); }
}

function decodeQuota(row) {
  return row.payload ? JSON.parse(row.payload) : { id: row.id, stationId: row.station_id, stationName: row.station_name,
    periodStartAt: row.period_start == null ? null : new Date(row.period_start).toISOString(), periodEndAt: new Date(row.period_end).toISOString(),
    previousBalance: row.previous_balance, currentBalance: row.current_balance, amount: row.amount, unit: row.unit };
}

function publicHistoryEvent(event) {
  const { accountKey, ...publicEvent } = event;
  return publicEvent;
}

function historyWhere(url, timestampColumn) {
  const where = ['1=1'], params = [];
  const add = (clause, value) => { where.push(clause); params.push(value); };
  const stationId = url.searchParams.get('stationId');
  if (stationId) add('station_id=?', stationId);
  const range = url.searchParams.get('range') || 'all';
  const from = url.searchParams.has('from') ? Date.parse(url.searchParams.get('from'))
    : range === 'today' ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
      : range === '7d' ? Date.now() - 7 * 86400000 : range === '30d' ? Date.now() - 30 * 86400000
        : range === '24h' ? Date.now() - 86400000 : null;
  if (Number.isFinite(from)) add(`${timestampColumn}>=?`, from);
  const to = url.searchParams.has('to') ? Date.parse(url.searchParams.get('to')) : null;
  if (Number.isFinite(to)) add(`${timestampColumn}<=?`, to);
  return { where, params };
}

module.exports = { UsageStore };
