const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { isDeepStrictEqual } = require('node:util');
const readline = require('node:readline');
const initSqlJs = require('sql.js');
const { parse: parseToml } = require('smol-toml');
const { validateUsageScript, evaluateUsageScript, usageTemplate, usageVariables } = require('./usage-query');
const quotaPolicy = require('./public/quota-policy');
const outboundNetwork = require('./outbound-network');
const balanceAlerts = require('./public/balance-alerts');
const { overviewStats } = require('./overview-stats');
const historyCalibration = require('./history-calibration');
const { buildHistoryExport } = require('./history-export');
const sourceAttribution = require('./source-attribution');
const modelPricing = require('./model-pricing');
const stationAccounting = require('./station-accounting');
const { readHarnessUsage } = require('./harness-usage');
const { readWorkBuddyUsage } = require('./workbuddy-usage');
const { createAccountMonitor } = require('./codex-account');
const { isOfficialStation } = require('./public/monitor-channels');

const PORT = Number(process.env.PORT || 4317);
const ROOT = __dirname;
const DEFAULT_DATA_DIR = process.env.TOKEN_WATCH_DATA_DIR
  || (process.env.APPDATA ? path.join(process.env.APPDATA, 'token-usage-monitor-demo') : path.join(ROOT, 'data'));
const WEB_DATA_DIR = process.env.TOKEN_WATCH_WEB_DATA_DIR || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'token-watch-web')
  : path.join(os.homedir(), '.token-watch-web'));
const PUBLIC_DIR = path.join(ROOT, 'public');
let sqlJsPromise;
const stateWriteQueues = new Map();
const usageStores = new Map();
const syncStates = new Map();
const DEFAULT_PRICING = { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 };

function syncStateFor(dataDir) {
  return syncStates.get(path.resolve(dataDir)) || { running: false, total: 0, done: 0, current: '', startedAt: null, finishedAt: null };
}

function setSyncState(dataDir, patch) {
  syncStates.set(path.resolve(dataDir), { ...syncStateFor(dataDir), ...patch });
}

function ensureState(dataDir, empty = false) {
  const dataFile = path.join(dataDir, 'stations.json');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    if (empty) {
      fs.writeFileSync(dataFile, JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [] }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      return dataFile;
    }
    const seedFile = path.join(ROOT, 'data', 'stations.json');
    if (!fs.existsSync(seedFile)) throw new Error(`Missing state file: ${dataFile}`);
    fs.copyFileSync(seedFile, dataFile);
  }
  return dataFile;
}

function readState(dataDir = DEFAULT_DATA_DIR) {
  if (usageStores.has(path.resolve(dataDir))) return usageStores.get(path.resolve(dataDir)).load();
  return normalizeState(JSON.parse(fs.readFileSync(ensureState(dataDir), 'utf8')));
}

function writeState(state, dataDir = DEFAULT_DATA_DIR) {
  if (usageStores.has(path.resolve(dataDir))) return usageStores.get(path.resolve(dataDir)).save(state);
  const dataFile = ensureState(dataDir);
  const tempFile = `${dataFile}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tempFile, dataFile);
}

function enqueueStateWrite(dataDir, mutation) {
  const key = path.resolve(dataDir);
  const previous = stateWriteQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const state = readState(dataDir);
    const result = await mutation(state);
    writeState(state, dataDir);
    return result;
  });
  stateWriteQueues.set(key, next);
  return next;
}

function normalizeState(state) {
  const normalized = state && typeof state === 'object' ? state : {};
  normalized.settings = normalized.settings && typeof normalized.settings === 'object'
    ? normalized.settings : {};
  normalized.settings.refreshMinutes = [5, 10, 60].includes(Number(normalized.settings.refreshMinutes))
    ? Number(normalized.settings.refreshMinutes) : 5;
  normalized.settings.balanceAlerts = balanceAlerts.normalize(normalized.settings.balanceAlerts);
  normalized.stations = Array.isArray(normalized.stations) ? normalized.stations : [];
  normalized.stations = normalized.stations.map((station) => normalizeStationState(station));
  normalized.quotaConsumptionLogs = Array.isArray(normalized.quotaConsumptionLogs) ? normalized.quotaConsumptionLogs : [];
  normalized.quotaSnapshots = normalized.quotaSnapshots && typeof normalized.quotaSnapshots === 'object' ? normalized.quotaSnapshots : {};
  normalized.cliCalls = Array.isArray(normalized.cliCalls) ? normalized.cliCalls : [];
  normalized.cliFileCache = normalized.cliFileCache && typeof normalized.cliFileCache === 'object'
    ? normalized.cliFileCache : {};
  historyCalibration.migrateLedger(normalized);
  return normalized;
}

function normalizeStationState(station) {
  const normalized = station && typeof station === 'object' ? station : {};
  normalized.calls = Array.isArray(normalized.calls) ? normalized.calls : [];
  normalized.models = Array.isArray(normalized.models) ? normalized.models : [];
  normalized.disabled = normalized.disabled === true;
  if (normalized.ghost === true) normalized.disabled = true;
  normalized.pricing = normalizePricing(normalized.pricing);
  normalized.quotaPolicy = quotaPolicy.normalize(normalized.quotaPolicy);
  historyCalibration.migrate(normalized);
  if (!normalized.modelStatus) {
    normalized.modelStatus = normalized.status === 'online' ? 'online'
      : normalized.status === 'error' ? 'error' : normalized.apiKey ? 'unknown' : 'missing';
  }
  if (!normalized.usageStatus) {
    normalized.usageStatus = normalized.spendSource === 'remote' && Number.isFinite(Number(normalized.balance))
      ? 'online' : normalized.apiKey ? 'unknown' : 'missing';
  }
  if (normalized.spendSource !== 'remote' && normalized.usageStatus !== 'online'
    && (!normalized.apiKey || normalized.metricsSource === '等待真实统计接口')) {
    normalized.balance = null;
    normalized.balanceLimit = null;
  }
  return normalized;
}

function ccSwitchDbPaths(override) {
  if (override) return [override];
  const home = process.env.USERPROFILE || os.homedir();
  return [
    process.env.CC_SWITCH_DB_PATH,
    path.join(home, '.cc-switch', 'cc-switch.db'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'com.ccswitch.desktop', 'cc-switch.db'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'com.ccswitch.desktop', 'cc-switch.db')
  ].filter(Boolean);
}

function cliPaths(overrides = {}) {
  const home = process.env.USERPROFILE || os.homedir();
  return {
    codexSessions: overrides.codexSessions || path.join(home, '.codex', 'sessions'),
    codexConfig: overrides.codexConfig || path.join(home, '.codex', 'config.toml'),
    claudeProjects: overrides.claudeProjects || path.join(home, '.claude', 'projects'),
    workBuddyProjects: overrides.workBuddyProjects || path.join(home, '.workbuddy', 'projects'),
    harnessSessions: overrides.harnessSessions || path.join(process.env.DSH_HOME || path.join(home, '.dsh'), 'sessions')
  };
}

async function getSqlJs() {
  sqlJsPromise ||= initSqlJs({ locateFile: (file) => path.join(ROOT, 'node_modules', 'sql.js', 'dist', file) });
  return sqlJsPromise;
}

function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseCodexSettings(settings) {
  const auth = settings.auth && typeof settings.auth === 'object' ? settings.auth : {};
  let config = {};
  try { config = parseToml(textValue(settings.config)); } catch { config = {}; }
  const providerId = textValue(config.model_provider) || 'custom';
  const provider = config.model_providers?.[providerId] || config.model_providers?.custom || {};
  return {
    baseUrl: textValue(provider.base_url),
    apiKey: textValue(provider.experimental_bearer_token) || textValue(auth.OPENAI_API_KEY || auth.api_key)
  };
}

function extractCcSwitchCandidate(row) {
  const settings = parseJsonObject(row.settings_config);
  const meta = parseJsonObject(row.meta);
  const usage = meta.usage_script && typeof meta.usage_script === 'object' ? meta.usage_script : {};
  let baseUrl = '';
  let apiKey = '';
  const appType = textValue(row.app_type).toLowerCase();

  if (appType === 'codex') {
    ({ baseUrl, apiKey } = parseCodexSettings(settings));
  } else if (appType === 'openclaw') {
    baseUrl = textValue(settings.baseUrl || settings.base_url);
    apiKey = textValue(settings.apiKey || settings.api_key);
  } else if (appType === 'opencode') {
    const options = settings.options && typeof settings.options === 'object' ? settings.options : {};
    baseUrl = textValue(options.baseURL || options.baseUrl || settings.baseURL || settings.baseUrl);
    apiKey = textValue(options.apiKey || settings.apiKey);
  } else if (appType === 'pi') {
    baseUrl = textValue(settings.baseUrl || settings.baseURL || settings.base_url);
    apiKey = textValue(settings.apiKey || settings.api_key);
  } else {
    return null;
  }

  if (!baseUrl || !apiKey) return null;
  try { normalizeUrl(baseUrl); } catch { return null; }
  const usageTemplate = textValue(usage.templateType).toLowerCase();
  const usageAccessToken = textValue(usage.accessToken);
  const usageUserId = textValue(usage.userId);
  const usageBaseUrl = textValue(usage.baseUrl);
  const usageCode = textValue(usage.code);
  let statsUrl = '';
  if (usageCode.toLowerCase().includes('/api/public/usage/stats')) {
    const statsOrigin = new URL(usageBaseUrl || baseUrl).origin;
    statsUrl = `${statsOrigin}/api/public/usage/stats`;
  } else if (usageTemplate === 'newapi' && (usageAccessToken || usageUserId)) {
    statsUrl = `${new URL(usageBaseUrl || baseUrl).origin}/api/user/self`;
  }
  return {
    id: `${appType}:${textValue(row.id)}`,
    sourceId: textValue(row.id),
    sourceApp: appType,
    name: textValue(row.name) || 'CC Switch 供应商',
    baseUrl,
    apiKey,
    statsUrl,
    statsToken: usageAccessToken,
    statsUserId: usageUserId,
    usageScript: usage.enabled && usageCode ? usageCode : '',
    usageScriptEnabled: Boolean(usage.enabled && usageCode),
    usageConfigured: Boolean(usage.enabled && (usageAccessToken || usageTemplate || usage.request))
  };
}

async function readCcSwitchCandidates(dbPathOverride) {
  const dbPath = ccSwitchDbPaths(dbPathOverride).find((candidate) => fs.existsSync(candidate));
  if (!dbPath) throw new Error('未找到 CC Switch 数据库（~/.cc-switch/cc-switch.db）');
  const SQL = await getSqlJs();
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
  try {
    const result = db.exec('SELECT id, app_type, name, settings_config, meta FROM providers ORDER BY app_type, sort_index, name');
    const rows = result[0]?.values || [];
    const unique = new Map();
    for (const [id, appType, name, settingsConfig, meta] of rows) {
      const candidate = extractCcSwitchCandidate({ id, app_type: appType, name, settings_config: settingsConfig, meta });
      if (!candidate) continue;
      const key = `${candidate.baseUrl}\n${candidate.apiKey}`;
      if (!unique.has(key)) unique.set(key, candidate);
    }
    return { dbPath, candidates: [...unique.values()] };
  } finally {
    db.close();
  }
}

function publicImportCandidate(candidate) {
  const { apiKey, statsToken, usageScript, ...safe } = candidate;
  return { ...safe, hasApiKey: Boolean(apiKey), hasStatsToken: Boolean(statsToken), hasStatsUserId: Boolean(candidate.statsUserId) };
}

function normalizePricing(value = {}) {
  const pricing = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(Object.entries(DEFAULT_PRICING).map(([key, fallback]) => {
    const number = Number(pricing[key]);
    return [key, Number.isFinite(number) && number >= 0 ? number : fallback];
  }));
}

function stationDefaults(id, candidate) {
  return {
    id,
    status: 'pending', checkedAt: null, modelCount: 0, models: [], tokenName: candidate.name,
    balance: null, balanceLimit: null, balanceUnit: inferredBalanceUnit(candidate), balanceUnitCustomized: false,
    todaySpendUnit: inferredBalanceUnit(candidate), totalSpendUnit: inferredBalanceUnit(candidate), pricing: normalizePricing(),
    tokens: 0, todaySpend: 0, todaySpendAvailable: true, totalSpend: 0, quotaConsumed: null, spendSource: 'local-proxy',
    balanceKnown: false, balanceUpdatedAt: null, modelStatus: 'missing', usageStatus: 'missing', usageCheckedAt: null,
    usageLastSuccessAt: null, usageError: '', metricsSource: '等待真实统计接口', lastError: '', trend: [], calls: []
  };
}

function normalizeUrl(value, { optional = false } = {}) {
  const input = String(value || '').trim();
  if (!input && optional) return '';
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http 或 https 地址');
  return input.replace(/\/+$/, '');
}

function nowIso() {
  return new Date().toISOString();
}

function inferredBalanceUnit(station) {
  try {
    const hostname = new URL(station.baseUrl).hostname.toLowerCase();
    if (hostname.includes('micuapi.ai')) return 'CNY';
    if (hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com')) return 'CNY';
  } catch {}
  return 'USD';
}

function effectiveBalanceUnit(station) {
  const unit = station.balanceUnitCustomized ? station.balanceUnit : (station.balanceUnit || inferredBalanceUnit(station));
  return ['CNY', 'USD'].includes(String(unit).toUpperCase()) ? String(unit).toUpperCase() : inferredBalanceUnit(station);
}

function modelStatusOf(station) {
  return station.modelStatus || (station.status === 'online' ? 'online' : station.status === 'error' ? 'error' : station.apiKey ? 'unknown' : 'missing');
}

function usageStatusOf(station) {
  return station.usageStatus || (station.spendSource === 'remote' && Number.isFinite(Number(station.balance))
    ? 'online' : station.apiKey ? 'unknown' : 'missing');
}

function stationTrend(station, now = Date.now()) {
  const bucketSize = 60 * 60 * 1000;
  const values = Array(12).fill(0);
  for (const call of station.calls || []) {
    const timestamp = Date.parse(call.timestamp || '');
    const age = now - timestamp;
    if (!Number.isFinite(timestamp) || age < 0 || age >= values.length * bucketSize) continue;
    const index = values.length - 1 - Math.floor(age / bucketSize);
    values[index] += stationAccounting.tokenBreakdown(call).total;
  }
  return values.map((value) => Number(value.toFixed(6)));
}

function publicStatsUrl(value) {
  try {
    const url = new URL(value);
    for (const key of ['key', 'apiKey', 'token', 'access_token', 'authorization']) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return '';
  }
}

function measuredQuotaByStation(state) {
  if (state._quotaTotals?.byStation) {
    const stationIds = new Set(state.stations.map(station => station.id));
    return Object.fromEntries(Object.entries(state._quotaTotals.byStation).filter(([stationId]) => stationIds.has(stationId)));
  }
  return (state.quotaConsumptionLogs || []).reduce((groups, event) => {
    if (!state.stations.some(station => station.id === event.stationId)) return groups;
    groups[event.stationId] ||= {};
    groups[event.stationId][event.unit] = Number(((groups[event.stationId][event.unit] || 0) + Number(event.amount || 0)).toFixed(6));
    return groups;
  }, {});
}

function quotaHistoryByStation(state) {
  const groups = structuredClone(measuredQuotaByStation(state));
  for (const station of state.stations) {
    const correction = historyCalibration.ledgerSummary(state, station);
    for (const [unit, amount] of Object.entries(correction.amountByUnit)) {
      groups[station.id] ||= {};
      groups[station.id][unit] = Number(((groups[station.id][unit] || 0) + amount).toFixed(6));
    }
  }
  return groups;
}

function stationTokenTotals(state, station) {
  return stationAccounting.logBreakdown(station);
}

function quotaAmountTotal(groups = {}) {
  const values = Object.values(groups);
  return values.length === 0 ? 0 : values.length === 1 ? values[0] : null;
}

function quotaAccountKey(station) {
  const policy = quotaPolicy.normalize(station.quotaPolicy);
  return crypto.createHash('sha256').update(JSON.stringify([
    String(station.baseUrl || ''), String(station.apiKey || ''), String(station.statsUrl || ''), String(station.statsToken || ''), String(station.statsUserId || ''),
    Boolean(station.usageScriptEnabled), station.usageScriptEnabled ? String(station.usageScript || '') : '',
    station.balanceUnitCustomized ? effectiveBalanceUnit(station) : '', policy.source, policy.mode, policy.limit
  ])).digest('hex');
}

function quotaObservation(station) {
  const quota = quotaPolicy.present({ ...station, balanceUnit: effectiveBalanceUnit(station) });
  const observedAt = station.balanceUpdatedAt || station.usageLastSuccessAt;
  if (station.spendSource !== 'remote' || quota.remaining === null || !Number.isFinite(Date.parse(observedAt || ''))) return null;
  return { balance: quota.remaining, unit: quota.unit, source: quota.source, accountKey: quotaAccountKey(station), observedAt };
}

function recordQuotaSnapshot(state, station) {
  if (station.usageStatus !== 'online') return;
  const current = quotaObservation(station);
  if (!current) return;
  state.quotaSnapshots ||= {};
  state.quotaConsumptionLogs ||= [];
  let previous = station.historyBaselineInvalidated ? null : state.quotaSnapshots[station.id];
  if (previous && previous.unit === current.unit && previous.source === current.source && previous.accountKey === current.accountKey
    && Date.parse(current.observedAt) >= Date.parse(previous.observedAt)) {
    const amount = Number((Number(previous.balance) - current.balance).toFixed(6));
    if (amount > 0) {
      state.quotaConsumptionLogs.push({ id: crypto.randomUUID(), stationId: station.id, stationName: station.name,
        periodStartAt: previous.observedAt, periodEndAt: current.observedAt, previousBalance: Number(previous.balance),
        currentBalance: current.balance, amount, unit: current.unit, source: current.source });
      if (state._quotaTotals?.byStation) {
        const totals = state._quotaTotals.byStation;
        totals[station.id] ||= {};
        totals[station.id][current.unit] = Number(((totals[station.id][current.unit] || 0) + amount).toFixed(6));
      }
    }
  }
  state.quotaSnapshots[station.id] = current;
  station.historyBaselineInvalidated = false;
}

function sanitizeStation(station, state) {
  const { apiKey, statsToken, remoteTokens, ...safe } = station;
  const balance = Number(station.balance);
  const balanceLimit = Number(station.balanceLimit);
  const balanceKnown = station.balanceKnown ?? (station.spendSource === 'remote' && Number.isFinite(balance));
  const hasTrustedTotal = balanceKnown && station.spendSource === 'remote'
    && station.balance !== null && station.balance !== undefined && station.balance !== ''
    && station.balanceLimit !== null && station.balanceLimit !== undefined && station.balanceLimit !== ''
    && Number.isFinite(balance)
    && Number.isFinite(balanceLimit);
  const quotaConsumed = hasTrustedTotal
    ? Number(Math.max(balanceLimit - balance, 0).toFixed(6))
    : null;
  const historyQuotaByUnit = quotaHistoryByStation(state)[station.id] || {};
  const tokenBreakdown = stationTokenTotals(state, station);
  const historyAdjustment = historyCalibration.ledgerSummary(state, station);
  return {
    ...safe,
    totalSpend: quotaAmountTotal(historyQuotaByUnit),
    historyQuotaByUnit,
    tokenBreakdown,
    tokens: tokenBreakdown.total + historyAdjustment.tokens,
    historyAdjustment,
    reportedTotalSpend: stationAccounting.remoteAmount(station),
    reportedTotalTokens: stationAccounting.remoteTokens(station),
    tokenStatsSource: historyAdjustment.tokens ? '调用日志累计 + 历史校正' : '调用日志累计',
    spendStatsSource: Object.values(historyAdjustment.amountByUnit).some(Boolean) ? '刷新额度差累计 + 历史校正' : '刷新额度差累计',
    balance: balanceKnown ? station.balance : null,
    balanceLimit: balanceKnown && Number.isFinite(balanceLimit) ? station.balanceLimit : null,
    quotaConsumed,
    statsUrl: publicStatsUrl(station.statsUrl),
    balanceUnit: effectiveBalanceUnit(station),
    todaySpendUnit: effectiveBalanceUnit(station),
    totalSpendUnit: effectiveBalanceUnit(station),
    trend: stationTrend(station),
    balanceKnown,
    modelStatus: modelStatusOf(station),
    usageStatus: usageStatusOf(station),
    hasApiKey: Boolean(apiKey),
    hasStatsToken: Boolean(statsToken),
    hasStatsUserId: Boolean(station.statsUserId),
    disabled: station.disabled === true,
    callCount: Array.isArray(station.calls) ? station.calls.length : 0
  };
}

function aggregate(state) {
  const quotaByStation = quotaHistoryByStation(state);
  const stations = state.stations.map(station => ({ ...station, tokenBreakdown: stationTokenTotals(state, station) }));
  const unmatchedForOverview = (state.cliCalls || []).filter(call => call.sourceType !== 'workbuddy');
  const unmatchedTokens = stationAccounting.logBreakdown({ calls: unmatchedForOverview });
  const trend = Array(12).fill(0);
  const addTrend = (calls, now) => stationTrend({ calls }, now).forEach((value, index) => { trend[index] += value; });
  const trendNow = Date.now();
  stations.forEach((station) => addTrend(station.calls || [], trendNow));
  addTrend(unmatchedForOverview, trendNow);
  const consumedFor = (station) => {
    if (station.spendSource !== 'remote') return null;
    if (station.balance === null || station.balance === undefined || station.balance === ''
      || station.balanceLimit === null || station.balanceLimit === undefined || station.balanceLimit === '') return null;
    const balance = Number(station.balance), limit = Number(station.balanceLimit);
    return Number.isFinite(balance) && Number.isFinite(limit) ? Number(Math.max(limit - balance, 0).toFixed(6)) : null;
  };
  const sumKnown = (field, predicate = () => true) => {
    let total = 0;
    let found = false;
    for (const station of stations) {
      if (!predicate(station) || station[field] === null || station[field] === undefined || station[field] === '') continue;
      const value = Number(station[field]);
      if (!Number.isFinite(value)) continue;
      total += value;
      found = true;
    }
    return found ? Number(total.toFixed(6)) : null;
  };
  const totalSpendByUnit = Object.values(quotaByStation).reduce((groups, values) => {
    for (const [unit, amount] of Object.entries(values)) groups[unit] = Number(((groups[unit] || 0) + amount).toFixed(6));
    return groups;
  }, {});
  for (const station of stations) totalSpendByUnit[effectiveBalanceUnit(station)] ??= 0;
  const quotaConsumedByUnit = stations.reduce((groups, station) => {
    const value = consumedFor(station);
    if (value === null) return groups;
    const unit = effectiveBalanceUnit(station);
    groups[unit] = Number(((groups[unit] || 0) + value).toFixed(6));
    return groups;
  }, {});
  const quotaValues = Object.values(quotaConsumedByUnit);
  const quotaConsumed = quotaValues.length === 1 ? quotaValues[0] : null;
  const groupMoney = (field) => stations.reduce((groups, station) => {
    if (station[field] === null || station[field] === undefined) return groups;
    const value = Number(station[field]);
    if (!Number.isFinite(value)) return groups;
    const unit = effectiveBalanceUnit(station);
    groups[unit] = Number(((groups[unit] || 0) + value).toFixed(6));
    return groups;
  }, {});
  const tokenBreakdown = stations.reduce((total, station) => {
    const tokens = station.tokenBreakdown;
    total.input += tokens.input; total.output += tokens.output;
    total.cacheRead += tokens.cacheRead; total.cacheWrite += tokens.cacheWrite;
    total.cache += tokens.cache; total.total += tokens.total;
    return total;
  }, { ...unmatchedTokens });
  const historyAdjustment = { tokens: stations.reduce((sum, station) => sum + historyCalibration.ledgerSummary(state, station).tokens, 0) };
  return {
    stationCount: stations.length,
    onlineCount: stations.filter((station) => modelStatusOf(station) === 'online' || station.status === 'online').length,
    usageOnlineCount: stations.filter((station) => usageStatusOf(station) === 'online').length,
    usageErrorCount: stations.filter((station) => usageStatusOf(station) === 'error').length,
    totalBalance: sumKnown('balance', (station) => station.balanceKnown ?? (station.spendSource === 'remote' && Number.isFinite(Number(station.balance)))),
    totalBalanceByUnit: groupMoney('balance', 'balanceUnit'),
    totalTokens: tokenBreakdown.total + historyAdjustment.tokens,
    historyAdjustment,
    tokenBreakdown,
    quotaConsumed,
    quotaConsumedByUnit,
    todaySpend: sumKnown('todaySpend'),
    todaySpendByUnit: groupMoney('todaySpend', 'todaySpendUnit'),
    totalSpend: quotaAmountTotal(totalSpendByUnit),
    totalSpendByUnit,
    modelCount: stations.reduce((sum, station) => sum + Number(station.modelCount || 0), 0),
    lastSync: stations.map((station) => station.checkedAt).filter(Boolean).sort().at(-1) || null,
    trend: trend.map((value) => Number(value.toFixed(6)))
  };
}

function publicState(state) {
  return {
    settings: state.settings,
    stations: state.stations.map(station => {
      const safe = sanitizeStation(station, state);
      if (state._sqlite) delete safe.calls;
      return safe;
    }),
    aggregate: aggregate(state),
    sourceAttribution: sourceAttribution.attributionStatus(state),
    cliSync: state.cliSync || null
  };
}

function decorateCall(call, station, index, catalog) {
  const buckets = stationAccounting.tokenBreakdown(call);
  const tokens = call.sourceType === 'manual-adjustment' ? Number(call.tokens || 0) : buckets.total;
  const inputTokens = buckets.input;
  const outputTokens = buckets.output;
  const duration = Number(call.duration ?? (3.2 + index * 1.7));
  const isCliUsage = ['codex-cli', 'claude-cli', 'deepseek-harness', 'workbuddy'].includes(call.sourceType);
  const sourceApp = call.sourceApp || (call.sourceType === 'codex-cli' ? 'Codex'
    : call.sourceType === 'claude-cli' ? 'Claude Code' : call.sourceType === 'deepseek-harness' ? 'DeepSeek Harness' : '本地代理');
  const decorated = {
    id: call.id || `${station.id}-${index}`,
    stationId: station.id === 'cli' ? null : station.id,
    source: call.source || station.name,
    originalSource: call.originalSource || call.source || station.name,
    token: call.token || station.tokenName || '本地代理',
    timestamp: call.timestamp || new Date(Date.now() - index * 7 * 60000).toISOString(),
    model: call.model === 'Codex CLI' && isCliUsage ? (station.cliModel || '未知模型') : (call.model || '未知模型'),
    stream: call.stream === undefined ? true : call.stream,
    tps: call.tps === null ? null : Number(call.tps ?? (outputTokens / Math.max(duration, 1)).toFixed(1)),
    tokens,
    breakdownEstimated: stationAccounting.breakdownEstimated(call),
    inputTokens,
    outputTokens,
    cacheReadTokens: buckets.cacheRead,
    cacheWriteTokens: buckets.cacheWrite,
    cacheHitRate: Number(call.cacheHitRate ?? 0),
    reasoning: call.reasoning || '未设置',
    cost: Number(call.cost ?? 0),
    costUnit: call.costUnit || effectiveBalanceUnit(station),
    costSource: call.costSource || 'estimated',
    multiplier: Number(call.multiplier ?? 1),
    ttft: call.ttft === null ? null : Number(call.ttft ?? 0),
    duration: call.duration === null ? null : duration,
    statusCode: call.statusCode === null ? null : Number(call.statusCode ?? 200),
    result: call.result || '成功',
    detail: call.detail || '本地代理 · 实时记录',
    dataSource: call.dataSource || (isCliUsage ? 'CLI usage' : '本地代理'),
    sourceType: call.sourceType || 'local-proxy',
    sourceApp,
    time: call.time || '刚刚'
  };
  return catalog ? modelPricing.priceCall(decorated, station, catalog) : decorated;
}

function allLogs(state, catalog) {
  const stationLogs = state.stations
    .flatMap((station) => (station.calls || [])
      .filter((call) => call.model !== 'GET /models')
      .map((call, index) => decorateCall(call, { ...station, balanceUnit: effectiveBalanceUnit(station) }, index, catalog)))
  const unmatchedLogs = (state.cliCalls || []).map((call, index) => decorateCall(call, { id: 'cli', name: call.source || '未匹配 CLI 来源' }, index, catalog));
  return [...stationLogs, ...unmatchedLogs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function recentStationActivity(state) {
  return (state.stations || []).flatMap((station) => {
    const timestamps = (station.calls || [])
      .filter((call) => call.sourceType !== 'manual-adjustment' && call.model !== 'GET /models')
      .map((call) => Date.parse(call.timestamp || ''))
      .filter(Number.isFinite);
    return timestamps.length ? [{ stationId: station.id, lastCallAt: timestamps.reduce((latest, time) => Math.max(latest, time), 0) }] : [];
  });
}

function logRangeStart(range, now = new Date()) {
  const date = new Date(now);
  if (range === 'today') return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (range === '7d') return new Date(date.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (range === '30d') return new Date(date.getTime() - 30 * 24 * 60 * 60 * 1000);
  return new Date(date.getTime() - 24 * 60 * 60 * 1000);
}

function publicLogs(state, url, catalog) {
  let logs = allLogs(state, catalog);
  const sources = [...new Set(logs.map(log => log.source))].sort();
  const requestedRange = url.searchParams.get('range') || '24h';
  const range = ['all', '24h', 'today', '7d', '30d'].includes(requestedRange) ? requestedRange : '24h';
  const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')) : range === 'all' ? null : logRangeStart(range);
  const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')) : new Date();
  if (from && !Number.isNaN(from.getTime())) logs = logs.filter((log) => new Date(log.timestamp) >= from);
  if (!Number.isNaN(to.getTime())) logs = logs.filter((log) => new Date(log.timestamp) <= to);
  const model = url.searchParams.get('model');
  const source = url.searchParams.get('source');
  const sourceApp = url.searchParams.get('sourceApp');
  if (model) logs = logs.filter((log) => log.model.toLowerCase().includes(model.toLowerCase()));
  if (source) logs = logs.filter((log) => log.source === source);
  if (sourceApp) logs = logs.filter((log) => log.sourceApp === sourceApp);
  const type = url.searchParams.get('type');
  if (type === 'usage') logs = logs.filter(log => ['codex-cli', 'claude-cli', 'deepseek-harness', 'workbuddy'].includes(log.sourceType));
  if (type === 'stream') logs = logs.filter(log => log.stream === true);
  if (type === 'complete') logs = logs.filter(log => log.stream === false);
  const measuredLogs = logs.filter(log => log.sourceType !== 'manual-adjustment');
  const usageByUnit = measuredLogs.reduce((groups, log) => {
    if (log.cost == null) return groups;
    const unit = log.costUnit || 'USD';
    groups[unit] = Number(((groups[unit] || 0) + Number(log.cost || 0)).toFixed(6));
    return groups;
  }, {});
  return {
    logs,
    sources,
    summary: {
      usage: Object.keys(usageByUnit).length === 1 ? Object.values(usageByUnit)[0] : null,
      usageByUnit,
      requestCount: logs.filter(log => log.sourceType !== 'manual-adjustment').length,
      tokenCount: measuredLogs.reduce((sum, log) => sum + log.tokens, 0),
      unpricedCount: measuredLogs.filter(log => log.cost == null).length,
      pricing: catalog ? { source: 'models.dev', updatedAt: catalog.updatedAt, error: catalog.error || '' } : null,
      count: logs.length
    }
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求 JSON 格式无效');
  }
}

function stationFromInput(input, existing = {}) {
  const name = String(input.name ?? existing.name ?? '').trim();
  if (!name) throw new Error('站点名称不能为空');
  const ghost = input.ghost === undefined ? existing.ghost === true : input.ghost === true;
  if (ghost && input.disabled === false) throw new Error('幽灵中转不监控，请先补充 URL 并转为普通中转');
  const baseUrl = normalizeUrl(input.baseUrl ?? existing.baseUrl, { optional: ghost });
  const statsUrl = normalizeUrl(input.statsUrl ?? existing.statsUrl, { optional: true });
  const hasBalanceUnit = input.balanceUnit !== undefined;
  const balanceUnit = String(input.balanceUnit ?? existing.balanceUnit ?? inferredBalanceUnit({ baseUrl })).toUpperCase();
  if (!['CNY', 'USD'].includes(balanceUnit)) throw new Error('额度单位只支持 CNY 或 USD');
  const pricingInput = input.pricing === undefined ? existing.pricing : input.pricing;
  const pricing = normalizePricing(pricingInput);
  if (input.quotaPolicy !== undefined && (!input.quotaPolicy || typeof input.quotaPolicy !== 'object' || Array.isArray(input.quotaPolicy))) {
    throw new Error('额度设置必须为对象');
  }
  const policy = quotaPolicy.normalize(input.quotaPolicy === undefined ? existing.quotaPolicy
    : { ...existing.quotaPolicy, ...input.quotaPolicy });
  const usageScriptEnabled = input.usageScriptEnabled === undefined ? Boolean(existing.usageScriptEnabled) : input.usageScriptEnabled === true;
  const usageScript = input.usageScript === undefined ? (existing.usageScript || '') : String(input.usageScript);
  if (usageScript.length > 65536) throw new Error('用量查询代码不能超过 64 KB');
  if (usageScriptEnabled) validateUsageScript(usageScript);
  if (input.pricing !== undefined) {
    for (const key of Object.keys(DEFAULT_PRICING)) {
      const value = Number(input.pricing?.[key]);
      if (!Number.isFinite(value) || value < 0) throw new Error('计价参数必须是大于等于 0 的数字');
    }
  }
  return {
    ...existing,
    name,
    ghost,
    tokenName: String(input.tokenName ?? existing.tokenName ?? '').trim(),
    baseUrl,
    statsUrl,
    usageScriptEnabled,
    usageScript,
    apiKey: input.apiKey === undefined ? (existing.apiKey || '') : String(input.apiKey).trim(),
    statsToken: input.statsToken === undefined ? (existing.statsToken || '') : String(input.statsToken).trim(),
    statsUserId: input.statsUserId === undefined ? (existing.statsUserId || '') : String(input.statsUserId).trim(),
    balanceUnit,
    quotaPolicy: policy,
    pricing,
    balanceUnitCustomized: hasBalanceUnit ? true : Boolean(existing.balanceUnitCustomized),
    disabled: ghost || (input.disabled === undefined ? (existing.ghost && !ghost ? false : Boolean(existing.disabled)) : input.disabled === true)
  };
}

async function fetchJson(url, apiKey, extraHeaders = {}, requestOptions = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const dispatcher = await outboundNetwork.dispatcher(url);
    const response = await outboundNetwork.fetch(url, {
      ...(dispatcher ? { dispatcher } : {}),
      method: requestOptions.method || 'GET',
      body: requestOptions.body,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'user-agent': 'token-watch/0.1',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...extraHeaders
      },
      signal: controller.signal
    });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        controller.abort();
        throw new Error('统计接口响应超过 2 MB');
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(detail);
    }
    return payload;
  } catch (error) {
    // Retain only the hostname for diagnostics; usage URLs may contain API keys.
    error.requestHost = new URL(url).hostname;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseModels(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return list.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean);
}

function amountFromQuota(value, quotaPerUnit) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Number((number / quotaPerUnit).toFixed(6)) : null;
}

function formatChinaTime(timestamp) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const date = new Date((seconds + 8 * 60 * 60) * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function applyAheStats(station, payload) {
  if (!payload?.code || !payload.data || typeof payload.data !== 'object') return 0;
  const data = payload.data;
  const quotaPerUnit = Number(data.quota_per_unit) || 500000;
  const walletRemaining = amountFromQuota(data.user_total_available, quotaPerUnit);
  const walletUsed = amountFromQuota(data.user_total_used, quotaPerUnit);
  const walletTotal = amountFromQuota(data.user_total_granted, quotaPerUnit);
  const plans = [];

  if (walletRemaining !== null || walletUsed !== null || walletTotal !== null) {
    plans.push({
      planName: '钱包',
      isValid: Boolean(data.unlimited_quota || walletRemaining === null || walletRemaining > 0),
      remaining: walletRemaining,
      used: walletUsed,
      total: walletTotal,
      unit: 'USD'
    });
  }

  for (const item of Array.isArray(data.subscriptions) ? data.subscriptions : []) {
    const subscription = item?.subscription;
    if (!subscription) continue;
    const total = amountFromQuota(subscription.amount_total, quotaPerUnit);
    const used = amountFromQuota(subscription.amount_used, quotaPerUnit);
    const remaining = total === null || used === null ? null : Math.max(total - used, 0);
    const extra = [];
    if (remaining !== null && remaining <= 0) extra.push('当日用完');
    const nextReset = formatChinaTime(subscription.next_reset_time);
    if (nextReset) extra.push(`下次重置: ${nextReset}`);
    plans.push({ planName: item?.plan?.title || 'HeyRoute Package', isValid: true, remaining, used, total, unit: 'USD', extra: extra.join(' | ') });
  }

  const activeBuckets = Array.isArray(data.quota_buckets?.active_buckets) ? data.quota_buckets.active_buckets : [];
  for (const item of activeBuckets) {
    const bucket = item?.bucket;
    if (!bucket) continue;
    const remaining = amountFromQuota(item.remaining_quota, quotaPerUnit);
    const used = amountFromQuota(bucket.amount_used, quotaPerUnit);
    const total = amountFromQuota(bucket.amount_total, quotaPerUnit);
    plans.push({ planName: bucket.title || 'HeyRoute Quota Pack', isValid: remaining === null || remaining > 0, remaining, used, total, unit: 'USD', extra: '' });
  }

  const validPlans = plans.filter((plan) => plan.remaining !== null || plan.used !== null || plan.total !== null);
  if (!validPlans.length) return 0;
  const fallbackRemaining = validPlans.every(plan => plan.remaining !== null)
    ? Number(validPlans.reduce((sum, plan) => sum + plan.remaining, 0).toFixed(6)) : null;
  const fallbackUsed = validPlans.reduce((sum, plan) => sum + (plan.used || 0), 0);
  const fallbackTotal = validPlans.reduce((sum, plan) => sum + (plan.total || 0), 0);
  station.balance = walletRemaining ?? fallbackRemaining;
  station.balanceLimit = walletTotal ?? Number(fallbackTotal.toFixed(6));
  station.totalSpend = walletUsed ?? Number(fallbackUsed.toFixed(6));
  station.quotaConsumed = station.balanceLimit !== null && station.balance !== null
    ? Number(Math.max(station.balanceLimit - station.balance, 0).toFixed(6)) : null;
  station.balanceKnown = station.balance !== null;
  station.balanceUpdatedAt = nowIso();
  station.balanceUnit = effectiveBalanceUnit(station);
  station.totalSpendUnit = effectiveBalanceUnit(station);
  station.todaySpend = null;
  station.todaySpendAvailable = false;
  station.spendSource = 'remote';
  station.usagePlans = validPlans;
  station.metricsSource = 'AHE 实时用量';
  return validPlans.length;
}

function applyAixhanStats(station, payload) {
  const source = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!isAmount(source?.remaining)) return 0;
  station.balance = Number(source.remaining);
  station.balanceLimit = null;
  station.quotaConsumed = null;
  station.balanceKnown = true;
  station.balanceUpdatedAt = nowIso();
  station.totalSpend = null;
  station.todaySpend = null;
  station.balanceUnit = effectiveBalanceUnit(station);
  station.todaySpendUnit = effectiveBalanceUnit(station);
  station.totalSpendUnit = effectiveBalanceUnit(station);
  station.todaySpendAvailable = false;
  station.spendSource = 'remote';
  station.usagePlans = [];
  station.metricsSource = '爱享实时用量';
  return 1;
}

function applyDeepSeekStats(station, payload) {
  if (!Array.isArray(payload?.balance_infos)) return 0;
  const balances = payload.balance_infos.filter((item) => item && typeof item === 'object');
  if (!balances.length) return 0;
  const selected = balances.find((item) => String(item.currency || '').toUpperCase() === 'CNY') || balances[0];
  const currency = String(selected.currency || '').toUpperCase();
  const total = Number(selected.total_balance);
  if (!currency || !isAmount(selected.total_balance)) return 0;
  const granted = Number(selected.granted_balance);
  const toppedUp = Number(selected.topped_up_balance);
  // DeepSeek returns the currency for each balance; keep that source-of-truth label instead of converting values.
  const displayUnit = currency;
  const plans = [{ planName: '总余额', remaining: total, used: null, total: null, unit: displayUnit, extra: 'DeepSeek 官方 total_balance' }];
  if (Number.isFinite(granted)) plans.push({ planName: '赠送余额', remaining: granted, used: null, total: null, unit: displayUnit, extra: 'DeepSeek 官方 granted_balance' });
  if (Number.isFinite(toppedUp)) plans.push({ planName: '充值余额', remaining: toppedUp, used: null, total: null, unit: displayUnit, extra: 'DeepSeek 官方 topped_up_balance' });
  if (payload.is_available === false) plans[0].extra += ' | 当前不可用';

  station.balance = total;
  station.balanceLimit = null;
  station.totalSpend = null;
  station.quotaConsumed = null;
  station.balanceKnown = true;
  station.balanceUpdatedAt = nowIso();
  station.balanceUnit = displayUnit;
  station.totalSpendUnit = displayUnit;
  station.todaySpend = null;
  station.todaySpendAvailable = false;
  station.spendSource = 'remote';
  station.usagePlans = plans;
  station.metricsSource = 'DeepSeek 官方余额';
  return 1;
}

function isAmount(value) {
  return ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value));
}

function applyStats(station, payload, profile = 'generic') {
  if (profile === 'ahe') return applyAheStats(station, payload);
  if (profile === 'aixhan') return applyAixhanStats(station, payload);
  if (profile === 'deepseek') return applyDeepSeekStats(station, payload);
  const source = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (isAmount(source?.quota) && isAmount(source?.used_quota)) {
    const total = (Number(source.quota) + Number(source.used_quota)) / 500000;
    station.balance = Number((Number(source.quota) / 500000).toFixed(6));
    station.balanceLimit = Number(total.toFixed(6));
    station.totalSpend = Number((Number(source.used_quota) / 500000).toFixed(6));
    station.quotaConsumed = Number(Math.max(total - station.balance, 0).toFixed(6));
    station.balanceKnown = true;
    station.balanceUpdatedAt = nowIso();
    station.balanceUnit = effectiveBalanceUnit(station);
    station.totalSpendUnit = effectiveBalanceUnit(station);
    station.todaySpend = null;
    station.todaySpendAvailable = false;
    station.spendSource = 'remote';
    station.usagePlans = [];
    station.metricsSource = 'New API 实时账户额度';
    return 3;
  }
  const fields = ['balance', 'tokens', 'todaySpend', 'totalSpend'];
  let matched = 0;
  for (const field of fields) {
    if (isAmount(source?.[field])) {
      station[field] = Number(source[field]);
      matched += 1;
    }
  }
  if (matched) {
    const remoteLimit = [source?.balanceLimit, source?.total, source?.limit, source?.quotaLimit]
      .filter(isAmount).map(Number).find((value) => Number.isFinite(value));
    station.balanceLimit = remoteLimit === undefined ? null : remoteLimit;
    station.balanceKnown = isAmount(source?.balance);
    if (station.balanceKnown) station.balanceUpdatedAt = nowIso();
    const unit = station.balanceUnitCustomized
      ? effectiveBalanceUnit(station)
      : String(source?.unit || source?.currency || effectiveBalanceUnit(station)).toUpperCase();
    station.balanceUnit = unit;
    station.todaySpendUnit = unit;
    station.totalSpendUnit = unit;
    station.quotaConsumed = station.balanceKnown && Number.isFinite(Number(station.balanceLimit)) && Number.isFinite(Number(station.balance))
      ? Number(Math.max(Number(station.balanceLimit) - Number(station.balance), 0).toFixed(6)) : null;
    station.todaySpendAvailable = Number.isFinite(Number(source?.todaySpend));
    station.spendSource = 'remote';
    station.usagePlans = [];
    station.metricsSource = '实时统计接口';
  }
  return matched;
}

function usageProfile(station) {
  const configuredUrl = String(station.statsUrl || '').toLowerCase();
  if (configuredUrl.includes('/api/usage/token')) return 'ahe';
  if (configuredUrl.includes('/api/public/usage/stats')) return 'aixhan';
  if (configuredUrl.includes('/user/balance')) return 'deepseek';
  if (configuredUrl.includes('/api/user/self')) return 'new-api';
  if (station.statsUrl) return 'custom';
  const hostname = new URL(station.baseUrl).hostname.toLowerCase();
  if (hostname.includes('aixhan.com')) return 'aixhan';
  if (hostname.includes('aheapi.com') || hostname.includes('heyroute.ai')) return 'ahe';
  if (hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com')) return 'deepseek';
  return 'new-api';
}

function usageRequest(station) {
  const profile = usageProfile(station);
  if (profile === 'ahe') {
    return {
      profile,
      url: station.statsUrl || `${new URL(station.baseUrl).origin}/api/usage/token/`,
      apiKey: station.apiKey,
      headers: { 'user-agent': 'cc-switch/1.0' }
    };
  }
  if (profile === 'aixhan') {
    const url = new URL(station.statsUrl || `${new URL(station.baseUrl).origin}/api/public/usage/stats`);
    url.searchParams.set('key', station.apiKey);
    return { profile, url: url.toString(), apiKey: '' };
  }
  if (profile === 'deepseek') {
    return {
      profile,
      url: station.statsUrl || `${new URL(station.baseUrl).origin}/user/balance`,
      apiKey: station.apiKey,
      headers: {}
    };
  }
  if (profile === 'custom') {
    return { profile, url: station.statsUrl, apiKey: station.statsToken || station.apiKey, headers: {} };
  }
  if (station.statsToken && station.statsUserId) {
    return {
      profile,
      url: station.statsUrl || `${new URL(station.baseUrl).origin}/api/user/self`,
      apiKey: station.statsToken,
      headers: { 'New-Api-User': station.statsUserId }
    };
  }
  return null;
}

function repairKnownStatsUrl(station) {
  try {
    const baseUrl = new URL(station.baseUrl);
    const statsUrl = station.statsUrl ? new URL(station.statsUrl) : null;
    if (baseUrl.hostname.toLowerCase() !== 'api.aixhan.com') return;
    if (statsUrl && (statsUrl.hostname.toLowerCase() !== 'api.aixhan.com' || statsUrl.pathname !== '/api/public/usage/stats')) return;
    station.statsUrl = 'https://cdk.aixhan.com/api/public/usage/stats';
  } catch {
    // Invalid URLs are reported by the normal station refresh flow.
  }
}

function usageErrorMessage(error, station) {
  let message = error?.name === 'AbortError' ? '请求超时（10 秒）' : String(error?.message || '用量查询失败');
  if (message === 'fetch failed' && error?.cause?.code) {
    const cause = error.cause;
    const destination = cause.address ? ` ${cause.address}${cause.port ? `:${cause.port}` : ''}` : '';
    const host = error.requestHost ? `${error.requestHost}：` : '';
    const localAddress = cause.address === '::1' || String(cause.address || '').startsWith('127.');
    const remoteHost = error.requestHost && error.requestHost !== 'localhost'
      && error.requestHost !== '[::1]' && error.requestHost !== '::1' && !error.requestHost.startsWith('127.');
    if (localAddress && remoteHost) {
      message = `${host}连接目标异常映射到本机（${cause.code}${destination}），请检查系统 DNS 缓存或网络软件的域名映射；尚未收到接口响应`;
    } else if (['ECONNRESET', 'UND_ERR_SOCKET'].includes(cause.code)) {
      message = `${host}连接被重置或提前关闭（${cause.code}），请检查网络、代理或站点连接限制；尚未收到完整接口响应`;
    } else {
      message = `${host}连接失败（${cause.code}${destination}），请检查网络、DNS 或代理设置`;
    }
  }
  for (const secret of [station.apiKey, station.statsToken].filter(Boolean)) {
    message = message.split(secret).join('[已隐藏]').split(encodeURIComponent(secret)).join('[已隐藏]');
  }
  return message.slice(0, 800);
}

function applyScriptStats(station, result) {
  const entries = Array.isArray(result) ? result : [result];
  if (!entries.length || entries.length > 100) throw new Error('解析结果需要返回 1 至 100 个额度条目');
  const amount = (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value))) throw new Error('额度必须是有效数字');
    return Number(value);
  };
  const plans = entries.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('解析结果必须为额度对象或数组');
    const remaining = amount(entry.remaining), used = amount(entry.used), total = amount(entry.total);
    if (remaining === null) throw new Error(entry.invalidMessage || '解析结果缺少 remaining 余额');
    // A depleted plan may be invalid but still carries a valid zero balance.
    if (entry.isValid === false && remaining !== 0) throw new Error(entry.invalidMessage || '查询结果无效');
    const unit = String(entry.unit || effectiveBalanceUnit(station)).toUpperCase();
    if (!['USD', 'CNY'].includes(unit)) throw new Error('查询结果额度单位只支持 USD 或 CNY');
    return { name: String(entry.planName || '账户'), remaining, used, total, unit, extra: String(entry.extra || '') };
  });
  const selected = plans.find((plan) => plan.name === '钱包');
  const totals = selected ? [selected] : plans;
  if (new Set(totals.map((plan) => plan.unit)).size > 1) throw new Error('不同币种的额度不能直接合计');
  const sum = (key) => totals.every((plan) => plan[key] !== null) ? totals.reduce((total, plan) => total + plan[key], 0) : null;
  station.balance = sum('remaining');
  station.balanceLimit = sum('total');
  station.totalSpend = sum('used');
  station.balanceKnown = true;
  station.balanceUpdatedAt = nowIso();
  station.balanceUnit = station.balanceUnitCustomized ? effectiveBalanceUnit(station) : totals[0].unit;
  station.totalSpendUnit = station.balanceUnit;
  station.todaySpend = null;
  station.todaySpendAvailable = false;
  station.spendSource = 'remote';
  station.usagePlans = plans;
  station.metricsSource = '自定义用量查询';
  return plans.length;
}

async function queryUsage(station) {
  if (station.ghost) throw new Error('幽灵中转仅保留记录，不查询用量');
  if (!station.usageScriptEnabled) {
    const usage = usageRequest(station);
    if (!usage) return 0;
    const payload = await fetchJson(usage.url, usage.apiKey, usage.headers);
    if (!applyStats(station, payload, usage.profile)) throw new Error('统计接口字段不足');
    captureRemoteTokens(station, payload, usage.profile);
    return 1;
  }
  const variables = usageVariables(station);
  const config = await evaluateUsageScript(station.usageScript, variables);
  if (!config || typeof config.url !== 'string') throw new Error('request.url 必须为 http/https 地址');
  const url = new URL(config.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持无内嵌密码的 http/https 地址');
  const method = String(config.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw new Error('用量查询只支持 GET 或 POST');
  if (config.headers !== undefined && (!config.headers || Array.isArray(config.headers) || typeof config.headers !== 'object')) throw new Error('request.headers 必须为对象');
  const headers = { ...(config.headers || {}) };
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value) || /^(host|content-length|connection|transfer-encoding)$/i.test(key)) throw new Error('请求头无效或不受支持');
  }
  let body;
  if (config.body != null) {
    if (method === 'GET') throw new Error('GET 查询不能设置 body');
    body = typeof config.body === 'string' ? config.body : JSON.stringify(config.body);
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }
  const response = await fetchJson(url, '', headers, { method, body });
  const extracted = await evaluateUsageScript(station.usageScript, variables, response, 'extractor');
  const matched = applyScriptStats(station, extracted);
  captureRemoteTokens(station, Array.isArray(extracted) ? {} : extracted, 'custom');
  return matched;
}

function captureRemoteTokens(station, payload, profile) {
  const source = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const value = profile === 'new-api' ? source?.used_tokens : source?.tokens;
  station.remoteTokens = value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

function usageFromPayload(payload) {
  const usage = payload?.usage || payload?.response?.usage || payload?.message?.usage || payload || {};
  const promptDetails = usage.prompt_tokens_details || usage.promptTokensDetails || {};
  const inputDetails = usage.input_tokens_details || usage.inputTokensDetails || {};
  const numberValue = (...values) => {
    const value = values.find((item) => item !== undefined && item !== null && item !== '');
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  };
  const cacheReadTokens = numberValue(usage.cache_read_input_tokens, usage.cache_read_tokens, usage.cached_tokens,
    promptDetails.cached_tokens, promptDetails.cachedTokens, inputDetails.cached_tokens, inputDetails.cachedTokens);
  const cacheWriteTokens = numberValue(usage.cache_creation_input_tokens, usage.cache_creation_tokens, usage.cache_write_tokens,
    promptDetails.cache_creation_tokens, promptDetails.cacheCreationTokens);
  const hasPromptTokens = usage.prompt_tokens !== undefined && usage.prompt_tokens !== null;
  const rawInputTokens = numberValue(usage.prompt_tokens, usage.input_tokens, usage.inputTokens);
  const inputIncludesCache = hasPromptTokens && (promptDetails.cached_tokens !== undefined || promptDetails.cachedTokens !== undefined
    || inputDetails.cached_tokens !== undefined || inputDetails.cachedTokens !== undefined);
  const inputTokens = Math.max(0, rawInputTokens - (inputIncludesCache ? cacheReadTokens : 0));
  const outputTokens = numberValue(usage.completion_tokens, usage.output_tokens, usage.outputTokens);
  const rawTotalTokens = numberValue(usage.total_tokens, usage.totalTokens);
  const componentTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = componentTotal || rawTotalTokens;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

function usageCost(usage, station) {
  const pricing = normalizePricing(station.pricing);
  const input = pricing.input;
  const output = pricing.output;
  const cacheRead = pricing.cacheRead;
  const cacheWrite = pricing.cacheWrite;
  const multiplier = Number(station.multiplier || 1);
  return Number(((usage.inputTokens * input + usage.outputTokens * output
    + usage.cacheReadTokens * cacheRead + usage.cacheWriteTokens * cacheWrite) / 1000000 * multiplier).toFixed(6));
}

function appendCall(station, call) {
  const usage = usageFromPayload(call.payload);
  const cost = Number(call.cost ?? usageCost(usage, station));
  const firstByteAt = call.firstByteAt || call.startedAt;
  const endedAt = call.endedAt || Date.now();
  const record = {
    id: crypto.randomUUID(), source: station.name, token: station.tokenName || '本地代理',
    timestamp: new Date(call.startedAt || Date.now()).toISOString(), model: call.responseModel || call.model || '未知模型', stream: Boolean(call.stream),
    tokens: usage.totalTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
    cacheHitRate: usage.inputTokens + usage.cacheReadTokens ? Number((usage.cacheReadTokens / (usage.inputTokens + usage.cacheReadTokens) * 100).toFixed(1)) : 0,
    reasoning: call.reasoning || '未设置',
    cost, costUnit: effectiveBalanceUnit(station), costSource: 'estimated', multiplier: Number(station.multiplier || 1), ttft: Number(((firstByteAt - call.startedAt) / 1000).toFixed(2)),
    duration: Number(((endedAt - call.startedAt) / 1000).toFixed(2)),
    tps: Number((usage.outputTokens / Math.max((endedAt - firstByteAt) / 1000, 0.1)).toFixed(1)),
    statusCode: call.statusCode, result: call.statusCode >= 200 && call.statusCode < 300 ? '成功' : '失败',
    detail: call.detail || '本地代理 · 实时记录', time: '刚刚'
  };
  station.calls = [record, ...(station.calls || [])];
  station.tokens = Number(station.tokens || 0) + usage.totalTokens;
  return record;
}

async function persistProxyCall(dataDir, stationId, call) {
  return enqueueStateWrite(dataDir, (state) => {
    const station = state.stations.find((item) => item.id === stationId);
    if (!station) return null;
    return appendCall(station, call);
  });
}

function isHealthCheckPath(upstreamPath) {
  const path = String(upstreamPath || '').replace(/^\/+/, '').toLowerCase();
  return path === 'models' || path === 'v1/models' || path === 'health' || path === 'v1/health';
}

function mergeUsagePayload(current, payload) {
  const incoming = payload?.usage || payload?.response?.usage || payload?.message?.usage;
  if (!incoming || typeof incoming !== 'object') return current || {};
  const previous = current?.usage || {};
  return { ...current, ...payload, usage: { ...previous, ...incoming } };
}

function usageFromCliPayload(payload) {
  const usage = payload?.usage || payload?.message?.usage || {};
  const numberValue = (...values) => {
    const value = values.find((item) => item !== undefined && item !== null && item !== '');
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  };
  const cacheReadTokens = numberValue(usage.cached_input_tokens, usage.cache_read_input_tokens, usage.cache_read_tokens,
    usage.prompt_tokens_details?.cached_tokens, usage.input_tokens_details?.cached_tokens);
  const cacheWriteTokens = numberValue(usage.cache_write_input_tokens, usage.cache_creation_input_tokens,
    usage.cache_write_tokens, usage.prompt_tokens_details?.cache_creation_tokens);
  const rawInputTokens = numberValue(usage.input_tokens, usage.prompt_tokens);
  const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens);
  const outputTokens = numberValue(usage.output_tokens, usage.completion_tokens);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens || numberValue(usage.total_tokens);
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

function configProviders(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return {};
  try {
    const config = parseToml(fs.readFileSync(configPath, 'utf8'));
    const providers = config.model_providers || {};
    const result = Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, {
      name: textValue(provider?.name) || id,
      baseUrl: textValue(provider?.base_url || provider?.baseURL),
      model: textValue(provider?.model)
    }]));
    result.__defaultModel = textValue(config.model);
    return result;
  } catch {
    return {};
  }
}

function comparableUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

function matchCliStation(stations, baseUrl, providerName) {
  const comparable = comparableUrl(baseUrl);
  if (comparable) {
    const exact = stations.find((station) => comparableUrl(station.baseUrl) === comparable);
    if (exact) return exact;
  }
  const normalizedName = textValue(providerName).toLowerCase();
  return stations.find((station) => textValue(station.name).toLowerCase() === normalizedName) || null;
}

async function walkJsonl(root, maxFiles = 200) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  const visit = async (directory) => {
    if (files.length >= maxFiles) return;
    let entries = [];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = await fs.promises.stat(fullPath);
          files.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {}
      }
    }
  };
  await visit(root);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function readCodexUsageFiles(root, providerConfig, fileCache = {}) {
  const records = [];
  const signature = `codex-v3:${JSON.stringify(providerConfig || {})}`;
  for (const file of await walkJsonl(root)) {
    const cached = fileCache[file.path];
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size
      && cached.signature === signature && Array.isArray(cached.records)) {
      records.push(...cached.records);
      continue;
    }
    const fileRecords = [];
    let session = {};
    const turnModels = new Map();
    const pendingUsage = [];
    const input = fs.createReadStream(file.path, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        if (item.type === 'session_meta') {
          session = item.payload || {};
          continue;
        }
        if (item.type === 'turn_context') {
          const context = item.payload || {};
          const model = textValue(context.model || context.collaboration_mode?.settings?.model);
          if (context.turn_id && model) turnModels.set(context.turn_id, model);
          continue;
        }
        if (item.type !== 'token_usage_record') continue;
        const payload = item.payload || {};
        const usage = usageFromCliPayload(payload);
        if (!usage.totalTokens) continue;
        const providerId = textValue(session.model_provider || payload.model_provider) || 'custom';
        const provider = providerConfig[providerId] || {};
        pendingUsage.push({ item, payload, usage, providerId, provider,
          sessionId: textValue(session.session_id), sessionModel: textValue(session.model) });
      }
      for (const { item, payload, usage, providerId, provider, sessionId, sessionModel } of pendingUsage) {
        fileRecords.push({
          importKey: `codex:${payload.session_id || sessionId || path.basename(file.path)}:${payload.response_id || payload.turn_id || item.timestamp}`,
          source: provider.name || `Codex CLI · ${providerId}`,
          providerId, baseUrl: provider.baseUrl,
          model: textValue(payload.model || turnModels.get(payload.turn_id) || sessionModel || provider.model || providerConfig.__defaultModel) || '未知模型',
          timestamp: item.timestamp || payload.timestamp || session.timestamp,
          usage, sourceType: 'codex-cli', detail: 'Codex CLI 会话同步'
        });
      }
    } finally {
      lines.close();
      input.destroy();
    }
    fileCache[file.path] = { mtimeMs: file.mtimeMs, size: file.size, signature, records: fileRecords };
    records.push(...fileRecords);
  }
  return records;
}

async function readClaudeUsageFiles(root, fileCache = {}) {
  const records = [];
  const signature = 'claude-v1';
  for (const file of await walkJsonl(root)) {
    const cached = fileCache[file.path];
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size
      && cached.signature === signature && Array.isArray(cached.records)) {
      records.push(...cached.records);
      continue;
    }
    const fileRecords = [];
    const input = fs.createReadStream(file.path, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        if (item.type !== 'assistant' || !item.message?.usage) continue;
        const usage = usageFromCliPayload(item.message);
        if (!usage.totalTokens) continue;
        fileRecords.push({
          importKey: `claude:${item.uuid || item.message.id || item.timestamp}`,
          source: `Claude Code${item.message.model ? ` · ${item.message.model}` : ''}`,
          providerId: '', baseUrl: '', model: textValue(item.message.model) || 'Claude Code',
          timestamp: item.timestamp, usage, sourceType: 'claude-cli', detail: 'Claude Code 会话同步'
        });
      }
    } finally {
      lines.close();
      input.destroy();
    }
    fileCache[file.path] = { mtimeMs: file.mtimeMs, size: file.size, signature, records: fileRecords };
    records.push(...fileRecords);
  }
  return records;
}

function cliRecordFromUsage(record, station) {
  return {
    id: crypto.randomUUID(), importKey: record.importKey, source: station?.name || record.source,
    originalSource: record.source,
    token: station?.tokenName || record.sourceType, timestamp: new Date(record.timestamp || Date.now()).toISOString(),
    model: record.model, stream: null, tokens: record.usage.totalTokens,
    inputTokens: record.usage.inputTokens, outputTokens: record.usage.outputTokens,
    cacheReadTokens: record.usage.cacheReadTokens, cacheWriteTokens: record.usage.cacheWriteTokens,
    cacheHitRate: record.usage.inputTokens + record.usage.cacheReadTokens
      ? Number((record.usage.cacheReadTokens / (record.usage.inputTokens + record.usage.cacheReadTokens) * 100).toFixed(1)) : 0,
    reasoning: '未设置', cost: station ? usageCost(record.usage, station) : 0, costUnit: station ? effectiveBalanceUnit(station) : 'USD', costSource: 'estimated', multiplier: Number(station?.multiplier || 1), ttft: null, duration: null, tps: null,
    statusCode: null, result: '已同步', detail: record.detail, dataSource: 'CLI usage', time: '已同步', sourceType: record.sourceType,
    sourceApp: record.sourceApp || (record.sourceType === 'codex-cli' ? 'Codex' : 'Claude Code')
  };
}

function migrateLegacyCliCalls(state, records) {
  const recordsByImportKey = new Map(records.map((record) => [record.importKey, record]));
  let migratedCount = 0;
  const migrate = (call) => {
    if (!['codex-cli', 'claude-cli'].includes(call.sourceType)) return;
    const record = call.importKey ? recordsByImportKey.get(call.importKey) : null;
    let changed = false;
    const model = textValue(record?.model);
    if (model && model !== '未知模型' && call.model !== model) {
      call.model = model;
      changed = true;
    }
    for (const field of ['stream', 'statusCode', 'ttft', 'duration', 'tps']) {
      if (call[field] !== null) {
        call[field] = null;
        changed = true;
      }
    }
    if (call.result !== '已同步') {
      call.result = '已同步';
      changed = true;
    }
    if (call.dataSource !== 'CLI usage') {
      call.dataSource = 'CLI usage';
      changed = true;
    }
    if (record?.detail && call.detail !== record.detail) {
      call.detail = record.detail;
      changed = true;
    }
    if (changed) migratedCount += 1;
  };
  for (const station of state.stations) for (const call of station.calls || []) migrate(call);
  for (const call of state.cliCalls || []) migrate(call);
  return migratedCount;
}

async function syncCliUsage(state, options = {}) {
  const paths = cliPaths(options.cliPaths);
  const providers = configProviders(paths.codexConfig);
  state.cliFileCache = state.cliFileCache && typeof state.cliFileCache === 'object' ? state.cliFileCache : {};
  state.cliFileCache.codex = state.cliFileCache.codex && typeof state.cliFileCache.codex === 'object' ? state.cliFileCache.codex : {};
  state.cliFileCache.claude = state.cliFileCache.claude && typeof state.cliFileCache.claude === 'object' ? state.cliFileCache.claude : {};
  const harness = options.includeHarness === false ? { records: [], diagnostics: { status: 'disabled', scanned: 0, warnings: [] } }
    : await readHarnessUsage(paths.harnessSessions);
  const workBuddy = options.workBuddyCache ? await readWorkBuddyUsage(paths.workBuddyProjects, options.workBuddyCache) : null;
  const records = [
    ...(options.includeCodex === false ? [] : await readCodexUsageFiles(paths.codexSessions, providers, state.cliFileCache.codex)),
    ...(options.includeClaude === false ? [] : await readClaudeUsageFiles(paths.claudeProjects, state.cliFileCache.claude)),
    ...harness.records, ...(workBuddy?.records || [])
  ];
  const migratedCount = migrateLegacyCliCalls(state, records);
  if (!Array.isArray(state.cliImportedKeys)) {
    const legacyCliCalls = state.stations.flatMap((station) => (station.calls || []).filter((call) => call.sourceType === 'codex-cli'));
    const latestLegacyTimestamp = legacyCliCalls.reduce((latest, call) => {
      const timestamp = Date.parse(call.timestamp || '');
      return Number.isFinite(timestamp) && timestamp > latest ? timestamp : latest;
    }, 0);
    state.cliImportedKeys = latestLegacyTimestamp
      ? records.filter((record) => record.sourceType === 'codex-cli' && Date.parse(record.timestamp || '') <= latestLegacyTimestamp).map((record) => record.importKey)
      : [];
  }
  const knownKeys = new Set([
    ...state.stations.flatMap((station) => (station.calls || []).map((call) => call.importKey).filter(Boolean)),
    ...(state.cliCalls || []).map((call) => call.importKey).filter(Boolean),
    ...(state.cliImportedKeys || [])
  ]);
  const initialKeys = new Set(knownKeys);
  const imported = [];
  const unmatched = [];
  for (const record of records) {
    // Account-login Harness providers cannot be attributed to an arbitrary relay with the same model.
    const mapped = sourceAttribution.mappedStation(state, record.source);
    const station = mapped || (['deepseek-harness', 'workbuddy'].includes(record.sourceType) ? null : matchCliStation(state.stations, record.baseUrl, record.source));
    if (record.sourceType === 'codex-cli' && station && record.model !== '未知模型') station.cliModel = record.model;
    if (knownKeys.has(record.importKey)) continue;
    const call = cliRecordFromUsage(record, station);
    if (mapped) call.mappingSource = String(record.source).trim();
    if (station) {
      station.calls = [call, ...(station.calls || [])];
      station.tokens = Number(station.tokens || 0) + call.tokens;
      imported.push({ source: station.name, model: call.model, tokens: call.tokens });
    } else {
      state.cliCalls = [call, ...(state.cliCalls || [])];
      unmatched.push({ source: call.source, model: call.model, tokens: call.tokens });
    }
    knownKeys.add(record.importKey);
    state.cliImportedKeys.push(record.importKey);
  }
  state.cliSync = { checkedAt: nowIso(), importedCount: imported.length, unmatchedCount: unmatched.length, migratedCount,
    workBuddy: workBuddy ? { ...workBuddy.diagnostics, importedCount: workBuddy.records.filter(record => !initialKeys.has(record.importKey)).length } : undefined,
    harness: { ...harness.diagnostics, importedCount: harness.records.filter(record => !initialKeys.has(record.importKey)).length } };
  return { imported, unmatched, migratedCount, scanned: records.length, checkedAt: state.cliSync.checkedAt };
}

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function proxyHeaders(req, station) {
  return {
    accept: req.headers.accept || 'application/json',
    'content-type': req.headers['content-type'] || 'application/json',
    ...(station.apiKey ? { authorization: `Bearer ${station.apiKey}` } : {})
  };
}

async function proxyRequest(req, res, station, upstreamPath, dataDir) {
  if (!station.apiKey) return sendError(res, 400, '该站点尚未配置 API Key');
  const rawBody = await readRaw(req);
  let input = {};
  try { input = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {}; } catch { return sendError(res, 400, '请求体不是有效 JSON'); }
  const call = { model: input.model, stream: input.stream, reasoning: input.reasoning_effort || input.reasoning, startedAt: Date.now(), firstByteAt: 0, statusCode: 500 };
  const shouldLog = !isHealthCheckPath(upstreamPath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const targetPath = upstreamPath.replace(/^\/+/, '').replace(/^v1\//, '');
  const target = `${station.baseUrl}/${targetPath}`;
  try {
    const upstream = await fetch(target, { method: req.method, headers: proxyHeaders(req, station), body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody, signal: controller.signal });
    call.statusCode = upstream.status;
    call.firstByteAt = Date.now();
    const contentType = upstream.headers.get('content-type') || 'application/json';
    if (!contentType.includes('text/event-stream')) {
      const buffer = Buffer.from(await upstream.arrayBuffer());
      let payload = {};
      try { payload = JSON.parse(buffer.toString('utf8')); } catch { payload = {}; }
      call.payload = payload; call.responseModel = payload.model; call.endedAt = Date.now();
      if (shouldLog) await persistProxyCall(dataDir, station.id, call);
      res.writeHead(upstream.status, { 'content-type': contentType, 'cache-control': 'no-store' });
      return res.end(buffer);
    }
    res.writeHead(upstream.status, { 'content-type': contentType, 'cache-control': 'no-cache', connection: 'keep-alive' });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let streamText = '';
    let usagePayload = {};
    let first = true;
    const captureUsage = (text) => {
      streamText += text;
      const lines = streamText.split(/\r?\n/);
      streamText = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const item = JSON.parse(line.slice(5).trim());
          if (item.usage || item.message?.usage) usagePayload = mergeUsagePayload(usagePayload, item);
        } catch {}
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first) { call.firstByteAt = Date.now(); first = false; }
      res.write(Buffer.from(value));
      captureUsage(decoder.decode(value, { stream: true }));
    }
    captureUsage(decoder.decode());
    if (streamText.startsWith('data:')) {
      try {
        const item = JSON.parse(streamText.slice(5).trim());
        if (item.usage || item.message?.usage) usagePayload = mergeUsagePayload(usagePayload, item);
      } catch {}
    }
    call.payload = usagePayload; call.responseModel = usagePayload.model; call.endedAt = Date.now();
    if (shouldLog) await persistProxyCall(dataDir, station.id, call);
    res.end();
  } catch (error) {
    if (!call.firstByteAt) call.firstByteAt = Date.now(); call.statusCode = 502; call.payload = {}; call.endedAt = Date.now();
    if (shouldLog) await persistProxyCall(dataDir, station.id, call);
    if (!res.headersSent) sendError(res, 502, error.name === 'AbortError' ? '上游请求超时' : `上游连接失败：${error.message}`);
    else res.end();
  } finally {
    clearTimeout(timeout);
  }
}

function refreshResult(station) {
  return {
    id: station.id,
    name: station.name,
    modelStatus: modelStatusOf(station),
    usageStatus: usageStatusOf(station),
    lastError: station.lastError || ''
  };
}

async function refreshStation(station) {
  if (station.disabled) {
    return { id: station.id, name: station.name, skipped: true, modelStatus: 'paused', usageStatus: 'paused', lastError: '监控已暂停' };
  }
  station.checkedAt = nowIso();
  station.usageCheckedAt = nowIso();
  station.lastError = '';
  station.usageError = '';
  if (!station.apiKey) {
    station.status = 'pending';
    station.modelStatus = 'missing';
    station.usageStatus = 'missing';
    station.lastError = '未配置 API Key，尚未发起外部请求';
    return refreshResult(station);
  }
  station.modelStatus = 'checking';
  station.usageStatus = 'checking';
  let modelError = '';
  try {
    const modelsPayload = await fetchJson(`${station.baseUrl}/models`, station.apiKey);
    const models = parseModels(modelsPayload);
    station.models = models.slice(0, 30);
    station.modelCount = models.length;
    station.status = 'online';
    station.modelStatus = 'online';
  } catch (error) {
    station.status = 'error';
    station.modelStatus = 'error';
    modelError = usageErrorMessage(error, station);
  }
  // Balance queries have independent credentials/endpoints and must run even if /models fails.
  repairKnownStatsUrl(station);
  try {
    if (await queryUsage(station)) {
      station.usageStatus = 'online';
      station.usageLastSuccessAt = nowIso();
    } else {
      station.usageStatus = 'unconfigured';
      station.metricsSource = station.statsToken ? '模型实时 / 缺少统计用户 ID' : '模型实时 / 等待用量查询';
    }
  } catch (error) {
    station.usageStatus = 'error';
    station.usageError = usageErrorMessage(error, station);
  }
  station.lastError = [
    modelError ? `模型列表接口失败：${modelError}` : '',
    station.usageError ? `${modelError ? '' : '模型接口正常，'}统计接口失败：${station.usageError}` : ''
  ].filter(Boolean).join('；');
  return refreshResult(station);
}

function monitoringClone(station) {
  const { calls, ...rest } = station;
  return structuredClone(rest);
}

function applyRefreshDiff(target, before, after) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    if (!isDeepStrictEqual(target[key], before[key])) continue;
    target[key] = after[key] === undefined ? undefined : structuredClone(after[key]);
  }
}

function acceptRefresh(state, target, before, probe) {
  // Probes run outside the write queue. Only the first result based on a given
  // revision/account may commit, so overlapping or reconfigured probes cannot
  // move the balance baseline backwards or create duplicate ledger entries.
  if (quotaAccountKey(target) !== quotaAccountKey(before)
    || Number(target.refreshRevision || 0) !== Number(before.refreshRevision || 0)) return false;
  applyRefreshDiff(target, before, probe);
  target.refreshRevision = Number(target.refreshRevision || 0) + 1;
  recordQuotaSnapshot(state, target);
  return true;
}

async function refreshStationSafely(dataDir, stationId) {
  const snapshotState = readState(dataDir);
  const snapshotStation = snapshotState.stations.find((station) => station.id === stationId);
  if (!snapshotStation) throw new Error('找不到这个站点');
  if (snapshotStation.disabled) {
    return enqueueStateWrite(dataDir, (currentState) => {
      const target = currentState.stations.find((station) => station.id === stationId);
      if (!target) throw new Error('找不到这个站点');
      return { ...publicState(currentState), refreshResults: [{ id: target.id, name: target.name, skipped: true, modelStatus: 'paused', usageStatus: 'paused', lastError: '监控已暂停' }] };
    });
  }
  const before = monitoringClone(snapshotStation);
  const probe = monitoringClone(snapshotStation);
  const result = await refreshStation(probe);
  return enqueueStateWrite(dataDir, (currentState) => {
    const target = currentState.stations.find((station) => station.id === stationId);
    if (!target) throw new Error('找不到这个站点');
    if (target.disabled) {
      return { ...publicState(currentState), refreshResults: [{ id: target.id, name: target.name, skipped: true, modelStatus: 'paused', usageStatus: 'paused', lastError: '监控已暂停' }] };
    }
    acceptRefresh(currentState, target, before, probe);
    return { ...publicState(currentState), refreshResults: [result] };
  });
}

async function refreshAllStationsSafely(dataDir, channel = null) {
  const snapshotState = readState(dataDir);
  const inScope = station => !channel || isOfficialStation(station) === (channel === 'official');
  const active = snapshotState.stations.filter((station) => !station.disabled && inScope(station));
  const before = active.map((station) => monitoringClone(station));
  const probes = active.map((station) => monitoringClone(station));
  const activeIds = new Set(active.map((station) => station.id));
  setSyncState(dataDir, { running: true, total: probes.length, done: 0, current: '', startedAt: new Date().toISOString(), finishedAt: null });
  try {
    const settled = await Promise.allSettled(probes.map(async (probe) => {
      try {
        return await refreshStation(probe);
      } finally {
        setSyncState(dataDir, { done: syncStateFor(dataDir).done + 1, current: probe.name });
      }
    }));
    const results = settled.map((entry, index) => entry.status === 'fulfilled'
      ? entry.value
      : { id: active[index].id, name: active[index].name, modelStatus: 'error', usageStatus: 'error', lastError: `刷新失败：${entry.reason?.message || '未知错误'}` });
    return enqueueStateWrite(dataDir, (currentState) => {
      const refreshResults = results.map((result, index) => {
        const target = currentState.stations.find((station) => station.id === active[index].id);
        if (!target) return result;
        if (target.disabled) return { id: target.id, name: target.name, skipped: true, modelStatus: 'paused', usageStatus: 'paused', lastError: '监控已暂停' };
        acceptRefresh(currentState, target, before[index], probes[index]);
        return result;
      });
      for (const station of currentState.stations.filter((item) => item.disabled && inScope(item) && !activeIds.has(item.id))) {
        refreshResults.push({ id: station.id, name: station.name, skipped: true, modelStatus: 'paused', usageStatus: 'paused', lastError: '监控已暂停' });
      }
      return { ...publicState(currentState), refreshResults };
    });
  } finally {
    setSyncState(dataDir, { running: false, current: '', finishedAt: new Date().toISOString() });
  }
}

async function handleApi(req, res, url, options = {}) {
  if (req.method === 'GET' && url.pathname === '/api/codex/account') {
    return sendJson(res, 200, await options.codexAccount(url.searchParams.get('refresh') === '1'));
  }
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const store = usageStores.get(path.resolve(dataDir));
  if (store && req.method === 'GET' && url.pathname === '/api/stations/recent-activity') {
    return sendJson(res, 200, { stations: store.recentActivity() });
  }
  if (store && req.method === 'GET' && url.pathname === '/api/logs') {
    const catalog = options.pricingEnabled ? await modelPricing.loadCatalog(dataDir) : options.pricingCatalog;
    return sendJson(res, 200, store.query(url, catalog));
  }
  if (store && req.method === 'GET' && url.pathname === '/api/history/quota') return sendJson(res, 200, store.queryQuotaHistory(url));
  if (store && req.method === 'GET' && url.pathname === '/api/history/tokens') return sendJson(res, 200, store.queryTokenHistory(url));
  if (store && req.method === 'GET' && url.pathname === '/api/history/corrections') return sendJson(res, 200, store.queryCorrections(url));
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, now: Date.now(), uptimeSeconds: Math.round(process.uptime()), runtime: options.runtime || 'desktop', sync: syncStateFor(dataDir) });
  }
  const state = readState(dataDir);
  if (req.method === 'GET' && url.pathname === '/api/source-attribution') {
    return sendJson(res, 200, sourceAttribution.attributionStatus(state));
  }
  if (req.method === 'POST' && url.pathname === '/api/source-attribution') {
    const input = await readJson(req);
    const payload = await enqueueStateWrite(dataDir, currentState => {
      const action = input.action || 'map';
      if (!['map', 'create'].includes(action)) throw new Error('不支持的归属操作');
      let target;
      if (action === 'map') {
        target = currentState.stations.find(station => station.id === input.stationId);
        if (!target) throw new Error('请选择当前已存在的中转站');
      } else {
        const name = String(input.name || input.source || '').trim();
        if (currentState.stations.some(station => station.name === name)) throw new Error('同名中转已存在，请映射到已有站点');
        target = stationFromInput({ name, baseUrl: input.baseUrl, ghost: input.ghost === true, balanceUnit: input.balanceUnit || 'USD' },
          stationDefaults(crypto.randomUUID(), { name }));
      }
      const movedCount = sourceAttribution.assignSource(currentState, input.source, target);
      if (action === 'create') currentState.stations.push(target);
      return { ...publicState(currentState), movedCount, targetStationId: target.id };
    });
    return sendJson(res, 200, payload);
  }
  if (req.method === 'GET' && url.pathname === '/api/history/export') {
    try {
      const snapshot = store ? { ...state, quotaConsumptionLogs: store.quotaConsumptionLogs() } : state;
      return sendJson(res, 200, buildHistoryExport(snapshot, url));
    } catch (error) { return sendError(res, 400, error.message); }
  }
  if (req.method === 'GET' && url.pathname === '/api/stations/recent-activity') {
    return sendJson(res, 200, { stations: recentStationActivity(state) });
  }
  if (req.method === 'POST' && ['/api/usage/template', '/api/usage/test'].includes(url.pathname)) {
    const input = await readJson(req);
    const saved = input.stationId ? state.stations.find((item) => item.id === input.stationId) : null;
    if (input.stationId && !saved) return sendError(res, 404, '找不到这个站点');
    const templateInput = url.pathname === '/api/usage/template' && !input.baseUrl
      ? { ...input, baseUrl: 'https://example.invalid/v1' } : input;
    const temporary = stationFromInput({ ...templateInput, name: input.name || saved?.name || '用量查询' },
      saved ? structuredClone(saved) : stationDefaults(crypto.randomUUID(), { name: '' }));
    repairKnownStatsUrl(temporary);
    if (url.pathname === '/api/usage/template') {
      return sendJson(res, 200, { code: usageTemplate(usageProfile(temporary), publicStatsUrl(temporary.statsUrl), effectiveBalanceUnit(temporary)) });
    }
    try {
      if (!await queryUsage(temporary)) throw new Error('尚未配置用量查询凭据或接口');
      return sendJson(res, 200, { balance: temporary.balance, unit: temporary.balanceUnit,
        total: temporary.balanceLimit, used: temporary.totalSpend, plans: temporary.usagePlans || [] });
    } catch (error) {
      return sendError(res, 400, usageErrorMessage(error, temporary));
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/import/cc-switch') {
    const result = await readCcSwitchCandidates(options.ccSwitchDbPath);
    return sendJson(res, 200, {
      sourcePath: result.dbPath,
      candidates: result.candidates.map(publicImportCandidate)
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/import/cc-switch') {
    const input = await readJson(req);
    const requestedIds = Array.isArray(input.ids) ? new Set(input.ids.map(String)) : new Set();
    const result = await readCcSwitchCandidates(options.ccSwitchDbPath);
    const selected = result.candidates.filter((candidate) => requestedIds.has(candidate.id));
    const payload = await enqueueStateWrite(dataDir, (currentState) => {
      const existingKeys = new Set(currentState.stations.map((station) => `${station.baseUrl}\n${station.apiKey || ''}`));
      const imported = [];
      const skipped = [];
      for (const candidate of selected) {
        const key = `${candidate.baseUrl}\n${candidate.apiKey}`;
        if (existingKeys.has(key)) {
          skipped.push({ name: candidate.name, reason: '已存在相同地址和 API Key' });
          continue;
        }
        const station = stationFromInput({
          name: candidate.name,
          tokenName: candidate.name,
          baseUrl: candidate.baseUrl,
          statsUrl: candidate.statsUrl,
          apiKey: candidate.apiKey,
          statsToken: candidate.statsToken,
          statsUserId: candidate.statsUserId,
          usageScript: candidate.usageScript,
          usageScriptEnabled: candidate.usageScriptEnabled
        }, stationDefaults(crypto.randomUUID(), candidate));
        currentState.stations.push(station);
        existingKeys.add(key);
        imported.push({ name: candidate.name, id: station.id });
      }
      return { ...publicState(currentState), sourcePath: result.dbPath, imported, skipped };
    });
    return sendJson(res, 200, payload);
  }
  if (req.method === 'GET' && url.pathname === '/api/stations') {
    return sendJson(res, 200, publicState(state));
  }
  if (req.method === 'GET' && url.pathname === '/api/overview') {
    const catalog = options.pricingEnabled ? await modelPricing.loadCatalog(dataDir) : options.pricingCatalog;
    return sendJson(res, 200, overviewStats(state, { days: Number(url.searchParams.get('days') || 7), timeZone: url.searchParams.get('timeZone') || 'UTC',
      priceCall: catalog ? (call, station) => modelPricing.priceCall(call, station, catalog) : undefined }));
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const catalog = options.pricingEnabled ? await modelPricing.loadCatalog(dataDir) : options.pricingCatalog;
    return sendJson(res, 200, publicLogs(state, url, catalog));
  }
  if (req.method === 'GET' && url.pathname === '/api/history/quota') {
    const stationId = url.searchParams.get('stationId');
    let logs = (state.quotaConsumptionLogs || []).filter(event => !stationId || event.stationId === stationId);
    const from = Date.parse(url.searchParams.get('from') || ''), to = Date.parse(url.searchParams.get('to') || '');
    if (Number.isFinite(from)) logs = logs.filter(event => Date.parse(event.periodEndAt) >= from);
    if (Number.isFinite(to)) logs = logs.filter(event => Date.parse(event.periodEndAt) <= to);
    logs.sort((a, b) => Date.parse(b.periodEndAt) - Date.parse(a.periodEndAt));
    const amountByUnit = logs.reduce((groups, event) => { groups[event.unit] = Number(((groups[event.unit] || 0) + event.amount).toFixed(6)); return groups; }, {});
    const pageSize = Math.max(1, Math.min(500, Number(url.searchParams.get('pageSize')) || 100));
    const page = Math.min(Math.max(1, Number(url.searchParams.get('page')) || 1), Math.max(1, Math.ceil(logs.length / pageSize)));
    const pageLogs = logs.slice((page - 1) * pageSize, page * pageSize).map(event => {
      const { accountKey, ...publicEvent } = event;
      return publicEvent;
    });
    return sendJson(res, 200, { logs: pageLogs, summary: { amountByUnit, count: logs.length },
      pagination: { page, pageSize, total: logs.length, pages: Math.max(1, Math.ceil(logs.length / pageSize)) } });
  }
  if (req.method === 'GET' && url.pathname === '/api/history/corrections') {
    const stationId = url.searchParams.get('stationId');
    const range = url.searchParams.get('range') || 'all';
    const from = url.searchParams.has('from') ? Date.parse(url.searchParams.get('from'))
      : range === 'today' ? new Date().setHours(0, 0, 0, 0)
        : ['24h', '7d', '30d'].includes(range) ? Date.now() - ({ '24h': 1, '7d': 7, '30d': 30 }[range] * 86400000) : null;
    const to = url.searchParams.has('to') ? Date.parse(url.searchParams.get('to')) : null;
    const logs = (state.historyCorrections || []).filter(event => (!stationId || event.stationId === stationId)
      && (!Number.isFinite(from) || Date.parse(event.createdAt) >= from) && (!Number.isFinite(to) || Date.parse(event.createdAt) <= to))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    const summary = logs.reduce((sum, event) => {
      sum.amountByUnit[event.unit] = Number(((sum.amountByUnit[event.unit] || 0) + event.amount).toFixed(6));
      sum.tokens += event.tokens; return sum;
    }, { amountByUnit: {}, tokens: 0, count: logs.length });
    const pageSize = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get('pageSize'))) || 100));
    const pages = Math.max(1, Math.ceil(logs.length / pageSize));
    const page = Math.min(pages, Math.max(1, Math.trunc(Number(url.searchParams.get('page'))) || 1));
    return sendJson(res, 200, { logs: logs.slice((page - 1) * pageSize, page * pageSize), summary,
      pagination: { page, pageSize, total: logs.length, pages } });
  }
  if (req.method === 'GET' && url.pathname === '/api/history/tokens') {
    const stationId = url.searchParams.get('stationId');
    const stations = state.stations.filter(station => !stationId || station.id === stationId);
    let logs = stations.flatMap(station => (station.calls || []).filter(call => call.sourceType !== 'manual-adjustment' && call.model !== 'GET /models')
      .map((call, index) => decorateCall(call, station, index)));
    if (!stationId) logs.push(...(state.cliCalls || []).filter(call => call.sourceType !== 'manual-adjustment' && call.model !== 'GET /models')
      .map((call, index) => decorateCall(call, { id: 'cli', name: call.source || '未匹配 CLI 来源' }, index)));
    const from = Date.parse(url.searchParams.get('from') || ''), to = Date.parse(url.searchParams.get('to') || '');
    if (Number.isFinite(from)) logs = logs.filter(log => Date.parse(log.timestamp) >= from);
    if (Number.isFinite(to)) logs = logs.filter(log => Date.parse(log.timestamp) <= to);
    logs.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const totals = logs.reduce((sum, log) => {
      const parts = stationAccounting.tokenBreakdown(log);
      sum.input += parts.input; sum.output += parts.output; sum.cacheRead += parts.cacheRead;
      sum.cacheWrite += parts.cacheWrite; sum.cache += parts.cache; sum.total += parts.total;
      return sum;
    }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cache: 0, total: 0 });
    const pageSize = Math.max(1, Math.min(500, Number(url.searchParams.get('pageSize')) || 100));
    const page = Math.min(Math.max(1, Number(url.searchParams.get('page')) || 1), Math.max(1, Math.ceil(logs.length / pageSize)));
    return sendJson(res, 200, { logs: logs.slice((page - 1) * pageSize, page * pageSize), summary: { ...totals, count: logs.length },
      pagination: { page, pageSize, total: logs.length, pages: Math.max(1, Math.ceil(logs.length / pageSize)) } });
  }
  if (req.method === 'POST' && url.pathname === '/api/pricing/refresh') {
    const catalog = options.pricingEnabled ? await modelPricing.loadCatalog(dataDir, { force: true }) : options.pricingCatalog || {};
    return sendJson(res, 200, { updatedAt: catalog.updatedAt, error: catalog.error || '', modelCount: Object.keys(catalog.models || {}).length });
  }
  if (req.method === 'POST' && url.pathname === '/api/logs/sync-cli') {
    const payload = await enqueueStateWrite(dataDir, async (currentState) => {
      const result = await syncCliUsage(currentState, options);
      return { ...publicState(currentState), ...result };
    });
    return sendJson(res, 200, payload);
  }
  if (req.method === 'POST' && url.pathname === '/api/stations/test') {
    const input = await readJson(req);
    const saved = input.stationId ? state.stations.find((item) => item.id === input.stationId) : null;
    if (input.stationId && !saved) return sendError(res, 404, '找不到这个站点');
    const temporary = stationFromInput(input, saved ? structuredClone(saved) : stationDefaults(crypto.randomUUID(), {
      name: textValue(input.name), baseUrl: textValue(input.baseUrl)
    }));
    const result = await refreshStation(temporary);
    const safeTest = sanitizeStation(temporary, state);
    if (usageStores.has(path.resolve(dataDir))) delete safeTest.calls;
    return sendJson(res, 200, { test: safeTest, refreshResult: result });
  }
  if (req.method === 'PATCH' && url.pathname === '/api/settings') {
    const input = await readJson(req);
    const payload = await enqueueStateWrite(dataDir, (currentState) => {
      if (input.refreshMinutes !== undefined) {
        const refreshMinutes = Number(input.refreshMinutes);
        if (![5, 10, 60].includes(refreshMinutes)) throw new Error('刷新周期只支持 5、10 或 60 分钟');
        currentState.settings.refreshMinutes = refreshMinutes;
      }
      if (input.balanceAlerts !== undefined) currentState.settings.balanceAlerts = balanceAlerts.normalize(input.balanceAlerts);
      return publicState(currentState);
    });
    return sendJson(res, 200, payload);
  }
  if (req.method === 'POST' && url.pathname === '/api/stations') {
    const input = await readJson(req);
    const payload = await enqueueStateWrite(dataDir, (currentState) => {
      const station = stationFromInput(input, stationDefaults(crypto.randomUUID(), { name: '' }));
      currentState.stations.push(station);
      return publicState(currentState);
    });
    return sendJson(res, 201, payload);
  }
  if (req.method === 'POST' && url.pathname === '/api/stations/refresh-all') {
    const channel = url.searchParams.get('channel');
    if (channel !== null && !['official', 'relay'].includes(channel)) return sendError(res, 400, '渠道无效');
    const payload = await refreshAllStationsSafely(dataDir, channel);
    return sendJson(res, 200, payload);
  }
  const proxyMatch = url.pathname.match(/^\/api\/stations\/([^/]+)\/proxy\/(.+)$/);
  if (proxyMatch) {
    const station = state.stations.find((item) => item.id === proxyMatch[1]);
    if (!station) return sendError(res, 404, '找不到这个站点');
    if (station.ghost) return sendError(res, 400, '幽灵中转仅保留记录，不提供代理或监控');
    return proxyRequest(req, res, station, proxyMatch[2], dataDir);
  }
  const match = url.pathname.match(/^\/api\/stations\/([^/]+)(?:\/(refresh|calibrate))?$/);
  if (!match) return sendError(res, 404, '接口不存在');
  const station = state.stations.find((item) => item.id === match[1]);
  if (!station) return sendError(res, 404, '找不到这个站点');
  if (req.method === 'POST' && match[2] === 'calibrate') {
    const input = await readJson(req);
    const payload = await enqueueStateWrite(dataDir, currentState => {
      const currentStation = currentState.stations.find(item => item.id === station.id);
      if (!currentStation) throw new Error('找不到这个站点');
      const view = sanitizeStation(currentStation, currentState);
      const units = [...new Set([effectiveBalanceUnit(currentStation), ...Object.keys(view.historyQuotaByUnit)])];
      const record = historyCalibration.calibrateLedger(currentState, currentStation, input,
        { amount: view.historyQuotaByUnit[input.unit] || 0, tokens: view.tokens }, units);
      return { ...publicState(currentState), adjustment: record };
    });
    return sendJson(res, 200, payload);
  }
  if (req.method === 'DELETE' && !match[2]) {
    const payload = await enqueueStateWrite(dataDir, (currentState) => {
      currentState.stations = currentState.stations.filter((item) => item.id !== station.id);
      currentState.sourceMappings = (currentState.sourceMappings || []).filter(rule => rule.stationId !== station.id);
      currentState.quotaConsumptionLogs = currentState.quotaConsumptionLogs.filter(event => event.stationId !== station.id);
      currentState.historyCorrections = currentState.historyCorrections.filter(event => event.stationId !== station.id);
      delete currentState.quotaSnapshots[station.id];
      return publicState(currentState);
    });
    return sendJson(res, 200, payload);
  }
  if (req.method === 'PATCH' && !match[2]) {
    const input = await readJson(req);
    const payload = await enqueueStateWrite(dataDir, (currentState) => {
      const currentStation = currentState.stations.find((item) => item.id === station.id);
      if (!currentStation) throw new Error('找不到这个站点');
      const updated = stationFromInput(input, currentStation);
      if (quotaAccountKey(updated) !== quotaAccountKey(currentStation)) updated.historyBaselineInvalidated = true;
      const previousName = currentStation.name;
      Object.assign(currentStation, updated);
      sourceAttribution.renameSources(currentStation, previousName);
      return publicState(currentState);
    });
    return sendJson(res, 200, payload);
  }
  if (req.method === 'POST' && match[2] === 'refresh') {
    const payload = await refreshStationSafely(dataDir, station.id);
    return sendJson(res, 200, payload);
  }
  return sendError(res, 405, '不支持这个请求方法');
}

function serveStatic(req, res, url, publicDir = PUBLIC_DIR, runtime = 'desktop') {
  const vendors = {
    '/vendor/chart.js': path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'),
    '/vendor/lucide.js': path.join(ROOT, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js')
  };
  if (Object.hasOwn(vendors, url.pathname)) {
    return fs.readFile(vendors[url.pathname], (error, content) => {
      if (error) return sendError(res, 404, '图表资源不可用');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(content);
    });
  }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return sendError(res, 403, '禁止访问');
  fs.readFile(filePath, (error, content) => {
    if (error) return sendError(res, 404, '页面不存在');
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    if (runtime === 'web' && filePath.endsWith(`${path.sep}index.html`)) {
      const html = content.toString('utf8')
        .replace('<body data-runtime="desktop">', '<body data-runtime="web">')
        .replace('<title>Token Watch ·', '<title>Token Watch Web ·');
      return res.writeHead(200, { 'content-type': types[ext] }).end(html);
    }
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

function createServer({ runtime = 'desktop', dataDir = runtime === 'web' ? WEB_DATA_DIR : DEFAULT_DATA_DIR, publicDir = PUBLIC_DIR, port = PORT, ccSwitchDbPath, cliPaths: cliPathOverrides, pricingEnabled = false, pricingCatalog, harnessEnabled = false, workBuddyEnabled = false, sqliteEnabled = false, codexAccount = createAccountMonitor() } = {}) {
  if (runtime === 'web') ensureState(dataDir, true);
  const storeKey = path.resolve(dataDir);
  let store;
  if (sqliteEnabled) {
    if (usageStores.has(storeKey)) throw new Error('该数据目录已有 SQLite 工作台运行');
    const { UsageStore } = require('./usage-store');
    store = new UsageStore(dataDir, { normalize: normalizeState, decorate: decorateCall });
    const migratedState = store.load();
    if (migratedState._correctionsMigrated) store.save(migratedState);
    usageStores.set(storeKey, store);
  }
  const workBuddyCache = workBuddyEnabled ? new Map() : null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url, { dataDir, ccSwitchDbPath, cliPaths: cliPathOverrides, pricingEnabled, pricingCatalog, includeHarness: harnessEnabled, workBuddyCache, runtime, codexAccount });
      else if (req.method === 'GET') serveStatic(req, res, url, publicDir, runtime);
      else sendError(res, 405, '不支持这个请求方法');
    } catch (error) {
      if (!res.headersSent) sendError(res, 400, error.message || '请求处理失败');
    }
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
  return { server, ready, get port() { return server.address()?.port; }, close: async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await stateWriteQueues.get(storeKey)?.catch(() => {});
    if (store) { store.close(); usageStores.delete(storeKey); }
    syncStates.delete(storeKey);
  } };
}

if (require.main === module) {
  const app = createServer({ pricingEnabled: true, harnessEnabled: true, workBuddyEnabled: true });
  app.ready.then((port) => console.log(`Token monitor running at http://127.0.0.1:${port}`));
}

module.exports = { createServer, decorateCall, publicLogs };
