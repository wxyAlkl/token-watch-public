const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../../server');
const { compile } = require('../../model-pricing');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-price-ui-'));
  const file = path.join(root, 'stations.json');
  const catalog = { models: compile({ openai: { models: { 'gpt-test': { cost: { input: 2, output: 10, cache_read: 0.1 } } } } }), updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify({ stations: [{ id: 'one', name: 'Relay', baseUrl: 'https://example.com/v1',
    balanceUnit: 'CNY', balanceUnitCustomized: true, spendSource: 'remote', totalSpend: 300, remoteTokens: 9000000, tokens: 1,
    balance: 20, balanceKnown: true, balanceLimit: 320, usageStatus: 'online', calls: [
      { id: 'call', timestamp: new Date().toISOString(), model: 'gpt-test', tokens: 1000000, inputTokens: 1000000, cost: 123 },
      { id: 'manual', timestamp: '1999-12-31T16:00:00Z', model: '历史补录', sourceType: 'manual-adjustment', sourceApp: '手动补录', tokens: 2000000, cost: 200 }
    ] }] }));
  const app = createServer({ runtime: 'web', dataDir: root, port: 0, pricingCatalog: catalog,
    cliPaths: { codexSessions: path.join(root, 'none'), claudeProjects: path.join(root, 'none'), codexConfig: path.join(root, 'none') } });
  let browser;
  try {
    await app.ready; browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/stations/refresh-all', async route => route.fulfill({ response: await page.request.get(`http://127.0.0.1:${app.port}/api/stations`) }));
    await page.goto(`http://127.0.0.1:${app.port}/#calls`); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#logUsage').innerText(), '$ 2.00');
    assert.equal(await page.locator('#logRpm').innerText(), '1');
    assert.equal(await page.locator('#logTpm').innerText(), '1M');
    assert.match(await page.locator('#callsBody').innerText(), /models.dev/);
    assert.match(await page.locator('#logPricingStatus').innerText(), /models.dev/);
    await page.locator('#refreshPricingButton').click(); await page.waitForLoadState('networkidle');
    await page.locator('[data-nav="overview"]').click();
    assert.match(await page.locator('#totalSpend').innerText(), /300/);
    assert.equal(await page.locator('#totalTokens').innerText(), '9,000,000');
    assert.deepEqual(errors, []);
    console.log('PASS: USD catalog estimate, manual exclusion, independent CNY station totals and remote tokens');
  } finally { if (browser) await browser.close(); await app.close(); fs.unlinkSync(file); fs.rmdirSync(root); }
})().catch(e => { console.error(e); process.exitCode = 1; });
