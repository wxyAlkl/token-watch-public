const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');
const { createServer } = require('../../server');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-history-ui-'));
  const output = path.resolve(__dirname, '../../output/playwright/history');
  const now = Date.now();
  const stamp = offset => new Date(now + offset).toISOString();
  let remaining = 500;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'fixture-model' }] }
      : { balance: remaining, balanceLimit: 500, totalSpend: 9999, tokens: 999999 }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const makeCall = (id, extra = {}) => ({ id, timestamp: stamp(-1000), model: 'fixture-model', sourceType: 'local-proxy',
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, tokens: 9999, ...extra });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 60 }, stations: [
    { id: 'relay', name: '示例中转 A', baseUrl: `${upstreamUrl}/v1`, statsUrl: `${upstreamUrl}/api/usage`, apiKey: 'synthetic-key',
      balance: null, balanceKnown: false, balanceUnit: 'USD', balanceUnitCustomized: true,
      calls: [makeCall('measured'), makeCall('health', { model: 'GET /models' }), makeCall('manual', { sourceType: 'manual-adjustment' })] },
    { id: 'other', name: '示例中转 B', baseUrl: 'https://unused.invalid/v1', disabled: true, balanceUnit: 'USD',
      calls: Array.from({ length: 230 }, (_, i) => makeCall(`other-${i}`, { timestamp: stamp(-2000 - i * 1000),
        inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, tokens: 1 })) }
  ], quotaConsumptionLogs: Array.from({ length: 115 }, (_, i) => ({ id: `quota-other-${i}`, stationId: 'other', stationName: '示例中转 B',
    periodStartAt: stamp(-20000 - (i + 1) * 60000), periodEndAt: stamp(-20000 - i * 60000),
    previousBalance: 500 - i, currentBalance: 499 - i, amount: 1, unit: 'USD' })) }));
  const app = createServer({ runtime: 'web', sqliteEnabled: true, dataDir: root, port: 0,
    cliPaths: { codexSessions: path.join(root, 'none'), claudeProjects: path.join(root, 'none'), codexConfig: path.join(root, 'none') } });
  let browser;
  try {
    await app.ready;
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const baseline = await fetch(`${baseUrl}/api/stations/relay/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(baseline.status, 200);
    const initial = await baseline.json();
    assert.equal(initial.stations.find(station => station.id === 'relay').balance, 500);
    assert.equal(initial.stations.find(station => station.id === 'relay').totalSpend, 0);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const capture = async name => {
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.page-view.active')).opacity) === 1);
      await page.screenshot({ path: path.join(output, name), fullPage: true });
    };
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // Only intercept the boot refresh, preserving the real single-station refresh and SQLite writes below.
    await page.route('**/api/stations/refresh-all', async route => {
      const response = await page.request.get(`${baseUrl}/api/stations`);
      await route.fulfill({ response });
    });
    await page.goto(`${baseUrl}/#stations`);
    await page.waitForLoadState('networkidle');
    const card = page.locator('[data-station-id="relay"]');
    assert.equal(await card.locator('.station-history-totals strong').nth(0).innerText(), '$ 0.00');
    assert.equal(await card.locator('.station-history-totals strong').nth(1).innerText(), '155');
    assert.deepEqual(await card.locator('.station-token-breakdown strong').allTextContents(), ['100', '20', '30', '5']);
    remaining = 450;
    await card.locator('[data-action="refresh"]').click();
    await page.waitForFunction(() => document.querySelector('[data-station-id="relay"] .station-history-totals strong')?.textContent.includes('50.00'));
    const quota = await (await fetch(`${baseUrl}/api/history/quota?stationId=relay`)).json();
    assert.equal(quota.logs.length, 1); assert.equal(quota.logs[0].amount, 50);
    assert.equal(quota.logs[0].previousBalance, 500); assert.equal(quota.logs[0].currentBalance, 450);
    assert.ok(Date.parse(quota.logs[0].periodEndAt) >= Date.parse(quota.logs[0].periodStartAt));
    fs.mkdirSync(output, { recursive: true });
    await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0);
    await capture('station-history-desktop.png');

    assert.equal(await card.locator('[data-action="show-quota-history"]').isVisible(), true);
    assert.equal(await card.locator('[data-action="show-token-history"]').isVisible(), true);
    await card.locator('[data-action="show-quota-history"]').click();
    await page.locator('[data-history-panel="quota"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#quotaHistoryBody')?.textContent.includes('50.00'));
    assert.equal(await page.locator('#historyStationFilter').inputValue(), 'relay');
    assert.equal(await page.locator('[data-history-panel="token"]').isVisible(), false);
    assert.equal(await page.locator('#quotaHistoryBody tr').count(), 1);
    assert.match(await page.locator('#quotaHistoryBody').innerText(), /500\.00[\s\S]*450\.00[\s\S]*50\.00/);
    assert.equal(await page.locator('#quotaHistoryBody tr td').nth(5).getAttribute('title'), '精确金额：$ 50.000000');
    await capture('quota-history-desktop.png');
    await page.locator('#historyStationFilter').selectOption('other');
    await page.waitForFunction(() => document.querySelector('#quotaHistoryPageLabel')?.textContent.includes('共 115'));
    assert.equal(await page.locator('#quotaHistoryBody tr').count(), 100);
    await page.locator('#quotaHistoryNext').click();
    await page.waitForFunction(() => document.querySelector('#quotaHistoryPageLabel')?.textContent.includes('第 2'));
    assert.equal(await page.locator('#quotaHistoryBody tr').count(), 15);

    await page.locator('[data-nav="stations"]').click();
    await card.locator('[data-action="show-token-history"]').click();
    await page.locator('[data-history-panel="token"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#tokenHistorySummary strong')?.textContent === '155');
    assert.equal(await page.locator('#historyStationFilter').inputValue(), 'relay');
    assert.equal(await page.locator('[data-history-panel="quota"]').isVisible(), false);
    assert.equal(await page.locator('#tokenHistoryBody tr').count(), 1);
    assert.deepEqual((await page.locator('#tokenHistoryBody tr').first().locator('td').allTextContents()).slice(3), ['100', '20', '30', '5', '155']);
    await capture('token-history-desktop.png');
    await page.locator('#historyStationFilter').selectOption('other');
    await page.waitForFunction(() => document.querySelector('#tokenHistoryPageLabel')?.textContent.includes('共 230'));
    assert.equal(await page.locator('#tokenHistoryBody tr').count(), 100);
    assert.equal(await page.locator('#tokenHistorySummary strong').innerText(), '230');
    await page.locator('#tokenHistoryNext').click();
    await page.waitForFunction(() => document.querySelector('#tokenHistoryPageLabel')?.textContent.includes('第 2'));
    assert.equal(await page.locator('#tokenHistoryBody tr').count(), 100);
    await page.locator('#historyStationFilter').selectOption('relay');
    await page.waitForFunction(() => document.querySelector('#tokenHistoryPageLabel')?.textContent.includes('第 1 / 1'));
    assert.equal(await page.locator('#tokenHistoryBody tr').count(), 1);

    await page.locator('[data-nav="overview"]').click();
    assert.equal(await page.locator('#totalSpend').innerText(), '$ 165.00');
    assert.equal(await page.locator('#totalTokens').innerText(), '385');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const tab of ['quota', 'token']) {
        await page.locator('[data-nav="calls"]').click();
        await page.locator(`[data-history-tab="${tab}"]`).click();
        await page.locator(`[data-history-panel="${tab}"]`).waitFor({ state: 'visible' });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tab} history overflows at ${width}px`);
        await capture(`${tab}-history-${width}.png`);
      }
      await page.locator('[data-nav="stations"]').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `station cards overflow at ${width}px`);
      await capture(`station-history-${width}.png`);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, checks: 'real 500→450 refresh; SQLite quota interval; 155 bucket-derived tokens; separate histories; station links/filter; quota/token pagination; overview sum; 390/320px layouts', screenshots: output }));
  } finally {
    if (browser) await browser.close();
    await app.close();
    await new Promise(resolve => upstream.close(resolve));
    for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file));
    fs.rmdirSync(root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
