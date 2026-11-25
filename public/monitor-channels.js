(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MonitorChannels = factory();
})(this, function () {
  function isOfficialStation(station) {
    if (!station || station.ghost) return false;
    try {
      return new URL(station.baseUrl).origin === 'https://api.deepseek.com';
    } catch { return false; }
  }

  function codexWindowLabel(window) {
    const minutes = window.minutes;
    let label = window.kind === 'secondary' ? '第二额度周期' : '额度周期';
    if (minutes === 10080) label = '每周额度';
    else if (minutes > 0 && minutes % 1440 === 0) label = `${minutes / 1440} 天额度`;
    else if (minutes > 0 && minutes % 60 === 0) label = `${minutes / 60} 小时额度`;
    else if (minutes > 0) label = `${minutes} 分钟额度`;
    return window.bucket === 'codex' ? label : `${window.bucket} · ${label}`;
  }

  function officialAccounts(stations, codex) {
    const windows = codex?.windows || [];
    const primary = windows.find(w => w.bucket === 'codex' && w.kind === 'primary') || windows[0];
    const percent = primary?.remaining;
    const details = windows.map(w => {
      const reset = w.resetsAt == null ? '' : ' · ' + new Date(w.resetsAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 重置';
      return codexWindowLabel(w) + (w.remaining == null ? ' 未知' : ' 剩余 ' + w.remaining + '%') + reset;
    });
    if (!windows.length) details.push(codex?.status === 'login-required' ? '请在本机 Codex 使用 ChatGPT 登录' : codex?.windows ? '官方未返回额度周期' : '额度暂未获取');
    const accounts = [{ provider: 'codex', name: 'Codex', value: percent == null ? '—' : percent + '%',
      percent, details, label: primary ? codexWindowLabel(primary) : '账号额度',
      state: percent == null ? 'unknown' : percent === 0 ? 'warn' : 'ok' }];
    for (const s of stations.filter(isOfficialStation)) {
      const known = s.balanceKnown && Number.isFinite(s.balance);
      const unit = String(s.balanceUnit || '').toUpperCase();
      const value = known ? (unit === 'CNY' ? '¥' : unit === 'USD' ? '$' : unit + ' ') + s.balance.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
      const label = s.disabled ? '已暂停' : s.usageStatus !== 'online' ? (known ? '上次余额' : '余额查询未就绪') : '账户余额';
      const date = s.balanceUpdatedAt ? new Date(s.balanceUpdatedAt).toLocaleString('zh-CN') : '';
      accounts.push({ provider: 'deepseek', name: /^deepseek$/i.test(s.name) ? 'DeepSeek' : 'DeepSeek · ' + s.name,
        value, label, details: [[label, date].filter(Boolean).join(' · ')],
        state: s.disabled || s.usageStatus !== 'online' || !known ? 'unknown' : s.balance <= 0 ? 'warn' : 'ok' });
    }
    return accounts;
  }
  return { isOfficialStation, codexWindowLabel, officialAccounts };
});
