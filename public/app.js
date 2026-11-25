const state = { data: null, logs: { logs: [], summary: {} }, logIndex: new Map(), timer: null, syncing: false, booting: false, fromCache: false, health: 'connecting', syncError: '', page: 'overview', ccSwitchCandidates: [], overviewDays: 7, overview: null };
let overviewRequestId = 0;
let logPage = 1;
let logRequestId = 0;
const appName = document.body.dataset.runtime === 'web' ? 'Token Watch Web' : 'Token Watch';
if (appName === 'Token Watch Web') {
  document.querySelector('.brand strong').textContent = appName;
  document.querySelector('.brand small').textContent = 'browser workbench';
  document.querySelector('#footerVersion').textContent = 'WEB 0.1';
}
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const defaultPricing = { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 };
let usageTemplateRequest = 0;
const pageMeta = {
  overview: { breadcrumb: '监控总览', title: '消耗监控总览', description: '查看全部已建站点的额度、Token 用量与连接状态。' },
  official: { breadcrumb: '官方渠道', title: '官方账号', description: '查看 Codex 订阅额度和 DeepSeek 官方 API 余额。' },
  stations: { breadcrumb: '中转站', title: '中转站资产', description: '管理 API 地址、凭证与每个中转站的实时连接状态。' },
  calls: { breadcrumb: '消耗日志', title: '消耗日志', description: '分别查看 Token 用量分项、额度余额差额和请求运行明细。' }
};
let quotaHistoryPage = 1;
let tokenHistoryPage = 1;
let correctionHistoryPage = 1;
let quotaHistory = null;
let tokenHistory = null;
let historyTab = 'calls';
let historyRequestId = 0;

function money(value, unit = 'CNY') {
  return DashboardFormat.money(value, String(unit || 'CNY').toUpperCase());
}
function groupedMoney(groups, fallbackValue = null) {
  const entries = Object.entries(groups || {});
  return entries.length ? entries.map(([unit, value]) => money(value, unit)).join(' · ') : money(fallbackValue);
}
function compact(value) { return DashboardFormat.compact(value); }
function tokenCount(value) { return Number(value || 0).toLocaleString('zh-CN'); }

function renderCodexAccount(data) {
  const metrics = $('#codexAccountMetrics');
  const history = $('#codexAccountHistory');
  const daysList = $('#codexAccountDays');
  const status = $('#codexAccountStatus');
  metrics.replaceChildren();
  daysList.replaceChildren();
  history.hidden = true;
  if (data.status !== 'connected') {
    status.textContent = data.status === 'login-required' ? '请先在本机 Codex 客户端使用 ChatGPT 账号登录，再刷新账号。' : data.error;
    return;
  }
  const formatDate = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  status.textContent = [data.plan, `查询于 ${formatDate(data.checkedAt)}`].filter(Boolean).join(' · ');
  function metric(label, value, note) {
    const item = document.createElement('div');
    for (const [tag, text] of [['span', label], ['strong', value], ['small', note]]) {
      const el = document.createElement(tag);
      el.textContent = text;
      item.append(el);
    }
    metrics.append(item);
  }
  for (const window of data.windows || []) {
    metric(MonitorChannels.codexWindowLabel(window), window.remaining === null ? '—' : `剩余 ${window.remaining.toLocaleString('zh-CN')}%`,
      window.resetsAt === null ? '官方未提供重置时间' : `${formatDate(window.resetsAt * 1000)} 重置`);
  }
  if (!data.windows?.length) metric('账号额度', '—', data.windows ? '官方未返回额度周期' : '额度查询失败，可刷新重试');
  const days = data.usage?.days || [];
  metric('官方累计 Token', data.usage?.total == null ? '—' : tokenCount(data.usage.total),
    !data.usage ? '用量查询失败，可刷新重试' : days.length ? `最新明细 ${days[0].date}` : '暂无每日明细');
  if (days.length) {
    daysList.innerHTML = days.map(day => `<div><dt>${escapeHtml(day.date)}</dt><dd>${day.tokens == null ? '—' : tokenCount(day.tokens)}</dd></div>`).join('');
    history.hidden = false;
  }
}

async function refreshCodexAccount(force = false) {
  const button = $('#refreshCodexAccount');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const data = await request('/api/codex/account' + (force ? '?refresh=1' : ''), { timeoutMs: 45000 });
    renderCodexAccount(data);
  } catch (error) {
    renderCodexAccount({ error: `账号查询失败 · ${error.message}` });
  } finally { button.disabled = false; }
}
function timeLabel(value) { if (!value) return '等待检测'; const diff = Math.max(0, Date.now() - new Date(value).getTime()); if (diff < 60000) return '刚刚检测'; if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前检测`; return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function stationInitial(name) { return String(name || '站').slice(0, 1).toUpperCase(); }
function statusText(station) {
  const status = station.modelStatus || station.status;
  return status === 'online' ? '模型接口正常' : status === 'error' ? '模型接口异常' : status === 'checking' ? '正在检查模型接口' : '等待 API Key';
}
function usageStatusText(station) {
  const status = station.usageStatus;
  return status === 'online' ? '用量查询正常' : status === 'error' ? '用量查询异常' : status === 'checking' ? '正在查询用量' : status === 'unconfigured' ? '未配置用量接口' : status === 'blocked' ? '等待模型接口' : status === 'missing' ? '等待 API Key' : '尚未查询';
}
function showToast(message, type = 'success') { const toast = document.createElement('div'); toast.className = `toast ${type}`; toast.textContent = message; $('#toastRegion').append(toast); setTimeout(() => toast.remove(), 3600); }

function humanizeError(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/Insufficient account balance|insufficient_quota|余额不足|account balance is insufficient/i.test(text)) return '中转站账户余额不足，请先充值';
  if (/DAILY_LIMIT_EXCEEDED|daily usage limit|quota exceeded|额度上限/i.test(text) || /\b429\b/.test(text)) {
    return '中转站今日额度已用尽（429 限流），请更换 Key 或稍后重试';
  }
  if (/超时|timeout|ETIMEDOUT|AbortError|aborted/i.test(text)) return '请求超时，中转站或网络无响应';
  if (/Failed to fetch|Load failed|NetworkError|网络请求失败/i.test(text)) return '网络请求失败或本地服务未启动';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|连接失败|ECONNRESET/i.test(text)) return '无法连接中转站，请检查网络或地址';
  if (/\b401\b|unauthorized|invalid.*(api key|token)/i.test(text)) return 'API Key 无效或无权限';
  if (/\b403\b|forbidden/i.test(text)) return '请求被中转站拒绝（403）';
  if (/\b5\d\d\b|server error|bad gateway|服务不可用/i.test(text)) return '中转站服务器错误，请稍后重试';
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function modelStatusLabel(station) {
  const status = station.modelStatus || station.status;
  if (status === 'online') return '正常';
  if (status === 'error') return '异常';
  if (status === 'checking') return '检查中';
  return station.hasApiKey ? '未检测' : '未配置 Key';
}

function usageStatusLabel(station) {
  const status = station.usageStatus;
  if (status === 'online') return '正常';
  if (status === 'error') return '异常';
  if (status === 'checking') return '检查中';
  if (status === 'unconfigured') return '未配置查询';
  if (status === 'blocked') return '等待模型接口';
  if (status === 'missing') return '未配置 Key';
  return '未查询';
}

function setServiceStatus(status) {
  state.health = status;
  const label = { connecting: '正在连接', syncing: '正在同步', online: '运行正常', offline: '连接中断' }[status] || '运行正常';
  const statusEl = $('#serviceStatus');
  if (statusEl) statusEl.textContent = label;
  const foot = document.querySelector('.sidebar-foot');
  if (foot) foot.classList.toggle('is-offline', status === 'offline');
}

function setSyncText(text) {
  const el = $('#syncProgress');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

function setDegraded(message, isError = false) {
  const banner = $('#degradedBanner');
  if (!banner) return;
  banner.hidden = !message;
  banner.classList.toggle('is-error', Boolean(message) && isError);
  const textEl = $('#degradedText');
  if (textEl) textEl.textContent = message || '';
}

async function request(url, options = {}) {
  const { timeoutMs = 30000, headers, ...rest } = options;
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(headers || {}) }, signal: AbortSignal.timeout(timeoutMs), ...rest });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}
function logQuery() {
  const params = new URLSearchParams();
  const range = $('#logDateFilter').value;
  const model = $('#logModelFilter').value.trim();
  const source = $('#logSourceFilter').value;
  const sourceApp = $('#logAppFilter').value;
  if (range) params.set('range', range);
  if (model) params.set('model', model);
  if (source) params.set('source', source);
  if (sourceApp) params.set('sourceApp', sourceApp);
  if ($('#logTypeFilter').value) params.set('type', $('#logTypeFilter').value);
  params.set('page', logPage);
  params.set('pageSize', '100');
  return params;
}
function applyLogTypeFilter(result) {
  if (result.pagination) return result;
  const type = $('#logTypeFilter').value;
  if (!type) return result;
  result.logs = result.logs.filter((log) => type === 'usage'
    ? ['codex-cli', 'claude-cli', 'deepseek-harness', 'workbuddy'].includes(log.sourceType)
    : type === 'stream' ? log.stream === true : log.stream === false);
  result.summary.count = result.logs.length;
  const measured = result.logs.filter(log => log.sourceType !== 'manual-adjustment');
  result.summary.usageByUnit = measured.reduce((groups, log) => {
    if (log.cost == null) return groups;
    const unit = log.costUnit || 'USD';
    groups[unit] = Number(((groups[unit] || 0) + Number(log.cost || 0)).toFixed(6));
    return groups;
  }, {});
  result.summary.usage = Object.keys(result.summary.usageByUnit).length === 1 ? Object.values(result.summary.usageByUnit)[0] : null;
  result.summary.requestCount = result.logs.filter(log => log.sourceType !== 'manual-adjustment').length;
  result.summary.tokenCount = measured.reduce((sum, log) => sum + log.tokens, 0);
  result.summary.unpricedCount = measured.filter(log => log.cost == null).length;
  return result;
}
async function syncAndLoadLogs() {
  const syncResult = await request('/api/logs/sync-cli', { method: 'POST', body: '{}' });
  const requestId = ++logRequestId;
  const logs = applyLogTypeFilter(await request(`/api/logs?${logQuery()}`));
  state.data = syncResult;
  if (requestId === logRequestId) state.logs = logs;
  render();
  await loadOverview();
  if (state.page === 'calls') await loadCurrentHistory();
  return syncResult;
}

async function refreshOverviewData() {
  const params = new URLSearchParams({ days: state.overviewDays, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  return request(`/api/overview?${params}`);
}

async function loadOverview() {
  const requestId = ++overviewRequestId;
  $('#overviewChartError').textContent = '正在读取';
  try {
    const data = await refreshOverviewData();
    if (requestId !== overviewRequestId) return;
    state.overview = data;
    $('#overviewChartError').textContent = '';
    renderOverviewCharts();
  } catch (error) {
    if (requestId === overviewRequestId) $('#overviewChartError').textContent = `图表读取失败：${humanizeError(error.message)}`;
  }
}

function currencyLines(groups, precision = 2) {
  const entries = Object.entries(groups || {}).sort(([a], [b]) => (a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b)));
  return entries.length ? entries.map(([unit, value]) => `<span class="currency-line">${escapeHtml(DashboardFormat.money(value, unit, precision))}</span>`).join('') : '<span>--</span>';
}

function renderOverviewCharts() {
  if (!state.overview) return;
  const stats = state.overview;
  $('#overviewPeriod').textContent = `${stats.from} 至 ${stats.to}`;
  $('#overviewRequestCount').textContent = `${tokenCount(stats.requests)} 次调用`;
  $('#chartTokenTotal').textContent = compact(stats.tokens);
  $('#chartTokenTotal').title = tokenCount(stats.tokens);
  $('#modelStatsBody').innerHTML = stats.models.map((model, index) => `<tr><td><span class="model-key" style="background:${OverviewCharts.colors[Math.min(index, 6)]}"></span><span title="${escapeHtml(model.model)}">${escapeHtml(model.model)}</span></td><td>${tokenCount(model.requests)}</td><td title="${tokenCount(model.tokens)}">${compact(model.tokens)}</td><td>${currencyLines(model.actualCostByUnit, 4)}</td><td class="estimated-cost">${currencyLines(model.estimatedCostByUnit, 4)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-row">暂无调用数据</td></tr>';
  OverviewCharts.render(stats);
}

function stationAlert(station, quota = QuotaPolicy.present(station)) {
  if (station.disabled) return { active: false, reasons: [] };
  return BalanceAlerts.evaluate(quota, state.data?.settings?.balanceAlerts);
}

function renderOverviewBalances(stations) {
  $('#overviewBalances').innerHTML = stations.map(station => {
    const quota = QuotaPolicy.present(station);
    const alert = stationAlert(station, quota);
    return `<button class="overview-balance-row ${alert.active ? 'balance-warning' : ''}" type="button" data-balance-station="${escapeHtml(station.id)}" title="${escapeHtml(station.name)}${quota.stale ? ' · 上次数据' : ''}"><span class="station-logo">${escapeHtml(stationInitial(station.name))}</span><span class="balance-row-main"><span class="balance-row-title"><span>${escapeHtml(station.name)}</span><strong>${money(quota.remaining, quota.unit)}</strong></span>${quota.mode !== 'prepaid' ? `<span class="balance-mini-meter ${quota.stale ? 'stale' : ''}" ${quota.percent !== null ? `role="progressbar" aria-label="${escapeHtml(station.name)}剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${quota.percent}"` : 'aria-label="剩余额度未获取"'}><span style="width:${quota.percent ?? 0}%"></span></span>` : ''}${quota.stale || quota.reason ? `<small>${escapeHtml(quota.reason || '上次数据')}</small>` : ''}</span></button>`;
  }).join('') || '<span class="analytics-caption">尚未添加中转站</span>';
  window.WebWorkbench?.afterBalances(stations);
}
function updateTrustUI() {
  if (!state.data) return;
  const aggregate = state.data.aggregate || {};
  const stations = state.data.stations || [];
  const active = stations.filter((station) => !station.disabled);
  const online = active.filter((station) => (station.modelStatus || station.status) === 'online').length;
  const modelErrors = active.filter((station) => (station.modelStatus || station.status) === 'error').length;
  const usageErrors = active.filter((station) => station.usageStatus === 'error').length;
  const problemCount = modelErrors + usageErrors;
  const lastSyncMs = aggregate.lastSync ? Date.parse(aggregate.lastSync) : null;
  const refreshMinutes = state.data.settings?.refreshMinutes || 5;
  const stale = Boolean(lastSyncMs) && Date.now() - lastSyncMs > Math.max(refreshMinutes * 60000 * 2, 10 * 60000);
  const live = $('#liveBadge');
  if (live) {
    const degraded = problemCount > 0;
    if (state.health === 'offline') {
      live.textContent = state.data ? 'CACHED' : 'OFFLINE';
      live.className = 'nav-pill is-offline';
      live.title = '本地服务连接中断';
    } else {
      live.textContent = state.syncing ? 'SYNC' : !active.length ? 'IDLE' : degraded ? 'DEGRADED' : 'LIVE';
      live.className = `nav-pill ${state.syncing ? 'is-sync' : !active.length ? 'is-idle' : degraded ? 'is-degraded' : 'is-live'}`;
      live.title = state.syncing ? '正在同步数据' : degraded ? `${problemCount} 项接口异常` : active.length ? '全部接口正常' : '尚未添加中转站';
    }
  }
  const signal = document.querySelector('.heading-signal');
  if (signal) {
    signal.classList.toggle('is-degraded', problemCount > 0 && online > 0);
    signal.classList.toggle('is-error', active.length > 0 && online === 0);
  }
  $('#onlineSummary').textContent = active.length ? `${online} / ${active.length} 个模型接口在线` : '尚未添加中转站';
  if (!state.syncing) {
    $('#lastSyncText').textContent = lastSyncMs
      ? `最后成功同步 ${timeLabel(aggregate.lastSync)}${problemCount ? ` · ${problemCount} 项接口异常` : ''}`
      : '等待首次同步';
  }
  if (state.health === 'offline') setDegraded('本地服务连接中断，正在重试…', true);
  else if (state.syncError) setDegraded(`上次同步失败：${state.syncError}`, true);
  else if (problemCount) setDegraded(`${[modelErrors ? `${modelErrors} 个模型接口异常` : '', usageErrors ? `${usageErrors} 个用量查询异常` : ''].filter(Boolean).join('，')}（${online}/${active.length} 模型在线），相关余额可能不是最新数据`, false);
  else if (stale) setDegraded(`数据超过 ${refreshMinutes} 分钟未成功更新，可能已过期`, false);
  else setDegraded('');
}

let heartbeatTimer = null;
function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    try {
      const health = await request('/api/health');
      if (health.sync?.running && state.syncing && health.sync.total) {
        setSyncText(health.sync.current ? `正在刷新 ${Math.min(health.sync.done, health.sync.total)}/${health.sync.total}：${health.sync.current}` : `正在刷新 0/${health.sync.total}`);
      }
      if (state.health === 'offline') {
        setServiceStatus(state.syncing ? 'syncing' : 'online');
        updateTrustUI();
      }
      if (!state.data) {
        bootstrap();
        return;
      }
    } catch {
      setServiceStatus('offline');
      setDegraded('本地服务连接中断，正在重试…', true);
      updateTrustUI();
    }
    if (state.data && !state.syncing) updateTrustUI();
  }, 30000);
}

const CLIENT_CACHE_KEY = `token-watch-${document.body.dataset.runtime}-client-cache-v1`;

function readClientCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(CLIENT_CACHE_KEY) || 'null');
    if (!cache || !cache.data || !Array.isArray(cache.data.stations) || typeof cache.savedAt !== 'number') return null;
    if (!cache.data.aggregate || typeof cache.data.aggregate !== 'object') return null;
    if (!cache.data.settings || typeof cache.data.settings !== 'object') return null;
    if (cache.logs && !Array.isArray(cache.logs.logs)) cache.logs = null;
    if (cache.overview && !Array.isArray(cache.overview.models)) cache.overview = null;
    return cache;
  } catch {
    return null;
  }
}

let clientCacheTimer = null;
function scheduleClientCache() {
  clearTimeout(clientCacheTimer);
  clientCacheTimer = setTimeout(saveClientCache, 400);
}

function saveClientCache() {
  if (!state.data || state.fromCache) return;
  try {
    const data = { ...state.data };
    if (data.cliSync) data.cliSync = { harness: data.cliSync.harness || null, workBuddy: data.cliSync.workBuddy || null };
    localStorage.setItem(CLIENT_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data, logs: state.logs, overview: state.overview }));
  } catch {}
}

function applyClientCache(cache) {
  try {
    state.fromCache = true;
    state.data = cache.data;
    state.logs = cache.logs || { logs: [], summary: {} };
    state.overview = cache.overview || null;
    render();
    if (state.overview) renderOverviewCharts();
    const dataAt = cache.data.aggregate?.lastSync || new Date(cache.savedAt).toISOString();
    setServiceStatus('connecting');
    setSyncText('正在获取最新数据…');
    setDegraded(`正在显示 ${timeLabel(dataAt)} 的缓存数据，正在自动更新`, false);
  } catch (error) {
    try { localStorage.removeItem(CLIENT_CACHE_KEY); } catch {}
    state.fromCache = false;
    state.data = null;
    state.logs = { logs: [], summary: {} };
    state.overview = null;
  }
}

async function bootstrap() {
  if (state.booting) return;
  state.booting = true;
  setServiceStatus('connecting');
  const cached = readClientCache();
  if (cached) applyClientCache(cached);
  else setSyncText('正在读取本地数据…');
  try {
    const initial = await request('/api/stations');
    state.data = initial;
    state.fromCache = false;
    render();
    const [logsResult, overviewResult] = await Promise.allSettled([
      request(`/api/logs?${logQuery()}`),
      refreshOverviewData()
    ]);
    if (logsResult.status === 'fulfilled') state.logs = applyLogTypeFilter(logsResult.value);
    if (overviewResult.status === 'fulfilled' && overviewResult.value) {
      state.overview = overviewResult.value;
      renderOverviewCharts();
    }
    render();
    startTimer(state.data.settings.refreshMinutes);
    if (state.page === 'calls') await loadCurrentHistory();
    startHeartbeat();
    setServiceStatus('online');
    setSyncText('');
    state.booting = false;
    if (logsResult.status !== 'fulfilled') showToast(`调用日志读取失败：${humanizeError(logsResult.reason?.message)}`, 'error');
    runFullSync({ silent: true });
  } catch (error) {
    state.booting = false;
    setServiceStatus('offline');
    updateTrustUI();
    setSyncText('');
    const detail = humanizeError(error.message);
    if (state.data) {
      setDegraded(`无法连接本地服务，当前显示缓存数据；正在重试：${detail}`, true);
      showToast('无法连接本地服务，已显示缓存数据', 'error');
      startTimer(state.data.settings.refreshMinutes);
    } else {
      setDegraded(`无法连接本地服务：${detail}`, true);
      showToast(`无法连接本地服务：${detail}`, 'error');
    }
    startHeartbeat();
  }
}

function setCcSwitchModal(open) { $('#ccSwitchModal').hidden = !open; }
function renderCcSwitchCandidates() {
  const candidates = state.ccSwitchCandidates;
  $('#ccSwitchCandidateCount').textContent = `${candidates.length} 个可导入配置`;
  $('#ccSwitchCandidates').innerHTML = candidates.map((candidate) => `<label class="import-candidate"><input type="checkbox" name="ccSwitchCandidate" value="${escapeHtml(candidate.id)}" checked><span><strong>${escapeHtml(candidate.name)}</strong><small>${escapeHtml(candidate.baseUrl)}</small></span><span class="import-app">${escapeHtml(candidate.sourceApp)}</span></label>`).join('') || '<div class="import-empty">没有找到可导入的 OpenAI 兼容配置。</div>';
}
async function openCcSwitchImport() {
  setCcSwitchModal(true);
  $('#ccSwitchImportSource').textContent = '正在读取 CC Switch 配置…';
  $('#ccSwitchCandidates').innerHTML = '';
  try {
    const result = await request('/api/import/cc-switch');
    state.ccSwitchCandidates = result.candidates || [];
    $('#ccSwitchImportSource').textContent = `来源：${result.sourcePath}`;
    renderCcSwitchCandidates();
  } catch (error) {
    state.ccSwitchCandidates = [];
    $('#ccSwitchImportSource').textContent = error.message;
    renderCcSwitchCandidates();
    showToast(error.message, 'error');
  }
}

function renderSourceAttribution() {
  const status = state.data?.sourceAttribution;
  if (!status) return;
  $('#sourceAttributionAlert').hidden = status.unresolvedCount === 0;
  $('#sourceAttributionAlertText').textContent = `${status.unresolvedCount} 个来源、${tokenCount(status.recordCount)} 条记录尚未确认归属。全部处理后提醒才会解除。`;
}
let attributionRequestId = 0;
async function refreshSourceAttribution() {
  const id = ++attributionRequestId;
  try {
    const result = await request('/api/source-attribution');
    if (id !== attributionRequestId || !state.data) return;
    state.data.sourceAttribution = result; renderSourceAttribution();
  } catch { /* Keep the last known alert until a successful read confirms resolution. */ }
}
let attributionReturnFocus = null;
function populateAttributionForm(selected = '') {
  const status = state.data?.sourceAttribution || { unresolved: [], mappings: [], unresolvedCount: 0 };
  const source = $('#attributionSource'); source.replaceChildren();
  const pending = document.createElement('optgroup'); pending.label = '待处理来源';
  status.unresolved.forEach(group => pending.append(new Option(`${group.source} · ${group.count} 条`, group.source)));
  if (pending.children.length) source.append(pending);
  const mapped = document.createElement('optgroup'); mapped.label = '已映射（可重新指定）';
  status.mappings.filter(rule => !status.unresolved.some(group => group.source === rule.source))
    .forEach(rule => mapped.append(new Option(`${rule.source} → ${rule.stationName}`, rule.source)));
  if (mapped.children.length) source.append(mapped);
  if ([...source.options].some(option => option.value === selected)) source.value = selected;
  const target = $('#attributionTarget');
  target.replaceChildren(new Option('请选择归属中转', ''), ...(state.data?.stations || []).map(station => new Option(`${station.name}${station.ghost ? '（幽灵）' : ''}`, station.id)));
  $('#sourceAttributionSummary').textContent = status.unresolvedCount
    ? `还有 ${status.unresolvedCount} 个陌生来源待处理。可逐个映射，或添加为普通 / 幽灵中转。`
    : '没有待处理来源。已保存的归属规则会用于后续同名调用，也可以在这里重新指定。';
  $('#saveSourceAttribution').disabled = source.options.length === 0;
  $('#attributionSource').disabled = source.options.length === 0;
  updateAttributionSelection();
}
function updateAttributionSelection() {
  const source = $('#attributionSource').value, status = state.data?.sourceAttribution;
  const pending = status?.unresolved.find(group => group.source === source);
  const mapping = status?.mappings.find(rule => rule.source === source);
  $('#attributionSourceDetail').textContent = pending
    ? `${tokenCount(pending.count)} 条记录 · ${tokenCount(pending.tokens)} Token · ${pending.apps.join(' / ')}`
    : mapping ? `当前归属：${mapping.stationName}。重新指定会同步迁移该来源的历史调用。` : '';
  $('#attributionAction').value = 'map';
  $('#attributionTarget').value = mapping?.stationId || '';
  $('#attributionName').value = source;
  $('#attributionUrl').value = '';
  $('#attributionGhost').checked = false;
  updateAttributionFields();
}
function updateAttributionFields() {
  const create = $('#attributionAction').value === 'create', ghost = $('#attributionGhost').checked;
  $('#attributionTargetField').hidden = create;
  $('#attributionTarget').required = !create; $('#attributionTarget').disabled = create;
  $('#attributionCreateFields').hidden = !create;
  $('#attributionName').required = create; $('#attributionName').disabled = !create;
  $('#attributionUrl').required = create && !ghost; $('#attributionUrl').disabled = !create || ghost;
}
async function openSourceAttribution() {
  attributionReturnFocus = document.activeElement;
  await refreshSourceAttribution(); populateAttributionForm();
  $('#sourceAttributionStatus').textContent = '';
  $('#sourceAttributionModal').hidden = false;
  $('#attributionSource').focus();
}
function closeSourceAttribution() {
  if ($('#sourceAttributionForm').dataset.saving === 'true') return;
  $('#sourceAttributionModal').hidden = true;
  if (attributionReturnFocus?.isConnected) attributionReturnFocus.focus();
}
$('#resolveUnknownSources').addEventListener('click', openSourceAttribution);
$('#manageSourceMappings').addEventListener('click', openSourceAttribution);
$('#attributionSource').addEventListener('change', updateAttributionSelection);
$('#attributionAction').addEventListener('change', updateAttributionFields);
$('#attributionGhost').addEventListener('change', updateAttributionFields);
$('#closeSourceAttribution').addEventListener('click', closeSourceAttribution);
$('#cancelSourceAttribution').addEventListener('click', closeSourceAttribution);
$('#sourceAttributionModal').addEventListener('click', event => { if (event.target.id === 'sourceAttributionModal') closeSourceAttribution(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#sourceAttributionModal').hidden) closeSourceAttribution(); });
$('#sourceAttributionForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.saving === 'true') return;
  const input = { source: $('#attributionSource').value, action: $('#attributionAction').value,
    stationId: $('#attributionTarget').value, name: $('#attributionName').value,
    baseUrl: $('#attributionGhost').checked ? '' : $('#attributionUrl').value, ghost: $('#attributionGhost').checked };
  form.dataset.saving = 'true';
  const controls = [...$('#sourceAttributionModal').querySelectorAll('input, select, button')];
  controls.forEach(control => { control.disabled = true; });
  $('#sourceAttributionStatus').textContent = '正在保存归属并更新历史记录…';
  let saved = false;
  try {
    const result = await request('/api/source-attribution', { method: 'POST', body: JSON.stringify(input), timeoutMs: 60000 });
    saved = true;
    attributionRequestId++; logRequestId++;
    state.data = result;
    state.logs = { logs: [], summary: {} };
    $('#logSourceFilter').value = ''; saveLogFilters();
    render();
    await searchLogs(); await loadOverview();
    if (state.page === 'calls') await loadCurrentHistory();
    $('#sourceAttributionStatus').textContent = `已归属 ${tokenCount(result.movedCount)} 条记录。${result.sourceAttribution.unresolvedCount ? `还有 ${result.sourceAttribution.unresolvedCount} 个来源待处理。` : '全部陌生来源已处理，提醒已解除。'}`;
  } catch (error) { $('#sourceAttributionStatus').textContent = `保存失败：${humanizeError(error.message)}`; }
  finally {
    form.dataset.saving = 'false'; controls.forEach(control => { control.disabled = false; });
    if (saved) populateAttributionForm();
    else updateAttributionFields();
  }
});

function render() {
  if (!state.data) return;
  renderSourceAttribution();
  const { aggregate, stations, settings } = state.data;
  const active = stations.filter((station) => !station.disabled);
  const onlineActive = active.filter((station) => (station.modelStatus || station.status) === 'online').length;
  const usageOnlineActive = active.filter((station) => station.usageStatus === 'online').length;
  renderOverviewBalances(stations);
  $('#totalTokens').textContent = tokenCount(aggregate.totalTokens);
  $('#totalTokensCompact').textContent = compact(aggregate.totalTokens);
  const buckets = aggregate.tokenBreakdown || { input: 0, output: 0, cache: 0 };
  $('#overviewTokenBreakdown').textContent = `输入 ${compact(buckets.input)} · 输出 ${compact(buckets.output)} · 缓存 ${compact(buckets.cache)}`;
  if (aggregate.historyAdjustment?.tokens) $('#overviewTokenBreakdown').textContent += ` · 校正 ${signedTokens(aggregate.historyAdjustment.tokens)}`;
  $('#overviewTokenBreakdown').title = `输入 ${tokenCount(buckets.input)} · 输出 ${tokenCount(buckets.output)} · 缓存读取 ${tokenCount(buckets.cacheRead)} · 缓存创建 ${tokenCount(buckets.cacheWrite)}`;
  $('#todaySpend').innerHTML = currencyLines(aggregate.quotaConsumedByUnit);
  $('#totalSpend').innerHTML = Object.keys(aggregate.totalSpendByUnit || {}).length ? currencyLines(aggregate.totalSpendByUnit) : '<span>0.00</span>';
  const warningCount = stations.filter(station => !MonitorChannels.isOfficialStation(station) && stationAlert(station).active).length;
  $('#stationAlertBadge').hidden = warningCount === 0;
  $('#stationAlertBadge').setAttribute('aria-label', `${warningCount} 个中转站额度警告`);
  $('#stationAlertBadge').title = `${warningCount} 个中转站额度偏低`;
  $('#alertSettingState').textContent = settings.balanceAlerts?.enabled === false ? '已关闭' : warningCount ? `${warningCount} 项警告` : '已开启';
  $('#modelSummary').textContent = `${aggregate.modelCount} 个模型可用`;
  $('#usageStatusSummary').textContent = `${usageOnlineActive} / ${active.length} 正常`;
  $('#activeStations').textContent = `${onlineActive} / ${active.length}`;
  $('#availableModels').textContent = tokenCount(aggregate.modelCount);
  $('#healthScore').textContent = `${active.length ? Math.round((onlineActive / active.length) * 100) : 0}%`;
  $('#healthBar').style.width = `${active.length ? (onlineActive / active.length) * 100 : 0}%`;
  const healthBadge = $('#healthBadge');
  healthBadge.className = `health-badge ${active.length && onlineActive === active.length ? 'online' : 'pending'}`;
  healthBadge.textContent = !active.length ? '● 等待添加站点' : onlineActive === active.length ? '● 模型接口正常' : onlineActive ? '● 部分接口异常' : '● 接口异常';
  $('#refreshLabel').textContent = settings.refreshMinutes === 60 ? '每 1 小时' : `每 ${settings.refreshMinutes} 分钟`;
  $('#refreshSelect').value = String(settings.refreshMinutes);
  updateTrustUI();
  renderStations(stations);
  renderHistoryOptions();
  renderLogs(state.logs.logs, state.logs.summary);
  scheduleClientCache();
}

function renderStations(stations) {
  window.WebWorkbench?.beforeStations();
  const renderCard = station => {
    const quota = QuotaPolicy.present(station);
    const alert = stationAlert(station, quota);
    const disabled = station.disabled === true;
    const statusClass = station.modelStatus || station.status || 'unknown';
    const rawError = station.usageError || station.lastError || '';
    const friendlyError = humanizeError(rawError);
    const error = friendlyError
      ? `<p class="station-error" title="${escapeHtml(rawError)}">${escapeHtml(friendlyError)}<button class="text-button retry-link" type="button" data-action="refresh">重试</button></p>` : '';
    const plans = Array.isArray(station.usagePlans) ? station.usagePlans : [];
    const planDetails = plans.length ? `<details class="usage-plan-details"><summary>额度明细 <span>${plans.length} 项</span></summary><div class="usage-plan-list">${plans.map((plan) => `<div class="usage-plan"><strong>${escapeHtml(QuotaPolicy.planName(plan))}</strong><span>剩余 ${money(plan.remaining, plan.unit || station.balanceUnit)}</span><span>已用 ${money(plan.used, plan.unit || station.balanceUnit)}</span><span>总额 ${money(plan.total, plan.unit || station.balanceUnit)}</span>${plan.extra ? `<small>${escapeHtml(plan.extra)}</small>` : ''}</div>`).join('')}</div></details>` : '';
    const proxyUrl = `${window.location.origin}/api/stations/${encodeURIComponent(station.id)}/proxy/v1`;
    const paused = disabled ? `<span class="station-paused-badge">${station.ghost ? '幽灵中转 · 仅记录' : '监控已暂停'}</span>` : '';
    return `<article class="station-card ${alert.active ? 'balance-warning' : ''} ${disabled ? 'is-disabled' : ''}" data-station-id="${station.id}">
      <div class="station-card-top"><div class="station-name-wrap"><div class="station-logo">${escapeHtml(stationInitial(station.name))}</div><div><h3 class="station-name">${escapeHtml(station.name)}</h3><p class="station-url" title="${escapeHtml(station.baseUrl)}">${escapeHtml(station.baseUrl || (station.ghost ? '未设置 URL · 不发起监控请求' : ''))}</p></div></div><div class="station-actions">${disabled ? '' : `<button class="mini-button" data-action="refresh" title="刷新此站点" aria-label="刷新站点 ${escapeHtml(station.name)}">↻</button>`}<button class="mini-button" data-action="edit" title="编辑站点" aria-label="编辑站点 ${escapeHtml(station.name)}">⋯</button></div></div>
      ${paused}
      ${disabled ? `<div class="station-status-grid"><span class="station-status paused">${station.ghost ? '仅保留调用记录与历史统计，不监控' : '监控已暂停，刷新时自动跳过'}</span></div>` : `<div class="station-status-grid"><span class="station-status ${statusClass}">模型接口：${modelStatusLabel(station)}</span><span class="station-usage-status ${station.usageStatus || 'unknown'}">用量查询：${usageStatusLabel(station)}</span></div>`}
      <div class="station-metric"><p class="station-balance">${money(quota.remaining, quota.unit)}</p><span class="station-source">${escapeHtml(station.metricsSource || '未设置来源')}</span></div>
      ${renderQuota(quota, station)}${alert.active ? `<p class="balance-alert-reason">${escapeHtml(alert.reasons.join(' · '))}</p>` : ''}
      <div class="station-history-totals" aria-label="${escapeHtml(station.name)}历史累计用量">
        <div><span>历史额度消耗</span><strong>${Object.keys(station.historyQuotaByUnit || {}).length ? groupedMoney(station.historyQuotaByUnit) : money(station.totalSpend, station.balanceUnit)}</strong></div>
        <div><span>历史 Token 合计</span><strong>${tokenCount(station.tokens)}</strong></div>
      </div>
      <div class="station-token-breakdown"><span>输入 <strong>${tokenCount(station.tokenBreakdown?.input)}</strong></span><span>输出 <strong>${tokenCount(station.tokenBreakdown?.output)}</strong></span><span>缓存读 <strong>${tokenCount(station.tokenBreakdown?.cacheRead)}</strong></span><span>缓存写 <strong>${tokenCount(station.tokenBreakdown?.cacheWrite)}</strong></span></div>
      ${station.historyAdjustment?.tokens ? `<p class="history-note">调用日志合计 ${tokenCount(station.tokenBreakdown.total)} · 历史校正 ${signedTokens(station.historyAdjustment.tokens)} Token</p>` : ''}
      <div class="station-history-links"><button class="text-button" type="button" data-action="show-quota-history">额度消耗日志 →</button><button class="text-button" type="button" data-action="show-token-history">Token 消耗日志 →</button></div>
      <div class="station-footer"><span>当前额度已用 <strong>${money(station.quotaConsumed, station.balanceUnit)}</strong></span><span>${station.modelCount || 0} 个模型 · ${tokenCount(station.callCount || 0)} 条调用</span></div>${planDetails}${station.ghost ? '' : `<div class="station-proxy" title="将此地址填入客户端的 Base URL">客户端 Base URL <code>${escapeHtml(proxyUrl)}</code></div>`}${disabled ? '' : error}
      <details class="station-history-menu"><summary title="更多站点设置">更多设置</summary>
        <button class="text-button" type="button" data-action="export-history">导出历史消耗</button>
        <button class="text-button" type="button" data-action="calibrate">历史消耗校准</button>
        <button class="text-button" type="button" data-action="show-correction-history">校正记录</button>
        ${station.ghost ? '<button class="text-button" type="button" data-action="edit">补充 URL / 转为普通中转</button>' : `<button class="text-button" type="button" data-action="toggle-disabled">${disabled ? '恢复监控' : '暂停监控'}</button>`}
        <button class="text-button danger-text" type="button" data-action="delete">删除站点</button>
      </details>
    </article>`;
  };
  $('#officialStationGrid').innerHTML = stations.filter(MonitorChannels.isOfficialStation).map(renderCard).join('') || '<p class="analytics-caption">还没有连接 DeepSeek 官方 API 账号。</p>';
  $('#stationGrid').innerHTML = stations.filter(station => !MonitorChannels.isOfficialStation(station)).map(renderCard).join('') || '<div class="empty-row empty-stations">还没有中转站。<button class="text-button" type="button" data-action="import">从 CC Switch 导入</button>或点击「添加中转站」开始。</div>';
  window.WebWorkbench?.afterStations(stations);
}

function renderQuota(quota, station) {
  const alert = stationAlert(station, quota);
  const mode = { daily: '每日额度', weekly: '每周额度', prepaid: '充值余额' }[quota.mode];
  const status = quota.state === 'unknown' ? '未获取' : quota.stale ? '上次数据'
    : quota.state === 'depleted' ? '额度已用完' : alert.active ? '余额偏低' : '余额正常';
  const period = quota.mode !== 'prepaid';
  const value = period ? quota.percent === null ? '未获取' : `剩余 ${Number(quota.percent.toFixed(1))}%` : status;
  const limit = period ? `${money(quota.remaining, quota.unit)} / ${money(quota.limit, quota.unit)}`
    : quota.lowBalanceThreshold !== null ? `提醒线 ${money(quota.lowBalanceThreshold, quota.unit)}` : '';
  const progress = !period ? '' : quota.percent === null ? '<div class="meter quota-unknown" aria-label="剩余额度未获取"></div>'
    : `<div class="meter quota-meter ${quota.stale ? 'quota-stale' : quota.state}" role="progressbar" aria-label="剩余额度百分比" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${quota.percent}"><span style="width:${quota.percent}%"></span></div>`;
  const timestamp = quota.stale && station.balanceUpdatedAt ? ` · ${timeLabel(station.balanceUpdatedAt)}` : '';
  return `<div class="quota-summary ${quota.stale ? 'stale' : quota.state === 'unknown' ? 'unknown' : alert.active ? 'low' : 'normal'}"><span>${mode}</span><strong>${value}</strong></div>${progress}
    <div class="quota-caption"><span>${escapeHtml(quota.sourceLabel)}</span><span>${limit}</span></div>
    ${quota.reason || quota.overLimit || (period && quota.stale) ? `<p class="quota-note">${escapeHtml(quota.reason || (quota.stale ? `${status}${timestamp}` : '剩余额度高于设置的周期上限'))}</p>` : ''}
    ${!period && quota.stale ? `<p class="quota-note">上次数据${escapeHtml(timestamp)}</p>` : ''}`;
}

function renderLogs(logs, summary = {}) {
  const pagination = state.logs.pagination;
  $('#logPagination').hidden = !pagination;
  if (pagination) {
    logPage = pagination.page;
    $('#logPageLabel').textContent = `第 ${pagination.page} / ${pagination.pages} 页 · 共 ${tokenCount(pagination.total)} 条`;
    $('#logPreviousPage').disabled = pagination.page <= 1;
    $('#logNextPage').disabled = pagination.page >= pagination.pages;
  }
  state.logIndex = new Map(logs.map((log) => [String(log.id), log]));
  $('#logUsage').textContent = groupedMoney(summary.usageByUnit, summary.usage);
  $('#logRpm').textContent = tokenCount(summary.requestCount ?? summary.count ?? 0);
  $('#logTpm').textContent = compact(summary.tokenCount ?? summary.tpm ?? 0);
  $('#logTpm').title = tokenCount(summary.tokenCount ?? 0);
  $('#logPricingStatus').textContent = [summary.pricing?.updatedAt ? `models.dev · ${new Date(summary.pricing.updatedAt).toLocaleString('zh-CN')}` : '模型参考价格／站点回退价格', summary.pricing?.error || '', summary.unpricedCount ? `${summary.unpricedCount} 条缺少价格` : ''].filter(Boolean).join(' · ');
  const harness = state.data?.cliSync?.harness;
  const hint = $('.log-hint');
  hint.textContent = harness?.status === 'online' ? `本地代理 / Codex / Claude Code / Harness（${harness.scanned} 条）`
    : harness?.status === 'partial' || harness?.status === 'error' ? `Harness 部分记录未读取（${harness.warnings?.length || 0} 项诊断）` : '数据来自本地代理与 CLI usage';
  hint.title = harness?.warnings?.map(warning => warning.reason).join('；') || '';
  const wb = state.data?.cliSync?.workBuddy;
  if (wb) {
    const status = { missing: '未找到会话目录', error: '目录读取失败', partial: `${wb.scanned} 条，部分记录未读取`, online: `${wb.scanned} 条` };
    hint.textContent += ` / WorkBuddy（${status[wb.status] || '未知'}）`;
  }
  const selectedSource = $('#logSourceFilter').value;
  $('#logSourceFilter').querySelectorAll('option:not(:first-child)').forEach((option) => option.remove());
  const sourceOptions = [...new Set([...state.data?.stations?.map(station => station.name) || [], ...state.logs.sources || [], ...logs.map(log => log.source)].filter(Boolean))].sort();
  sourceOptions.forEach((source) => {
    const option = document.createElement('option'); option.value = source; option.textContent = source; $('#logSourceFilter').append(option);
  });
  $('#logSourceFilter').value = sourceOptions.includes(selectedSource) ? selectedSource : '';
  const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/\//g, '-') : '--';
  $('#callsBody').innerHTML = logs.map((log) => `<tr data-log-id="${escapeHtml(log.id)}">
    <td><span class="source-cell"><i class="source-bullet"></i><strong>${escapeHtml(log.source)}</strong></span></td>
    <td class="source-app-cell">${escapeHtml(log.sourceApp || (log.sourceType === 'codex-cli' ? 'Codex' : log.sourceType === 'claude-cli' ? 'Claude Code' : '本地代理'))}</td>
    <td class="time-cell">${log.sourceType === 'manual-adjustment' ? '2000-01-01 00:00（北京时间）' : formatDate(log.timestamp)}</td>
    <td><span class="token-badge">${escapeHtml(log.token || '本地代理')}</span></td>
    <td class="model-cell">${escapeHtml(log.model)}</td>
    <td><span class="stream-badge ${log.stream === true ? 'is-stream' : ''}">${log.stream === null ? '用量同步' : log.stream ? '流' : '非流'}</span><small class="tps-label">${log.stream === true && log.tps !== null ? `${log.tps} t/s` : ''}</small></td>
    <td class="dual-cell"><strong>${tokenCount(log.inputTokens)}</strong><span>/ ${tokenCount(log.outputTokens)}</span></td>
    <td class="dual-cell"><strong>${tokenCount(log.cacheReadTokens)}</strong><span>/ ${tokenCount(log.cacheWriteTokens)}</span></td>
    <td class="token-total-cell">${tokenCount(log.tokens)}</td>
    <td class="hit-cell">${log.cacheHitRate.toFixed(1)}%</td>
    <td><span class="reasoning-badge ${log.reasoning}">${escapeHtml(log.reasoning)}</span></td>
    <td class="cost-cell" title="${escapeHtml(log.pricingModel || log.pricingSource || (log.costSource === 'manual' ? '历史校准，不计入日志统计' : '站点价格'))}">${log.costSource === 'estimated' ? '≈ ' : ''}${DashboardFormat.money(log.cost, log.costUnit, 6)}<small>${log.pricingSource === 'models.dev' ? 'models.dev' : log.pricingSource === 'unavailable' ? '无价格' : log.costSource === 'manual' ? '补录' : '站点价格'}</small></td>
    <td class="performance-cell"><span>首字 <b>${log.ttft === null ? '--' : `${log.ttft}s`}</b></span><span>耗时 <b>${log.duration === null ? '--' : `${log.duration}s`}</b></span></td>
    <td><span class="status-code ${log.statusCode === null ? 'unknown' : ''}">${log.statusCode === null ? '--' : log.statusCode}</span></td>
    <td class="detail-cell">${escapeHtml(log.detail)} <button class="detail-button" type="button" title="查看日志详情">›</button></td>
  </tr>`).join('') || '<tr><td class="empty-row" colspan="15">没有符合条件的调用日志。</td></tr>';
}

function formatHistoryDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/\//g, '-') : '--';
}

function renderHistoryOptions() {
  const select = $('#historyStationFilter');
  const selected = select.value;
  select.innerHTML = '<option value="">所有中转站</option>' + (state.data?.stations || []).map(station => `<option value="${escapeHtml(station.id)}">${escapeHtml(station.name)}</option>`).join('');
  select.value = (state.data?.stations || []).some(station => station.id === selected) ? selected : '';
}

function setHistoryTab(tab) {
  historyTab = ['token', 'quota', 'correction', 'calls'].includes(tab) ? tab : 'calls';
  $$('[data-history-tab]').forEach(button => {
    const active = button.dataset.historyTab === historyTab;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('active', active);
  });
  $$('[data-history-panel]').forEach(panel => { panel.hidden = panel.dataset.historyPanel !== historyTab; });
  $('#historyFilters').hidden = historyTab === 'calls';
  $('#historyExportToolbar').hidden = historyTab === 'calls';
  $('#historyStatus').hidden = true;
  historyRequestId++;
  if (historyTab !== 'calls') loadCurrentHistory();
}

function renderQuotaHistory(data = quotaHistory) {
  if (!data) return;
  const pagination = data.pagination;
  $('#quotaHistoryPagination').hidden = !pagination;
  if (pagination) {
    quotaHistoryPage = pagination.page;
    $('#quotaHistoryPageLabel').textContent = `第 ${pagination.page} / ${pagination.pages} 页 · 共 ${tokenCount(pagination.total)} 条`;
    $('#quotaHistoryPrevious').disabled = pagination.page <= 1; $('#quotaHistoryNext').disabled = pagination.page >= pagination.pages;
  }
  $('#quotaHistorySummary').innerHTML = `<span>筛选合计 <strong>${Object.keys(data.summary.amountByUnit || {}).length ? groupedMoney(data.summary.amountByUnit) : '0.00'}</strong></span><span>${tokenCount(data.summary.count)} 次余额下降</span>`;
  $('#quotaHistoryBody').innerHTML = data.logs.map(log => `<tr><td>${escapeHtml(log.stationName)}</td><td>${formatHistoryDate(log.periodEndAt)}</td><td>${formatHistoryDate(log.periodStartAt)}<span class="history-range-end">至 ${formatHistoryDate(log.periodEndAt)}</span></td><td title="精确金额：${escapeHtml(DashboardFormat.money(log.previousBalance, log.unit, 6))}">${DashboardFormat.money(log.previousBalance, log.unit)}</td><td title="精确金额：${escapeHtml(DashboardFormat.money(log.currentBalance, log.unit, 6))}">${DashboardFormat.money(log.currentBalance, log.unit)}</td><td class="history-amount" title="精确金额：${escapeHtml(DashboardFormat.money(log.amount, log.unit, 6))}">${DashboardFormat.money(log.amount, log.unit)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-row">暂无额度消耗记录。首次获取余额只建立基线。</td></tr>';
}

function renderTokenHistory(data = tokenHistory) {
  if (!data) return;
  const pagination = data.pagination;
  $('#tokenHistoryPagination').hidden = !pagination;
  if (pagination) {
    tokenHistoryPage = pagination.page;
    $('#tokenHistoryPageLabel').textContent = `第 ${pagination.page} / ${pagination.pages} 页 · 共 ${tokenCount(pagination.total)} 条`;
    $('#tokenHistoryPrevious').disabled = pagination.page <= 1; $('#tokenHistoryNext').disabled = pagination.page >= pagination.pages;
  }
  const s = data.summary;
  $('#tokenHistorySummary').innerHTML = `<span>总计 <strong>${tokenCount(s.total)}</strong></span><span>输入 ${tokenCount(s.input)}</span><span>输出 ${tokenCount(s.output)}</span><span>缓存读取 ${tokenCount(s.cacheRead)}</span><span>缓存创建 ${tokenCount(s.cacheWrite)}</span>`;
  $('#tokenHistoryBody').innerHTML = data.logs.map(log => {
    const total = Number(log.inputTokens || 0) + Number(log.outputTokens || 0) + Number(log.cacheReadTokens || 0) + Number(log.cacheWriteTokens || 0);
    return `<tr><td>${escapeHtml(log.source)}</td><td>${formatHistoryDate(log.timestamp)}</td><td>${escapeHtml(log.model)}</td><td>${tokenCount(log.inputTokens)}${log.breakdownEstimated ? '<small class="history-range-end">旧记录总量归入输入</small>' : ''}</td><td>${tokenCount(log.outputTokens)}</td><td>${tokenCount(log.cacheReadTokens)}</td><td>${tokenCount(log.cacheWriteTokens)}</td><td class="history-amount">${tokenCount(total)}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="empty-row">暂无 Token 调用日志。</td></tr>';
}

function signedTokens(value) { return `${Number(value) >= 0 ? '+' : ''}${tokenCount(value)}`; }
function renderCorrectionHistory(data) {
  const p = data.pagination;
  correctionHistoryPage = p.page;
  $('#correctionHistoryPagination').hidden = false;
  $('#correctionHistoryPageLabel').textContent = `第 ${p.page} / ${p.pages} 页 · 共 ${tokenCount(p.total)} 条`;
  $('#correctionHistoryPrevious').disabled = p.page <= 1;
  $('#correctionHistoryNext').disabled = p.page >= p.pages;
  $('#correctionHistorySummary').textContent = `校正差额：${groupedMoney(data.summary.amountByUnit, 0)} · ${signedTokens(data.summary.tokens)} Token · ${data.summary.count} 条`;
  $('#correctionHistoryBody').innerHTML = data.logs.map(log => `<tr><td>${escapeHtml(log.stationName)}</td><td>${formatHistoryDate(log.createdAt)}<small class="history-range-end">${log.source === 'legacy' ? '旧校正迁移' : '手动校正'}</small></td><td>${money(log.previousAmount, log.unit)} → ${money(log.targetAmount, log.unit)}</td><td title="${escapeHtml(DashboardFormat.money(log.amount, log.unit, 6))}">${log.amount >= 0 ? '+' : ''}${money(log.amount, log.unit)}</td><td>${tokenCount(log.previousTokens)} → ${tokenCount(log.targetTokens)}</td><td>${signedTokens(log.tokens)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-row">暂无历史校正记录。</td></tr>';
}

async function loadCurrentHistory() {
  if (historyTab === 'calls') return;
  renderHistoryOptions();
  const tab = historyTab;
  const requestId = ++historyRequestId;
  const prefix = tab;
  const columns = tab === 'token' ? 8 : 6;
  const params = new URLSearchParams({ page: tab === 'quota' ? quotaHistoryPage : tab === 'correction' ? correctionHistoryPage : tokenHistoryPage, pageSize: '100', range: $('#historyRangeFilter').value });
  if ($('#historyStationFilter').value) params.set('stationId', $('#historyStationFilter').value);
  $('#historyStatus').hidden = false;
  $('#historyStatus').textContent = '正在读取记录…';
  $(`#${prefix}HistorySummary`).textContent = '';
  $(`#${prefix}HistoryBody`).innerHTML = `<tr><td colspan="${columns}" class="empty-row">正在读取…</td></tr>`;
  $(`#${prefix}HistoryPagination`).hidden = true;
  try {
    const data = await request(`/api/history/${tab === 'quota' ? 'quota' : tab === 'correction' ? 'corrections' : 'tokens'}?${params}`);
    if (requestId !== historyRequestId) return;
    if (tab === 'quota') { quotaHistory = data; renderQuotaHistory(); }
    else if (tab === 'correction') renderCorrectionHistory(data);
    else { tokenHistory = data; renderTokenHistory(); }
    $('#historyStatus').hidden = true;
  } catch (error) {
    if (requestId !== historyRequestId) return;
    $('#historyStatus').textContent = `记录读取失败：${humanizeError(error.message)}，可点击“刷新记录”重试。`;
    $(`#${prefix}HistoryBody`).innerHTML = `<tr><td colspan="${columns}" class="empty-row">记录未读取</td></tr>`;
  }
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function refreshFeedback(results = []) {
  const list = results.filter(Boolean);
  if (!list.length) return { message: '没有可刷新的站点', type: 'error' };
  const missing = list.filter((item) => item.modelStatus === 'missing').length;
  const timedOut = list.filter((item) => /超时|timeout/i.test(item.lastError || '')).length;
  const modelErrors = list.filter((item) => item.modelStatus === 'error').length;
  const usageErrors = list.filter((item) => item.usageStatus === 'error').length;
  const usageUnconfigured = list.filter((item) => item.usageStatus === 'unconfigured').length;
  if (missing) return { message: `${missing} 个站点缺少 API Key`, type: 'error' };
  if (timedOut) return { message: `${timedOut} 个站点请求超时`, type: 'error' };
  if (modelErrors) return { message: `${modelErrors} 个站点模型接口失败`, type: 'error' };
  if (usageErrors) return { message: `模型接口正常，但 ${usageErrors} 个站点用量接口失败`, type: 'error' };
  if (usageUnconfigured) return { message: `模型接口正常，${usageUnconfigured} 个站点未配置用量接口`, type: 'success' };
  const skipped = list.filter((item) => item.skipped || item.modelStatus === 'paused').length;
  const base = list.length === 1 ? '站点已完成同步' : '全部站点已完成同步';
  return { message: skipped ? `${base}（跳过 ${skipped} 个暂停站点）` : base, type: 'success' };
}

function formStationPayload({ includeCredentials = false } = {}) {
  const apiKey = $('#stationApiKey').value.trim();
  const statsToken = $('#stationStatsToken').value.trim();
  const payload = {
    name: $('#stationName').value.trim(),
    tokenName: $('#stationTokenName').value.trim(),
    baseUrl: $('#stationBaseUrl').value.trim(),
    ghost: $('#stationGhost').checked,
    balanceUnit: $('#stationBalanceUnit').value,
    quotaPolicy: QuotaPolicy.normalize({
      mode: $('#stationQuotaMode').value,
      limit: $('#stationQuotaLimit').value,
      lowBalanceThreshold: $('#stationQuotaThreshold').value,
      source: $('#stationQuotaSource').value
    }),
    statsUrl: $('#stationStatsUrl').value.trim(),
    statsUserId: $('#stationStatsUserId').value.trim(),
    usageScriptEnabled: $('#stationUsageScriptEnabled')?.checked === true,
    usageScript: $('#stationUsageScript')?.value || '',
    pricing: {
      input: Number($('#stationPriceInput').value),
      output: Number($('#stationPriceOutput').value),
      cacheRead: Number($('#stationPriceCacheRead').value),
      cacheWrite: Number($('#stationPriceCacheWrite').value)
    }
  };
  if (includeCredentials || apiKey) payload.apiKey = apiKey;
  if (includeCredentials || statsToken) payload.statsToken = statsToken;
  return payload;
}

async function loadUsageTemplate() {
  if ($('#stationGhost').checked) return;
  const editor = $('#stationUsageScript');
  if (!editor) return;
  const requestId = ++usageTemplateRequest;
  const stationId = $('#stationId').value;
  const payload = {
    stationId: stationId || undefined,
    name: $('#stationName').value.trim() || '用量查询',
    baseUrl: $('#stationBaseUrl').value.trim(),
    statsUrl: $('#stationStatsUrl').value.trim(),
    balanceUnit: $('#stationBalanceUnit').value
  };
  $('#usageCodeStatus').textContent = '正在读取默认配置…';
  try {
    const result = await request('/api/usage/template', { method: 'POST', body: JSON.stringify(payload) });
    if (requestId !== usageTemplateRequest || editor.dataset.dirty === 'true') return;
    editor.value = result.code || '';
    editor.dataset.template = editor.value;
    $('#usageCodeStatus').textContent = '默认配置，可编辑';
  } catch (error) {
    if (requestId === usageTemplateRequest) $('#usageCodeStatus').textContent = error.message;
  }
}

function usageTestPayload() {
  const payload = formStationPayload({ includeCredentials: !$('#stationId').value });
  if ($('#stationId').value) payload.stationId = $('#stationId').value;
  payload.usageScriptEnabled = true;
  return payload;
}

async function testUsageQuery() {
  const button = $('#testUsageButton');
  const result = $('#usageTestResult');
  button.disabled = true;
  result.className = 'test-result checking';
  result.textContent = '正在读取用量接口…';
  try {
    const data = await request('/api/usage/test', { method: 'POST', body: JSON.stringify(usageTestPayload()) });
    result.className = 'test-result success';
    result.textContent = `查询成功 · 余额 ${money(data.balance, data.unit)} · 已用 ${money(data.used, data.unit)}`;
    $('#usageCodeStatus').textContent = '测试成功';
  } catch (error) {
    result.className = 'test-result error';
    result.textContent = error.message;
  } finally {
    button.disabled = $('#stationGhost').checked;
  }
}

async function testStationConnection() {
  const button = $('#testStationButton');
  const resultElement = $('#stationTestResult');
  const stationId = $('#stationId').value;
  let payload;
  try { payload = formStationPayload({ includeCredentials: !stationId }); }
  catch (error) {
    resultElement.className = 'test-result error';
    resultElement.textContent = error.message;
    return;
  }
  if (stationId) payload.stationId = stationId;
  if (!payload.name || !payload.baseUrl) {
    resultElement.className = 'test-result error';
    resultElement.textContent = '请先填写站点名称和地址';
    return;
  }
  button.disabled = true;
  resultElement.className = 'test-result checking';
  resultElement.textContent = '正在连接模型与用量接口…';
  try {
    const result = await request('/api/stations/test', { method: 'POST', body: JSON.stringify(payload) });
    const tested = result.test || {};
    const modelText = tested.modelStatus === 'online' ? '模型正常' : `模型${statusText(tested).replace('模型接口', '')}`;
    const usageText = tested.usageStatus === 'online' ? '用量正常' : usageStatusText(tested);
    resultElement.className = `test-result ${tested.modelStatus === 'online' ? 'success' : 'error'}`;
    resultElement.textContent = `${modelText} · ${usageText} · ${tested.modelCount || 0} 个模型 · 余额 ${money(tested.balance, tested.balanceUnit)}`;
  } catch (error) {
    resultElement.className = 'test-result error';
    resultElement.textContent = error.message;
  } finally {
    button.disabled = $('#stationGhost').checked;
  }
}

function setModal(open, station) {
  $('#stationModal').hidden = !open;
  if (!open) return;
  window.WebWorkbench?.prepareStationForm();
  $('#modalTitle').textContent = station ? '编辑中转站' : '添加中转站';
  $('#stationId').value = station?.id || '';
  $('#stationName').value = station?.name || '';
  $('#stationTokenName').value = station?.tokenName || '';
  $('#stationBaseUrl').value = station?.baseUrl || '';
  $('#stationGhost').checked = station?.ghost === true;
  updateGhostFields();
  const baseUrl = station?.baseUrl?.toLowerCase() || '';
  $('#stationBalanceUnit').value = station?.balanceUnit || (baseUrl.includes('micuapi.ai') || baseUrl.includes('deepseek.com') ? 'CNY' : 'USD');
  const policy = QuotaPolicy.normalize(station?.quotaPolicy);
  $('#stationQuotaMode').value = policy.mode;
  $('#stationQuotaLimit').value = policy.limit ?? '';
  $('#stationQuotaThreshold').value = policy.lowBalanceThreshold ?? '';
  const sources = $('#stationQuotaSource');
  sources.replaceChildren(new Option('账户余额', 'account'));
  const names = [...new Set((station?.usagePlans || []).map(QuotaPolicy.planName))];
  names.forEach((name) => sources.add(new Option(name, `plan:${name}`)));
  if (policy.source !== 'account' && !names.includes(policy.source.slice(5))) {
    sources.add(new Option(`${policy.source.slice(5)}（当前不可用）`, policy.source));
  }
  sources.value = policy.source;
  updateQuotaFields();
  $('#stationApiKey').value = '';
  $('#stationApiKey').placeholder = station?.hasApiKey ? '已保存，留空表示不修改' : 'sk-...';
  $('#stationStatsUrl').value = station?.statsUrl || '';
  $('#stationStatsToken').value = '';
  $('#stationStatsToken').placeholder = station?.hasStatsToken ? '已保存，留空表示不修改' : '访问令牌';
  $('#stationStatsUserId').value = station?.statsUserId || '';
  $('#stationUsageScriptEnabled').checked = station?.usageScriptEnabled === true;
  $('#stationUsageScript').value = station?.usageScript || '';
  $('#stationUsageScript').dataset.dirty = station?.usageScript ? 'true' : 'false';
  $('#stationUsageScript').disabled = !$('#stationUsageScriptEnabled').checked;
  $('#usageTestResult').className = 'test-result';
  $('#usageTestResult').textContent = '';
  const pricing = { ...defaultPricing, ...(station?.pricing || {}) };
  $('#stationPriceInput').value = pricing.input;
  $('#stationPriceOutput').value = pricing.output;
  $('#stationPriceCacheRead').value = pricing.cacheRead;
  $('#stationPriceCacheWrite').value = pricing.cacheWrite;
  $('#stationTestResult').className = 'test-result';
  $('#stationTestResult').textContent = '';
  loadUsageTemplate();
  $('#stationName').focus();
}
function findStation(id) { return state.data?.stations.find((station) => station.id === id); }
function updateGhostFields() {
  const ghost = $('#stationGhost').checked;
  $('#stationBaseUrl').required = !ghost;
  $('#testStationButton').disabled = ghost;
  $('#testUsageButton').disabled = ghost;
}
$('#stationGhost').addEventListener('change', updateGhostFields);

function updateQuotaFields() {
  const mode = $('#stationQuotaMode').value;
  const period = mode !== 'prepaid';
  $('#quotaLimitField').hidden = !period;
  $('#stationQuotaLimit').disabled = !period;
  $('#stationQuotaLimit').required = period;
  $('#quotaLimitLabel').textContent = mode === 'weekly' ? '每周额度' : '每日额度';
  $('#quotaThresholdField').hidden = period;
  $('#stationQuotaThreshold').disabled = period;
}

function showLogDetail(log) {
  if (!log) return;
  const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }) : '--';
  const requestType = ['codex-cli', 'claude-cli', 'deepseek-harness', 'workbuddy'].includes(log.sourceType)
    ? 'CLI usage' : log.stream === true ? '流式' : '非流式';
  const rows = [
    ['来源中转', log.source], ['来源应用', log.sourceApp || '--'], ['模型', log.model], ['时间', log.sourceType === 'manual-adjustment' ? '2000-01-01 00:00（北京时间）' : formatDate(log.timestamp)],
    ['请求类型', requestType], ['状态码', log.statusCode === null ? '--' : log.statusCode],
    ['普通输入', tokenCount(log.inputTokens)], ['普通输出', tokenCount(log.outputTokens)],
    ['缓存读取', tokenCount(log.cacheReadTokens)], ['缓存创建', tokenCount(log.cacheWriteTokens)],
    ['总 Tokens', tokenCount(log.tokens)], ['缓存命中', `${Number(log.cacheHitRate || 0).toFixed(1)}%`],
    ['估算金额', `${DashboardFormat.money(log.cost, log.costUnit, 6)}${log.costSource === 'estimated' ? '（参考估算）' : ''}`],
    ['计价来源', log.pricingSource === 'models.dev' ? `models.dev · ${log.pricingModel}` : log.pricingSource === 'unavailable' ? '未匹配价格' : log.costSource === 'manual' ? '历史校准' : '站点回退价格'],
    ['首字 / 耗时', `${log.ttft === null ? '--' : `${log.ttft}s`} / ${log.duration === null ? '--' : `${log.duration}s`}`],
    ['数据来源', log.dataSource || '--'], ['说明', log.detail], ['原始来源', log.originalSource || log.source]
  ];
  $('#logDetailList').innerHTML = rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  window.WebWorkbench?.groupLogDetail();
  $('#logDetailModal').hidden = false;
}

function setLogDetail(open) { $('#logDetailModal').hidden = !open; }

function downloadText(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
$('#exportAllStationsButton').addEventListener('click', async () => {
  const button = $('#exportAllStationsButton');
  if (button.disabled) return;
  button.disabled = true; button.textContent = '正在导出全部…';
  try {
    const data = await request('/api/history/export?kind=all&range=all', { timeoutMs: 60000 });
    downloadText(`token-watch-all-stations-${Date.now()}.json`, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
    showToast(`已导出全部 ${data.count} 个中转汇总及额度、Token、校正明细`);
  } catch (error) { showToast(`导出失败：${humanizeError(error.message)}`, 'error'); }
  finally { button.disabled = false; button.textContent = '一键导出全部中转'; }
});
let historyExportReturnFocus = null;
function openHistoryExport(stationId = '', kind = 'summary', range = 'all') {
  historyExportReturnFocus = document.activeElement;
  $('#exportHistoryStation').replaceChildren(new Option('所有中转站', ''),
    ...(state.data?.stations || []).map(station => new Option(station.name, station.id)));
  $('#exportHistoryStation').value = stationId;
  $('#exportHistoryKind').value = kind;
  $('#exportHistoryRange').value = range;
  $('#historyExportStatus').textContent = '';
  $('#historyExportModal').hidden = false;
  $('#exportHistoryStation').focus();
}
function closeHistoryExport() {
  if ($('#downloadHistoryExport').disabled) return;
  $('#historyExportModal').hidden = true;
  if (historyExportReturnFocus?.isConnected) historyExportReturnFocus.focus();
}
$('#exportStationHistoryButton').addEventListener('click', () => openHistoryExport());
$('#exportHistoryButton').addEventListener('click', () => openHistoryExport($('#historyStationFilter').value,
  { token: 'tokens', quota: 'quota', correction: 'corrections' }[historyTab], $('#historyRangeFilter').value));
$('#closeHistoryExport').addEventListener('click', closeHistoryExport);
$('#cancelHistoryExport').addEventListener('click', closeHistoryExport);
$('#historyExportModal').addEventListener('click', event => { if (event.target.id === 'historyExportModal') closeHistoryExport(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#historyExportModal').hidden) closeHistoryExport(); });
$('#historyExportForm').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('#downloadHistoryExport').disabled) return;
  const kind = $('#exportHistoryKind').value, range = $('#exportHistoryRange').value;
  const stationId = $('#exportHistoryStation').value, format = $('#exportHistoryFormat').value;
  const params = new URLSearchParams({ kind, range, stationId });
  const controls = [...$('#historyExportModal').querySelectorAll('button, select')];
  controls.forEach(control => { control.disabled = true; });
  $('#historyExportStatus').textContent = '正在读取全部匹配记录…';
  try {
    const data = await request(`/api/history/export?${params}`, { timeoutMs: 60000 });
    if (!data.count) { $('#historyExportStatus').textContent = '当前筛选没有可导出的数据。'; return; }
    const name = `token-watch-history-${kind}-${range}-${Date.now()}.${format}`;
    downloadText(name, format === 'csv' ? HistoryExportFormat.csv(data) : JSON.stringify(data, null, 2),
      format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8');
    $('#historyExportStatus').textContent = `已导出 ${data.count} ${kind === 'summary' ? '个站点汇总' : '条记录'}。`;
    showToast('历史消耗文件已生成');
  } catch (error) { $('#historyExportStatus').textContent = `导出失败：${humanizeError(error.message)}，请重试。`; }
  finally { controls.forEach(control => { control.disabled = false; }); }
});
async function exportLogs(format) {
  let logs;
  try {
    const params = logQuery(); params.set('pageSize', 'all');
    logs = applyLogTypeFilter(await request(`/api/logs?${params}`)).logs;
  } catch (error) { return showToast(error.message, 'error'); }
  if (!logs.length) return showToast('当前筛选没有可导出的日志', 'error');
  const fields = ['source', 'originalSource', 'sourceApp', 'timestamp', 'token', 'model', 'stream', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'tokens', 'cacheHitRate', 'reasoning', 'cost', 'costUnit', 'statusCode', 'ttft', 'duration', 'tps', 'dataSource', 'detail'];
  if (format === 'json') {
    downloadText(`token-watch-logs-${Date.now()}.json`, JSON.stringify(logs, null, 2), 'application/json;charset=utf-8');
    return showToast(`已导出 ${logs.length} 条日志`);
  }
  const header = fields.map(csvCell).join(',');
  const body = logs.map((log) => fields.map((field) => csvCell(log[field])).join(',')).join('\r\n');
  downloadText(`token-watch-logs-${Date.now()}.csv`, `\ufeff${header}\r\n${body}`, 'text/csv;charset=utf-8');
  showToast(`已导出 ${logs.length} 条日志`);
}

async function refreshStation(id) {
  const station = findStation(id); if (!station) return;
  try {
    const result = await request(`/api/stations/${id}/refresh`, { method: 'POST', body: '{}', timeoutMs: 60000 });
    const feedback = refreshFeedback(result.refreshResults);
    await syncAndLoadLogs();
    showToast(feedback.message, feedback.type);
  }
  catch (error) { showToast(humanizeError(error.message), 'error'); }
}
async function runFullSync({ silent = false } = {}) {
  if (state.page === 'official') refreshCodexAccount(!silent);
  if (state.syncing) return;
  if (!state.data) { bootstrap(); return; }
  let poll = null;
  try {
    state.syncing = true;
    state.syncError = '';
    document.body.classList.add('is-syncing');
    const button = $('#refreshAllButton');
    button.disabled = true;
    button.classList.add('is-loading');
    setServiceStatus('syncing');
    setSyncText(state.page === 'official' && !silent ? '正在刷新官方渠道…' : '正在刷新站点…');
    updateTrustUI();
    poll = setInterval(async () => {
      try {
        const health = await request('/api/health');
        if (health.sync?.running) {
          setSyncText(health.sync.current ? `正在刷新 ${Math.min(health.sync.done, health.sync.total)}/${health.sync.total}：${health.sync.current}` : `正在刷新 0/${health.sync.total}`);
        }
      } catch {}
    }, 700);
    const scope = !silent && state.page === 'official' ? '?channel=official' : !silent && state.page === 'stations' ? '?channel=relay' : '';
    const refreshed = await request('/api/stations/refresh-all' + scope, { method: 'POST', body: '{}', timeoutMs: 180000 });
    state.data = refreshed;
    state.fromCache = false;
    const feedback = refreshFeedback(refreshed.refreshResults);
    setSyncText('正在同步本机用量…');
    const syncResult = await request('/api/logs/sync-cli', { method: 'POST', body: '{}', timeoutMs: 120000 });
    state.data = syncResult;
    state.logs = applyLogTypeFilter(await request(`/api/logs?${logQuery()}`));
    await loadOverview();
    render();
    if (state.page === 'calls') await loadCurrentHistory();
    setServiceStatus('online');
    if (!silent) showToast(feedback.message, feedback.type);
  } catch (error) {
    state.syncError = humanizeError(error.message) || error.message;
    setServiceStatus('offline');
    if (state.data) render();
    if (!silent) showToast(state.syncError, 'error');
  } finally {
    if (poll) clearInterval(poll);
    state.syncing = false;
    document.body.classList.remove('is-syncing');
    const button = $('#refreshAllButton');
    if (button) {
      button.disabled = false;
      button.classList.remove('is-loading');
    }
    setSyncText('');
    if (state.health !== 'offline') setServiceStatus('online');
    updateTrustUI();
  }
}

function startTimer(minutes) {
  clearInterval(state.timer);
  state.timer = setInterval(() => runFullSync({ silent: true }), minutes * 60 * 1000);
}

function currentPage() { const page = window.location.hash.slice(1); return pageMeta[page] ? page : 'overview'; }
function setPage(page, { push = true } = {}) {
  const nextPage = pageMeta[page] ? page : 'overview';
  state.page = nextPage;
  if (nextPage === 'official') refreshCodexAccount();
  if (push && window.location.hash !== `#${nextPage}`) window.history.pushState({}, '', `#${nextPage}`);
  $$('.page-view').forEach((view) => {
    const active = view.dataset.page === nextPage;
    view.hidden = !active;
    view.classList.toggle('active', active);
  });
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.nav === nextPage));
  const meta = pageMeta[nextPage];
  $('#pageBreadcrumb').textContent = meta.breadcrumb;
  $('#pageTitle').textContent = meta.title;
  $('#pageDescription').textContent = meta.description;
  $('#addStationButton').hidden = nextPage === 'calls' || nextPage === 'official';
  $('#importCcSwitchButton').hidden = nextPage === 'calls' || nextPage === 'official';
  window.WebWorkbench?.setPage(nextPage);
  document.title = `${appName} · ${meta.breadcrumb}`;
  if (nextPage === 'overview') requestAnimationFrame(() => OverviewCharts.resize());
  if (nextPage === 'calls' && state.data) loadCurrentHistory();
}

function setAlertSettings(open) {
  $('#alertSettingsModal').hidden = !open;
  if (!open) { $('#openAlertSettings').focus(); return; }
  const config = BalanceAlerts.normalize(state.data?.settings?.balanceAlerts);
  $('#balanceAlertsEnabled').checked = config.enabled;
  $('#alertUsd').value = config.USD ?? '';
  $('#alertCny').value = config.CNY ?? '';
  $('#alertPercent').value = config.percent ?? '';
  $('#alertSettingsError').textContent = '';
  updateAlertInputs();
  $('#balanceAlertsEnabled').focus();
}

function updateAlertInputs() {
  ['#alertUsd', '#alertCny', '#alertPercent'].forEach(selector => { $(selector).disabled = !$('#balanceAlertsEnabled').checked; });
}

$('#openAlertSettings').addEventListener('click', () => setAlertSettings(true));
$('#closeAlertSettings').addEventListener('click', () => setAlertSettings(false));
$('#cancelAlertSettings').addEventListener('click', () => setAlertSettings(false));
$('#balanceAlertsEnabled').addEventListener('change', updateAlertInputs);
$('#alertSettingsModal').addEventListener('click', event => { if (event.target.id === 'alertSettingsModal') setAlertSettings(false); });
$('#alertSettingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#saveAlertSettings');
  button.disabled = true;
  try {
    const balanceAlerts = BalanceAlerts.normalize({ enabled: $('#balanceAlertsEnabled').checked, USD: $('#alertUsd').value, CNY: $('#alertCny').value, percent: $('#alertPercent').value });
    state.data = await request('/api/settings', { method: 'PATCH', body: JSON.stringify({ balanceAlerts }) });
    render();
    setAlertSettings(false);
    showToast('额度警告设置已保存');
  } catch (error) { $('#alertSettingsError').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#overviewBalances').addEventListener('click', event => {
  const row = event.target.closest('[data-balance-station]');
  if (!row) return;
  window.WebWorkbench?.resetStationFilters();
  setPage(MonitorChannels.isOfficialStation(findStation(row.dataset.balanceStation)) ? 'official' : 'stations');
  const card = [...$$('[data-station-id]')].find(card => card.dataset.stationId === row.dataset.balanceStation);
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});
$$('[data-overview-days]').forEach(button => button.addEventListener('click', async () => {
  state.overviewDays = Number(button.dataset.overviewDays);
  $$('[data-overview-days]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  await loadOverview();
}));
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!$('#calibrationModal').hidden) closeCalibration();
  if (!$('#alertSettingsModal').hidden) setAlertSettings(false);
  if (!$('#deleteStationModal').hidden) closeDeleteStation();
  if (!$('#logDetailModal').hidden) setLogDetail(false);
  if (!$('#stationModal').hidden) setModal(false);
  if (!$('#ccSwitchModal').hidden) setCcSwitchModal(false);
});
lucide.createIcons();

$('#refreshAllButton').addEventListener('click', () => runFullSync({ silent: false }));
$('#refreshCodexAccount').addEventListener('click', () => refreshCodexAccount(true));
$('#degradedAction').addEventListener('click', () => runFullSync({ silent: false }));
$('#addStationButton').addEventListener('click', () => setModal(true));
$('#addDeepSeekAccount').addEventListener('click', () => {
  setModal(true);
  $('#modalTitle').textContent = '添加 DeepSeek 官方账号';
  $('#stationName').value = 'DeepSeek';
  $('#stationBaseUrl').value = 'https://api.deepseek.com';
  $('#stationBalanceUnit').value = 'CNY';
});
$('#addStationInline').addEventListener('click', () => setModal(true));
$('#closeModal').addEventListener('click', () => setModal(false));
$('#cancelModal').addEventListener('click', () => setModal(false));
$('#stationModal').addEventListener('click', (event) => { if (event.target.id === 'stationModal') setModal(false); });
$('#testStationButton').addEventListener('click', testStationConnection);
$('#testUsageButton').addEventListener('click', testUsageQuery);
$('#stationUsageScriptEnabled').addEventListener('change', (event) => {
  $('#stationUsageScript').disabled = !event.target.checked;
  $('#usageCodeStatus').textContent = event.target.checked ? '已启用自定义配置' : '使用内置查询逻辑';
});
$('#stationUsageScript').addEventListener('input', (event) => {
  event.target.dataset.dirty = 'true';
  if (!$('#stationUsageScriptEnabled').checked) $('#stationUsageScriptEnabled').checked = true;
  $('#usageCodeStatus').textContent = '有未保存修改';
});
['#stationBaseUrl', '#stationStatsUrl', '#stationBalanceUnit'].forEach((selector) => {
  $(selector).addEventListener('change', () => {
    if ($('#stationUsageScript').dataset.dirty !== 'true') loadUsageTemplate();
  });
});
$('#resetUsageCodeButton').addEventListener('click', async () => {
  $('#stationUsageScript').dataset.dirty = 'false';
  await loadUsageTemplate();
  $('#usageCodeStatus').textContent = '已恢复默认配置';
});
$('#importCcSwitchButton').addEventListener('click', openCcSwitchImport);
$('#closeCcSwitchModal').addEventListener('click', () => setCcSwitchModal(false));
$('#cancelCcSwitchImport').addEventListener('click', () => setCcSwitchModal(false));
$('#ccSwitchModal').addEventListener('click', (event) => { if (event.target.id === 'ccSwitchModal') setCcSwitchModal(false); });
$('#selectAllCcSwitch').addEventListener('click', () => $$('#ccSwitchCandidates input[name="ccSwitchCandidate"]').forEach((input) => { input.checked = true; }));
$('#clearAllCcSwitch').addEventListener('click', () => $$('#ccSwitchCandidates input[name="ccSwitchCandidate"]').forEach((input) => { input.checked = false; }));
$('#confirmCcSwitchImport').addEventListener('click', async () => {
  const ids = $$('#ccSwitchCandidates input[name="ccSwitchCandidate"]:checked').map((input) => input.value);
  if (!ids.length) return showToast('请至少选择一个配置', 'error');
  try {
    const result = await request('/api/import/cc-switch', { method: 'POST', body: JSON.stringify({ ids }) });
    state.data = result;
    setCcSwitchModal(false);
    render();
    const skipped = result.skipped?.length ? `，跳过 ${result.skipped.length} 个重复配置` : '';
    showToast(`已导入 ${result.imported?.length || 0} 个配置${skipped}`);
  } catch (error) { showToast(error.message, 'error'); }
});
$('#refreshSelect').addEventListener('change', async (event) => { const minutes = Number(event.target.value); try { state.data = await request('/api/settings', { method: 'PATCH', body: JSON.stringify({ refreshMinutes: minutes }) }); startTimer(minutes); render(); showToast(`自动刷新已调整为 ${minutes === 60 ? '每 1 小时' : `每 ${minutes} 分钟`}`); } catch (error) { showToast(error.message, 'error'); } });
async function searchLogs(event, keepPage = false) {
  if (!keepPage) logPage = 1;
  const requestId = ++logRequestId;
  try { const result = applyLogTypeFilter(await request(`/api/logs?${logQuery()}`));
    if (requestId !== logRequestId) return;
    state.logs = result; renderLogs(result.logs, result.summary);
    refreshSourceAttribution();
  } catch (error) { if (requestId === logRequestId) showToast(error.message, 'error'); }
}
$('#logPreviousPage').addEventListener('click', () => { logPage = Math.max(1, logPage - 1); searchLogs(null, true); });
$('#logNextPage').addEventListener('click', () => { logPage++; searchLogs(null, true); });
$('#logSearchButton').addEventListener('click', searchLogs);
$('#refreshLogsButton').addEventListener('click', async () => { const button = $('#refreshLogsButton'); button.disabled = true; try { const result = await syncAndLoadLogs(); showToast(`已读取本地代理和 CLI 用量，扫描 ${result.scanned} 条，新增 ${result.imported.length + result.unmatched.length} 条`); } catch (error) { showToast(error.message, 'error'); } finally { button.disabled = false; } });
$('#refreshPricingButton').addEventListener('click', async () => {
  const button = $('#refreshPricingButton'); button.disabled = true;
  try { const result = await request('/api/pricing/refresh', { method: 'POST', body: '{}' }); await searchLogs(); await loadOverview(); showToast(result.error || '模型价格已更新', result.error ? 'error' : 'success'); }
  catch (error) { showToast(error.message, 'error'); } finally { button.disabled = false; }
});
$('#syncCliButton').addEventListener('click', async () => { const button = $('#syncCliButton'); button.disabled = true; try { const result = await syncAndLoadLogs(); const migrated = result.migratedCount ? `，修复历史日志 ${result.migratedCount} 条` : ''; showToast(`已读取本地代理和 CLI 用量，扫描 ${result.scanned} 条，新增 ${result.imported.length + result.unmatched.length} 条${migrated}`); } catch (error) { showToast(error.message, 'error'); } finally { button.disabled = false; } });
$('#exportCsvButton').addEventListener('click', () => exportLogs('csv'));
$('#exportJsonButton').addEventListener('click', () => exportLogs('json'));
$('#logModelFilter').addEventListener('keydown', (event) => { if (event.key === 'Enter') searchLogs(); });
$('#logResetButton').addEventListener('click', () => { $('#logModelFilter').value = ''; $('#logSourceFilter').value = ''; $('#logAppFilter').value = ''; $('#logTypeFilter').value = ''; $('#logDateFilter').value = 'all'; saveLogFilters(); searchLogs(); });
$('#logDateFilter').addEventListener('change', searchLogs);
const logFilterIds = ['logDateFilter', 'logModelFilter', 'logSourceFilter', 'logAppFilter', 'logTypeFilter'];
const logFilterStorageKey = `token-watch-${document.body.dataset.runtime}-log-filters`;
function saveLogFilters() {
  try { localStorage.setItem(logFilterStorageKey, JSON.stringify(Object.fromEntries(logFilterIds.map(id => [id, document.getElementById(id).value])))); } catch {}
}
function restoreLogFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(logFilterStorageKey) || '{}');
    for (const id of logFilterIds) {
      if (typeof saved[id] !== 'string') continue;
      const input = document.getElementById(id);
      if (id === 'logSourceFilter' && saved[id] && ![...input.options].some(option => option.value === saved[id])) input.add(new Option(saved[id], saved[id]));
      if (input.tagName !== 'SELECT' || [...input.options].some(option => option.value === saved[id])) input.value = saved[id];
    }
  } catch {}
}
logFilterIds.forEach(id => document.getElementById(id).addEventListener('change', saveLogFilters));
$('#logModelFilter').addEventListener('input', saveLogFilters);
['#logSourceFilter', '#logAppFilter', '#logTypeFilter'].forEach(selector => $(selector).addEventListener('change', searchLogs));
$('#logAppFilter').add(new Option('手动补录', '手动补录'));
restoreLogFilters();
$('#callsBody').addEventListener('click', (event) => { const button = event.target.closest('.detail-button'); if (!button) return; const row = event.target.closest('tr'); showLogDetail(state.logIndex.get(row?.dataset.logId)); });
$('#closeLogDetail').addEventListener('click', () => setLogDetail(false));
$('#cancelLogDetail').addEventListener('click', () => setLogDetail(false));
$('#logDetailModal').addEventListener('click', (event) => { if (event.target.id === 'logDetailModal') setLogDetail(false); });
$$('.station-grid').forEach(grid => grid.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'import') return openCcSwitchImport();
  const id = event.target.closest('[data-station-id]')?.dataset.stationId;
  if (!id) return;
  const station = findStation(id);
  if (!station) return;
  if (action === 'refresh') await refreshStation(id);
  if (action === 'edit') setModal(true, station);
  if (action === 'delete') openDeleteStation(station);
  if (action === 'toggle-disabled') await toggleStationMonitoring(station);
  if (action === 'export-history') openHistoryExport(id);
  if (['show-quota-history', 'show-token-history', 'show-correction-history'].includes(action)) {
    renderHistoryOptions();
    $('#historyStationFilter').value = station.id;
    $('#historyRangeFilter').value = 'all';
    quotaHistoryPage = tokenHistoryPage = correctionHistoryPage = 1;
    setPage('calls');
    setHistoryTab(action === 'show-quota-history' ? 'quota' : action === 'show-correction-history' ? 'correction' : 'token');
  }
}));

let deleteStationTarget = null;
let deleteReturnFocus = null;
function openDeleteStation(station) {
  deleteStationTarget = station;
  deleteReturnFocus = document.activeElement;
  $('#deleteStationCopy').textContent = `将永久删除站点「${station.name}」及其配置。`;
  const callCount = Number(station.callCount || 0);
  $('#deleteStationImpact').innerHTML = callCount
    ? `该站点的 <strong>${tokenCount(callCount)} 条</strong>调用记录（含历史校准）会一并删除，且无法恢复。`
    : '该站点目前没有调用记录。';
  $('#deleteStationModal').hidden = false;
  $('#cancelDeleteStation').focus();
}

function closeDeleteStation() {
  $('#deleteStationModal').hidden = true;
  deleteStationTarget = null;
  if (deleteReturnFocus && typeof deleteReturnFocus.focus === 'function') deleteReturnFocus.focus();
  deleteReturnFocus = null;
}

$('#closeDeleteStation').addEventListener('click', closeDeleteStation);
$('#cancelDeleteStation').addEventListener('click', closeDeleteStation);
$('#deleteStationModal').addEventListener('click', (event) => { if (event.target.id === 'deleteStationModal') closeDeleteStation(); });
$('#confirmDeleteStation').addEventListener('click', async () => {
  const station = deleteStationTarget;
  if (!station) return;
  const button = $('#confirmDeleteStation');
  button.disabled = true;
  try {
    state.data = await request(`/api/stations/${station.id}`, { method: 'DELETE' });
    closeDeleteStation();
    render();
    showToast(`${station.name} 已删除`);
  } catch (error) {
    showToast(humanizeError(error.message), 'error');
  } finally {
    button.disabled = false;
  }
});
$('#pauseInsteadOfDelete').addEventListener('click', async () => {
  const station = deleteStationTarget;
  if (!station) return;
  closeDeleteStation();
  await toggleStationMonitoring(station, true);
});

async function toggleStationMonitoring(station, pause = null) {
  const disabled = pause === null ? !station.disabled : Boolean(pause);
  try {
    state.data = await request(`/api/stations/${encodeURIComponent(station.id)}`, { method: 'PATCH', body: JSON.stringify({ disabled }) });
    render();
    showToast(disabled ? `${station.name} 已暂停监控` : `${station.name} 已恢复监控`);
  } catch (error) {
    showToast(humanizeError(error.message), 'error');
  }
}
$('#stationQuotaMode').addEventListener('change', updateQuotaFields);
let calibrationStation = null;
let calibrationReturnFocus = null;
function closeCalibration() {
  if ($('#saveCalibration').disabled) return;
  $('#calibrationModal').hidden = true; calibrationStation = null;
  calibrationReturnFocus?.focus(); calibrationReturnFocus = null;
}
function calibrationAmountFor(station, unit = $('#calibrationUnit').value) { return station.historyQuotaByUnit?.[unit] || 0; }
function changeCalibrationUnit() {
  if (!calibrationStation) return;
  const amount = calibrationAmountFor(calibrationStation);
  $('#calibrationAmount').value = amount;
  $('#calibrationCurrent').textContent = `${money(amount, $('#calibrationUnit').value)} · ${tokenCount(calibrationStation.tokens)} Tokens`;
  updateCalibrationPreview();
}
$('#calibrationUnit').addEventListener('change', changeCalibrationUnit);
function updateCalibrationPreview() {
  if (!calibrationStation) return;
  const amount = Number($('#calibrationAmount').value);
  const tokens = Number($('#calibrationTokens').value);
  const delta = amount - calibrationAmountFor(calibrationStation);
  const deltaTokens = tokens - Number(calibrationStation.tokens || 0);
  $('#calibrationDelta').textContent = `${delta >= 0 ? '+' : ''}${money(delta, $('#calibrationUnit').value)} · ${signedTokens(deltaTokens)} Tokens`;
}
$$('.station-grid').forEach(grid => grid.addEventListener('click', event => {
  if (event.target.closest('[data-action]')?.dataset.action !== 'calibrate') return;
  const station = findStation(event.target.closest('[data-station-id]')?.dataset.stationId);
  if (!station) return;
  calibrationReturnFocus = document.activeElement;
  calibrationStation = structuredClone(station);
  $('#calibrationStation').textContent = station.name;
  $('#calibrationUnit').innerHTML = [...new Set([station.balanceUnit, ...Object.keys(station.historyQuotaByUnit || {})])].map(unit => `<option value="${escapeHtml(unit)}">${escapeHtml(unit)}</option>`).join('');
  $('#calibrationAmount').value = calibrationAmountFor(station);
  $('#calibrationTokens').value = station.tokens || 0;
  $('#calibrationCurrent').textContent = `${money(calibrationAmountFor(station), station.balanceUnit)} · ${tokenCount(station.tokens)} Tokens`;
  $('#calibrationError').textContent = '';
  $('#calibrationModal').hidden = false;
  updateCalibrationPreview();
  $('#calibrationAmount').focus();
}));
$('#calibrationAmount').addEventListener('input', updateCalibrationPreview);
$('#calibrationTokens').addEventListener('input', updateCalibrationPreview);
$('#closeCalibration').addEventListener('click', closeCalibration);
$('#cancelCalibration').addEventListener('click', closeCalibration);
$('#calibrationModal').addEventListener('click', event => { if (event.target === $('#calibrationModal') && !$('#saveCalibration').disabled) closeCalibration(); });
$('#calibrationForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!calibrationStation) return;
  const station = calibrationStation;
  $('#saveCalibration').disabled = true;
  try {
    const result = await request(`/api/stations/${encodeURIComponent(station.id)}/calibrate`, { method: 'POST', body: JSON.stringify({
      amount: Number($('#calibrationAmount').value), tokens: Number($('#calibrationTokens').value), unit: $('#calibrationUnit').value,
      expectedAmount: calibrationAmountFor(station), expectedTokens: Number(station.tokens || 0)
    }) });
    state.data = result;
    $('#saveCalibration').disabled = false;
    closeCalibration(); render();
    showToast(result.adjustment ? '历史消耗已校准' : '累计数值未变化，无需补录');
    await searchLogs(); await loadOverview(); if (state.page === 'calls') await loadCurrentHistory();
  } catch (error) { $('#calibrationError').textContent = error.message; }
  finally { $('#saveCalibration').disabled = false; }
});
  $('#stationForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('#stationId').value;
    let body;
    try { body = formStationPayload({ includeCredentials: false }); }
    catch (error) { window.WebWorkbench?.showFormError(error.message); return showToast(error.message, 'error'); }
    if (!body.name) return showToast('请输入站点名称', 'error');
    if (Object.values(body.pricing).some((value) => !Number.isFinite(value) || value < 0)) return showToast('计价参数必须是大于等于 0 的数字', 'error');
    try { if (!body.ghost || body.baseUrl) new URL(body.baseUrl); if (body.statsUrl) new URL(body.statsUrl); } catch { return showToast('请输入有效的 http/https 地址', 'error'); }
    try {
      state.data = await request(id ? `/api/stations/${id}` : '/api/stations', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setModal(false);
      render();
      showToast(id ? '站点配置已更新' : '站点已添加');
    } catch (error) {
      showToast(error.message, 'error');
      $('#usageCodeStatus').textContent = error.message;
      window.WebWorkbench?.showFormError(error.message);
    }
  });
$$('[data-history-tab]').forEach(button => button.addEventListener('click', () => setHistoryTab(button.dataset.historyTab)));
['#historyStationFilter', '#historyRangeFilter'].forEach(selector => $(selector).addEventListener('change', () => {
  quotaHistoryPage = tokenHistoryPage = correctionHistoryPage = 1;
  loadCurrentHistory();
}));
$('#refreshHistoryButton').addEventListener('click', loadCurrentHistory);
$('#quotaHistoryPrevious').addEventListener('click', () => { quotaHistoryPage = Math.max(1, quotaHistoryPage - 1); loadCurrentHistory(); });
$('#quotaHistoryNext').addEventListener('click', () => { quotaHistoryPage++; loadCurrentHistory(); });
$('#tokenHistoryPrevious').addEventListener('click', () => { tokenHistoryPage = Math.max(1, tokenHistoryPage - 1); loadCurrentHistory(); });
$('#tokenHistoryNext').addEventListener('click', () => { tokenHistoryPage++; loadCurrentHistory(); });
$('#correctionHistoryPrevious').addEventListener('click', () => { correctionHistoryPage = Math.max(1, correctionHistoryPage - 1); loadCurrentHistory(); });
$('#correctionHistoryNext').addEventListener('click', () => { correctionHistoryPage++; loadCurrentHistory(); });
$$('.nav-item').forEach((item) => item.addEventListener('click', () => setPage(item.dataset.nav)));
window.addEventListener('popstate', () => setPage(currentPage(), { push: false }));
window.addEventListener('hashchange', () => setPage(currentPage(), { push: false }));

setPage(currentPage(), { push: false });
bootstrap();
