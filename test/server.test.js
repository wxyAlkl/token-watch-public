const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

const { createServer } = require('../server');

function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ port, method, path: url, headers: { 'content-type': 'application/json' } }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : {} }));
    });
    request.on('error', reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

function requestText(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ port, method, path: url, headers: { 'content-type': 'application/json' } }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: raw }));
    });
    request.on('error', reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

test('web runtime isolates settings, credentials and logs from the desktop runtime', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-web-isolation-'));
  const desktopDir = path.join(root, 'desktop');
  const webDir = path.join(root, 'web');
  fs.mkdirSync(desktopDir);
  const desktopFile = path.join(desktopDir, 'stations.json');
  const desktopOriginal = JSON.stringify({ settings: { refreshMinutes: 60 }, stations: [{
    id: 'desktop', name: 'Desktop only', baseUrl: 'https://desktop.example/v1', apiKey: 'desktop-secret',
    calls: [{ id: 'desktop-log', model: 'desktop-model', tokens: 12, timestamp: new Date().toISOString() }]
  }] });
  fs.writeFileSync(desktopFile, desktopOriginal);
  const desktop = createServer({ dataDir: desktopDir, port: 0 });
  const web = createServer({ dataDir: webDir, port: 0, runtime: 'web' });
  t.after(async () => {
    await desktop.close();
    await web.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await desktop.ready;
  await web.ready;

  for (const url of ['/', '/index.html']) {
    const html = await requestText(web.port, 'GET', url);
    assert.equal(html.status, 200);
    assert.match(html.body, /data-runtime="web"/);
    assert.match(html.body, /<title>Token Watch Web/);
  }
  const desktopHtml = await requestText(desktop.port, 'GET', '/');
  assert.match(desktopHtml.body, /data-runtime="desktop"/);
  assert.doesNotMatch(desktopHtml.body, /<title>Token Watch Web/);

  const initialWeb = await request(web.port, 'GET', '/api/stations');
  assert.deepEqual(initialWeb.body.stations, []);
  assert.equal(initialWeb.body.settings.refreshMinutes, 5);
  const newStation = await request(web.port, 'POST', '/api/stations', {
    name: 'Web only', baseUrl: 'https://web.example/v1', apiKey: 'web-secret', balanceUnit: 'USD'
  });
  assert.equal(newStation.status, 201);
  assert.equal(newStation.body.stations[0].hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(newStation.body), /web-secret|desktop-secret/);
  await request(web.port, 'PATCH', '/api/settings', { refreshMinutes: 10 });
  const desktopState = await request(desktop.port, 'GET', '/api/stations');
  assert.equal(desktopState.body.stations.length, 1);
  assert.equal(desktopState.body.stations[0].name, 'Desktop only');
  assert.equal(desktopState.body.settings.refreshMinutes, 60);
  const desktopLogs = await request(desktop.port, 'GET', '/api/logs');
  const webLogs = await request(web.port, 'GET', '/api/logs');
  assert.deepEqual(desktopLogs.body.logs.map((log) => log.model), ['desktop-model']);
  assert.deepEqual(webLogs.body.logs, []);
  const activity = await request(desktop.port, 'GET', '/api/stations/recent-activity');
  assert.deepEqual(activity.body.stations, [{ stationId: 'desktop', lastCallAt: Date.parse(desktopLogs.body.logs[0].timestamp) }]);
  assert.equal(fs.readFileSync(desktopFile, 'utf8'), desktopOriginal);
  const stored = JSON.parse(fs.readFileSync(path.join(webDir, 'stations.json'), 'utf8'));
  assert.equal(stored.stations[0].apiKey, 'web-secret');
  assert.equal(stored.settings.refreshMinutes, 10);
});

test('web runtime preserves previously saved settings on restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-web-restart-'));
  const original = JSON.stringify({ settings: { refreshMinutes: 10 }, stations: [{
    id: 'saved', name: 'Saved station', apiKey: 'saved-secret', calls: []
  }] });
  fs.writeFileSync(path.join(root, 'stations.json'), original);
  let web = createServer({ dataDir: root, port: 0, runtime: 'web' });
  t.after(async () => { await web.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await web.ready;
  await web.close();
  web = createServer({ dataDir: root, port: 0, runtime: 'web' });
  await web.ready;
  const state = await request(web.port, 'GET', '/api/stations');
  assert.equal(state.body.settings.refreshMinutes, 10);
  assert.equal(state.body.stations[0].hasApiKey, true);
  assert.equal(state.body.stations[0].name, 'Saved station');
  assert.equal(fs.readFileSync(path.join(root, 'stations.json'), 'utf8'), original);
});

test('server stores a real proxy call with response usage and no key in public state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        assert.equal(req.headers.authorization, 'Bearer test-key');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl_test', model: 'gpt-test', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{ id: 'test', name: 'Test', baseUrl: upstreamUrl, apiKey: 'test-key', calls: [], trend: [] }] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const proxy = await request(app.port, 'POST', '/api/stations/test/proxy/v1/chat/completions', { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(proxy.status, 200);
  assert.equal(proxy.body.usage.total_tokens, 19);
  const logs = await request(app.port, 'GET', '/api/logs');
  assert.equal(logs.status, 200);
  assert.equal(logs.body.logs[0].inputTokens, 12);
  assert.equal(logs.body.logs[0].outputTokens, 7);
  const state = await request(app.port, 'GET', '/api/stations');
  assert.equal(state.body.stations[0].hasApiKey, true);
  assert.equal('apiKey' in state.body.stations[0], false);
});

test('server excludes health checks from the call-flow log', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-health-check-'));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{
    id: 'test', name: 'Test', calls: [{ model: 'GET /models', tokens: 0 }, { model: 'gpt-test', tokens: 19 }]
  }] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const logs = await request(app.port, 'GET', '/api/logs');
  assert.equal(logs.status, 200);
  assert.deepEqual(logs.body.logs.map((log) => log.model), ['gpt-test']);
});

test('server records CC Switch token buckets from a final streaming usage event', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-stream-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"stream-test","model":"gpt-stream","choices":[{"delta":{"content":"hel');
      setTimeout(() => {
        res.write('lo"}}]}\n\n');
        setTimeout(() => {
          res.end('data: {"model":"gpt-stream","usage":{"prompt_tokens":20,"prompt_tokens_details":{"cached_tokens":5},"completion_tokens":8,"total_tokens":28}}\n\ndata: [DONE]\n\n');
        }, 5);
      }, 5);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{
    id: 'stream', name: 'Stream', baseUrl: upstreamUrl, apiKey: 'stream-key', calls: [], trend: []
  }] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const proxy = await requestText(app.port, 'POST', '/api/stations/stream/proxy/v1/chat/completions', { model: 'gpt-stream', stream: true, messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(proxy.status, 200);
  assert.match(proxy.body, /data: \[DONE\]/);
  const logs = await request(app.port, 'GET', '/api/logs?range=30d');
  assert.equal(logs.body.logs[0].model, 'gpt-stream');
  assert.equal(logs.body.logs[0].inputTokens, 15);
  assert.equal(logs.body.logs[0].outputTokens, 8);
  assert.equal(logs.body.logs[0].cacheReadTokens, 5);
  assert.equal(logs.body.logs[0].tokens, 28);
  assert.equal(logs.body.logs[0].cacheHitRate, 25);
});

test('server filters call logs by CC Switch style time ranges', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-ranges-'));
  const now = Date.now();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{
    id: 'ranges', name: 'Ranges', calls: [
      { id: 'recent', model: 'recent', timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(), tokens: 2 },
      { id: 'week-old', model: 'week-old', timestamp: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(), tokens: 3 }
    ]
  }] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const day = await request(app.port, 'GET', '/api/logs?range=24h');
  const week = await request(app.port, 'GET', '/api/logs?range=7d');
  assert.deepEqual(day.body.logs.map((log) => log.model), ['recent']);
  assert.deepEqual(week.body.logs.map((log) => log.model), ['recent']);
});

test('server imports real Codex CLI session usage without double counting', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-cli-'));
  const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-codex-'));
  const sessionFile = path.join(cliRoot, 'rollout-test.jsonl');
  const usageTimestamp = new Date(Date.now() - 60 * 1000).toISOString();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(cliRoot, 'config.toml'), 'model = "gpt-5.6-terra"\n[model_providers.custom]\nname = "Example CLI"\nbase_url = "https://relay.example/v1"\n');
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'session-1', model_provider: 'custom' }, timestamp: usageTimestamp }),
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-6.1-sol' }, timestamp: usageTimestamp }),
    JSON.stringify({ type: 'token_usage_record', timestamp: usageTimestamp, payload: {
      session_id: 'session-1', turn_id: 'turn-1', response_id: 'response-1',
      usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5, output_tokens: 20, total_tokens: 125 }
    } })
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{
    id: 'example-relay', name: '示例中转站', tokenName: 'example-client', baseUrl: 'https://relay.example/v1', calls: [], tokens: 0
  }] }));
  const app = createServer({ dataDir: root, port: 0, cliPaths: { codexSessions: cliRoot, codexConfig: path.join(cliRoot, 'config.toml'), claudeProjects: path.join(cliRoot, 'missing-claude') }, });
  await app.ready;
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cliRoot, { recursive: true, force: true }); });

  const synced = await request(app.port, 'POST', '/api/logs/sync-cli', {});
  assert.equal(synced.status, 200);
  assert.equal(synced.body.scanned, 1);
  assert.equal(synced.body.imported.length, 1);
  assert.equal(synced.body.imported[0].tokens, 125);
  assert.equal(synced.body.stations[0].tokens, 125);
  const logs = await request(app.port, 'GET', '/api/logs?range=30d');
  assert.equal(logs.body.logs[0].source, '示例中转站');
  assert.equal(logs.body.logs[0].inputTokens, 60);
  assert.equal(logs.body.logs[0].cacheReadTokens, 40);
  assert.equal(logs.body.logs[0].cacheWriteTokens, 5);
  assert.equal(logs.body.logs[0].outputTokens, 20);
  assert.equal(logs.body.logs[0].stream, null);
  assert.equal(logs.body.logs[0].ttft, null);
  assert.equal(logs.body.logs[0].duration, null);
  assert.equal(logs.body.logs[0].tps, null);
  assert.equal(logs.body.logs[0].statusCode, null);
  assert.equal(logs.body.logs[0].dataSource, 'CLI usage');
  assert.equal(logs.body.logs[0].model, 'gpt-6.1-sol');
  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'stations.json'), 'utf8'));
  assert.equal(persisted.cliFileCache.codex[sessionFile].size, fs.statSync(sessionFile).size);
  const repeated = await request(app.port, 'POST', '/api/logs/sync-cli', {});
  assert.equal(repeated.body.imported.length, 0);
  assert.equal(repeated.body.stations[0].tokens, 125);
  assert.equal(repeated.body.cliSync.importedCount, 0);
});

test('server migrates legacy CLI logs without importing them again', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-cli-migration-'));
  const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-codex-migration-'));
  const sessionFile = path.join(cliRoot, 'rollout-legacy.jsonl');
  const usageTimestamp = new Date(Date.now() - 60 * 1000).toISOString();
  const importKey = 'codex:session-legacy:response-legacy';
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(cliRoot, 'config.toml'), 'model = "gpt-5.6-terra"\n[model_providers.custom]\nname = "Example CLI"\nbase_url = "https://relay.example/v1"\n');
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'session-legacy', model_provider: 'custom' }, timestamp: usageTimestamp }),
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-legacy', model: 'gpt-6.1-sol' }, timestamp: usageTimestamp }),
    JSON.stringify({ type: 'token_usage_record', timestamp: usageTimestamp, payload: {
      session_id: 'session-legacy', turn_id: 'turn-legacy', response_id: 'response-legacy',
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 120 }
    } })
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, cliImportedKeys: [importKey], stations: [{
    id: 'example-relay', name: '示例中转站', tokenName: 'example-client', baseUrl: 'https://relay.example/v1', tokens: 120,
    calls: [{ id: 'legacy-call', importKey, sourceType: 'codex-cli', model: 'gpt-5.6-terra', stream: false,
      statusCode: 200, duration: 0, ttft: 0, tps: 0, tokens: 120, result: '成功' }]
  }] }));
  const app = createServer({ dataDir: root, port: 0, cliPaths: {
    codexSessions: cliRoot, codexConfig: path.join(cliRoot, 'config.toml'), claudeProjects: path.join(cliRoot, 'missing-claude')
  } });
  await app.ready;
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cliRoot, { recursive: true, force: true }); });

  const synced = await request(app.port, 'POST', '/api/logs/sync-cli', {});
  assert.equal(synced.status, 200);
  assert.equal(synced.body.imported.length, 0);
  assert.equal(synced.body.migratedCount, 1);
  assert.equal(synced.body.stations[0].tokens, 120);
  const logs = await request(app.port, 'GET', '/api/logs?range=30d');
  const log = logs.body.logs[0];
  assert.equal(log.model, 'gpt-6.1-sol');
  assert.equal(log.stream, null);
  assert.equal(log.statusCode, null);
  assert.equal(log.duration, null);
  assert.equal(log.ttft, null);
  assert.equal(log.tps, null);
  assert.equal(log.result, '已同步');

  const repeated = await request(app.port, 'POST', '/api/logs/sync-cli', {});
  assert.equal(repeated.body.migratedCount, 0);
  assert.equal(repeated.body.imported.length, 0);
});

test('server reads New API account balance with separate access token and user id', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-new-api-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      assert.equal(req.headers.authorization, 'Bearer model-key');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
      return;
    }
    if (req.url === '/api/user/self') {
      assert.equal(req.headers.authorization, 'Bearer usage-token');
      assert.equal(req.headers['new-api-user'], '42');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { quota: 15395000, used_quota: 22185000, group: 'default' } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{
    id: 'new-api', name: 'New API', baseUrl: upstreamUrl, apiKey: 'model-key', statsToken: 'usage-token', statsUserId: '42', calls: [], trend: []
  }] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const refreshed = await request(app.port, 'POST', '/api/stations/new-api/refresh', {});
  assert.equal(refreshed.status, 200);
  const station = refreshed.body.stations[0];
  assert.equal(station.status, 'online');
  assert.equal(station.modelCount, 1);
  assert.equal(station.balance, 30.79);
  assert.equal(station.totalSpend, 0);
  assert.equal(station.reportedTotalSpend, 44.37);
  assert.equal(station.balanceLimit, 75.16);
  assert.equal(station.balanceUnit, 'USD');
  assert.equal(station.totalSpendUnit, 'USD');
  assert.equal(station.todaySpend, null);
  assert.equal(station.todaySpendAvailable, false);
  assert.equal(station.metricsSource, 'New API 实时账户额度');
  assert.equal(station.hasStatsToken, true);
  assert.equal(station.hasStatsUserId, true);
  assert.equal('statsToken' in station, false);
  assert.deepEqual(refreshed.body.aggregate.totalBalanceByUnit, { USD: 30.79 });
  assert.deepEqual(refreshed.body.aggregate.todaySpendByUnit, {});
  assert.deepEqual(refreshed.body.aggregate.totalSpendByUnit, { USD: 0 });
});

test('server reads AHE usage plans with its token endpoint', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-ahe-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'ahe-model' }] }));
      return;
    }
    if (req.url === '/api/usage/token/') {
      assert.equal(req.headers.authorization, 'Bearer ahe-key');
      assert.equal(req.headers['user-agent'], 'cc-switch/1.0');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 200, data: {
        quota_per_unit: 100000,
        user_total_available: 1250000,
        user_total_used: 250000,
        user_total_granted: 1500000,
        subscriptions: [{ plan: { title: 'Daily Plan' }, subscription: { amount_total: 500000, amount_used: 100000, next_reset_time: 0 } }],
        quota_buckets: { active_buckets: [{ bucket: { title: 'Pack', amount_total: 400000, amount_used: 150000 }, remaining_quota: 250000 }] }
      } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{
    id: 'ahe', name: 'AHE API', baseUrl: upstreamUrl, statsUrl: `${upstreamUrl.replace('/v1', '')}/api/usage/token/`, apiKey: 'ahe-key', calls: [], trend: []
  }] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const refreshed = await request(app.port, 'POST', '/api/stations/ahe/refresh', {});
  assert.equal(refreshed.status, 200);
  const station = refreshed.body.stations[0];
  assert.equal(station.status, 'online');
  assert.equal(station.balance, 12.5);
  assert.equal(station.balanceLimit, 15);
  assert.equal(station.totalSpend, 0);
  assert.equal(station.reportedTotalSpend, 2.5);
  assert.equal(station.balanceUnit, 'USD');
  assert.equal(station.metricsSource, 'AHE 实时用量');
  assert.equal(station.usagePlans.length, 3);
  assert.equal(station.usagePlans[1].planName, 'Daily Plan');
  assert.equal(station.usagePlans[1].remaining, 4);
  assert.equal('apiKey' in station, false);
  const logs = await request(app.port, 'GET', '/api/logs');
  assert.equal(logs.body.logs.length, 0);
});

test('server reads DeepSeek official balance with the model API key', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-deepseek-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      assert.equal(req.headers.authorization, 'Bearer deepseek-key');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }));
      return;
    }
    if (req.url === '/user/balance') {
      assert.equal(req.headers.authorization, 'Bearer deepseek-key');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ is_available: true, balance_infos: [{
        currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00'
      }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const upstreamUrl = `${origin}/v1`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{
    id: 'deepseek', name: 'DeepSeek 官方', baseUrl: upstreamUrl, statsUrl: `${origin}/user/balance`, apiKey: 'deepseek-key', calls: [], trend: []
  }] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const refreshed = await request(app.port, 'POST', '/api/stations/deepseek/refresh', {});
  assert.equal(refreshed.status, 200);
  const station = refreshed.body.stations[0];
  assert.equal(station.status, 'online');
  assert.equal(station.usageStatus, 'online');
  assert.equal(station.modelCount, 1);
  assert.equal(station.balance, 110);
  assert.equal(station.balanceUnit, 'CNY');
  assert.equal(station.balanceLimit, null);
  assert.equal(station.totalSpend, 0);
  assert.equal(station.quotaConsumed, null);
  assert.equal(station.metricsSource, 'DeepSeek 官方余额');
  assert.deepEqual(station.usagePlans.map((plan) => plan.planName), ['总余额', '赠送余额', '充值余额']);
  assert.deepEqual(station.usagePlans.map((plan) => plan.remaining), [110, 10, 100]);
  assert.deepEqual(refreshed.body.aggregate.totalBalanceByUnit, { CNY: 110 });
  assert.deepEqual(refreshed.body.aggregate.quotaConsumedByUnit, {});
  assert.equal('apiKey' in station, false);
});

test('server reads Aixhan remaining balance with an encoded key query', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-aixhan-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'aixhan-model' }] }));
      return;
    }
    if (req.url?.startsWith('/api/public/usage/stats?')) {
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      assert.equal(query.get('key'), 'aixhan key+/');
      assert.equal(req.headers.authorization, undefined);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { remaining: 7.25 } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{
    id: 'aixhan', name: '爱享 API', baseUrl: upstreamUrl, statsUrl: `${upstreamUrl.replace('/v1', '')}/api/public/usage/stats?key=old-secret`, apiKey: 'aixhan key+/', calls: [], trend: []
  }] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const refreshed = await request(app.port, 'POST', '/api/stations/aixhan/refresh', {});
  assert.equal(refreshed.status, 200);
  const station = refreshed.body.stations[0];
  assert.equal(station.status, 'online');
  assert.equal(station.balance, 7.25);
  assert.equal(station.balanceUnit, 'USD');
  assert.equal(station.totalSpend, 0);
  assert.equal(station.metricsSource, '爱享实时用量');
  assert.equal(new URL(station.statsUrl).searchParams.get('key'), null);
  assert.equal('apiKey' in station, false);
});

test('server only reports quota difference when a trusted total quota exists', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-quota-difference-'));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [
    { id: 'local', name: 'Local proxy', balance: 65, balanceLimit: 100, balanceUnit: 'USD', spendSource: 'local-proxy', calls: [], trend: [] },
    { id: 'remote', name: 'Remote quota', balance: 65, balanceLimit: 100, balanceUnit: 'USD', spendSource: 'remote', calls: [], trend: [] },
    { id: 'unknown', name: 'Unknown quota', balance: 65, balanceLimit: null, balanceUnit: 'USD', spendSource: 'remote', calls: [], trend: [] }
  ] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const result = await request(app.port, 'GET', '/api/stations');
  assert.equal(result.body.stations.find((station) => station.id === 'local').quotaConsumed, null);
  assert.equal(result.body.stations.find((station) => station.id === 'remote').quotaConsumed, 35);
  assert.equal(result.body.stations.find((station) => station.id === 'unknown').quotaConsumed, null);
  assert.deepEqual(result.body.aggregate.quotaConsumedByUnit, { USD: 35 });
});

test('server builds a live token trend and supports per-station balance units', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-trend-units-'));
  const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [
    { id: 'example-relay', name: 'Example Relay', baseUrl: 'https://www.micuapi.ai/v1', calls: [{ timestamp: recent, tokens: 42 }], trend: [] },
    { id: 'ahe', name: 'AHE', baseUrl: 'https://aheapi.com/v1', calls: [], trend: [] }
  ] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const initial = await request(app.port, 'GET', '/api/stations');
  assert.equal(initial.body.stations.find((station) => station.id === 'example-relay').balanceUnit, 'CNY');
  assert.equal(initial.body.stations.find((station) => station.id === 'ahe').balanceUnit, 'USD');
  assert.equal(initial.body.stations.find((station) => station.id === 'example-relay').trend.reduce((sum, value) => sum + value, 0), 42);

  const updated = await request(app.port, 'PATCH', '/api/stations/ahe', { balanceUnit: 'CNY' });
  assert.equal(updated.body.stations.find((station) => station.id === 'ahe').balanceUnit, 'CNY');
});

test('server keeps an unqueried balance distinct from a real zero balance', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-unknown-balance-'));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [
    { id: 'pending', name: 'Pending', baseUrl: 'https://pending.example/v1', apiKey: '', status: 'pending',
      balance: 0, balanceLimit: 0, todaySpend: 0, totalSpend: 0, metricsSource: '等待真实统计接口', calls: [] }
  ] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const result = await request(app.port, 'GET', '/api/stations');
  const station = result.body.stations[0];
  assert.equal(station.balance, null);
  assert.equal(station.balanceLimit, null);
  assert.equal(station.quotaConsumed, null);
  assert.equal(result.body.aggregate.totalBalance, null);
  assert.equal(result.body.aggregate.quotaConsumed, null);
});

test('server exposes model and usage health separately when statistics fail', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-health-split-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
      return;
    }
    if (req.url === '/stats') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'temporary outage' }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{
    id: 'health-split', name: 'Health Split', baseUrl: upstreamUrl, statsUrl: `${upstreamUrl.replace('/v1', '')}/stats`, apiKey: 'test-key', calls: []
  }] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const result = await request(app.port, 'POST', '/api/stations/health-split/refresh', {});
  const station = result.body.stations[0];
  assert.equal(station.status, 'online');
  assert.equal(station.modelStatus, 'online');
  assert.equal(station.usageStatus, 'error');
  assert.match(station.usageError, /temporary outage/);
  assert.equal(result.body.aggregate.usageOnlineCount, 0);
  assert.equal(result.body.aggregate.usageErrorCount, 1);
  assert.equal(result.body.refreshResults[0].modelStatus, 'online');
  assert.equal(result.body.refreshResults[0].usageStatus, 'error');
});

test('server tests a station connection without saving the station', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-connection-test-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
      return;
    }
    if (req.url === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ balance: 12, balanceLimit: 20, unit: 'USD' }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const tested = await request(app.port, 'POST', '/api/stations/test', {
    name: 'Unsaved', baseUrl: upstreamUrl, apiKey: 'test-key', statsUrl: `${upstreamUrl.replace('/v1', '')}/stats`
  });
  assert.equal(tested.status, 200);
  assert.equal(tested.body.test.modelStatus, 'online');
  assert.equal(tested.body.test.usageStatus, 'online');
  assert.equal(tested.body.test.modelCount, 1);
  assert.equal(tested.body.test.balance, 12);
  const state = await request(app.port, 'GET', '/api/stations');
  assert.equal(state.body.stations.length, 0);
});

test('server does not invent a quota limit for generic balance-only statistics', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-generic-balance-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
      return;
    }
    if (req.url === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { balance: 7.25, unit: 'USD' } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{
    id: 'generic', name: 'Generic', baseUrl: upstreamUrl, statsUrl: `${upstreamUrl.replace('/v1', '')}/stats`, apiKey: 'test-key', calls: []
  }] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const result = await request(app.port, 'POST', '/api/stations/generic/refresh', {});
  const station = result.body.stations[0];
  assert.equal(station.balance, 7.25);
  assert.equal(station.balanceLimit, null);
  assert.equal(station.quotaConsumed, null);
});

test('server keeps more than 100 persisted call logs and reports units accurately', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-log-retention-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'gpt-test', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [{
    id: 'logs', name: 'Logs', baseUrl: upstreamUrl, apiKey: 'test-key', balanceUnit: 'USD', balanceUnitCustomized: true,
    pricing: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, calls: []
  }] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const responses = await Promise.all(Array.from({ length: 101 }, () => request(
    app.port, 'POST', '/api/stations/logs/proxy/v1/chat/completions', { model: 'gpt-test', messages: [] }
  )));
  assert.equal(responses.filter((response) => response.status === 200).length, 101);
  const logs = await request(app.port, 'GET', '/api/logs?range=30d');
  assert.equal(logs.body.logs.length, 101);
  assert.equal(logs.body.logs[0].costUnit, 'USD');
  assert.equal(logs.body.summary.requestCount, 101);
  assert.equal(logs.body.summary.tokenCount, 505);
  assert.deepEqual(logs.body.summary.usageByUnit, { USD: 0.000808 });
});

test('server includes unmatched CLI usage in the aggregate trend', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-cli-trend-'));
  const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [], cliCalls: [
    { id: 'cli', source: 'Other CLI', timestamp: recent, tokens: 42 }
  ] }));
  const app = createServer({ dataDir: root, port: 0 });
  await app.ready;
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const state = await request(app.port, 'GET', '/api/stations');
  assert.equal(state.body.aggregate.trend.reduce((sum, value) => sum + value, 0), 42);
});

test('server imports OpenAI-compatible providers from a CC Switch SQLite database', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-cc-switch-'));
  const dbPath = path.join(root, 'cc-switch.db');
  const SQL = await initSqlJs({ locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file) });
  const db = new SQL.Database();
  db.run('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT, sort_index INTEGER)');
  db.run('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?)', [
    'example-id', 'codex', 'Example Relay', JSON.stringify({
      auth: {},
      config: '[model_providers.custom]\nname = "Example Relay"\nbase_url = "https://relay.example/v1"\nexperimental_bearer_token = "model-key"'
    }), JSON.stringify({ usage_script: { enabled: true, templateType: 'newapi', accessToken: 'stats-token', userId: '42' } }), 1
  ]);
  db.run('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?)', [
    'official', 'codex', 'OpenAI Official', JSON.stringify({ auth: { OPENAI_API_KEY: 'official-key' }, config: 'model = "gpt"' }), '{}', 2
  ]);
  db.run('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?)', [
    'aixhan-id', 'codex', 'AixHan', JSON.stringify({
      auth: {},
      config: '[model_providers.custom]\nname = "AixHan"\nbase_url = "https://api.aixhan.com/v1"\nexperimental_bearer_token = "aixhan-model-key"'
    }), JSON.stringify({ usage_script: {
      enabled: true,
      baseUrl: 'https://cdk.aixhan.com',
      code: '({ request: { url: "{{baseUrl}}/api/public/usage/stats?key=" + encodeURIComponent("{{apiKey}}") } })'
    } }), 3
  ]);
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 5 }, stations: [] }));
  const app = createServer({ dataDir: root, port: 0, ccSwitchDbPath: dbPath });
  await app.ready;
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const available = await request(app.port, 'GET', '/api/import/cc-switch');
  assert.equal(available.status, 200);
  assert.equal(available.body.candidates.length, 2);
  const exampleRelay = available.body.candidates.find((candidate) => candidate.name === 'Example Relay');
  const aixhan = available.body.candidates.find((candidate) => candidate.name === 'AixHan');
  assert.equal(exampleRelay.baseUrl, 'https://relay.example/v1');
  assert.equal(exampleRelay.hasApiKey, true);
  assert.equal(exampleRelay.hasStatsToken, true);
  assert.equal('apiKey' in exampleRelay, false);
  assert.equal('statsToken' in exampleRelay, false);
  assert.equal(aixhan.statsUrl, 'https://cdk.aixhan.com/api/public/usage/stats');
  assert.equal(aixhan.hasApiKey, true);
  assert.equal(aixhan.hasStatsToken, false);

  const imported = await request(app.port, 'POST', '/api/import/cc-switch', { ids: [exampleRelay.id] });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported.length, 1);
  assert.equal(imported.body.stations[0].name, 'Example Relay');
  assert.equal(imported.body.stations[0].hasApiKey, true);
  assert.equal(imported.body.stations[0].hasStatsToken, true);
  assert.equal(imported.body.stations[0].hasStatsUserId, true);
  assert.equal('apiKey' in imported.body.stations[0], false);

  const repeated = await request(app.port, 'POST', '/api/import/cc-switch', { ids: [exampleRelay.id] });
  assert.equal(repeated.body.imported.length, 0);
  assert.equal(repeated.body.skipped.length, 1);
  assert.equal(repeated.body.stations.length, 1);
});
