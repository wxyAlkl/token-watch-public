const { app, BrowserWindow, Menu, ipcMain, screen, shell, Tray, nativeImage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const quotaPolicy = require('./public/quota-policy');
const balanceAlerts = require('./public/balance-alerts');
const { FloatingService } = require('./floating-service');
const { startupController } = require('./floating-startup');
const { BALL_SIZE, PANEL_WIDTH, panelBounds, islandBounds } = require('./floating-layout');
const { isOfficialStation, officialAccounts } = require('./public/monitor-channels');
const { orderStations } = require('./floating-island');
const { advanceIslandState, toggleIslandMode } = require('./floating-island-state');
const iconDir = path.join(__dirname, 'public', 'icons');
const trayImages = new Map();
function trayImage(state) {
  if (!trayImages.has(state)) trayImages.set(state, nativeImage.createFromPath(path.join(iconDir, `tray-${state}.png`)));
  return trayImages.get(state);
}

app.setName('Token Watch Floating');
const CAPTURE_ARG = process.argv.find((arg) => arg.startsWith('--capture='));
const ISLAND_CAPTURE_ARG = process.argv.find((arg) => arg.startsWith('--capture-island='));
const CAPTURE_DIR = CAPTURE_ARG ? path.resolve(CAPTURE_ARG.slice('--capture='.length))
  : ISLAND_CAPTURE_ARG ? path.resolve(ISLAND_CAPTURE_ARG.slice('--capture-island='.length)) : null;
const IS_CAPTURE = Boolean(CAPTURE_DIR);
const ISLAND_CAPTURE = Boolean(ISLAND_CAPTURE_ARG);
if (IS_CAPTURE) {
  const captureUserData = path.join(CAPTURE_DIR, 'electron-user-data');
  fs.mkdirSync(captureUserData, { recursive: true });
  app.setPath('userData', captureUserData);
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const service = new FloatingService();
const startup = startupController(app, __dirname);
const API_BASE = service.config.url;
const DASHBOARD_URL = API_BASE + '/';
const BALL_GAP = 18;
const EDGE_GAP = 0;
const HIDE_VISIBLE = Math.max(8, Math.min(24, Number(process.env.FLOATING_HIDE_VISIBLE || 12)));
const AUTO_HIDE = process.env.FLOATING_AUTOHIDE !== '0';
const IDLE_RETRACT_MS = Math.max(600, Number(process.env.FLOATING_IDLE_RETRACT_MS || 1400));
const LEAVE_RETRACT_MS = Math.max(300, Number(process.env.FLOATING_LEAVE_RETRACT_MS || 650));
const ANIM_MS = 170;
const POLL_MS = Math.max(5000, Number(process.env.FLOATING_POLL_MS || 30000));

let ballWin = null;
let panelWin = null;
let latest = null;
let lastGoodSummary = null;
let lastGoodAt = null;
let pollTimer = null;
let modeRevision = 0;
let pollingRevision = null;
let channelMode = 'official';
let dragState = null;
let syncing = false;
let lastPanelHideAt = 0;
let edgeSide = null;
let tucked = false;
let retractTimer = null;
let animTimer = null;
let panelOpen = false;
let tray = null;
let quitting = false;
let stopped = false;
let serviceError = '';
let menuOpen = false;
let lastRefreshAttemptAt = 0;
let floatingStyle = 'ball';
let islandMode = 'tucked';
let islandPointerTimer = null;
let islandAnimTimer = null;
let islandLeaveAt = 0;
let islandIdleAt = 0;
let islandReducedMotion = false;
const ISLAND_IDLE_MS = Math.max(1000, Number(process.env.FLOATING_ISLAND_IDLE_MS || 3000));
const ISLAND_LEAVE_MS = 180;
let recentActivity = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function positionFile() {
  return path.join(app.getPath('userData'), 'ball-position.json');
}

function styleFile() { return path.join(app.getPath('userData'), 'floating-style.json'); }
function loadStyle() {
  try { return JSON.parse(fs.readFileSync(styleFile(), 'utf8')).style === 'island' ? 'island' : 'ball'; }
  catch { return 'ball'; }
}
function loadChannelMode() {
  try { return JSON.parse(fs.readFileSync(styleFile(), 'utf8')).channel === 'relay' ? 'relay' : 'official'; }
  catch { return 'official'; }
}
function dashboardUrl() { return DASHBOARD_URL + (channelMode === 'official' ? '#official' : '#stations'); }
function displayedCount() {
  const summary = latest?.ok ? latest : latest?.cached;
  return summary?.accounts?.length ?? summary?.stations?.length ?? 0;
}
function setChannelMode(mode) {
  if (!['official', 'relay'].includes(mode) || channelMode === mode) return;
  channelMode = mode;
  modeRevision++;
  saveStyle();
  latest = { ok: false, channel: mode, loading: true };
  lastGoodSummary = null;
  lastGoodAt = null;
  broadcast('floating:summary', latest);
  updateTray();
  poll();
}
function saveStyle() {
  try {
    fs.mkdirSync(path.dirname(styleFile()), { recursive: true });
    fs.writeFileSync(styleFile(), JSON.stringify({ style: floatingStyle, channel: channelMode }));
  } catch {}
}

function loadPosition() {
  try {
    const parsed = JSON.parse(fs.readFileSync(positionFile(), 'utf8'));
    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return { x: parsed.x, y: parsed.y };
  } catch {}
  return null;
}

function savePosition(position) {
  try {
    fs.mkdirSync(path.dirname(positionFile()), { recursive: true });
    fs.writeFileSync(positionFile(), JSON.stringify(position));
  } catch {}
}

function displayArea(x, y) {
  return screen.getDisplayNearestPoint({ x: x + BALL_SIZE / 2, y: y + BALL_SIZE / 2 }).workArea;
}

function currentArea() {
  const [x, y] = ballWin ? ballWin.getPosition() : [0, 0];
  return displayArea(x, y);
}

function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - BALL_SIZE - EDGE_GAP, y: area.y + 120 };
}

function clampToArea(position) {
  const area = displayArea(position.x, position.y);
  return {
    x: Math.min(Math.max(position.x, area.x), area.x + area.width - BALL_SIZE),
    y: Math.min(Math.max(position.y, area.y), area.y + area.height - BALL_SIZE)
  };
}

function expandedPosition(side, y) {
  const area = currentArea();
  const x = side === 'left' ? area.x + EDGE_GAP : area.x + area.width - BALL_SIZE - EDGE_GAP;
  return { x, y: Math.min(Math.max(y, area.y), area.y + area.height - BALL_SIZE) };
}

function tuckedPosition(side, y) {
  const area = currentArea();
  const x = side === 'left' ? area.x - BALL_SIZE + HIDE_VISIBLE : area.x + area.width - HIDE_VISIBLE;
  return { x, y: Math.min(Math.max(y, area.y), area.y + area.height - BALL_SIZE) };
}

function sideFromPosition(x) {
  const area = currentArea();
  if (x <= area.x + 24) return 'left';
  if (x + BALL_SIZE >= area.x + area.width - 24) return 'right';
  return null;
}

function positionIsland() {
  if (!ballWin || floatingStyle !== 'island') return;
  const count = displayedCount();
  const bounds = islandBounds(screen.getPrimaryDisplay().workArea, islandMode, count);
  if (islandAnimTimer) return;
  if (JSON.stringify(ballWin.getBounds()) !== JSON.stringify(bounds)) ballWin.setBounds(bounds);
}

function animateIslandTo(bounds, duration) {
  if (!ballWin) return;
  clearInterval(islandAnimTimer);
  if (islandReducedMotion) {
    islandAnimTimer = null;
    ballWin.setBounds(bounds);
    return;
  }
  const start = ballWin.getBounds();
  const startedAt = Date.now();
  const area = screen.getPrimaryDisplay().workArea;
  islandAnimTimer = setInterval(() => {
    if (!ballWin || ballWin.isDestroyed()) {
      clearInterval(islandAnimTimer);
      islandAnimTimer = null;
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / duration);
    // Damped spring: a small overshoot gives the island a rubber-ball release.
    const eased = 1 - Math.exp(-6 * progress)
      * (Math.cos(10 * progress) + 0.6 * Math.sin(10 * progress));
    const width = Math.max(1, Math.min(area.width, Math.round(start.width + (bounds.width - start.width) * eased)));
    const y = Math.max(area.y, Math.min(area.y + area.height - 1,
      Math.round(start.y + (bounds.y - start.y) * eased)));
    const height = Math.max(1, Math.min(area.y + area.height - y,
      Math.round(start.height + (bounds.height - start.height) * eased)));
    ballWin.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y, width, height });
    if (progress >= 1) {
      clearInterval(islandAnimTimer);
      islandAnimTimer = null;
      ballWin.setBounds(bounds);
      positionIsland();
    }
  }, 16);
}

function setIslandMode(mode) {
  if (floatingStyle !== 'island' || !ballWin) return;
  if (islandMode === mode) return;
  const previous = islandMode;
  islandMode = mode;
  islandLeaveAt = 0;
  islandIdleAt = mode === 'compact' ? Date.now() : 0;
  const count = displayedCount();
  const duration = mode === 'expanded' ? 430 : mode === 'tucked' ? 330 : previous === 'expanded' ? 340 : 390;
  animateIslandTo(islandBounds(screen.getPrimaryDisplay().workArea, mode, count), duration);
  ballWin.webContents.send('floating:island-state', { mode });
}

function startIslandPointerWatch() {
  clearInterval(islandPointerTimer);
  islandPointerTimer = setInterval(() => {
    if (floatingStyle !== 'island' || !ballWin?.isVisible() || menuOpen) return;
    const cursor = screen.getCursorScreenPoint();
    const count = displayedCount();
    // Use logical target bounds so an in-flight animation cannot trap the pointer.
    const bounds = islandBounds(screen.getPrimaryDisplay().workArea, islandMode, count);
    const pad = islandMode === 'tucked' ? 16 : islandMode === 'compact' ? 8 : 0;
    const inside = cursor.x >= bounds.x - pad && cursor.x < bounds.x + bounds.width + pad
      && cursor.y >= bounds.y - pad && cursor.y < bounds.y + bounds.height + pad;
    const next = advanceIslandState({ mode: islandMode, leaveAt: islandLeaveAt, idleAt: islandIdleAt },
      inside, Date.now(), { leaveDelay: ISLAND_LEAVE_MS, idleDelay: ISLAND_IDLE_MS });
    islandLeaveAt = next.leaveAt;
    islandIdleAt = next.idleAt;
    if (next.mode !== islandMode) setIslandMode(next.mode);
  }, 80);
}

function setFloatingStyle(style) {
  if (!['ball', 'island'].includes(style) || style === floatingStyle || !ballWin) return;
  hidePanel();
  cancelRetract();
  clearInterval(animTimer); animTimer = null;
  clearInterval(islandAnimTimer); islandAnimTimer = null;
  if (dragState) { clearInterval(dragState.timer); dragState = null; }
  floatingStyle = style;
  islandMode = 'tucked';
  islandLeaveAt = 0;
  islandIdleAt = 0;
  tucked = false;
  saveStyle();
  if (style === 'island') {
    positionIsland();
    ballWin.loadFile(path.join(__dirname, 'floating.html'), { query: { view: 'island' } });
  } else {
    const position = clampToArea(loadPosition() || defaultPosition());
    ballWin.setBounds({ ...position, width: BALL_SIZE, height: BALL_SIZE });
    edgeSide = sideFromPosition(position.x);
    ballWin.loadFile(path.join(__dirname, 'floating.html'), { query: { view: 'ball' } });
    scheduleRetract(5000);
  }
  ballWin.show();
  updateTray();
}

function broadcast(channel, payload) {
  for (const win of [ballWin, panelWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function sendTuckState() {
  if (ballWin && !ballWin.isDestroyed()) ballWin.webContents.send('floating:tuck-state', { tucked, side: edgeSide, visible: HIDE_VISIBLE });
}

function animateBallTo(targetX, targetY) {
  if (!ballWin) return;
  clearInterval(animTimer);
  const [startX, startY] = ballWin.getPosition();
  const startedAt = Date.now();
  animTimer = setInterval(() => {
    if (!ballWin) { clearInterval(animTimer); animTimer = null; return; }
    const t = Math.min(1, (Date.now() - startedAt) / ANIM_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    const x = Math.round(startX + (targetX - startX) * eased);
    const y = Math.round(startY + (targetY - startY) * eased);
    ballWin.setPosition(x, y);
    if (t >= 1) {
      clearInterval(animTimer);
      animTimer = null;
      ballWin.setPosition(targetX, targetY);
    }
  }, 16);
}

function cancelRetract() {
  if (retractTimer) { clearTimeout(retractTimer); retractTimer = null; }
}

function scheduleRetract(delay = IDLE_RETRACT_MS) {
  clearTimeout(retractTimer);
  retractTimer = null;
  if (floatingStyle !== 'ball' || !AUTO_HIDE || !edgeSide || panelOpen || menuOpen || dragState || tucked || !ballWin?.isVisible()) return;
  retractTimer = setTimeout(() => {
    retractTimer = null;
    if (!panelOpen && !menuOpen && !dragState && edgeSide && !tucked) tuckNow();
  }, delay);
}

function tuckNow(immediate = false) {
  if (!ballWin || !edgeSide || tucked) return;
  cancelRetract();
  if (immediate) { clearInterval(animTimer); animTimer = null; }
  const [x, y] = ballWin.getPosition();
  const target = tuckedPosition(edgeSide, y);
  tucked = true;
  sendTuckState();
  if (immediate) ballWin.setPosition(target.x, target.y);
  else animateBallTo(target.x, target.y);
}

function expandNow(immediate = false) {
  if (!ballWin || !tucked) return;
  cancelRetract();
  if (immediate) { clearInterval(animTimer); animTimer = null; }
  const [x, y] = ballWin.getPosition();
  const target = expandedPosition(edgeSide || 'right', y);
  tucked = false;
  sendTuckState();
  if (immediate) ballWin.setPosition(target.x, target.y);
  else animateBallTo(target.x, target.y);
}

function onBallHover() {
  if (floatingStyle === 'island') { setIslandMode('compact'); return; }
  cancelRetract();
  // Restore the native window in one step; animating an off-screen Windows
  // window across x=0 can stall native move handling. CSS still fades the ball.
  if (tucked) expandNow(true);
}

function onBallLeave() {
  if (floatingStyle === 'island') { islandLeaveAt = Date.now(); return; }
  scheduleRetract(LEAVE_RETRACT_MS);
}

function moneyByUnit(stations) {
  const groups = {};
  for (const station of stations) {
    if (station.disabled || station.balance === null || station.balance === undefined || !station.balanceKnown) continue;
    const value = Number(station.balance);
    if (!Number.isFinite(value)) continue;
    const unit = String(station.balanceUnit || 'USD').toUpperCase();
    groups[unit] = Number(((groups[unit] || 0) + value).toFixed(6));
  }
  return groups;
}

function buildSummary(state, health, activity = []) {
  const rawStations = (state.stations || []).filter(station => !isOfficialStation(station));
  const activityById = new Map(activity.map((item) => [String(item.stationId), item.lastCallAt]));
  const active = rawStations.filter((station) => !station.disabled);
  const alerts = [];
  const stations = rawStations.map((station) => {
    const quota = quotaPolicy.present(station);
    const alert = station.disabled ? { active: false, reasons: [] } : balanceAlerts.evaluate(quota, state.settings?.balanceAlerts);
    if (alert.active) alerts.push({ name: station.name, reasons: alert.reasons });
    return {
      id: station.id,
      name: station.name,
      disabled: station.disabled === true,
      balance: station.balanceKnown ? station.balance : null,
      balanceKnown: Boolean(station.balanceKnown),
      balanceUnit: String(station.balanceUnit || 'USD').toUpperCase(),
      modelStatus: station.modelStatus || station.status || 'unknown',
      usageStatus: station.usageStatus || 'unknown',
      modelCount: Number(station.modelCount || 0),
      lastCallAt: activityById.get(String(station.id)) || null,
      quota: {
        mode: quota.mode, remaining: quota.remaining, limit: quota.limit, percent: quota.percent,
        unit: quota.unit, state: quota.state, sourceLabel: quota.sourceLabel,
        stale: quota.stale, reason: quota.reason
      },
      alertActive: Boolean(alert.active),
      alertReasons: alert.reasons || []
    };
  });
  const online = active.filter((station) => (station.modelStatus || station.status) === 'online').length;
  const modelErrors = active.filter((station) => (station.modelStatus || station.status) === 'error').length;
  const usageErrors = active.filter((station) => station.usageStatus === 'error').length;
  const syncingInfo = health?.sync || null;
  return {
    ok: true,
    at: Date.now(),
    apiBase: API_BASE,
    dashboardUrl: DASHBOARD_URL,
    status: {
      active: active.length,
      online,
      modelErrors,
      usageErrors,
      alerts: alerts.length,
      alertDetails: alerts,
      lastSync: active.map(s => s.checkedAt).filter(Boolean).sort().at(-1) || null,
      totalModels: active.reduce((sum, s) => sum + (Number(s.modelCount) || 0), 0),
      syncing: Boolean(syncingInfo?.running),
      progress: syncingInfo ? { done: syncingInfo.done || 0, total: syncingInfo.total || 0, current: syncingInfo.current || '' } : null
    },
    totalBalanceByUnit: moneyByUnit(rawStations),
    stations: orderStations(stations, activity)
  };
}

async function fetchJson(pathname, timeout = 10000) {
  const response = await fetch(API_BASE + pathname, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function poll() {
  const revision = modeRevision;
  const official = channelMode === 'official';
  if (pollingRevision === revision) return latest;
  pollingRevision = revision;
  try {
    const connection = await service.ensure();
    serviceError = connection.ok ? '' : connection.error;
    if (!connection.ok) throw new Error(serviceError);
    const [state, health, activity, codex] = await Promise.all([
      fetchJson('/api/stations'),
      fetchJson('/api/health', 5000).catch(() => null),
      official ? [] : fetchJson('/api/stations/recent-activity', 5000).then((value) => {
        recentActivity = Array.isArray(value.stations) ? value.stations : recentActivity;
        return recentActivity;
      }).catch(() => recentActivity),
      official ? fetchJson('/api/codex/account', 45000).catch(() => null) : null
    ]);
    if (revision !== modeRevision) return latest;
    latest = official ? { ok: true, channel: 'official', accounts: officialAccounts(state.stations, codex), at: Date.now() } : buildSummary(state, health, activity);
    lastGoodSummary = latest;
    lastGoodAt = Date.now();
    broadcast('floating:summary', latest);
    updateTray();
    if (panelOpen) positionPanel();
    if (floatingStyle === 'island' && islandMode === 'expanded') positionIsland();
    // A hidden companion must keep syncing even when no browser tab is open.
    const refreshMs = Math.max(1, Number(state.settings?.refreshMinutes) || 5) * 60000;
    const lastSyncAt = Date.parse(state.aggregate?.lastSync) || 0;
    if (!IS_CAPTURE && !syncing && !health?.sync?.running
      && Date.now() - Math.max(lastSyncAt, lastRefreshAttemptAt) >= refreshMs) {
      setImmediate(() => { if (!quitting) triggerRefresh('all').catch(() => {}); });
    }
    return latest;
  } catch (error) {
    if (revision !== modeRevision) return latest;
    latest = {
      channel: channelMode,
      ok: false,
      at: Date.now(),
      apiBase: API_BASE,
      dashboardUrl: DASHBOARD_URL,
      error: String(error.message || error),
      lastGoodAt,
      cached: lastGoodSummary
    };
    broadcast('floating:summary', latest);
    updateTray();
    return latest;
  } finally {
    if (pollingRevision === revision) pollingRevision = null;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { poll(); }, POLL_MS);
}

async function triggerRefresh(scope = channelMode) {
  if (syncing) return { ok: false, error: '正在刷新中' };
  syncing = true;
  lastRefreshAttemptAt = Date.now();
  const fast = channelMode === 'relay' ? setInterval(() => { poll(); }, 1000) : null;
  try {
    const params = scope === 'all' ? '' : '?channel=' + scope;
    const codexRead = scope === 'official' ? fetchJson('/api/codex/account?refresh=1', 45000).catch(() => null) : null;
    const response = await fetch(API_BASE + '/api/stations/refresh-all' + params, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await codexRead;
    if (scope !== 'official') await fetch(API_BASE + '/api/logs/sync-cli', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(120000) }).catch(() => null);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  } finally {
    clearInterval(fast);
    syncing = false;
    await poll();
  }
}

function hidePanel() {
  if (floatingStyle === 'island') {
    setIslandMode('compact');
    return;
  }
  if (!panelWin) return;
  panelWin.hide();
  panelOpen = false;
  lastPanelHideAt = Date.now();
  scheduleRetract(900);
}

function showPanel() {
  if (floatingStyle === 'island') {
    if (!ballWin?.isVisible()) recoverBall();
    setIslandMode('expanded');
    poll();
    return;
  }
  if (!panelWin) return;
  if (!ballWin.isVisible()) recoverBall();
  cancelRetract();
  if (tucked) expandNow(true);
  positionPanel();
  panelOpen = true;
  panelWin.show();
  panelWin.focus();
  poll();
}

function togglePanel() {
  if (floatingStyle === 'island') { setIslandMode(toggleIslandMode(islandMode)); poll(); return; }
  if (!panelWin) return;
  if (panelWin.isVisible()) { hidePanel(); return; }
  if (Date.now() - lastPanelHideAt < 300) return;
  showPanel();
}

function positionPanel() {
  if (floatingStyle === 'island') return;
  if (!ballWin || !panelWin) return;
  const [bx, by] = ballWin.getPosition();
  const base = tucked ? expandedPosition(edgeSide || 'right', by) : { x: bx, y: by };
  const area = displayArea(base.x, base.y);
  const count = displayedCount();
  panelWin.setBounds(panelBounds(base, area, count));
}

function hideBall() {
  if (floatingStyle !== 'island') hidePanel();
  cancelRetract();
  clearInterval(animTimer); animTimer = null;
  clearInterval(islandAnimTimer); islandAnimTimer = null;
  ballWin?.hide();
  updateTray();
}

function recoverBall() {
  if (!ballWin) return;
  if (floatingStyle === 'island') {
    clearInterval(islandAnimTimer); islandAnimTimer = null;
    islandMode = 'tucked';
    islandLeaveAt = 0;
    islandIdleAt = 0;
    positionIsland();
    ballWin.webContents.send('floating:island-state', { mode: islandMode });
    ballWin.show();
    updateTray();
    return;
  }
  cancelRetract();
  clearInterval(animTimer); animTimer = null;
  if (dragState) { clearInterval(dragState.timer); dragState = null; }
  tucked = false;
  const position = clampToArea(defaultPosition());
  ballWin.setPosition(position.x, position.y);
  edgeSide = 'right';
  savePosition(position);
  sendTuckState();
  ballWin.show();
  if (panelOpen) positionPanel();
  scheduleRetract(5000);
  updateTray();
}

function menuTemplate() {
  return [
    { label: '打开工作台', click: () => shell.openExternal(dashboardUrl()) },
    { label: '立即刷新', enabled: !syncing, click: () => { triggerRefresh().catch(() => {}); } },
    { label: '重新连接后台', click: () => { poll(); } },
    { type: 'separator' },
    { label: ballWin?.isVisible() ? '隐藏悬浮球' : '显示悬浮球', click: () => ballWin?.isVisible() ? hideBall() : recoverBall() },
    { label: '找回悬浮球', click: recoverBall },
    { label: floatingStyle === 'island' ? '展开/收起灵动岛' : '显示/隐藏面板', click: togglePanel },
    { label: '监控模式', submenu: [
      { label: '官方账号', type: 'radio', checked: channelMode === 'official', click: () => setChannelMode('official') },
      { label: '中转站', type: 'radio', checked: channelMode === 'relay', click: () => setChannelMode('relay') }
    ] },
    { label: '悬浮样式', submenu: [
      { label: '圆球', type: 'radio', checked: floatingStyle === 'ball', click: () => setFloatingStyle('ball') },
      { label: '顶部灵动岛', type: 'radio', checked: floatingStyle === 'island', click: () => setFloatingStyle('island') }
    ] },
    { label: '创建桌面快捷方式', enabled: process.platform === 'win32', click: createDesktopShortcut },
    { label: '开机启动', type: 'checkbox', checked: startup.enabled(), enabled: startup.supported && !IS_CAPTURE,
      click: (item) => { try { startup.setEnabled(item.checked); } catch { dialog.showErrorBox('设置失败', '无法修改开机启动，请检查系统权限。'); } updateTray(); } },
    { type: 'separator' },
    { label: '退出应用', click: () => app.quit() }
  ];
}

function createDesktopShortcut() {
  try {
    const link = path.join(app.getPath('desktop'), 'Token Watch.lnk');
    const icon = path.join(iconDir, 'token-watch.ico');
    const options = { target: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'),
      args: `"${path.join(__dirname, 'Start-Token-Watch.vbs')}"`, cwd: __dirname,
      description: 'Token Watch 悬浮球与用量监控', icon, iconIndex: 0 };
    if (!shell.writeShortcutLink(link, fs.existsSync(link) ? 'update' : 'create', options)) throw new Error();
  } catch { dialog.showErrorBox('创建失败', '无法创建桌面快捷方式，请使用项目中的 Start-Token-Watch.vbs。'); }
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const status = latest?.ok ? latest.status : null;
  const problems = status ? status.modelErrors + status.usageErrors + status.alerts : 0;
  const accounts = latest?.accounts;
  const state = accounts ? (accounts.every(a => a.state === 'ok') ? 'online' : 'warning') : !status ? 'offline' : status.syncing ? 'syncing' : problems ? 'warning' : 'online';
  tray.setImage(trayImage(state));
  tray.setToolTip(accounts ? '官方账号 · ' + accounts.map(a => a.name + ' ' + a.value).join(' · ') : status ? `Token Watch · ${status.online}/${status.active} 在线 · ${problems} 项提醒` : 'Token Watch · ' + (serviceError || '正在连接后台'));
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function createTray() {
  tray = new Tray(trayImage('offline'));
  tray.on('click', () => { recoverBall(); togglePanel(); });
  updateTray();
}

function windowOptions(extra = {}) {
  return {
    icon: path.join(iconDir, 'token-watch.png'),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    roundedCorners: false,
    ...extra,
    webPreferences: {
      preload: path.join(__dirname, 'floating-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false
    }
  };
}

function createBall() {
  const position = clampToArea(loadPosition() || defaultPosition());
  const bounds = floatingStyle === 'island' ? islandBounds(screen.getPrimaryDisplay().workArea, islandMode) : { ...position, width: BALL_SIZE, height: BALL_SIZE };
  ballWin = new BrowserWindow({ ...windowOptions(), ...bounds, show: false });
  ballWin.setAlwaysOnTop(true, 'floating');
  ballWin.loadFile(path.join(__dirname, 'floating.html'), { query: { view: floatingStyle } });
  ballWin.once('ready-to-show', () => { ballWin.show(); });
  ballWin.webContents.on('did-finish-load', () => {
    if (floatingStyle === 'island') {
      ballWin.webContents.send('floating:island-state', { mode: islandMode });
      return;
    }
    sendTuckState();
    edgeSide = sideFromPosition(ballWin.getPosition()[0]);
    if (edgeSide && AUTO_HIDE && !IS_CAPTURE) scheduleRetract(2600);
  });
  ballWin.on('closed', () => { ballWin = null; });
}

function createPanel() {
  panelWin = new BrowserWindow({ ...windowOptions(), width: PANEL_WIDTH, height: 368, show: false });
  panelWin.setAlwaysOnTop(true, 'floating');
  panelWin.loadFile(path.join(__dirname, 'floating.html'), { query: { view: 'panel' } });
  panelWin.on('blur', () => {
    if (IS_CAPTURE || menuOpen || !panelWin || panelWin.webContents.isDevToolsOpened()) return;
    hidePanel();
  });
  panelWin.on('closed', () => { panelWin = null; });
}

function registerIpc() {
  ipcMain.handle('floating:get-summary', async () => latest || await poll() || { ok: false, channel: channelMode, loading: true });
  ipcMain.handle('floating:set-channel', (_event, mode) => { setChannelMode(mode); });
  ipcMain.handle('floating:get-island-state', () => ({ mode: islandMode }));
  ipcMain.handle('floating:set-island-reduced-motion', (_event, enabled) => {
    islandReducedMotion = Boolean(enabled);
    if (islandReducedMotion && islandAnimTimer) {
      clearInterval(islandAnimTimer);
      islandAnimTimer = null;
      positionIsland();
    }
    return true;
  });
  ipcMain.handle('floating:get-tuck-state', () => ({ tucked, side: edgeSide, visible: HIDE_VISIBLE }));
  ipcMain.handle('floating:hover', () => { onBallHover(); return true; });
  ipcMain.handle('floating:leave', () => { onBallLeave(); return true; });
  ipcMain.handle('floating:toggle-panel', () => { togglePanel(); return true; });
  ipcMain.handle('floating:hide-panel', () => { hidePanel(); return true; });
  ipcMain.handle('floating:open-dashboard', () => { shell.openExternal(dashboardUrl()); return true; });
  ipcMain.handle('floating:refresh', () => triggerRefresh());
  ipcMain.handle('floating:quit', () => { app.quit(); return true; });
  ipcMain.handle('floating:hide-ball', () => { hideBall(); return true; });
  ipcMain.handle('floating:menu', () => {
    cancelRetract();
    menuOpen = true;
    Menu.buildFromTemplate(menuTemplate()).popup({ window: panelOpen ? panelWin : ballWin, callback: () => {
      menuOpen = false;
      if (floatingStyle === 'island' && islandMode === 'compact') islandIdleAt = Date.now();
      scheduleRetract(900);
    } });
    return true;
  });
  ipcMain.handle('floating:drag-start', () => {
    if (floatingStyle === 'island') return false;
    if (!ballWin || dragState) return false;
    cancelRetract();
    clearInterval(animTimer); animTimer = null;
    if (tucked) expandNow(true);
    const startPos = ballWin.getPosition();
    const startCursor = screen.getCursorScreenPoint();
    dragState = {
      startPos,
      startCursor,
      moved: 0,
      timer: setInterval(() => {
        if (!ballWin || !dragState) return;
        const cursor = screen.getCursorScreenPoint();
        const dx = cursor.x - dragState.startCursor.x;
        const dy = cursor.y - dragState.startCursor.y;
        dragState.moved = Math.max(dragState.moved, Math.abs(dx) + Math.abs(dy));
        ballWin.setPosition(dragState.startPos[0] + dx, dragState.startPos[1] + dy);
      }, 16)
    };
    return true;
  });
  ipcMain.handle('floating:drag-end', () => {
    if (floatingStyle === 'island') return { moved: 0, clicked: false };
    if (!dragState || !ballWin) return { moved: 0, clicked: true };
    clearInterval(dragState.timer);
    const moved = dragState.moved;
    dragState = null;
    const [x, y] = ballWin.getPosition();
    const area = displayArea(x, y);
    let nextX = x;
    const nextY = Math.min(Math.max(y, area.y + BALL_GAP), area.y + area.height - BALL_SIZE - BALL_GAP);
    if (Math.abs(nextX - area.x) < 48) { nextX = area.x + EDGE_GAP; edgeSide = 'left'; }
    else if (Math.abs(nextX + BALL_SIZE - (area.x + area.width)) < 48) { nextX = area.x + area.width - BALL_SIZE - EDGE_GAP; edgeSide = 'right'; }
    else { edgeSide = null; }
    const clamped = clampToArea({ x: nextX, y: nextY });
    ballWin.setPosition(clamped.x, clamped.y);
    savePosition(clamped);
    sendTuckState();
    if (edgeSide) scheduleRetract(IDLE_RETRACT_MS);
    return { moved, clicked: moved < 5 };
  });
}

async function waitForLoad(win) {
  if (!win || win.webContents.isLoading() === false) return;
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
}

async function runCapture() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  await Promise.all([waitForLoad(ballWin), waitForLoad(panelWin)]);
  await poll();
  await sleep(900);
  await poll();
  await sleep(700);
  fs.writeFileSync(path.join(CAPTURE_DIR, 'ball.png'), (await ballWin.webContents.capturePage()).toPNG());
  positionPanel();
  panelOpen = true;
  panelWin.show();
  panelWin.focus();
  await poll();
  await sleep(900);
  fs.writeFileSync(path.join(CAPTURE_DIR, 'panel.png'), (await panelWin.webContents.capturePage()).toPNG());

  panelWin.hide();
  panelOpen = false;
  const area = screen.getPrimaryDisplay().workArea;
  const y = area.y + 150;
  ballWin.setPosition(area.x + area.width - BALL_SIZE - EDGE_GAP, y);
  edgeSide = 'right';
  sendTuckState();
  await sleep(120);
  const expanded = ballWin.getPosition();
  tuckNow(true);
  await sleep(400);
  const tuckedPositionNow = ballWin.getPosition();
  const rendererTucked = await ballWin.webContents.executeJavaScript('document.body.dataset.tucked || ""');
  const measureHandle = () => ballWin.webContents.executeJavaScript(`(() => {
    const element = document.getElementById('tuckHandle');
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity: style.opacity };
  })()`);
  const rightHandle = await measureHandle();
  const checkHandle = (position, handle) => {
    const left = position[0] + handle.x;
    if (left < area.x || left + handle.width > area.x + area.width || Number(handle.opacity) !== 1) {
      throw new Error('Tucked handle is outside the visible screen area');
    }
  };
  checkHandle(tuckedPositionNow, rightHandle);
  fs.writeFileSync(path.join(CAPTURE_DIR, 'ball-tucked.png'), (await ballWin.webContents.capturePage()).toPNG());
  await ballWin.webContents.executeJavaScript('window.floating.hover()');
  await sleep(ANIM_MS + 260);
  const expandedAgain = ballWin.getPosition();
  const rendererExpanded = await ballWin.webContents.executeJavaScript('document.body.dataset.tucked || ""');
  fs.writeFileSync(path.join(CAPTURE_DIR, 'ball-expanded.png'), (await ballWin.webContents.capturePage()).toPNG());
  ballWin.setPosition(area.x, y);
  edgeSide = 'left';
  tuckNow(true);
  await sleep(400);
  const leftTuckedPosition = ballWin.getPosition();
  const leftHandle = await measureHandle();
  checkHandle(leftTuckedPosition, leftHandle);
  fs.writeFileSync(path.join(CAPTURE_DIR, 'ball-tucked-left.png'), (await ballWin.webContents.capturePage()).toPNG());
  await ballWin.webContents.executeJavaScript('document.getElementById("tuckHandle").click(); true');
  await sleep(ANIM_MS + 260);
  if (tucked) throw new Error('Clicking the tucked handle did not expand the ball');
  const startupEnabled = startup.enabled();
  const hasTray = Boolean(tray && !tray.isDestroyed());
  hideBall();
  const hidden = !ballWin.isVisible() && hasTray;
  recoverBall();
  const recovered = ballWin.isVisible() && !tucked;
  const geometry = await panelWin.webContents.executeJavaScript(`(() => {
    const list = document.getElementById('stationList');
    return { viewport: innerHeight, pageHeight: document.documentElement.scrollHeight, listHeight: list.clientHeight, listContent: list.scrollHeight };
  })()`);
  fs.writeFileSync(path.join(CAPTURE_DIR, 'capture-state.json'), JSON.stringify({ expanded, tucked: tuckedPositionNow, expandedAgain, tuckedFlag: tucked, rendererTucked, rendererExpanded, edgeSide, animMs: ANIM_MS, hideVisible: HIDE_VISIBLE, rightHandle, leftHandle, leftTuckedPosition, startupEnabled, hasTray, hidden, recovered, geometry }, null, 2));
  console.log('CAPTURED ' + CAPTURE_DIR);
  app.quit();
}

async function runIslandCapture() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  await waitForLoad(ballWin);
  for (let attempt = 0; attempt < 30 && !latest?.ok; attempt++) {
    await poll();
    if (!latest?.ok) await sleep(250);
  }
  if (!latest?.ok) throw new Error('Island capture could not read station data');
  // Capture each interaction stage in an isolated fixture without moving the real cursor.
  await sleep(150);
  fs.writeFileSync(path.join(CAPTURE_DIR, 'island-tucked.png'), (await ballWin.webContents.capturePage()).toPNG());
  const tuckedBounds = ballWin.getBounds();
  setIslandMode('compact');
  await sleep(440);
  fs.writeFileSync(path.join(CAPTURE_DIR, 'island-compact.png'), (await ballWin.webContents.capturePage()).toPNG());
  const compact = ballWin.getBounds();
  const compactContent = await ballWin.webContents.executeJavaScript(`({
    avatars: [...document.querySelectorAll('.preview-avatar')].map(avatar => ({
      initials: avatar.querySelector('.preview-initials').textContent,
      ring: getComputedStyle(avatar.querySelector('.preview-ring-value')).strokeDasharray,
      progress: avatar.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') || null
    })),
    overflow: document.getElementById('islandPreview').scrollWidth > document.getElementById('islandPreview').clientWidth
  })`);
  setIslandMode('expanded');
  await sleep(90);
  const expanding = ballWin.getBounds();
  fs.writeFileSync(path.join(CAPTURE_DIR, 'island-expanding.png'), (await ballWin.webContents.capturePage()).toPNG());
  await sleep(390);
  fs.writeFileSync(path.join(CAPTURE_DIR, 'island-expanded.png'), (await ballWin.webContents.capturePage()).toPNG());
  const expanded = ballWin.getBounds();
  const content = await ballWin.webContents.executeJavaScript(`({
    preview: document.getElementById('islandPreview').innerText,
    rows: [...document.querySelectorAll('.island-station')].map(row => row.innerText),
    scrollHeight: document.getElementById('islandStations').scrollHeight,
    clientHeight: document.getElementById('islandStations').clientHeight
  })`);
  setIslandMode('compact');
  await sleep(390);
  const collapsed = ballWin.getBounds();
  const collapsedPreview = await ballWin.webContents.executeJavaScript('document.getElementById("islandPreview").innerText');
  fs.writeFileSync(path.join(CAPTURE_DIR, 'island-collapsed.png'), (await ballWin.webContents.capturePage()).toPNG());
  if (JSON.stringify(collapsed) !== JSON.stringify(compact) || !collapsedPreview) throw new Error('Island did not restore compact content');
  setFloatingStyle('ball');
  const ballStyleSaved = JSON.parse(fs.readFileSync(styleFile(), 'utf8')).style === 'ball' && ballWin.getBounds().width === BALL_SIZE;
  setFloatingStyle('island');
  const islandStyleSaved = JSON.parse(fs.readFileSync(styleFile(), 'utf8')).style === 'island' && ballWin.getBounds().width === tuckedBounds.width;
  if (!ballStyleSaved || !islandStyleSaved) throw new Error('Style switch did not persist or resize the window');
  fs.writeFileSync(path.join(CAPTURE_DIR, 'island-state.json'), JSON.stringify({ tucked: tuckedBounds, compact, compactContent, expanding, expanded, collapsed, collapsedPreview, content, ballStyleSaved, islandStyleSaved }, null, 2));
  console.log('CAPTURED ' + CAPTURE_DIR);
  app.quit();
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('local.tokenwatch.floating');
  channelMode = loadChannelMode();
  floatingStyle = ISLAND_CAPTURE ? 'island' : loadStyle();
  registerIpc();
  createBall();
  startIslandPointerWatch();
  createPanel();
  createTray();
  if (process.argv.includes('--create-shortcut')) createDesktopShortcut();
  screen.on('display-removed', recoverBall);
  screen.on('display-metrics-changed', () => { if (ballWin?.isVisible()) recoverBall(); });
  startPolling();
  poll();
  if (IS_CAPTURE) {
    setTimeout(() => { console.error('CAPTURE TIMEOUT'); app.quit(); }, 30000);
    (ISLAND_CAPTURE ? runIslandCapture() : runCapture()).catch((error) => { console.error('CAPTURE FAILED', error); app.quit(); });
  } else if (ballWin) {
    ballWin.show();
    if (process.argv.includes('--show-panel')) {
      await waitForLoad(panelWin);
      showPanel();
    }
  }
});

app.on('second-instance', (_event, argv) => {
  if (argv.includes('--create-shortcut')) createDesktopShortcut();
  recoverBall();
  if (argv.includes('--show-panel')) showPanel();
});

app.on('before-quit', (event) => {
  if (stopped) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  cancelRetract();
  clearInterval(animTimer);
  clearInterval(islandAnimTimer);
  clearInterval(pollTimer);
  clearInterval(islandPointerTimer);
  if (dragState) clearInterval(dragState.timer);
  service.stop().finally(() => {
    tray?.destroy();
    stopped = true;
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());
