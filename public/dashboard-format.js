(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DashboardFormat = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  function compact(value) {
    const n = Number(value || 0);
    const units = ['', 'K', 'M', 'G', 'T', 'P'];
    const index = Math.min(5, Math.max(0, Math.floor(Math.log10(Math.max(1, Math.abs(n))) / 3)));
    return `${Math.trunc(n / 1000 ** index).toLocaleString('en-US')}${units[index]}`;
  }
  function money(value, unit = 'CNY', precision = 2) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '--';
    const symbol = unit === 'USD' ? '$' : unit === 'CNY' ? '¥' : unit;
    return `${symbol} ${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: precision, maximumFractionDigits: precision })}`;
  }
  return { compact, money };
});
