const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { createServer } = require('../../server');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-legacy-history-ui-'));
  const file = path.join(root, 'stations.json');
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ stations: [{ id: 'relay', name: 'Relay', baseUrl: 'https://relay.example/v1',
    balance: 50, balanceLimit: 150, balanceKnown: true, balanceUnit: 'USD', spendSource: 'remote',
    totalSpend: 100, tokens: 100000000, calls: [
      { id: 'old-call', model: 'model', timestamp: now, tokens: 100000000, inputTokens: 100000000, outputTokens: 0, cost: 100, costUnit: 'USD', costSource: 'estimated' },
      { id: 'legacy-adjustment', sourceType: 'manual-adjustment', sourceApp: '手动补录', model: '历史补录', token: '手动校准',
        timestamp: '1999-12-31T16:00:00.000Z', tokens: 200000000, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        cost: 200, costUnit: 'USD', costSource: 'manual', result: '历史补录', detail: 'legacy fixture for audit' }
    ] }] }));
  const app = createServer({ runtime: 'web', sqliteEnabled: true, dataDir: root, port: 0, cliPaths: {
    codexSessions: path.join(root, 'none'), claudeProjects: path.join(root, 'none'), codexConfig: path.join(root, 'none')
  } });
  let browser;
  try {
    await app.ready; browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const baseUrl = `http://127.0.0.1:${app.port}`;
    await page.route('**/api/stations/refresh-all', async route => {
      const response = await page.request.get(`${baseUrl}/api/stations`);
      await route.fulfill({ response });
    });
    await page.goto(`${baseUrl}/#stations`); await page.waitForLoadState('networkidle');
    const card = page.locator('[data-station-id="relay"]');
    assert.equal(await card.locator('.station-history-menu button[data-action="calibrate"]').count(), 1);
    assert.equal(await page.locator('#calibrationModal').count(), 1);
    assert.equal(await card.locator('.station-history-totals strong').nth(1).innerText(), '100,000,000');
    await card.locator('.station-history-menu summary').click();
    const openCalibration = async () => {
      await card.locator('.station-history-menu').evaluate(element => { element.open = true; });
      await card.locator('[data-action="calibrate"]').click();
      await page.locator('#calibrationModal').waitFor({ state: 'visible' });
    };
    await openCalibration();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#calibrationModal').isHidden(), true);
    await openCalibration();
    await page.locator('#calibrationAmount').fill('300');
    await page.locator('#calibrationTokens').fill('300000000');
    assert.match(await page.locator('#calibrationDelta').innerText(), /300\.00.*200,000,000/);
    await page.locator('#saveCalibration').click();
    await page.locator('#calibrationModal').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('[data-station-id="relay"] .station-history-totals')?.textContent.includes('300,000,000'));
    assert.match(await card.innerText(), /调用日志合计 100,000,000.*历史校正 \+200,000,000/);
    const stored = await (await fetch(`${baseUrl}/api/stations`)).json();
    assert.equal(stored.stations[0].tokens, 300000000);
    assert.equal(stored.stations[0].totalSpend, 300);
    await openCalibration();
    await page.locator('#saveCalibration').click();
    await page.locator('#calibrationModal').waitFor({ state: 'hidden' });
    assert.equal((await (await fetch(`${baseUrl}/api/history/corrections`)).json()).summary.count, 1);
    await openCalibration();
    await page.locator('#calibrationAmount').fill('20');
    await page.locator('#calibrationTokens').fill('10');
    await page.locator('#saveCalibration').click();
    await page.locator('#calibrationModal').waitFor({ state: 'hidden' });
    await card.locator('.station-history-menu').evaluate(element => { element.open = true; });
    await card.locator('[data-action="show-correction-history"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#correctionHistoryBody tr').length === 2);
    assert.match(await page.locator('#correctionHistoryBody').innerText(), /-299,999,990/);
    const output = path.resolve(__dirname, '../../output/playwright/history');
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'corrections-desktop.png'), fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `correction page overflows ${width}px`);
      await page.locator('[data-nav="stations"]').click(); await openCalibration();
      assert.ok(await page.evaluate(() => document.querySelector('.calibration-modal').getBoundingClientRect().right <= innerWidth), `calibration modal overflows ${width}px`);
      await page.screenshot({ path: path.join(output, `calibration-${width}.png`), fullPage: true });
      await page.locator('#cancelCalibration').click();
      await page.locator('[data-nav="calls"]').click();
    }

    await page.locator('[data-nav="calls"]').click();
    await page.locator('[data-history-tab="calls"]').click();
    await page.locator('#logDateFilter').selectOption('all');
    await page.waitForFunction(() => document.querySelector('#callsBody')?.textContent.includes('历史补录'));
    assert.equal(await page.locator('#callsBody tr').count(), 2);
    const legacyRow = page.locator('#callsBody tr').filter({ hasText: '历史补录' });
    assert.match(await legacyRow.innerText(), /2000-01-01 00:00/);
    assert.match(await legacyRow.innerText(), /历史补录/);

    await page.locator('[data-history-tab="token"]').click();
    await page.waitForFunction(() => document.querySelector('#tokenHistorySummary strong')?.textContent === '100,000,000');
    assert.equal(await page.locator('#tokenHistoryBody tr').count(), 1);
    assert.doesNotMatch(await page.locator('#tokenHistoryBody').innerText(), /历史补录/);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log('PASS: calibration entry/modal, up/down corrections, no-op retry, separate audit, original token buckets, 390/320px layout');
  } finally {
    if (browser) await browser.close(); await app.close();
    for (const entry of fs.readdirSync(root)) fs.unlinkSync(path.join(root, entry));
    fs.rmdirSync(root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
