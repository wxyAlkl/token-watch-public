const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../server');

for (const sqliteEnabled of [false, true]) {
  test(`unknown sources stay alerted until assigned; attribution persists without duplication (${sqliteEnabled ? 'SQLite' : 'JSON'})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-attribution-'));
    const sessions = path.join(root, 'claude'); fs.mkdirSync(sessions);
    const now = new Date().toISOString();
    const source = 'Claude Code · fixture';
    const calls = Array.from({ length: 125 }, (_, i) => ({ id: `legacy-${i}`, importKey: `old-${i}`, source,
      sourceType: 'claude-cli', timestamp: now, model: 'fixture', inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 }));
    fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: {}, stations: [
      { id: 'a', name: 'A', baseUrl: 'https://example.invalid/v1', calls: [{ id: 'bound-old', source: 'A 的旧名称', timestamp: now, model: 'fixture', tokens: 5 }] },
      { id: 'b', name: 'B', baseUrl: 'https://example.invalid/b', calls: [] }
    ], cliCalls: [...calls, { id: 'mystery', importKey: 'mystery-key', source: '幽灵来源', timestamp: now, model: 'fixture', tokens: 7 },
      { id: 'known-url', source: '新中转', timestamp: now, model: 'fixture', tokens: 9 }],
    quotaConsumptionLogs: [{ id: 'quota', stationId: 'a', stationName: 'A', periodStartAt: now, periodEndAt: now, previousBalance: 20, currentBalance: 18, amount: 2, unit: 'USD' }],
    historyCorrections: [{ id: 'correction', stationId: 'a', stationName: 'A', createdAt: now, source: 'manual', unit: 'USD',
      previousAmount: 2, targetAmount: 3, amount: 1, previousTokens: 5, targetTokens: 6, tokens: 1 }] }));
    let app;
    const start = async () => { app = createServer({ runtime: 'web', dataDir: root, port: 0, sqliteEnabled,
      cliPaths: { claudeProjects: sessions, codexSessions: path.join(root, 'missing'), codexConfig: path.join(root, 'missing.toml') } }); await app.ready; };
    await start();
    t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const api = async (route, method = 'GET', body, status = 200) => {
      const response = await fetch(`http://127.0.0.1:${app.port}${route}`, { method,
        headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
    };
    const before = await api('/api/stations');
    assert.equal(before.sourceAttribution.unresolvedCount, 4);
    assert.equal(before.sourceAttribution.recordCount, 128);
    await api('/api/source-attribution', 'POST', { source, stationId: 'missing' }, 400);
    assert.equal((await api('/api/source-attribution')).unresolvedCount, 4);
    let result = await api('/api/source-attribution', 'POST', { source, stationId: 'a' });
    assert.equal(result.movedCount, 125); assert.equal(result.sourceAttribution.unresolvedCount, 3);
    assert.equal(result.aggregate.totalTokens, before.aggregate.totalTokens);
    assert.deepEqual(result.aggregate.totalSpendByUnit, before.aggregate.totalSpendByUnit);
    let logs = await api('/api/logs?range=all&pageSize=all');
    assert.equal(logs.logs.length, 128);
    assert.equal(logs.logs.filter(log => log.stationId === 'a' && log.originalSource === source).length, 125);
    assert.ok(!logs.sources.includes(source));
    await app.close(); await start();
    assert.equal((await api('/api/source-attribution')).unresolvedCount, 3);
    // Reassign an existing rule: same import keys and record IDs move atomically.
    result = await api('/api/source-attribution', 'POST', { source, stationId: 'b' });
    assert.equal(result.movedCount, 125);
    const mapped = await api('/api/logs?range=all&pageSize=all&source=B');
    assert.equal(mapped.logs.length, 125); assert.ok(mapped.logs.every(log => log.stationId === 'b'));
    assert.deepEqual(mapped.logs.map(log => log.id).sort(), calls.map(call => call.id).sort());
    // Later CLI sync obeys the saved mapping, including after a restart.
    const file = path.join(sessions, 'fixture.jsonl');
    const newCall = { type: 'assistant', uuid: 'new-call', timestamp: now, message: { model: 'fixture', usage: { input_tokens: 8, output_tokens: 2 } } };
    fs.writeFileSync(file, JSON.stringify(newCall) + '\n');
    result = await api('/api/logs/sync-cli', 'POST', {});
    assert.equal(result.imported.length, 1); assert.equal(result.unmatched.length, 0);
    assert.equal(result.stations.find(station => station.id === 'b').tokenBreakdown.total, 2010);
    result = await api('/api/logs/sync-cli', 'POST', {});
    assert.equal(result.imported.length, 0); assert.equal(result.aggregate.totalTokens, before.aggregate.totalTokens + 10);
    result = await api('/api/source-attribution', 'POST', { source: 'A 的旧名称', stationId: 'a' });
    assert.equal(result.sourceAttribution.unresolvedCount, 2);
    // Creating a same-name destination still resolves the source before adding it to the list.
    result = await api('/api/source-attribution', 'POST', { source: '幽灵来源', action: 'create', ghost: true, name: '幽灵来源' });
    const ghost = result.stations.find(station => station.id === result.targetStationId);
    assert.equal(ghost.ghost, true); assert.equal(ghost.disabled, true); assert.equal(ghost.baseUrl, ''); assert.equal(ghost.tokens, 7);
    assert.equal(result.sourceAttribution.unresolvedCount, 1);
    const countBeforeInvalid = result.stations.length;
    await api('/api/source-attribution', 'POST', { source: '不存在', action: 'create', ghost: true, name: '不会留下的站点' }, 400);
    assert.equal((await api('/api/stations')).stations.length, countBeforeInvalid);
    result = await api('/api/source-attribution', 'POST', { source: '新中转', action: 'create', name: '新中转', baseUrl: 'https://example.invalid/new' });
    assert.equal(result.sourceAttribution.unresolvedCount, 0);
    assert.equal(result.stations.find(station => station.id === result.targetStationId).ghost, false);
    await api('/api/stations/b', 'PATCH', { name: 'B 新名称' });
    assert.equal((await api('/api/source-attribution')).unresolvedCount, 0);
    logs = await api('/api/logs?range=all&pageSize=all');
    assert.ok(!logs.sources.includes('B')); assert.ok(logs.sources.includes('B 新名称'));
    const bundle = await api('/api/history/export?kind=all&range=all');
    assert.equal(bundle.datasets.tokens.rows.length, 129); assert.equal(bundle.datasets.quota.count, 1);
    assert.equal(bundle.datasets.corrections.count, 1);
    assert.equal(bundle.datasets.summary.rows.reduce((sum, row) => sum + row.totalTokens, 0), before.aggregate.totalTokens + 10);
    assert.equal(bundle.datasets.summary.rows.find(row => row.stationId === ghost.id).monitoring, '幽灵（仅记录）');
    await app.close(); await start();
    assert.equal((await api('/api/source-attribution')).unresolvedCount, 0);
    assert.equal((await api('/api/stations')).stations.find(station => station.id === ghost.id).ghost, true);
    // Deleting a target drops its rule; a future source raises a new alert.
    await api('/api/stations/b', 'DELETE');
    fs.appendFileSync(file, JSON.stringify({ ...newCall, uuid: 'after-delete' }) + '\n');
    result = await api('/api/logs/sync-cli', 'POST', {});
    assert.equal(result.sourceAttribution.unresolvedCount, 1);
    assert.equal(result.sourceAttribution.unresolved[0].source, source);
  });
}

test('ghost stations reject monitoring and proxy access until explicitly converted with a URL', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-ghost-'));
  let requests = 0;
  const upstream = http.createServer((req, res) => { requests++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [], balance: 10 })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ stations: [] }));
  const app = createServer({ dataDir: root, runtime: 'web', port: 0, sqliteEnabled: true }); await app.ready;
  t.after(async () => { await app.close(); await new Promise(resolve => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const api = async (route, method, body, status = 200) => {
    const response = await fetch(`http://127.0.0.1:${app.port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  let result = await api('/api/stations', 'POST', { name: 'Ghost', ghost: true, baseUrl: '', apiKey: 'fixture', statsUrl: origin + '/balance' }, 201);
  const id = result.stations[0].id;
  await api(`/api/stations/${id}/refresh`, 'POST', {});
  await api('/api/stations/refresh-all', 'POST', {});
  await api('/api/usage/test', 'POST', { stationId: id }, 400);
  await api(`/api/stations/${id}/proxy/chat/completions`, 'POST', {}, 400);
  await api(`/api/stations/${id}`, 'PATCH', { disabled: false }, 400);
  await api(`/api/stations/${id}`, 'PATCH', { ghost: false }, 400);
  assert.equal(requests, 0);
  result = await api(`/api/stations/${id}`, 'PATCH', { ghost: false, baseUrl: origin + '/v1' });
  assert.equal(result.stations[0].disabled, false);
  await api(`/api/stations/${id}/refresh`, 'POST', {});
  assert.ok(requests > 0);
});
