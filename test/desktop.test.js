const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, buildLaunchConfig } = require('../launcher');

test('desktop entrypoint and packaging configuration exist', () => {
  const root = path.join(__dirname, '..');
  assert.equal(fs.existsSync(path.join(root, 'electron-main.js')), true);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'electron-main.js');
  assert.equal(pkg.scripts.app, 'node launcher.js');
  assert.equal(pkg.scripts.web, 'node launcher.js --web');
  assert.equal(typeof pkg.scripts['dist:win'], 'string');
  assert.equal(pkg.build.nsis.artifactName, 'Token-Watch-${version}-${arch}-Setup.${ext}');
  assert.equal(pkg.build.portable.artifactName, 'Token-Watch-${version}-${arch}-Portable.${ext}');
});

test('unified app entrypoint selects normal, web, and isolated test modes', () => {
  assert.deepEqual(parseArgs([]), { mode: 'desktop' });
  assert.deepEqual(parseArgs(['--web']), { mode: 'web' });
  assert.deepEqual(parseArgs(['--web', '--open']), { mode: 'web', openBrowser: true });
  assert.deepEqual(parseArgs(['--test']), { mode: 'test' });
  assert.equal(buildLaunchConfig({ mode: 'desktop', platform: 'win32' }).desktop, true);
  assert.equal(buildLaunchConfig({ mode: 'web', platform: 'win32' }).desktop, false);
  assert.match(buildLaunchConfig({ mode: 'test', platform: 'win32', tempDir: 'C:\\Temp' }).dataDir, /token-watch-test/);
});

test('web workbench has a separate data directory and port', () => {
  const web = buildLaunchConfig({ mode: 'web', platform: 'win32', env: { APPDATA: 'C:\\WebTest' } });
  assert.equal(web.dataDir, path.join('C:\\WebTest', 'token-watch-web'));
  assert.equal(web.runtime, 'web');
  assert.equal(web.port, 4318);
  const desktop = buildLaunchConfig({ mode: 'desktop', env: {} });
  assert.deepEqual(desktop, { mode: 'desktop', desktop: true });
  const custom = buildLaunchConfig({ mode: 'web', env: { TOKEN_WATCH_DATA_DIR: 'desktop-only', TOKEN_WATCH_WEB_DATA_DIR: 'web-only', TOKEN_WATCH_WEB_PORT: '0' } });
  assert.equal(custom.dataDir, 'web-only');
  assert.equal(custom.port, 0);
  const unix = buildLaunchConfig({ mode: 'web', platform: 'linux', homeDir: '/home/test', env: { TOKEN_WATCH_DATA_DIR: 'desktop-only' } });
  assert.equal(unix.dataDir, path.join('/home/test', '.token-watch-web'));
  assert.throws(() => buildLaunchConfig({ mode: 'web', env: { TOKEN_WATCH_WEB_PORT: 'invalid' } }), /Web 端口/);
});

test('frontend exposes four independent hash-routed views including official accounts', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.match(html, /data-nav="overview"/);
  assert.match(html, /data-nav="official"/);
  assert.match(html, /data-nav="stations"/);
  assert.match(html, /data-nav="calls"/);
  assert.match(html, /id="syncCliButton"/);
  assert.equal((html.match(/class="page-view/g) || []).length, 4);
  assert.match(app, /window\.history\.pushState/);
  assert.match(app, /window\.addEventListener\('hashchange'/);
  assert.match(app, /syncAndLoadLogs/);
  assert.match(app, /request\('\/api\/stations\/refresh-all'/);
  assert.match(app, /refreshLogsButton.*syncAndLoadLogs/);
  assert.match(html, /id="stationBalanceUnit"/);
  assert.match(html, /id="testStationButton"/);
  assert.match(html, /id="logDetailModal"/);
  assert.match(html, /id="exportCsvButton"/);
  assert.match(html, /额度明细/);
  assert.match(html, /<option value="usage">CLI usage/);
  assert.match(html, /id="modelChart"/);
  assert.match(html, /id="tokenTrendChart"/);
  assert.doesNotMatch(html, /id="trendBars"/);
  assert.match(styles, /\.log-table-wrap[^}]*height: min\(58vh, 620px\)/);
  assert.match(styles, /\.log-table-wrap \{ height: 320px;/);
  assert.match(styles, /\.log-table th[^}]*position: sticky/);
  assert.match(html, /当前额度已用/);
  assert.match(html, /累计额度 - 当前余额/);
  assert.match(html, /调用数/);
  assert.match(html, /Token 总量/);
  assert.match(app, /usageByUnit/);
  assert.match(html, /id="liveBadge"/);
  assert.match(html, /id="degradedBanner"/);
  assert.match(html, /id="deleteStationModal"/);
  assert.match(html, /id="syncProgress"/);
  assert.match(app, /bootstrap/);
  assert.match(app, /runFullSync/);
  assert.match(app, /api\/health/);
  assert.match(app, /humanizeError/);
});
