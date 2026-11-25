const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../server');
const { present } = require('../public/quota-policy');

async function request(app, route, body, method = 'PATCH') {
  const response = await fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: body === undefined ? 'GET' : method,
    headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('station quota settings persist across restart without changing trusted quota or aggregation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-quota-policy-'));
  const file = path.join(root, 'stations.json');
  fs.writeFileSync(file, JSON.stringify({ stations: [{
    id: 'relay', name: 'Relay', baseUrl: 'https://relay.example/v1',
    balance: 60, balanceLimit: 100, totalSpend: 40, balanceUnit: 'USD', balanceKnown: true,
    spendSource: 'remote', usageStatus: 'online', usagePlans: [{ name: 'Daily', remaining: 15, unit: 'USD' }]
  }] }));
  let app = createServer({ runtime: 'web', dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); fs.unlinkSync(file); fs.rmdirSync(root); });
  const before = (await request(app, '/api/stations')).body;
  assert.equal(before.stations[0].quotaPolicy.mode, 'prepaid');

  for (const [mode, limit, percent] of [['daily', 20, 75], ['weekly', 100, 15]]) {
    const result = await request(app, '/api/stations/relay', { quotaPolicy: { mode, limit, source: 'plan:Daily' } });
    assert.equal(result.status, 200);
    assert.equal(present(result.body.stations[0]).percent, percent);
    assert.equal(result.body.stations[0].balanceLimit, 100);
    assert.equal(result.body.stations[0].balance, 60);
    assert.equal(result.body.stations[0].quotaConsumed, 40);
    assert.deepEqual(result.body.aggregate, before.aggregate);
  }
  const updated = await request(app, '/api/stations/relay', { quotaPolicy: { mode: 'prepaid', source: 'account', lowBalanceThreshold: 65 } });
  assert.equal(present(updated.body.stations[0]).state, 'low');
  assert.equal(present(updated.body.stations[0]).percent, null);
  await request(app, '/api/stations/relay', { tokenName: 'renamed' });
  await app.close();
  app = createServer({ runtime: 'web', dataDir: root, port: 0 });
  await app.ready;
  const saved = (await request(app, '/api/stations')).body.stations[0];
  assert.deepEqual(saved.quotaPolicy, { mode: 'prepaid', limit: null, source: 'account', lowBalanceThreshold: 65 });
  assert.equal(saved.tokenName, 'renamed');
});

test('station quota API validates create and patch and preserves settings on failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-quota-validation-'));
  const app = createServer({ runtime: 'web', dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); fs.unlinkSync(path.join(root, 'stations.json')); fs.rmdirSync(root); });
  const input = { name: 'Relay', baseUrl: 'https://relay.example/v1', quotaPolicy: { mode: 'daily', limit: 20 } };
  const created = await request(app, '/api/stations', input, 'POST');
  assert.equal(created.status, 201);
  const id = created.body.stations[0].id;
  for (const quotaPolicy of [null, [], 'daily', { mode: 'bad' }, { limit: 0 }, { limit: -10 }, { limit: 'bad' },
    { limit: true }, { lowBalanceThreshold: -1 }, { source: 'other' }]) {
    const invalid = await request(app, `/api/stations/${id}`, { quotaPolicy });
    assert.equal(invalid.status, 400, JSON.stringify(quotaPolicy));
  }
  const badCreate = await request(app, '/api/stations', { ...input, quotaPolicy: { mode: 'weekly' } }, 'POST');
  assert.equal(badCreate.status, 400);
  const final = (await request(app, '/api/stations')).body;
  assert.equal(final.stations.length, 1);
  assert.deepEqual(final.stations[0].quotaPolicy, created.body.stations[0].quotaPolicy);
});

test('quota display retains cached plan on query failure and never resets it locally', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-quota-stale-'));
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/models') return res.end(JSON.stringify({ data: [] }));
    res.writeHead(503); res.end(JSON.stringify({ message: 'Unavailable' }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ stations: [{
    id: 'relay', name: 'Relay', baseUrl: origin, statsUrl: `${origin}/stats`, apiKey: 'test-key',
    spendSource: 'remote', usageStatus: 'online', balanceKnown: true, balance: 75, balanceUnit: 'USD',
    balanceUpdatedAt: '2020-01-01T00:00:00Z', usagePlans: [{ planName: 'Daily', remaining: 5, unit: 'USD' }],
    quotaPolicy: { mode: 'daily', limit: 20, source: 'plan:Daily' }
  }] }));
  const app = createServer({ runtime: 'web', dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => {
    await app.close(); await new Promise((resolve) => upstream.close(resolve));
    fs.unlinkSync(path.join(root, 'stations.json')); fs.rmdirSync(root);
  });
  const refreshed = await request(app, '/api/stations/relay/refresh', {}, 'POST');
  const station = refreshed.body.stations[0];
  assert.equal(station.usageStatus, 'error');
  assert.equal(station.balance, 75);
  assert.equal(present(station).remaining, 5);
  assert.equal(present(station).percent, 25);
  assert.equal(present(station).stale, true);
});
