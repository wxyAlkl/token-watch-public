const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../../server');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-quota-ui-'));
  const file = path.join(root, 'stations.json');
  const output = path.resolve(__dirname, '../../output/quota-ui');
  const makeStation = (id, name, balance, quotaPolicy, extra = {}) => ({
    id, name, baseUrl: 'https://relay.example/v1', balance, quotaPolicy,
    balanceKnown: balance !== null, balanceUnit: 'USD', spendSource: 'remote',
    modelStatus: 'online', usageStatus: 'online', status: 'online', ...extra
  });
  fs.writeFileSync(file, JSON.stringify({ stations: [
    makeStation('daily', 'Daily plan', 15, { mode: 'daily', limit: 20 }),
    makeStation('weekly', 'Weekly plan', 60, { mode: 'weekly', limit: 100 }),
    makeStation('prepaid', 'Prepaid wallet', 5, { mode: 'prepaid', lowBalanceThreshold: 10 }),
    makeStation('missing', 'Missing balance', null, { mode: 'daily', limit: 20 }),
    makeStation('stale', 'Cached balance', 10, { mode: 'daily', limit: 20 }, { usageStatus: 'error', usageError: 'Test failure', balanceUpdatedAt: new Date().toISOString() }),
    makeStation('plans', 'Subscription source', 100, { mode: 'daily', limit: 20, source: 'plan:Daily' }, {
      usagePlans: [{ name: 'Wallet', remaining: 100, unit: 'USD' }, { planName: 'Daily', remaining: 5, unit: 'USD' }]
    }),
    makeStation('lost', 'Unavailable source', 80, { mode: 'weekly', limit: 100, source: 'plan:Expired' })
  ] }));
  const app = createServer({ runtime: 'web', dataDir: root, port: 0, cliPaths: {
    codexSessions: path.join(root, 'no-codex'), codexConfig: path.join(root, 'no-config'), claudeProjects: path.join(root, 'no-claude')
  } });
  let browser, desktopApp;
  try {
    await app.ready;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // Preserve fixtures on initial load; API mutation and persistence still use the real server.
    await page.route('**/api/stations/refresh-all', async (route) => {
      const result = await page.request.get(`http://127.0.0.1:${app.port}/api/stations`);
      await route.fulfill({ response: result });
    });
    await page.goto(`http://127.0.0.1:${app.port}/#stations`);
    await page.waitForLoadState('networkidle');
    const card = (id) => page.locator(`[data-station-id="${id}"]`);
    assert.equal(await card('daily').getByRole('progressbar').getAttribute('aria-valuenow'), '75');
    assert.equal(await card('weekly').getByRole('progressbar').getAttribute('aria-valuenow'), '60');
    assert.equal(await card('prepaid').locator('.meter').count(), 0);
    assert.match(await card('prepaid').innerText(), /余额偏低/);
    assert.equal(await card('missing').getByRole('progressbar').count(), 0);
    assert.match(await card('missing').innerText(), /未获取/);
    assert.match(await card('stale').innerText(), /上次数据/);
    assert.equal(await card('plans').getByRole('progressbar').getAttribute('aria-valuenow'), '25');
    assert.match(await card('lost').innerText(), /未找到所选额度明细/);
    assert.equal(await card('lost').getByRole('progressbar').count(), 0);
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'stations-desktop.png'), fullPage: true });

    await card('daily').locator('[data-action="edit"]').click();
    assert.equal(await page.locator('#stationQuotaMode').inputValue(), 'daily');
    assert.equal(await page.locator('#stationQuotaLimit').inputValue(), '20');
    await page.locator('#stationQuotaMode').selectOption('weekly');
    assert.equal(await page.locator('#quotaLimitLabel').innerText(), '每周额度');
    await page.locator('#stationQuotaLimit').fill('40');
    await page.getByRole('button', { name: '保存站点', exact: false }).click();
    await page.locator('#stationModal').waitFor({ state: 'hidden' });
    assert.equal(await card('daily').getByRole('progressbar').getAttribute('aria-valuenow'), '37.5');
    await page.reload();
    await page.waitForLoadState('networkidle');
    assert.equal(await card('daily').getByRole('progressbar').getAttribute('aria-valuenow'), '37.5');
    await card('daily').locator('[data-action="edit"]').click();
    assert.equal(await page.locator('#stationQuotaMode').inputValue(), 'weekly');
    assert.equal(await page.locator('#stationQuotaLimit').inputValue(), '40');
    await page.locator('#stationQuotaMode').selectOption('prepaid');
    assert.equal(await page.locator('#quotaLimitField').isVisible(), false);
    await page.locator('#stationQuotaThreshold').fill('20');
    await page.getByRole('button', { name: '保存站点', exact: false }).click();
    await page.locator('#stationModal').waitFor({ state: 'hidden' });
    assert.equal(await card('daily').locator('.meter').count(), 0);
    assert.match(await card('daily').innerText(), /余额偏低/);

    await card('plans').locator('[data-action="edit"]').click();
    assert.equal(await page.locator('#stationQuotaSource').inputValue(), 'plan:Daily');
    await page.locator('#stationQuotaSource').selectOption('account');
    await page.locator('#stationQuotaLimit').fill('200');
    await page.getByRole('button', { name: '保存站点', exact: false }).click();
    await page.locator('#stationModal').waitFor({ state: 'hidden' });
    assert.equal(await card('plans').getByRole('progressbar').getAttribute('aria-valuenow'), '50');
    await card('lost').locator('[data-action="edit"]').click();
    assert.equal(await page.locator('#stationQuotaSource').inputValue(), 'plan:Expired');
    assert.match(await page.locator('#stationQuotaSource').innerText(), /当前不可用/);
    await page.locator('#cancelModal').click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'stations-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await card('weekly').locator('[data-action="edit"]').click();
    await page.screenshot({ path: path.join(output, 'settings-mobile.png') });
    assert.equal(await page.evaluate(() => {
      const bounds = document.querySelector('#stationModal .modal').getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= window.innerWidth;
    }), true);
    await page.locator('#cancelModal').click();
    await page.locator('[data-nav="overview"]').click();
    assert.equal(await page.locator('#overviewBalances .overview-balance-row').count(), 7);

    desktopApp = createServer({ runtime: 'desktop', dataDir: root, port: 0, cliPaths: {
      codexSessions: path.join(root, 'no-codex'), codexConfig: path.join(root, 'no-config'), claudeProjects: path.join(root, 'no-claude')
    } });
    await desktopApp.ready;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`http://127.0.0.1:${desktopApp.port}/#stations`);
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('body').getAttribute('data-runtime'), 'desktop');
    await card('weekly').locator('[data-action="edit"]').click();
    assert.equal(await page.locator('#stationQuotaMode').inputValue(), 'weekly');
    await page.screenshot({ path: path.join(output, 'settings-desktop-runtime.png') });
    await page.locator('#cancelModal').click();
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(JSON.stringify({ passed: true, checks: 'daily/weekly/prepaid, editing, reload persistence, source selection, stale/missing, mobile layout, aggregate balance', screenshots: output }));
  } finally {
    if (browser) await browser.close();
    if (desktopApp) await desktopApp.close();
    await app.close();
    fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
