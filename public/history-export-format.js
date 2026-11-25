(function(root) {
  function cell(value) {
    let text = String(value ?? '');
    // Preserve numeric corrections, but keep untrusted labels from becoming spreadsheet formulas.
    if (typeof value === 'string' && /^[\s\uFEFF]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function csv(data) {
    return '\ufeff' + [data.columns.map(column => cell(column.label)).join(','),
      ...data.rows.map(row => data.columns.map(column => cell(row[column.key])).join(','))].join('\r\n');
  }
  if (typeof module === 'object' && module.exports) module.exports = { csv };
  else root.HistoryExportFormat = { csv };
})(typeof window === 'undefined' ? globalThis : window);
