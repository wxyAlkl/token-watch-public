const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../server');

test('saved CC Switch usage script refreshes independently of failed model listing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-independent-'));
  let modelFails = true;
  let usageFails = false;
  let usageRequests = 0;
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.statusCode = modelFails ? 503 : 200;
      return res.end(JSON.stringify(modelFails ? { message: 'model listing unavailable' } : { data: [{ id: 'model' }] }));
    }
    usageRequests += 1;
    assert.equal(req.headers.authorization, 'Bearer test-only-key');
    res.statusCode = usageFails ? 503 : 200;
    res.end(JSON.stringify(usageFails ? { message: 'balance unavailable' } : { remaining: 12.34 }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const app = createServer({ runtime: 'web', dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => {
    await app.close(); await new Promise(resolve => upstream.close(resolve));
    fs.unlinkSync(path.join(root, 'stations.json')); fs.rmdirSync(root);
  });
  const post = async (endpoint, body) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.ok(res.ok);
    return res.json();
  };
  const input = {
    name: 'Example relay', baseUrl: `${origin}/v1`, apiKey: 'test-only-key', usageScriptEnabled: true,
    usageScript: `({request:{url:"{{baseUrl}}/balance",headers:{Authorization:"Bearer {{apiKey}}"}},
      extractor:function(response){return {remaining:response.remaining,unit:"CNY",isValid:true};}})`
  };
  const created = await post('/api/stations', input);
  const id = created.stations[0].id;
  const standalone = await post('/api/usage/test', { stationId: id });
  assert.equal(standalone.balance, 12.34);
  const refreshed = await post(`/api/stations/${id}/refresh`, {});
  const station = refreshed.stations[0];
  assert.equal(station.modelStatus, 'error');
  assert.equal(station.usageStatus, 'online');
  assert.equal(station.balance, standalone.balance);
  assert.ok(station.usageLastSuccessAt);
  assert.equal(station.usageError, '');
  assert.match(station.lastError, /模型列表接口失败.*model listing unavailable/);
  assert.doesNotMatch(station.lastError, /统计接口失败/);
  assert.equal(refreshed.aggregate.usageOnlineCount, 1);
  assert.equal(usageRequests, 2);

  usageFails = true;
  const bothFailed = (await post('/api/stations/refresh-all', {})).stations[0];
  assert.equal(bothFailed.usageStatus, 'error');
  assert.match(bothFailed.lastError, /model listing unavailable.*balance unavailable/);
  assert.equal(bothFailed.balance, 12.34);
  modelFails = false;
  usageFails = false;
  const recovered = (await post(`/api/stations/${id}/refresh`, {})).stations[0];
  assert.equal(recovered.modelStatus, 'online');
  assert.equal(recovered.usageStatus, 'online');
  assert.equal(recovered.lastError, '');
});

test('connection resets are reported as network failures without leaking usage query secrets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-reset-'));
  const upstream = http.createServer((req) => req.socket.destroy());
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const app = createServer({ runtime: 'web', dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => {
    await app.close(); await new Promise(resolve => upstream.close(resolve));
    fs.unlinkSync(path.join(root, 'stations.json')); fs.rmdirSync(root);
  });
  const result = await fetch(`http://127.0.0.1:${app.port}/api/usage/test`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Reset', baseUrl: origin, apiKey: 'secret-reset-test',
      statsUrl: `${origin}/stats?key=secret-reset-test` })
  });
  assert.equal(result.status, 400);
  const payload = await result.json();
  assert.match(payload.error, /127\.0\.0\.1.*连接被重置或提前关闭/);
  assert.match(payload.error, /尚未收到完整接口响应/);
  assert.doesNotMatch(JSON.stringify(payload), /secret-reset-test|\/stats\?key=/);
});
