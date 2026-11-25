const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { FloatingService, connectionConfig } = require('../floating-service');
const { startupController } = require('../floating-startup');
const { panelBounds, islandBounds, BALL_SIZE } = require('../floating-layout');
const { orderStations } = require('../floating-island');
const { advanceIslandState, toggleIslandMode } = require('../floating-island-state');
const { createServer } = require('../server');

async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('floating service cold starts SQLite Web, reuses it and stops only its own child', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-floating-'));
  const port = await freePort();
  const env = { ...process.env, TOKEN_WATCH_WEB_URL: `http://127.0.0.1:${port}`, TOKEN_WATCH_WEB_DATA_DIR: dataDir };
  delete env.FLOATING_START_SERVICE;
  const owner = new FloatingService({ env, nodePath: process.execPath });
  const reused = new FloatingService({ env, nodePath: process.execPath });
  t.after(async () => { await reused.stop(); await owner.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const [first, second] = await Promise.all([owner.ensure(), owner.ensure()]);
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true);
  assert.ok(owner.child);
  assert.ok(fs.existsSync(path.join(dataDir, 'usage.db')));
  assert.equal((await reused.ensure()).ok, true);
  assert.equal(reused.child, null);
  await reused.stop();
  assert.equal((await owner.probe()).ok, true);
  await owner.stop();
  assert.equal((await owner.probe()).ok, false);
});

test('floating service leaves an independently started Web server running', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-independent-'));
  const web = createServer({ runtime: 'web', dataDir, port: 0 });
  await web.ready;
  t.after(async () => { await web.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const companion = new FloatingService({ env: { TOKEN_WATCH_WEB_URL: `http://127.0.0.1:${web.port}` }, forkImpl: () => assert.fail('must reuse') });
  assert.equal((await companion.ensure()).ok, true);
  await companion.stop();
  assert.equal((await (await fetch(`http://127.0.0.1:${web.port}/api/health`)).json()).ok, true);
});

test('floating service refuses foreign listeners and never starts services at remote URLs', async t => {
  const other = http.createServer((_req, res) => res.end('{"ok":true}'));
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(() => new Promise(resolve => other.close(resolve)));
  const service = new FloatingService({ env: { TOKEN_WATCH_WEB_URL: `http://127.0.0.1:${other.address().port}` }, forkImpl: () => assert.fail('foreign listener') });
  assert.match((await service.ensure()).error, /不是 Token Watch/);
  const remote = new FloatingService({ env: { TOKEN_WATCH_WEB_URL: 'https://workbench.example' }, fetchImpl: async () => { throw { cause: { code: 'ECONNREFUSED' } }; }, forkImpl: () => assert.fail('remote') });
  assert.equal((await remote.ensure()).ok, false);
  assert.equal(connectionConfig({ TOKEN_WATCH_WEB_PORT: '4500' }).url, 'http://127.0.0.1:4500');
  assert.throws(() => connectionConfig({ TOKEN_WATCH_WEB_URL: 'https://user:pass@example.com' }), /无内嵌凭据/);
});

test('managed background shuts down on parent IPC disconnect', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-disconnect-'));
  const port = await freePort();
  const companion = new FloatingService({ env: { ...process.env, TOKEN_WATCH_WEB_URL: `http://127.0.0.1:${port}`, TOKEN_WATCH_WEB_DATA_DIR: dataDir, FLOATING_START_SERVICE: '1' }, nodePath: process.execPath });
  t.after(async () => { await companion.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal((await companion.ensure()).ok, true);
  const child = companion.child;
  const exited = once(child, 'exit');
  child.disconnect();
  await exited;
  assert.equal((await companion.probe()).ok, false);
});

test('startup is read-only by default and writes only after an explicit user toggle', () => {
  const writes = [];
  const mock = { getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: value => writes.push(value) };
  const startup = startupController(mock, 'E:/project with spaces', 'win32', { SystemRoot: 'C:/Windows' });
  assert.equal(startup.enabled(), false);
  assert.equal(writes.length, 0);
  startup.setEnabled(true);
  startup.setEnabled(false);
  assert.deepEqual(writes.map(w => w.openAtLogin), [true, false]);
  assert.match(writes[0].path, /wscript.exe$/);
  assert.match(writes[0].args[0], /project with spaces.*Start-Token-Watch.vbs$/);
  assert.equal(startupController(mock, '/project', 'linux').supported, false);
});

test('adaptive panel fits either screen edge and scrolls at more than five stations', () => {
  const area = { x: -1920, y: 50, width: 1920, height: 900 };
  const one = panelBounds({ x: -BALL_SIZE, y: 700 }, area, 1);
  const five = panelBounds({ x: -1920, y: 50 }, area, 5);
  assert.ok(one.height < five.height);
  assert.equal(panelBounds({ x: -1920, y: 50 }, area, 30).height, five.height);
  for (const bounds of [one, five, panelBounds({ x: 0, y: 0 }, { x: 0, y: 0, width: 320, height: 480 }, 30)]) {
    const a = bounds.width < 344 ? { x: 0, y: 0, width: 320, height: 480 } : area;
    assert.ok(bounds.x >= a.x && bounds.y >= a.y);
    assert.ok(bounds.x + bounds.width <= a.x + a.width && bounds.y + bounds.height <= a.y + a.height);
  }
});

test('island prioritizes recent real stations and keeps paused stations out of compact slots', () => {
  const stations = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' },
    { id: 'c', name: 'C' }, { id: 'd', name: 'D', disabled: true }
  ];
  assert.deepEqual(orderStations(stations, [{ stationId: 'b', lastCallAt: 100 }, { stationId: 'a', lastCallAt: 50 }]).map(s => s.id), ['b', 'a', 'c', 'd']);
  assert.deepEqual(orderStations(stations, [{ stationId: 'c', lastCallAt: 200 }, { stationId: 'b', lastCallAt: 100 }]).map(s => s.id), ['c', 'b', 'a', 'd']);
  assert.deepEqual(orderStations(stations, []).map(s => s.id), ['a', 'b', 'c', 'd']);
});

test('island stages stay centered and fit within the display work area', () => {
  const area = { x: -1920, y: 40, width: 1500, height: 850 };
  const tucked = islandBounds(area, 'tucked');
  const compact = islandBounds(area, 'compact');
  const open = islandBounds(area, 'expanded', 20);
  assert.equal(tucked.width, 96);
  assert.equal(tucked.height, 12);
  assert.equal(tucked.y, area.y);
  assert.equal(compact.width, 260);
  assert.equal(compact.height, 52);
  assert.equal(open.width, 520);
  assert.equal(compact.y, 44);
  assert.equal(open.height, islandBounds(area, 'expanded', 5).height);
  assert.ok(tucked.width < compact.width && compact.width < open.width);
  assert.ok(tucked.height < compact.height && compact.height < open.height);
  for (const parent of [area, { x: 0, y: 0, width: 320, height: 320 }, { x: 10, y: 20, width: 80, height: 90 }]) {
    for (const mode of ['tucked', 'compact', 'expanded']) {
      const bounds = islandBounds(parent, mode, 20);
      assert.ok(Math.abs(bounds.x + bounds.width / 2 - (parent.x + parent.width / 2)) <= 0.5);
      assert.ok(bounds.x >= parent.x && bounds.y >= parent.y);
      assert.ok(bounds.x + bounds.width <= parent.x + parent.width);
      assert.ok(bounds.y + bounds.height <= parent.y + parent.height);
    }
  }
});

test('island pointer transitions pop on approach, expand only on click, and retract after idle', () => {
  const timing = { leaveDelay: 180, idleDelay: 3000 };
  let state = { mode: 'tucked', leaveAt: 0, idleAt: 0 };
  state = advanceIslandState(state, true, 1000, timing);
  assert.equal(state.mode, 'compact');

  // Hovering over the compact island never opens details.
  state = advanceIslandState(state, true, 1500, timing);
  assert.equal(state.mode, 'compact');

  // Only the click action opens details; moving away returns to compact.
  state = { ...state, mode: toggleIslandMode(state.mode) };
  assert.equal(state.mode, 'expanded');
  state = advanceIslandState(state, false, 2000, timing);
  assert.equal(state.mode, 'expanded');
  state = advanceIslandState(state, false, 2179, timing);
  assert.equal(state.mode, 'expanded');
  state = advanceIslandState(state, false, 2180, timing);
  assert.equal(state.mode, 'compact');
  assert.equal(state.idleAt, 2180);

  state = advanceIslandState(state, false, 5179, timing);
  assert.equal(state.mode, 'compact');
  state = advanceIslandState(state, false, 5180, timing);
  assert.equal(state.mode, 'tucked');
});

test('returning to the island cancels its idle retraction timer', () => {
  const timing = { leaveDelay: 180, idleDelay: 3000 };
  let state = { mode: 'compact', leaveAt: 0, idleAt: 4000 };
  state = advanceIslandState(state, true, 6500, timing);
  assert.equal(state.mode, 'compact');
  assert.equal(state.idleAt, 0);
  state = advanceIslandState(state, false, 7000, timing);
  assert.equal(state.mode, 'compact');
  assert.equal(state.idleAt, 7000);
});
