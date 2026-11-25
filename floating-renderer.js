const requestedView = new URLSearchParams(window.location.search).get('view');
const view = ['ball', 'panel', 'island'].includes(requestedView) ? requestedView : 'ball';
document.body.dataset.view = view;
const ballView = document.getElementById('ballView');
const panelView = document.getElementById('panelView');
const islandView = document.getElementById('islandView');
ballView.hidden = view !== 'ball';
panelView.hidden = view !== 'panel';
islandView.hidden = view !== 'island';

const money = (value, unit) => {
  const numeric = Number(value);
  if (value === null || value === undefined || !Number.isFinite(numeric)) return '--';
  const code = String(unit || 'USD').toUpperCase();
  const symbol = code === 'USD' ? '$' : code === 'CNY' ? '¥' : `${code} `;
  return symbol + numeric.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const groupedMoney = (groups) => {
  const entries = Object.entries(groups || {});
  if (!entries.length) return '--';
  const order = ['USD', 'CNY'];
  entries.sort((a, b) => (order.indexOf(a[0]) === -1 ? 99 : order.indexOf(a[0])) - (order.indexOf(b[0]) === -1 ? 99 : order.indexOf(b[0])));
  return entries.map(([unit, value]) => money(value, unit)).join(' · ');
};

const timeAgo = (value) => {
  if (!value) return '--';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '--';
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
};

const MODEL_LABEL = { online: '模型正常', error: '模型异常', missing: '未配置 Key', checking: '检查中', unknown: '未检测' };
const USAGE_LABEL = { online: '用量正常', error: '用量异常', missing: '未配置 Key', unconfigured: '用量未配置', blocked: '等待模型接口', checking: '查询中', unknown: '未查询' };
const chipClass = (status) => status === 'online' ? 'ok' : status === 'error' ? 'error' : status === 'missing' || status === 'unconfigured' ? 'warn' : '';

function setBallState(state) {
  document.body.dataset.ballState = state;
}

function applyTuckState(tuck) {
  const visible = Number(tuck?.visible);
  if (Number.isFinite(visible)) document.body.style.setProperty('--tuck-visible', `${Math.max(8, Math.min(24, visible))}px`);
  if (tuck && tuck.tucked && tuck.side) document.body.dataset.tucked = tuck.side;
  else delete document.body.dataset.tucked;
  const handle = document.getElementById('tuckHandle');
  if (handle) {
    handle.tabIndex = tuck?.tucked ? 0 : -1;
    handle.setAttribute('aria-label', '悬浮球已收起，悬停或点击展开');
  }
}

/* ---------- ball ---------- */
function renderBall(summary) {
  const ball = document.getElementById('ball');
  if (!ball) return;
  const valueEl = document.getElementById('ballValue');
  const labelEl = document.getElementById('ballLabel');
  const badgeEl = document.getElementById('ballBadge');
  const ring = document.getElementById('ringProgress');
  ball.classList.remove('state-ok', 'state-warn', 'state-error', 'state-offline', 'state-syncing');
  if (!summary || !summary.ok) {
    ball.classList.add('state-offline');
    valueEl.textContent = '--';
    labelEl.textContent = '未连接';
    badgeEl.hidden = true;
    ring.style.strokeDashoffset = '264';
    ball.title = `无法连接本地服务 ${summary?.apiBase || ''}`;
    setBallState('offline');
    return;
  }
  const status = summary.status;
  const total = Math.max(1, status.active);
  const percent = Math.round((status.online / total) * 100);
  ring.style.strokeDashoffset = String(Math.round(264 - (264 * percent) / 100));
  valueEl.textContent = `${status.online}/${status.active}`;
  const problems = status.modelErrors + status.usageErrors;
  const badge = problems + status.alerts;
  badgeEl.hidden = badge === 0;
  badgeEl.textContent = badge > 99 ? '99+' : String(badge);
  if (status.syncing) {
    ball.classList.add('state-syncing');
    labelEl.textContent = status.progress && status.progress.total ? `同步 ${status.progress.done}/${status.progress.total}` : '同步中';
    setBallState('syncing');
  } else if (status.active > 0 && status.online === 0) {
    ball.classList.add('state-error');
    labelEl.textContent = '全部异常';
    setBallState('error');
  } else if (problems > 0) {
    ball.classList.add('state-warn');
    labelEl.textContent = `${problems} 异常`;
    setBallState('warn');
  } else if (status.alerts > 0) {
    ball.classList.add('state-warn');
    labelEl.textContent = `${status.alerts} 告警`;
    setBallState('warn');
  } else {
    ball.classList.add('state-ok');
    labelEl.textContent = '运行正常';
    setBallState('ok');
  }
  ball.title = `${status.online}/${status.active} 在线 · 告警 ${status.alerts} 项 · 最后同步 ${timeAgo(status.lastSync)}`;
}

/* ---------- panel ---------- */
function renderPanel(summary) {
  const dot = document.getElementById('panelDot');
  const serviceEl = document.getElementById('panelService');
  const hint = document.getElementById('panelHint');
  dot.className = 'panel-dot';
  if (!summary || !summary.ok) {
    dot.classList.add('error');
    serviceEl.textContent = '无法连接本地服务 · ' + (summary?.apiBase || '');
    document.getElementById('statOnline').textContent = '--';
    document.getElementById('statAlerts').textContent = '--';
    document.getElementById('statSync').textContent = '--';
    document.getElementById('statBalance').textContent = '--';
    const cached = summary?.cached;
    if (cached?.ok) {
      renderPanel(cached);
      dot.className = 'panel-dot error';
      serviceEl.textContent = '连接已断开 · 下方为上次读取的数据';
      hint.textContent = summary.error || '后台正在重连';
      return;
    }
    document.getElementById('stationList').innerHTML = `<li class="station-empty">${escapeHtml(summary?.error || '正在连接后台服务…')}<br><small>右上角菜单可重新连接后台</small></li>`;
    document.getElementById('panelStationCount').textContent = '';
    hint.textContent = '服务恢复后自动重连';
    return;
  }
  const status = summary.status;
  const problems = status.modelErrors + status.usageErrors;
  if (problems > 0) dot.classList.add('error');
  else if (status.alerts > 0) dot.classList.add('warn');
  else dot.classList.add('ok');
  serviceEl.textContent = status.syncing
    ? (status.progress && status.progress.total ? `正在刷新 ${status.progress.done}/${status.progress.total}${status.progress.current ? ' · ' + status.progress.current : ''}` : '正在刷新…')
    : '最后同步 ' + timeAgo(status.lastSync);

  const onlineEl = document.getElementById('statOnline');
  onlineEl.textContent = `${status.online}/${status.active}`;
  onlineEl.className = status.active && status.online === status.active ? '' : problems ? 'error' : 'warn';
  const alertEl = document.getElementById('statAlerts');
  alertEl.textContent = status.alerts ? `${status.alerts} 项` : '无';
  alertEl.className = status.alerts ? 'warn' : '';
  document.getElementById('statSync').textContent = timeAgo(status.lastSync);
  document.getElementById('statBalance').textContent = groupedMoney(summary.totalBalanceByUnit);
  document.getElementById('panelStationCount').textContent = `${summary.stations.length} 个`;
  document.getElementById('stationList').innerHTML = summary.stations.map((station) => {
    const problem = station.modelStatus === 'error' || station.usageStatus === 'error';
    const rowClass = station.disabled ? 'disabled' : station.alertActive ? 'alert' : problem ? 'error' : '';
    return `<li class="station-row ${rowClass}" title="${station.alertReasons.length ? station.alertReasons.join('；') : ''}">
      <span class="station-name">${escapeHtml(station.name)}${station.disabled ? '<span class="paused-tag">已暂停</span>' : ''}</span>
      <span class="station-balance">${station.disabled ? '--' : money(station.balance, station.balanceUnit)}</span>
      <span class="station-sub"><span class="status-chip ${chipClass(station.modelStatus)}">${MODEL_LABEL[station.modelStatus] || station.modelStatus}</span><span class="status-chip ${chipClass(station.usageStatus)}">${USAGE_LABEL[station.usageStatus] || station.usageStatus}</span><span>${station.modelCount} 模型</span></span>
    </li>`;
  }).join('') || '<li class="station-empty">还没有中转站</li>';
  if (problems > 0) hint.textContent = `${status.modelErrors} 个模型接口异常 · ${status.usageErrors} 个用量查询异常`;
  else if (status.alerts > 0) hint.textContent = `${status.alerts} 项额度告警，请查看工作台`;
  else hint.textContent = '左键拖拽移动 · 右键菜单 · 单击展开/收起';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function quotaLabel(quota, compact = false) {
  if (!quota || quota.remaining === null || quota.remaining === undefined) return '额度未知';
  if (quota.mode === 'prepaid') return compact ? money(quota.remaining, quota.unit) : `剩余 ${money(quota.remaining, quota.unit)}`;
  if (quota.percent === null || quota.percent === undefined) return '额度未知';
  const percent = `${Number(quota.percent.toFixed(1))}%`;
  return compact ? percent : `剩余 ${percent}`;
}

function stationInitials(name) {
  return Array.from(String(name || '').trim()).slice(0, 2).join('').toLocaleUpperCase() || '--';
}

function islandAvatar(station) {
  const quota = station.quota || {};
  const periodic = quota.mode === 'daily' || quota.mode === 'weekly';
  const percent = periodic && Number.isFinite(quota.percent)
    ? Math.max(0, Math.min(100, quota.percent)) : null;
  const state = quota.stale ? 'stale'
    : station.modelStatus === 'error' || station.usageStatus === 'error' || quota.state === 'depleted'
      ? 'error' : station.alertActive || quota.state === 'low' ? 'warn' : 'ok';
  const ringValue = periodic ? percent ?? 0 : quota.remaining === null || quota.remaining === undefined || quota.state === 'depleted' ? 0 : 100;
  const progress = percent === null ? ''
    : ` role="progressbar" aria-label="${escapeHtml(station.name)}剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"`;
  return `<span class="preview-avatar ${state}${periodic ? ' periodic' : ' balance'}">
    <svg class="preview-ring" viewBox="0 0 40 40"${progress || ' aria-hidden="true"'}><circle class="preview-ring-track" cx="20" cy="20" r="17" pathLength="100"></circle><circle class="preview-ring-value" cx="20" cy="20" r="17" pathLength="100" style="stroke-dasharray:${ringValue} 100"></circle></svg>
    <span class="preview-initials" aria-hidden="true">${escapeHtml(stationInitials(station.name))}</span>
  </span>`;
}

function renderIsland(summary, stale = false) {
  const dot = document.getElementById('islandDot');
  const service = document.getElementById('islandService');
  if (!summary?.ok) {
    if (summary?.cached?.ok) {
      renderIsland(summary.cached, true);
      dot.className = 'island-status-dot error';
      document.getElementById('islandMore').textContent += ' · 离线';
      service.textContent = '连接已断开 · 显示上次数据';
      document.getElementById('islandHint').textContent = '后台恢复后自动更新';
      return;
    }
    dot.className = 'island-status-dot error';
    document.getElementById('islandPreview').textContent = '后台未连接';
    document.getElementById('islandMore').textContent = '';
    service.textContent = '无法连接本地服务';
    document.getElementById('islandStations').innerHTML = '<li class="station-empty">正在连接后台服务…</li>';
    document.getElementById('islandOnline').textContent = '-- 在线';
    document.getElementById('islandAlerts').textContent = '-- 告警';
    document.getElementById('islandBalance').textContent = '余额 --';
    document.getElementById('islandStationCount').textContent = '';
    document.getElementById('islandHint').textContent = '后台恢复后自动更新';
    return;
  }
  const status = summary.status;
  const active = summary.stations.filter((station) => !station.disabled);
  const problemCount = status.modelErrors + status.usageErrors;
  dot.className = 'island-status-dot ' + (stale ? 'error' : status.syncing ? 'syncing' : problemCount ? 'error' : status.alerts ? 'warn' : 'ok');
  const preview = document.getElementById('islandPreview');
  preview.innerHTML = active.slice(0, 2).map((station) => {
    const state = station.alertActive ? 'warn' : station.modelStatus === 'error' || station.usageStatus === 'error' ? 'error' : '';
    const ringMeaning = station.quota?.mode === 'prepaid' ? '圆环表示余额状态' : '圆环表示剩余额度比例';
    return `<span class="preview-station ${state}" title="${escapeHtml(station.name)} · ${escapeHtml(quotaLabel(station.quota))} · ${ringMeaning}${station.quota?.stale ? ' · 上次数据' : ''}">${islandAvatar(station)}<strong>${escapeHtml(quotaLabel(station.quota, true))}</strong></span>`;
  }).join('') || '<span>还没有中转站</span>';
  document.getElementById('islandMore').textContent = active.length > 2 ? `+${active.length - 2}` : '';
  service.textContent = stale ? '连接已断开 · 显示上次数据'
    : status.syncing ? '正在刷新…' : `最后同步 ${timeAgo(status.lastSync)}`;
  document.getElementById('islandOnline').textContent = `${status.online}/${status.active} 在线`;
  document.getElementById('islandAlerts').textContent = `${status.alerts} 告警 · ${problemCount} 接口异常`;
  document.getElementById('islandBalance').textContent = `余额 ${groupedMoney(summary.totalBalanceByUnit)}`;
  document.getElementById('islandStationCount').textContent = `${summary.stations.length} 个`;
  document.getElementById('islandStations').innerHTML = summary.stations.map((station) => {
    const quota = station.quota || {};
    const rowClass = station.disabled ? 'disabled' : station.alertActive ? 'alert' : station.modelStatus === 'error' || station.usageStatus === 'error' ? 'error' : '';
    const mode = { daily: '每日', weekly: '每周', prepaid: '充值余额' }[quota.mode] || '额度';
    const model = MODEL_LABEL[station.modelStatus] || station.modelStatus;
    const usage = USAGE_LABEL[station.usageStatus] || station.usageStatus;
    const limit = quota.mode !== 'prepaid' && quota.remaining !== null && quota.limit !== null
      ? `${money(quota.remaining, quota.unit)} / ${money(quota.limit, quota.unit)}` : '';
    const calledAt = Number.isFinite(Number(station.lastCallAt)) && station.lastCallAt
      ? `最近调用 ${timeAgo(new Date(Number(station.lastCallAt)).toISOString())}` : '';
    const meter = quota.mode !== 'prepaid' && quota.percent !== null && quota.percent !== undefined
      ? `<div class="island-meter" role="progressbar" aria-label="${escapeHtml(station.name)}剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${quota.percent}"><span style="width:${quota.percent}%"></span></div>` : '';
    return `<li class="island-station ${rowClass}"><div class="island-station-top"><strong>${escapeHtml(station.name)}${station.disabled ? ' · 已暂停' : ''}</strong><span>${station.disabled ? '--' : escapeHtml(quotaLabel(quota))}</span></div>
      <div class="island-station-meta"><span>${mode} · ${escapeHtml(quota.sourceLabel || '账户余额')}</span>${limit ? `<span>${escapeHtml(limit)}</span>` : ''}<span class="${station.modelStatus === 'error' ? 'bad' : ''}">${escapeHtml(model)}</span><span class="${station.usageStatus === 'error' ? 'bad' : ''}">${escapeHtml(usage)}</span>${quota.stale ? '<span class="warn">上次数据</span>' : ''}</div>
      ${calledAt ? `<div class="island-station-meta">${escapeHtml(calledAt)}</div>` : ''}
      ${meter}${station.alertActive || quota.reason ? `<div class="island-station-meta warn">${escapeHtml([...station.alertReasons, quota.reason].filter(Boolean).join(' · '))}</div>` : ''}</li>`;
  }).join('') || '<li class="station-empty">还没有中转站</li>';
  document.getElementById('islandHint').textContent = stale ? '后台恢复后自动更新' : '';
}

function renderOfficial(summary) {
  const byId = id => document.getElementById(id);
  const accounts = (summary.ok ? summary : summary.cached)?.accounts || [];
  const codex = accounts[0];
  const status = summary.loading ? '正在读取官方账号…' : !summary.ok ? '后台未连接' + (accounts.length ? ' · 上次数据' : '') : '官方账号';
  const tone = !summary.ok ? 'offline' : accounts.some(a => a.state !== 'ok') ? 'warn' : 'ok';
  if (view === 'ball') {
    byId('ball').className = 'ball state-' + tone;
    byId('ballValue').textContent = codex?.value ?? '—';
    const deepseek = accounts.find(a => a.provider === 'deepseek');
    byId('ballLabel').textContent = !summary.ok ? (summary.loading ? '读取中' : '离线') : deepseek
      ? 'DS ' + deepseek.value + (deepseek.state === 'unknown' ? '*' : '') : '剩余额度';
    byId('ballBadge').hidden = true;
    byId('ringProgress').style.strokeDashoffset = String(264 * (1 - (codex?.percent ?? 0) / 100));
    byId('ball').title = [status, ...accounts.map(a => a.name + ' ' + a.value + ' · ' + a.label)].join('\n');
    setBallState(tone);
    return;
  }
  const island = view === 'island';
  const prefix = island ? 'island' : 'panel';
  byId(prefix + 'Service').textContent = status;
  byId(prefix + 'StationCount').textContent = accounts.length ? accounts.length + ' 个' : '';
  byId(prefix + 'Hint').textContent = '';
  byId(prefix + 'Dot').className = (island ? 'island-status-dot ' : 'panel-dot ') + (tone === 'offline' ? 'error' : tone);
  const list = byId(island ? 'islandStations' : 'stationList');
  list.innerHTML = accounts.map(a => `<li class="official-account-row"><strong>${escapeHtml(a.name)}</strong><b>${escapeHtml(a.value)}</b><small>${a.details.map(escapeHtml).join('<br>')}</small></li>`).join('')
    || `<li class="station-empty">${escapeHtml(status)}</li>`;
  if (island) {
    byId('islandPreview').innerHTML = accounts.slice(0, 2).map(a => `<span class="official-preview"><small>${escapeHtml(a.provider === 'codex' ? 'Codex' : 'DeepSeek')}</small><strong>${escapeHtml(a.value)}</strong></span>`).join('') || escapeHtml(status);
    byId('islandMore').textContent = accounts.length > 2 ? '+' + (accounts.length - 2) : '';
  }
}

function render(summary) {
  const official = summary?.channel === 'official';
  document.body.dataset.channel = official ? 'official' : 'relay';
  if (view !== 'ball') {
    document.getElementById(view + 'ChannelTitle').textContent = official ? '官方账号' : '中转站';
    document.getElementById(view + 'ChannelSwitch').textContent = official ? '切到中转站' : '切到官方账号';
  }
  if (official) renderOfficial(summary);
  else if (view === 'ball') renderBall(summary);
  else if (view === 'island') renderIsland(summary);
  else renderPanel(summary);
}

if (view !== 'ball') {
  document.getElementById(view + 'ChannelSwitch').addEventListener('click', () =>
    window.floating.setChannel(document.body.dataset.channel === 'official' ? 'relay' : 'official'));
}

window.floating.onSummary(render);
window.floating.getSummary().then(render).catch(() => render(null));

if (view === 'island') {
  const island = document.getElementById('island');
  const islandHandle = document.getElementById('islandTuckHandle');
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const syncMotionPreference = () => window.floating.setIslandReducedMotion(motionPreference.matches).catch(() => {});
  syncMotionPreference();
  motionPreference.addEventListener('change', syncMotionPreference);
  const applyIslandState = (state) => {
    const mode = ['tucked', 'compact', 'expanded'].includes(state?.mode) ? state.mode : 'compact';
    document.body.dataset.islandMode = mode;
    island.setAttribute('aria-label', mode === 'expanded'
      ? 'Token Watch 灵动岛详情'
      : 'Token Watch 灵动岛，单击展开详情');
    island.tabIndex = mode === 'tucked' ? -1 : 0;
    islandHandle.tabIndex = mode === 'tucked' ? 0 : -1;
  };
  window.floating.onIslandState(applyIslandState);
  window.floating.getIslandState().then(applyIslandState).catch(() => {});
  islandHandle.addEventListener('click', () => window.floating.hover().catch(() => {}));
  document.getElementById('islandCompact').addEventListener('click', () => window.floating.togglePanel());
  document.getElementById('islandClose').addEventListener('click', () => window.floating.hidePanel());
  document.getElementById('islandOpen').addEventListener('click', () => window.floating.openDashboard());
  document.getElementById('islandMenu').addEventListener('click', () => window.floating.showMenu());
  document.getElementById('islandRefresh').addEventListener('click', async () => {
    const button = document.getElementById('islandRefresh');
    button.disabled = true;
    try {
      const result = await window.floating.refresh();
      if (!result.ok) document.getElementById('islandHint').textContent = `刷新失败：${result.error || '未知错误'}`;
    } catch (error) {
      document.getElementById('islandHint').textContent = `刷新失败：${error.message || error}`;
    } finally { button.disabled = false; }
  });
  island.addEventListener('contextmenu', (event) => { event.preventDefault(); window.floating.showMenu(); });
  island.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); window.floating.hidePanel(); }
    if ((event.key === 'Enter' || event.key === ' ') && event.target === island) { event.preventDefault(); window.floating.togglePanel(); }
  });
} else if (view === 'ball') {
  const ball = document.getElementById('ball');
  document.getElementById('tuckHandle').addEventListener('click', () => { window.floating.hover().catch(() => {}); });
  let dragging = false;
  window.floating.onTuckState(applyTuckState);
  window.floating.getTuckState().then(applyTuckState).catch(() => {});
  document.body.addEventListener('mouseenter', () => { window.floating.hover().catch(() => {}); });
  document.body.addEventListener('mouseleave', () => { window.floating.leave().catch(() => {}); });
  ball.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    window.floating.dragStart().catch(() => {});
  });
  window.addEventListener('mouseup', async () => {
    if (!dragging) return;
    dragging = false;
    try {
      const result = await window.floating.dragEnd();
      if (result && result.clicked) window.floating.togglePanel();
    } catch {}
  });
  ball.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.floating.showMenu();
  });
  ball.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); window.floating.togglePanel(); }
  });
} else {
  document.getElementById('panelClose').addEventListener('click', () => window.floating.hidePanel());
  document.getElementById('panelOpen').addEventListener('click', () => window.floating.openDashboard());
  document.getElementById('panelHide').addEventListener('click', () => window.floating.hideBall());
  document.getElementById('panelMenu').addEventListener('click', () => window.floating.showMenu());
  document.getElementById('panelRefresh').addEventListener('click', () => runRefresh());
  document.getElementById('panelRefreshAll').addEventListener('click', () => runRefresh());
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.floating.hidePanel(); });
  async function runRefresh() {
    const buttons = [document.getElementById('panelRefresh'), document.getElementById('panelRefreshAll')];
    buttons.forEach((button) => { button.disabled = true; });
    document.getElementById('panelService').textContent = '正在触发刷新…';
    try {
      const result = await window.floating.refresh();
      if (!result.ok) document.getElementById('panelHint').textContent = '刷新失败：' + (result.error || '未知错误');
    } catch (error) {
      document.getElementById('panelHint').textContent = '刷新失败：' + (error.message || error);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }
}
