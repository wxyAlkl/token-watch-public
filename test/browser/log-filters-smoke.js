const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { createServer } = require('../../server');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-log-ui-'));
  const file = path.join(root, 'stations.json');
  fs.writeFileSync(file, JSON.stringify({ stations: [{ id: 'opus', name: 'opus5', baseUrl: 'https://example.com/v1', calls: [
    { id: 'one', sourceType: 'claude-cli', timestamp: '2020-01-01T00:00:00Z', model: 'opus', tokens: 100, cost: 2, costUnit: 'USD' },
    { id: 'two', sourceType: 'codex-cli', timestamp: new Date().toISOString(), model: 'gpt', tokens: 50, cost: 1, costUnit: 'USD' }
  ] }, { id: 'other', name: 'Other', baseUrl: 'https://example.com/v1', calls: [] }] }));
  const app = createServer({ runtime: 'web', dataDir: root, port: 0, cliPaths: { codexSessions: path.join(root, 'none'), claudeProjects: path.join(root, 'none'), codexConfig: path.join(root, 'none') } });
  let browser;
  try {
    await app.ready;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${app.port}/#calls`);
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#logDateFilter').inputValue(), 'all');
    assert.equal(await page.locator('#logRpm').innerText(), '2');
    await page.locator('#logSourceFilter').selectOption('opus5');
    await page.waitForLoadState('networkidle');
    await page.locator('#logAppFilter').selectOption('Claude Code');
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#logRpm').innerText(), '1');
    assert.match(await page.locator('#callsBody').innerText(), /Claude Code/);
    assert.equal(await page.locator('#logUsage').innerText(), '$ 2.00');
    await page.locator('#refreshLogsButton').click(); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#logSourceFilter').inputValue(), 'opus5');
    assert.equal(await page.locator('#logAppFilter').inputValue(), 'Claude Code');
    await page.reload(); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#logSourceFilter').inputValue(), 'opus5');
    assert.equal(await page.locator('#logRpm').innerText(), '1');
    await page.locator('#logModelFilter').fill('no-results'); await page.locator('#logSearchButton').click(); await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => document.querySelector('#logRpm').textContent === '0');
    assert.equal(await page.locator('#logRpm').innerText(), '0');
    await page.locator('#refreshLogsButton').click(); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#logSourceFilter').inputValue(), 'opus5');
    await page.locator('#logResetButton').click(); await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => document.querySelector('#logRpm').textContent === '2');
    assert.equal(await page.locator('#logAppFilter').inputValue(), '');
    assert.equal(await page.locator('#logRpm').innerText(), '2');
    assert.ok(await page.locator('.log-summary').evaluate(el => el.getBoundingClientRect().bottom <= document.querySelector('.log-toolbar').getBoundingClientRect().top));
    fs.mkdirSync(path.resolve('output/log-ui'), { recursive: true });
    await page.screenshot({ path: path.resolve('output/log-ui/desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.resolve('output/log-ui/mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: all history, app/source filtering, refresh/reload/no-results persistence, totals, reset and responsive layout');
  } finally {
    if (browser) await browser.close();
    await app.close(); fs.unlinkSync(file); fs.rmdirSync(root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
