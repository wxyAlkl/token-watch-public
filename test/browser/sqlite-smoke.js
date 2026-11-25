const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { createServer } = require('../../server');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-sqlite-ui-'));
  const now = Date.now();
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ stations: [{ id: 'relay', name: 'Relay', baseUrl: 'https://example.com/v1',
    calls: Array.from({ length: 230 }, (_, i) => ({ id: `log-${i}`, timestamp: new Date(now - i * 1000).toISOString(), sourceType: 'codex-cli', tokens: 10,
      inputTokens: 10, model: 'test', cost: 1, costUnit: 'USD', stream: null })) }] }));
  const app = createServer({ runtime: 'web', sqliteEnabled: true, dataDir: root, port: 0,
    cliPaths: { codexSessions: path.join(root, 'none'), claudeProjects: path.join(root, 'none'), codexConfig: path.join(root, 'none') } });
  let browser;
  try {
    await app.ready; browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${app.port}/#calls`); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#callsBody tr').count(), 100);
    assert.equal(await page.locator('#logRpm').innerText(), '230');
    await page.locator('#logNextPage').click();
    await page.waitForFunction(() => document.querySelector('#logPageLabel').textContent.includes('第 2'));
    assert.equal(await page.locator('#callsBody tr').count(), 100);
    await page.locator('#logSourceFilter').selectOption('Relay');
    await page.waitForFunction(() => document.querySelector('#logPageLabel').textContent.includes('第 1'));
    await page.locator('#logNextPage').click();
    await page.waitForFunction(() => document.querySelector('#logPageLabel').textContent.includes('第 2'));
    await page.locator('#refreshLogsButton').click(); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#logSourceFilter').inputValue(), 'Relay');
    assert.match(await page.locator('#logPageLabel').innerText(), /第 2/);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#exportJsonButton').click()]);
    const text = fs.readFileSync(await download.path(), 'utf8');
    assert.equal(JSON.parse(text).length, 230);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log('PASS: SQLite pagination, all-result summary/export, source retention and mobile layout');
  } finally {
    if (browser) await browser.close(); await app.close();
    for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)); fs.rmdirSync(root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
