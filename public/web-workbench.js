/* Web presentation only. Existing controls, API calls and accounting stay in app.js. */
(() => {
  if (document.body.dataset.runtime !== 'web') return;
  const one = selector => document.querySelector(selector);
  const all = selector => [...document.querySelectorAll(selector)];
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  };
  const icon = name => {
    const element = document.createElement('i');
    element.dataset.lucide = name;
    element.setAttribute('aria-hidden', 'true');
    return element;
  };
  const iconButton = (selector, name, label) => {
    const button = typeof selector === 'string' ? one(selector) : selector;
    if (!button) return;
    button.replaceChildren(icon(name));
    if (label) button.append(node('span', '', label));
  };
  const details = (title, description, className = 'form-section', open = false) => {
    const element = node('details', className);
    element.open = open;
    const summary = node('summary');
    summary.append(node('strong', '', title), node('span', '', description), icon('chevron-down'));
    element.append(summary);
    return element;
  };

  // Keep the original controls and their identities; only reorganize the Web layout.
  const navIcons = ['layout-dashboard', 'badge-check', 'server', 'list-filter'];
  all('.nav-icon').forEach((element, index) => element.replaceChildren(icon(navIcons[index])));
  const sidebar = one('.sidebar');
  const settings = details('运行设置', '刷新与额度提醒', 'runtime-settings', matchMedia('(min-width: 1100px)').matches);
  const settingsBody = node('div', 'runtime-settings-body');
  ['.select-label', '.select-wrap', '#openAlertSettings'].forEach(selector => settingsBody.append(one(selector)));
  settings.append(settingsBody);
  one('.sidebar-label-spaced').replaceWith(settings);
  matchMedia('(min-width: 1100px)').addEventListener('change', event => { settings.open = event.matches; });
  document.addEventListener('click', event => {
    if (!matchMedia('(min-width: 1100px)').matches && !settings.contains(event.target)) settings.open = false;
  });
  const skip = node('a', 'skip-link', '跳到主要内容');
  skip.href = '#mainContent';
  skip.addEventListener('click', event => { event.preventDefault(); one('.workspace').focus(); });
  document.body.prepend(skip);
  one('.workspace').id = 'mainContent';
  one('.workspace').tabIndex = -1;
  one('.eyebrow').textContent = '用量与额度 · 一处掌握';
  const pageActions = node('div', 'page-actions');
  pageActions.append(one('#importCcSwitchButton'), one('#addStationButton'));
  one('.page-heading').append(pageActions);
  const headingStatus = one('.heading-signal');
  one('.sidebar-foot').before(headingStatus);
  iconButton('#refreshAllButton', 'refresh-cw', '刷新全部');
  iconButton('#addStationButton', 'plus', '添加中转站');
  iconButton('#importCcSwitchButton', 'import', '导入配置');
  iconButton('#syncCliButton', 'refresh-cw', '同步 CLI 用量');
  iconButton('#exportCsvButton', 'download', 'CSV');
  iconButton('#exportJsonButton', 'download', 'JSON');
  iconButton('#refreshLogsButton', 'refresh-cw');
  one('#refreshLogsButton').setAttribute('aria-label', '刷新调用日志');
  iconButton('#testStationButton', 'radio', '测试连接');
  iconButton('#testUsageButton', 'flask-conical', '测试用量查询');
  iconButton('#stationForm button[type="submit"]', 'check', '保存站点');
  iconButton('#confirmCcSwitchImport', 'check', '导入选中');
  all('.close-button').forEach(button => {
    button.setAttribute('aria-label', '关闭');
    iconButton(button, 'x');
  });
  all('.log-pagination button').forEach(button => iconButton(button, /Previous|previous/.test(button.id) ? 'chevron-left' : 'chevron-right'));
  const kpiIcons = ['cpu', 'wallet', 'history'];
  all('.kpi-icon').forEach((element, index) => element.replaceWith(icon(kpiIcons[index])));

  const balance = one('.kpi-balance');
  balance.className = 'analytics-panel balances-panel';
  const balanceHeading = node('div', 'panel-heading');
  balanceHeading.append(node('h2', '', '站点余额与状态'));
  const manage = node('button', 'text-button', '管理站点');
  manage.type = 'button';
  manage.addEventListener('click', () => one('[data-nav="stations"]').click());
  balanceHeading.append(manage);
  balance.querySelector('.kpi-top').replaceWith(balanceHeading);
  const add = one('#addStationInline');
  iconButton(add, 'plus', '添加站点');
  balance.append(add);
  one('.overview-charts').classList.add('overview-focus');
  const model = one('.model-panel');
  one('.overview-charts').after(model);
  one('.overview-charts').append(balance);
  const trendHeading = one('.token-trend-panel .panel-heading');
  const chartToolbar = one('.overview-chart-toolbar');
  trendHeading.after(chartToolbar);
  chartToolbar.append(node('small', 'scope-note', '仅影响趋势与模型分布'));
  one('.kpi-grid').setAttribute('aria-label', '历史累计指标，不受图表时间范围影响');
  one('.kpi-tokens .kpi-label').textContent = '累计 Token 用量';
  one('.overview-health .section-kicker').textContent = '连接状态';

  // Local station filters never alter monitoring or accounting.
  const stationToolbar = one('#stationsSection .section-heading');
  stationToolbar.replaceChildren();
  const searchLabel = node('label', 'station-search');
  searchLabel.append(icon('search'), node('span', 'sr-only', '搜索中转站'));
  const search = node('input');
  search.id = 'stationSearch'; search.type = 'search'; search.placeholder = '搜索站点名称或地址';
  searchLabel.append(search);
  const filters = node('div', 'segmented-control station-filters');
  filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '站点状态');
  [['all', '全部'], ['attention', '需关注'], ['paused', '已暂停']].forEach(([value, label]) => {
    const button = node('button', '', label);
    button.type = 'button'; button.dataset.stationFilter = value;
    button.setAttribute('aria-pressed', String(value === 'all'));
    filters.append(button);
  });
  const count = node('span', 'station-count'); count.id = 'stationFilterCount'; count.setAttribute('role', 'status');
  stationToolbar.append(searchLabel, filters, count);
  const noMatch = node('div', 'station-no-match'); noMatch.hidden = true;
  noMatch.append(icon('search-x'), node('h3', '', '没有匹配的中转站'), node('p', '', '尝试其他名称，或清除筛选查看全部站点。'));
  const reset = node('button', 'secondary-button', '清除筛选'); reset.type = 'button';
  noMatch.append(reset); one('#stationGrid').after(noMatch);
  let stationFilter = 'all';
  const expanded = new Map();
  let stationList = [];
  function filterStations() {
    const query = search.value.trim().toLocaleLowerCase();
    const cards = all('#stationGrid .station-card');
    let visible = 0;
    cards.forEach(card => {
      const text = `${card.querySelector('.station-name').textContent} ${card.querySelector('.station-url').textContent}`.toLocaleLowerCase();
      const station = stationList.find(item => item.id === card.dataset.stationId);
      const needsAttention = !station?.disabled && (card.classList.contains('balance-warning') || ['error', 'missing'].includes(station?.modelStatus || station?.status) || ['error', 'missing'].includes(station?.usageStatus) || QuotaPolicy.present(station || {}).stale);
      const matches = text.includes(query) && (stationFilter === 'all' || stationFilter === 'paused' && station?.disabled || stationFilter === 'attention' && needsAttention);
      card.hidden = !matches;
      if (matches) visible++;
    });
    count.textContent = `显示 ${visible} / ${cards.length} 个站点`;
    noMatch.hidden = !cards.length || visible > 0;
  }
  function resetStationFilters() {
    search.value = ''; stationFilter = 'all';
    all('[data-station-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.stationFilter === 'all')));
    filterStations();
  }
  search.addEventListener('input', filterStations);
  reset.addEventListener('click', resetStationFilters);
  filters.addEventListener('click', event => {
    const button = event.target.closest('[data-station-filter]');
    if (!button) return;
    stationFilter = button.dataset.stationFilter;
    all('[data-station-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    filterStations();
  });

  // Logs: compact summary, one toolbar, then the table and pagination.
  const calls = one('[data-history-panel="calls"]');
  const logHeading = calls.querySelector('.log-heading');
  calls.prepend(calls.querySelector('.log-summary'));
  const actions = calls.querySelector('.log-actions');
  const logTools = node('div', 'log-tools');
  logTools.append(node('h2', '', '调用明细'), actions);
  logHeading.replaceWith(logTools);
  calls.append(one('#logPagination'));
  all('.history-panel').forEach(panel => panel.append(panel.querySelector('.log-pagination')));
  all('.table-wrap, .model-table-wrap').forEach(element => {
    element.tabIndex = 0;
    element.setAttribute('role', 'region');
    element.setAttribute('aria-label', element.classList.contains('model-table-wrap') ? '模型用量明细，可横向滚动' : '日志明细，可横向滚动');
  });

  const form = one('#stationForm');
  one('#stationUsageScript').setAttribute('aria-label', '用量查询代码');
  one('#stationBaseUrl').type = 'url';
  one('#stationStatsUrl').type = 'url';
  function field(id) { return one(id).closest('label'); }
  function group(title, description, elements, open = false) {
    const section = details(title, description, 'form-section', open);
    const content = node('div', 'form-section-content');
    content.append(...elements); section.append(content);
    form.insertBefore(section, one('#stationForm .form-hint'));
    return section;
  }
  group('基本信息', '名称、模型接口与访问凭证', ['#stationName', '#stationTokenName', '#stationBaseUrl', '#stationGhost', '#stationApiKey'].map(field), true);
  group('额度与提醒', '币种、充值余额及日 / 周额度', [field('#stationBalanceUnit'), one('.quota-fieldset')]);
  group('用量查询', '统计认证与自定义查询代码', ['#stationStatsUrl', '#stationStatsToken', '#stationStatsUserId'].map(field).concat(one('.usage-code-editor')));
  group('代理计价', '输入、输出及缓存的估算单价', [one('.pricing-fieldset')]);
  form.addEventListener('invalid', event => {
    for (let parent = event.target.parentElement; parent && parent !== form; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
    // Native form validation focuses the now-visible invalid field.
  }, true);

  // Keep dialogs keyboard-contained and restore the initiating control on close.
  const shell = one('.app-shell');
  let dialog = null, returnFocus = null, lastOutsideFocus = null, returnTarget = null, stationFocus = null;
  function rememberTarget(element) {
    if (!element) return null;
    if (element.id) return { id: element.id };
    const card = element.closest('[data-station-id]');
    if (card) return { station: card.dataset.stationId, action: element.dataset.action, section: element.closest('details')?.dataset.section || element.closest('details')?.className };
    const row = element.closest('[data-log-id]');
    if (row) return { log: row.dataset.logId };
    return null;
  }
  function resolveTarget(target) {
    if (!target) return null;
    if (target.id) return document.getElementById(target.id);
    if (target.log) return all('[data-log-id]').find(row => row.dataset.logId === target.log)?.querySelector('.detail-button');
    const card = all('[data-station-id]').find(item => item.dataset.stationId === target.station);
    if (target.action) return [...(card?.querySelectorAll('[data-action]') || [])].find(button => button.dataset.action === target.action);
    return [...(card?.querySelectorAll('details') || [])].find(item => (item.dataset.section || item.className) === target.section)?.querySelector('summary');
  }
  const focusable = element => [...element.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"], a[href]')]
    .filter(item => item.getClientRects().length > 0 && !item.closest('[hidden]'));
  document.addEventListener('focusin', event => {
    if (!event.target.closest('.modal-backdrop')) lastOutsideFocus = event.target;
  });
  const observer = new MutationObserver(() => {
    const next = all('.modal-backdrop').find(element => !element.hidden);
    if (next && next !== dialog) {
      returnFocus = lastOutsideFocus || document.activeElement;
      returnTarget = rememberTarget(returnFocus);
      dialog = next; shell.inert = true; document.body.classList.add('dialog-open');
      if (!dialog.contains(document.activeElement)) (focusable(dialog)[0] || dialog.querySelector('.modal')).focus();
    } else if (!next && dialog) {
      shell.inert = false; document.body.classList.remove('dialog-open');
      dialog = null;
      const target = returnFocus?.isConnected ? returnFocus : resolveTarget(returnTarget);
      if (target?.getClientRects().length) target.focus();
      else one('.nav-item.active')?.focus();
      returnFocus = null;
      returnTarget = null;
    }
  });
  all('.modal-backdrop').forEach(element => observer.observe(element, { attributes: true, attributeFilter: ['hidden'] }));
  document.addEventListener('keydown', event => {
    if (!dialog || event.key !== 'Tab') return;
    const targets = focusable(dialog);
    const first = targets[0], last = targets.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  });

  let visiblePage = null;
  window.WebWorkbench = {
    showFormError(message) {
      const result = one('#stationTestResult');
      result.className = 'test-result error'; result.textContent = message;
      if (/代码|脚本|script|extractor/i.test(message)) all('#stationForm .form-section')[2].open = true;
      result.scrollIntoView({ block: 'center' });
    },
    groupLogDetail() {
      const list = one('#logDetailList');
      const rows = [...list.children];
      list.replaceChildren();
      list.classList.add('grouped-details');
      [['请求信息', 0, 6], ['Token 用量', 6, 12], ['费用与计价', 12, 14], ['性能与来源', 14, rows.length]].forEach(([title, start, end]) => {
        const group = node('div', 'detail-group');
        const content = node('dd'); const fields = node('dl', 'detail-fields');
        fields.append(...rows.slice(start, end)); content.append(fields);
        group.append(node('dt', 'detail-group-title', title), content); list.append(group);
      });
    },
    setPage(page) {
      document.body.dataset.view = page;
      if (visiblePage !== null && visiblePage !== page) window.scrollTo({ top: 0, behavior: 'instant' });
      visiblePage = page;
      pageActions.hidden = page !== 'stations';
      all('[data-nav]').forEach(button => {
        if (button.dataset.nav === page) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
    },
    resetStationFilters,
    prepareStationForm() {
      all('#stationForm .form-section').forEach((section, index) => { section.open = index === 0; });
      one('#stationModal .modal').scrollTop = 0;
    },
    beforeStations() {
      stationFocus = document.activeElement.closest('.station-grid') ? rememberTarget(document.activeElement) : null;
      all('.station-grid .station-card').forEach(card => {
        expanded.set(card.dataset.stationId, [...card.querySelectorAll('details')].filter(item => item.open).map(item => item.dataset.section || item.className));
      });
    },
    afterStations(stations) {
      stationList = stations;
      const ids = new Set(stations.map(station => station.id));
      for (const id of expanded.keys()) if (!ids.has(id)) expanded.delete(id);
      all('.station-grid .station-card').forEach(card => {
        iconButton(card.querySelector('[data-action="refresh"]'), 'refresh-cw');
        iconButton(card.querySelector('[data-action="edit"]'), 'sliders-horizontal');
        const station = stations.find(item => item.id === card.dataset.stationId);
        const breakdown = details(station?.ghost ? 'Token 分项' : 'Token 分项与接入',
          station?.ghost ? '查看输入、输出和缓存记录' : '查看输入、输出、缓存和代理地址', 'station-detail');
        breakdown.dataset.section = 'breakdown';
        const content = node('div', 'station-detail-content');
        ['.station-token-breakdown', '.history-note', '.station-proxy'].forEach(selector => {
          const element = card.querySelector(selector); if (element) content.append(element);
        });
        breakdown.append(content);
        card.querySelector('.station-history-menu').before(breakdown);
        card.querySelector('.station-history-menu summary').textContent = '管理与历史校准';
        card.querySelectorAll('details').forEach(item => { item.open = (expanded.get(card.dataset.stationId) || []).includes(item.dataset.section || item.className); });
      });
      filterStations();
      lucide.createIcons();
      if (stationFocus && !dialog) resolveTarget(stationFocus)?.focus({ preventScroll: true });
      stationFocus = null;
    },
    afterBalances(stations) {
      all('[data-balance-station]').forEach(row => {
        const station = stations.find(item => item.id === row.dataset.balanceStation);
        const status = node('small', 'balance-row-status');
        const modelStatus = station.modelStatus || station.status;
        status.textContent = station.ghost ? '幽灵中转 · 仅记录' : station.disabled ? '已暂停监控' : `模型${modelStatus === 'online' ? '正常' : modelStatus === 'error' ? '异常' : '待检测'} · 用量${station.usageStatus === 'online' ? '正常' : station.usageStatus === 'error' ? '异常' : '待查询'}`;
        row.querySelector('.balance-row-main').append(status);
      });
    }
  };
})();
