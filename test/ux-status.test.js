const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createServer } = require('../server');

function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path: url, headers: { 'content-type': 'application/json' } }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : {} }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function makeState() {
  const calls = Array.from({ length: 3 }, (_, index) => ({
    id: `call-${index}`,
    model: 'test-model',
    tokens: 10 + index,
    timestamp: new Date(Date.now() - index * 60000).toISOString(),
    sourceType: 'local-proxy',
    cost: 1,
    costUnit: 'USD'
  }));
  return {
    settings: { refreshMinutes: 5 },
    stations: [
      { id: 'relay-a', name: 'Relay A', baseUrl: 'https://relay-a.invalid/v1', calls },
      { id: 'relay-b', name: 'Relay B', baseUrl: 'https://relay-b.invalid/v1', calls: [], disabled: true }
    ]
  };
}

async function startServer(t, state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-ux-'));
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify(state));
  const app = createServer({ dataDir: root, runtime: 'web', port: 0 });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.ready;
  app.dataDir = root;
  return app;
}

test('health endpoint reports sync state without requiring a full state read', async (t) => {
  const app = await startServer(t, makeState());
  const health = await request(app.port, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.sync.running, false);
  assert.equal(typeof health.body.now, 'number');
});

test('health endpoint stays available even when the state file is corrupt', async (t) => {
  const app = await startServer(t, makeState());
  fs.writeFileSync(path.join(app.dataDir, 'stations.json'), '{ not valid json');
  const health = await request(app.port, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  const bodyText = JSON.stringify(health.body);
  assert.equal(/apiKey|Bearer|token-watch-data/.test(bodyText), false);
});

test('SQLite station responses keep callCount while omitting calls', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-ux-sqlite-'));
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify(makeState()));
  const app = createServer({ dataDir: root, runtime: 'web', port: 0, sqliteEnabled: true });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.ready;
  const listed = await request(app.port, 'GET', '/api/stations');
  const relayA = listed.body.stations.find((station) => station.id === 'relay-a');
  assert.equal(relayA.callCount, 3);
  assert.equal('calls' in relayA, false);
  const paused = await request(app.port, 'PATCH', '/api/stations/relay-b', { name: 'Relay B2' });
  assert.equal(paused.body.stations.find((station) => station.id === 'relay-b').disabled, true);
  assert.equal(paused.body.stations.find((station) => station.id === 'relay-b').name, 'Relay B2');
});

test('station list exposes callCount/disabled and refresh-all skips paused stations', async (t) => {
  const app = await startServer(t, makeState());
  const listed = await request(app.port, 'GET', '/api/stations');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.stations.length, 2);
  const relayA = listed.body.stations.find((station) => station.id === 'relay-a');
  const relayB = listed.body.stations.find((station) => station.id === 'relay-b');
  assert.equal(relayA.callCount, 3);
  assert.equal(relayA.disabled, false);
  assert.equal(relayB.disabled, true);
  assert.equal('apiKey' in relayA, false);

  const refresh = await request(app.port, 'POST', '/api/stations/refresh-all', {});
  assert.equal(refresh.status, 200);
  const skipped = refresh.body.refreshResults.find((result) => result.id === 'relay-b');
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.modelStatus, 'paused');
  const contacted = refresh.body.refreshResults.find((result) => result.id === 'relay-a');
  assert.equal(contacted.skipped, undefined);
  assert.equal(contacted.modelStatus, 'missing');
});

test('single-station refresh on a paused station is skipped without network access', async (t) => {
  const app = await startServer(t, makeState());
  const refresh = await request(app.port, 'POST', '/api/stations/relay-b/refresh', {});
  assert.equal(refresh.status, 200);
  assert.equal(refresh.body.refreshResults[0].skipped, true);
  assert.equal(refresh.body.refreshResults[0].modelStatus, 'paused');
  const listed = await request(app.port, 'GET', '/api/stations');
  assert.equal(listed.body.stations.find((station) => station.id === 'relay-b').callCount, 0);
});

test('refresh-all probes run outside the write queue so concurrent edits are not blocked or overwritten', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'slow-model' }] }));
      }, 800);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-ux-queue-'));
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [
    { id: 'queue-a', name: 'Queue A', baseUrl: upstreamUrl, apiKey: 'key-a', calls: [] },
    { id: 'queue-b', name: 'Queue B', baseUrl: upstreamUrl, apiKey: 'key-b', calls: [] }
  ] }));
  const app = createServer({ dataDir: root, port: 0 });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.ready;

  const refreshPromise = request(app.port, 'POST', '/api/stations/refresh-all', {});
  await new Promise((resolve) => setTimeout(resolve, 120));
  const editStarted = Date.now();
  const edited = await request(app.port, 'PATCH', '/api/stations/queue-a', { name: 'Queue A edited' });
  const editMs = Date.now() - editStarted;
  assert.equal(edited.status, 200);
  assert.ok(editMs < 500, 'concurrent edit should not wait for the network probes, took ' + editMs + 'ms');
  const refreshed = await refreshPromise;
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.refreshResults.length, 2);
  const station = refreshed.body.stations.find((item) => item.id === 'queue-a');
  assert.equal(station.name, 'Queue A edited');
  assert.equal(station.modelStatus, 'online');
  assert.equal(station.modelCount, 1);
});

test('disabled flag persists through PATCH and round-trips through the store', async (t) => {
  const app = await startServer(t, makeState());
  const paused = await request(app.port, 'PATCH', '/api/stations/relay-a', { disabled: true });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.stations.find((station) => station.id === 'relay-a').disabled, true);
  const restored = await request(app.port, 'PATCH', '/api/stations/relay-a', { disabled: false });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.stations.find((station) => station.id === 'relay-a').disabled, false);
  const health = await request(app.port, 'GET', '/api/health');
  assert.equal(health.body.sync.running, false);
});
