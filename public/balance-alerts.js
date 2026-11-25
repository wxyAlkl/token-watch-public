(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BalanceAlerts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  function threshold(value, label, max = Infinity) {
    if (value == null || value === '') return null;
    if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') throw new Error(`${label}必须为有效数字`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label}必须在 0 至 ${max === Infinity ? '正数' : max} 范围内`);
    return n;
  }
  function normalize(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('额度警告设置必须为对象');
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('警告开关必须为布尔值');
    return { enabled: value.enabled ?? true, USD: threshold(value.USD, '美元阈值'), CNY: threshold(value.CNY, '人民币阈值'), percent: threshold(value.percent, '百分比阈值', 100) };
  }
  function evaluate(quota, config) {
    const settings = normalize(config);
    if (!settings.enabled || quota.remaining === null) return { active: false, reasons: [] };
    const amount = quota.lowBalanceThreshold ?? settings[quota.unit] ?? null;
    const reasons = [];
    if (quota.remaining <= 0) reasons.push('余额已用完');
    else {
      if (amount !== null && quota.remaining < amount) reasons.push('低于余额提醒线');
      if (quota.percent !== null && settings.percent !== null && quota.percent < settings.percent) reasons.push('低于剩余百分比提醒线');
    }
    return { active: reasons.length > 0, reasons, stale: quota.stale, amount, percent: settings.percent };
  }
  return { normalize, evaluate };
});
