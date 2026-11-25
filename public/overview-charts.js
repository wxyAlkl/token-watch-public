(function() {
  const web = document.body.dataset.runtime === 'web';
  const colors = ['#377cf6', '#14aa83', '#f0ad29', '#d4547b', '#8a68d5', '#22b8cf', '#8392a5'];
  let doughnut, trend;
  const emptyPlugin = {
    id: 'emptyState',
    afterDraw(chart) {
      if (chart.config.type !== 'line' || chart.data.datasets.some(dataset => dataset.yAxisID !== 'percent' && dataset.data.some(value => value > 0))) return;
      const { ctx, chartArea } = chart;
      ctx.save(); ctx.fillStyle = '#7c8898'; ctx.font = '12px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('暂无调用数据', (chartArea.left + chartArea.right) / 2, (chartArea.top + chartArea.bottom) / 2); ctx.restore();
    }
  };
  function render(stats) {
    const models = stats.models;
    const slices = models.slice(0, 6).map(model => ({ name: model.model, tokens: model.tokens }));
    if (models.length > 6) slices.push({ name: '其他模型', tokens: models.slice(6).reduce((sum, model) => sum + model.tokens, 0) });
    const data = { labels: slices.map(model => model.name), datasets: [{ data: slices.map(model => model.tokens), backgroundColor: colors, borderColor: '#fff', borderWidth: 2, hoverOffset: 4 }] };
    if (!doughnut) doughnut = new Chart(document.getElementById('modelChart'), {
      type: 'doughnut', data,
      options: { responsive: true, maintainAspectRatio: false, cutout: '72%', animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${context.label}: ${Number(context.raw).toLocaleString('zh-CN')} Tokens` } } } }
    });
    else { doughnut.data = data; doughnut.update('none'); }
    const definitions = [
      [web ? '普通输入' : 'Input', 'input', '#377cf6'], [web ? '普通输出' : 'Output', 'output', '#14aa83'],
      [web ? '缓存创建' : 'Cache Creation', 'cacheCreation', '#f0ad29'], [web ? '缓存读取' : 'Cache Read', 'cacheRead', '#10b6cd']
    ];
    const lineData = { labels: stats.trend.map(bucket => bucket.date), datasets: definitions.map(([label, key, color]) => ({
      label, data: stats.trend.map(bucket => bucket[key]), borderColor: color, backgroundColor: `${color}18`,
      fill: key === 'cacheRead', tension: 0.3, pointRadius: stats.days === 30 ? 1 : 2, borderWidth: 2, yAxisID: 'tokens'
    })) };
    lineData.datasets.push({ label: web ? '缓存命中率' : 'Cache Hit Rate', data: stats.trend.map(bucket => bucket.cacheHitRate),
      borderColor: '#9863f8', backgroundColor: '#9863f818', borderDash: [5, 4], tension: 0.3, pointRadius: 2, borderWidth: 2, yAxisID: 'percent', spanGaps: false });
    if (!trend) trend = new Chart(document.getElementById('tokenTrendChart'), {
      type: 'line', data: lineData, plugins: [emptyPlugin], options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 13, font: { size: 10 } } },
          tooltip: { callbacks: { label: context => `${context.dataset.label}: ${context.parsed.y == null ? '--' : context.dataset.yAxisID === 'percent' ? `${context.parsed.y.toFixed(1)}%` : Number(context.parsed.y).toLocaleString('zh-CN')}` } }
        },
        scales: {
          x: { grid: { color: '#edf0f5' }, ticks: { maxTicksLimit: 7, font: { size: 10 }, callback: function(value) { return this.getLabelForValue(value).slice(5); } } },
          tokens: { beginAtZero: true, suggestedMax: 1, grid: { color: '#e7ebf2' }, ticks: { maxTicksLimit: 5, font: { size: 10 }, callback: value => DashboardFormat.compact(value) } },
          percent: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { color: '#9863f8', stepSize: 25, font: { size: 10 }, callback: value => `${value}%` } }
        }
      }
    });
    else { trend.data = lineData; trend.update('none'); }
  }
  window.OverviewCharts = { render, resize: () => { doughnut?.resize(); trend?.resize(); }, colors };
})();
