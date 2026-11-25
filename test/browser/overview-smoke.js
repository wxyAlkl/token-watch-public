const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../../server');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-overview-ui-'));
  const file = path.join(root, 'stations.json');
  const output = path.resolve(__dirname, '../../output/overview-ui');
  const stamp = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const models = ['gpt-6.1-sol', 'claude-opus-5.5', 'claude-opus-5', 'claude-sonnet-5', 'gpt-6-luna', 'claude-haiku-4-5'];
  const calls = Array.from({ length: 42 }, (_, index) => ({
    id: `fixture-${index}`, timestamp: stamp(index % 7), model: models[index % models.length],
    tokens: 1234000 - index * 10000, inputTokens: 120000 + index * 1000, outputTokens: 40000,
    cacheReadTokens: 1000000 - index * 10000, cacheWriteTokens: 74000,
    cost: index / 50, costUnit: index % 2 ? 'CNY' : 'USD', costSource: index % 3 ? 'estimated' : 'remote'
  }));
  const make = (id, name, unit, balance, mode, limit, extra = {}) => ({
    id, name, baseUrl: 'https://relay.example/v1', apiKey: '', balanceUnit: unit, balanceUnitCustomized: true,
    balance, balanceKnown: balance !== null, balanceLimit: balance === null ? null : 100,
    tokens: id === 'daily' ? 123456789 : 0, totalSpend: balance === null ? null : 100 - balance,
    quotaPolicy: { mode, limit }, status: 'online', modelStatus: 'online', usageStatus: 'online', spendSource: 'remote', ...extra
  });
  fs.writeFileSync(file, JSON.stringify({ stations: [
    make('daily', '示例日付站', 'CNY', 3, 'daily', 20, { calls }),
    make('weekly', '示例周付站', 'USD', 35, 'weekly', 100),
    make('prepaid', 'DeepSeek 官方', 'CNY', 21.39, 'prepaid', null),
    make('override', '示例余额站', 'USD', 8, 'prepaid', null, { quotaPolicy: { mode: 'prepaid', lowBalanceThreshold: 5 } }),
    make('unknown', 'Unknown quota', 'USD', null, 'daily', 20)
  ], cliCalls: [{ id: 'older', timestamp: stamp(20), model: 'older-model', tokens: 789, inputTokens: 789 }] }));
  const app = createServer({ runtime: 'web', dataDir: root, port: 0, cliPaths: {
    codexSessions: path.join(root, 'none'), claudeProjects: path.join(root, 'none'), codexConfig: path.join(root, 'none.toml')
  } });
  let browser;
  try {
    await app.ready;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1720, height: 1080 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/stations/refresh-all', async route => {
      const result = await page.request.get(`http://127.0.0.1:${app.port}/api/stations`);
      await route.fulfill({ response: result });
    });
    await page.goto(`http://127.0.0.1:${app.port}/#overview`);
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#totalTokens').innerText(), '123,457,578');
    assert.equal(await page.locator('#totalTokensCompact').innerText(), '123M');
    assert.equal(await page.locator('#todaySpend .currency-line').count(), 2);
    assert.match(await page.locator('#todaySpend').innerText(), /^\$.*\n¥/);
    assert.equal(await page.locator('#totalSpend .currency-line').count(), 2);
    assert.equal(await page.locator('#overviewBalances .overview-balance-row').count(), 5);
    assert.equal(await page.locator('[data-balance-station="prepaid"] [role="progressbar"]').count(), 0);
    assert.equal(await page.locator('[data-balance-station="daily"] [role="progressbar"]').getAttribute('aria-valuenow'), '15');
    assert.equal(await page.locator('#modelStatsBody tr').count(), 6);
    const chartInfo = await page.evaluate(() => ({
      model: Chart.getChart('modelChart').data.datasets[0].data,
      trend: Chart.getChart('tokenTrendChart').data.datasets.length,
      days: Chart.getChart('tokenTrendChart').data.labels.length,
      pixels: ['modelChart', 'tokenTrendChart'].map(id => {
        const canvas = document.getElementById(id);
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) painted++;
        return { width: canvas.width, height: canvas.height, painted };
      })
    }));
    assert.equal(chartInfo.trend, 5); assert.equal(chartInfo.days, 7);
    assert.ok(chartInfo.model.some(value => value > 0));
    assert.ok(chartInfo.pixels.every(canvas => canvas.width > 100 && canvas.height > 100 && canvas.painted > 1000));
    await page.locator('[data-overview-days="30"]').click();
    await page.waitForFunction(() => Chart.getChart('tokenTrendChart').data.labels.length === 30);
    assert.equal(await page.locator('#modelStatsBody tr').count(), 7);
    await page.locator('[data-overview-days="7"]').click();
    await page.waitForFunction(() => Chart.getChart('tokenTrendChart').data.labels.length === 7);

    await page.locator('#openAlertSettings').click();
    await page.locator('#alertUsd').fill('10');
    await page.locator('#alertCny').fill('2');
    await page.locator('#alertPercent').fill('20');
    await page.locator('#saveAlertSettings').click();
    await page.locator('#alertSettingsModal').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#stationAlertBadge').isVisible(), true);
    assert.equal(await page.locator('[data-balance-station="daily"]').evaluate(el => el.classList.contains('balance-warning')), true);
    assert.equal(await page.locator('[data-balance-station="override"]').evaluate(el => el.classList.contains('balance-warning')), false);
    assert.equal(await page.locator('[data-balance-station="unknown"]').evaluate(el => el.classList.contains('balance-warning')), false);
    await page.reload(); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#stationAlertBadge').isVisible(), true);
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'overview-desktop.png'), fullPage: true });
    await page.locator('[data-balance-station="daily"]').click();
    assert.equal(new URL(page.url()).hash, '#stations');
    const lowCard = page.locator('[data-station-id="daily"]');
    assert.equal(await lowCard.evaluate(el => el.classList.contains('balance-warning')), true);
    assert.equal(await lowCard.locator('.meter span').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(211, 65, 77)');
    await page.locator('[data-nav="calls"]').click();
    await page.locator('#logModelFilter').fill('does-not-exist');
    await page.locator('#logSearchButton').click();
    await page.waitForLoadState('networkidle');
    await page.locator('[data-nav="overview"]').click();
    assert.equal(await page.locator('#modelStatsBody tr').count(), 6);

    await page.locator('#openAlertSettings').click();
    assert.equal(await page.locator('#alertPercent').inputValue(), '20');
    await page.locator('#balanceAlertsEnabled').uncheck();
    assert.equal(await page.locator('#alertPercent').isDisabled(), true);
    await page.locator('#saveAlertSettings').click();
    await page.locator('#alertSettingsModal').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#stationAlertBadge').isVisible(), false);
    assert.equal(await page.locator('#overviewBalances .balance-warning').count(), 0);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.ok(await page.locator('#tokenTrendChart').evaluate(el => el.width > 100 && el.height > 100));
      await page.screenshot({ path: path.join(output, `overview-${width}.png`), fullPage: true });
    }
    await page.locator('#openAlertSettings').click();
    await page.screenshot({ path: path.join(output, 'alerts-mobile.png') });
    await page.locator('#balanceAlertsEnabled').check();
    await page.locator('#saveAlertSettings').click();
    await page.locator('#alertSettingsModal').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#stationAlertBadge').isVisible(), true);

    // Empty responses must remove previous chart values rather than leaving stale plotted data.
    await page.route('**/api/overview?**', async route => {
      await route.fulfill({ json: { days: 7, from: '2026-10-19', to: '2026-10-25', requests: 0, tokens: 0, models: [], trend: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${19 + i}`, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheHitRate: null })) } });
    });
    await page.locator('[data-overview-days="7"]').click();
    await page.waitForFunction(() => Chart.getChart('modelChart').data.labels.length === 0);
    assert.match(await page.locator('#modelStatsBody').innerText(), /暂无调用数据/);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(JSON.stringify({ passed: true, checks: 'chart data and canvas pixels; ranges; independent filters; full tokens; currency lines; policy balances; warning save/disable/reload/overrides; desktop/mobile; empty charts', screenshots: output }));
  } finally {
    if (browser) await browser.close();
    await app.close();
    fs.unlinkSync(file); fs.rmdirSync(root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
