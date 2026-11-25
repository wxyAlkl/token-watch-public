const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../../server');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-harness-ui-'));
  const sessions = path.join(root, 'sessions'), data = path.join(root, 'data');
  fs.mkdirSync(sessions);
  const fixture = path.join(sessions, 'session.v4.jsonl');
  fs.writeFileSync(fixture, [
    { type: 'session', version: 4, id: 'ui-session', isSeeded: false },
    { type: 'request/header', seq: 0, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 1, time: Date.now(), data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 30, totalTokens: 42 } } }
  ].map(row => JSON.stringify(row)).join('\n'));
  const app = createServer({ runtime: 'web', dataDir: data, port: 0, harnessEnabled: true, pricingCatalog: { models: {}, updatedAt: null },
    cliPaths: { harnessSessions: sessions, codexSessions: path.join(root, 'none'), claudeProjects: path.join(root, 'none'), codexConfig: path.join(root, 'none') } });
  let browser;
  try {
    await app.ready;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${app.port}/#calls`);
    await page.waitForLoadState('networkidle');
    await page.locator('#logAppFilter').selectOption('DeepSeek Harness');
    await page.waitForFunction(() => document.querySelector('#logRpm').textContent === '1');
    assert.match(await page.locator('#callsBody').innerText(), /DeepSeek Harness/);
    assert.match(await page.locator('#callsBody').innerText(), /deepseek-flash/);
    assert.match(await page.locator('#callsBody').innerText(), /无价格/);
    assert.equal(await page.locator('#logTpm').innerText(), '42');
    await page.locator('#logTypeFilter').selectOption('usage');
    await page.waitForLoadState('networkidle');
    await page.locator('#refreshLogsButton').click();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#logRpm').innerText(), '1');
    assert.equal(await page.locator('#logAppFilter').inputValue(), 'DeepSeek Harness');
    assert.equal(await page.locator('#callsBody tr').count(), 1);
    await page.locator('.detail-button').click();
    assert.match(await page.locator('#logDetailList').innerText(), /DeepSeek Harness/);
    await page.locator('#cancelLogDetail').click();
    await page.reload(); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#logAppFilter').inputValue(), 'DeepSeek Harness');
    assert.equal(await page.locator('#logRpm').innerText(), '1');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log('PASS: Harness sync/filter/type/detail/reload/dedup/missing-price/mobile');
  } finally {
    if (browser) await browser.close(); await app.close();
    fs.unlinkSync(fixture); fs.unlinkSync(path.join(data, 'stations.json')); fs.rmdirSync(sessions); fs.rmdirSync(data); fs.rmdirSync(root);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
