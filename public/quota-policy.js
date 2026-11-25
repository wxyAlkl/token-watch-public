(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuotaPolicy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function amount(value) {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  function normalize(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('额度设置必须为对象');
    const mode = value.mode === undefined ? 'prepaid' : value.mode;
    if (!['daily', 'weekly', 'prepaid'].includes(mode)) throw new Error('请选择每日、每周或充值余额模式');
    const limit = amount(value.limit);
    if (mode !== 'prepaid' && (limit === null || limit <= 0)) throw new Error('周期额度必须为大于 0 的数字');
    const threshold = amount(value.lowBalanceThreshold);
    if (value.lowBalanceThreshold != null && value.lowBalanceThreshold !== '' && (threshold === null || threshold < 0)) {
      throw new Error('低余额提醒阈值必须为大于等于 0 的数字');
    }
    const source = value.source === undefined ? 'account' : value.source;
    if (typeof source !== 'string' || source.length > 240 || (source !== 'account' && !/^plan:[^\r\n]+$/.test(source))) {
      throw new Error('请选择有效的额度来源');
    }
    return { mode, limit: mode === 'prepaid' ? null : limit, lowBalanceThreshold: threshold, source };
  }

  function planName(plan) { return String(plan?.planName || plan?.name || '用量计划'); }

  function present(station) {
    const policy = normalize(station.quotaPolicy);
    const unit = station.balanceUnit || 'USD';
    let remaining = station.balanceKnown === false ? null : amount(station.balance);
    let sourceLabel = '账户余额';
    let reason = '';
    if (policy.source !== 'account') {
      sourceLabel = policy.source.slice(5);
      const matches = (station.usagePlans || []).filter((plan) => planName(plan) === sourceLabel);
      if (matches.length !== 1) {
        remaining = null;
        reason = matches.length ? '额度明细名称重复' : '未找到所选额度明细';
      } else if (String(matches[0].unit || unit).toUpperCase() !== String(unit).toUpperCase()) {
        remaining = null;
        reason = '额度明细币种不匹配';
      } else {
        remaining = station.balanceKnown === false ? null : amount(matches[0].remaining);
      }
    }
    const stale = station.usageStatus !== 'online' && remaining !== null;
    const percent = remaining === null || policy.mode === 'prepaid' ? null
      : Math.min(100, Math.max(0, remaining / policy.limit * 100));
    const state = remaining === null ? 'unknown' : remaining <= 0 ? 'depleted'
      : policy.mode === 'prepaid' && policy.lowBalanceThreshold !== null && remaining <= policy.lowBalanceThreshold ? 'low' : 'normal';
    return { ...policy, remaining, unit, percent, state, sourceLabel, reason, stale,
      overLimit: percent !== null && remaining > policy.limit };
  }

  return { normalize, present, planName };
});
