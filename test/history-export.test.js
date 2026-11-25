const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');
const { buildHistoryExport } = require('../history-export');
const { csv } = require('../public/history-export-format');

for (const sqliteEnabled of [false, true]) {
  test(`history export returns complete filtered records and reconciled station totals (${sqliteEnabled ? 'SQLite' : 'JSON'})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-export-'));
    const timestamp = new Date().toISOString();
    const calls = Array.from({ length: 505 }, (_, index) => ({ id: `call-${index}`, timestamp, model: 'fixture',
      inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 }));
    const quota = Array.from({ length: 505 }, (_, index) => ({ id: `quota-${index}`, stationId: 'a', stationName: 'Old name',
      periodStartAt: timestamp, periodEndAt: timestamp, previousBalance: 10, currentBalance: 9, amount: 1, unit: 'USD', accountKey: 'secret-account' }));
    const corrections = Array.from({ length: 505 }, (_, index) => ({ id: `correction-${index}`, stationId: 'a', stationName: 'Old name',
      createdAt: timestamp, source: 'manual', unit: 'USD', previousAmount: 10, targetAmount: 9, amount: -1,
      previousTokens: 20, targetTokens: 19, tokens: -1 }));
    fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: {}, stations: [
      { id: 'a', name: '=SUM(1,2)', baseUrl: 'https://example.invalid', apiKey: 'secret-api', statsToken: 'secret-stats', balanceUnit: 'USD', calls: [
        ...calls, { id: 'health', model: 'GET /models', timestamp, tokens: 9999 },
        { id: 'old', model: 'legacy', timestamp: '2001-01-01T00:00:00Z', tokens: 7 }
      ] },
      { id: 'b', name: '人民币暂停站', disabled: true, balanceUnit: 'CNY', calls: [] },
      { id: 'empty', name: '空站点', calls: [] }
    ], quotaConsumptionLogs: [...quota, { id: 'cny', stationId: 'b', stationName: '人民币暂停站', periodStartAt: timestamp, periodEndAt: timestamp, previousBalance: 10, currentBalance: 1.75, amount: 8.25, unit: 'CNY' }],
    historyCorrections: corrections, cliCalls: [{ id: 'cli', timestamp, model: 'cli', sourceType: 'codex-cli', tokens: 4 }] }));
    const app = createServer({ dataDir: root, port: 0, runtime: 'web', sqliteEnabled });
    await app.ready;
    t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const get = async query => {
      const response = await fetch(`http://127.0.0.1:${app.port}/api/history/export?${query}`);
      return { status: response.status, data: await response.json() };
    };
    for (const kind of ['tokens', 'quota', 'corrections']) {
      const { status, data } = await get(`kind=${kind}&range=7d&stationId=a&pageSize=1&page=2`);
      assert.equal(status, 200); assert.equal(data.count, 505); assert.equal(data.rows.length, 505);
      assert.ok(data.rows.every(row => row.stationId === 'a' && row.stationName === '=SUM(1,2)'));
      assert.doesNotMatch(JSON.stringify(data), /secret-api|secret-stats|secret-account|accountKey|apiKey|baseUrl/);
    }
    const summary = (await get('kind=summary&range=all')).data;
    const a = summary.rows.find(row => row.stationId === 'a');
    assert.equal(a.measuredUSD, 505); assert.equal(a.correctionUSD, -505); assert.equal(a.totalUSD, 0);
    assert.equal(a.measuredTokens, 505 * 16 + 7); assert.equal(a.correctionTokens, -505);
    assert.equal(a.totalTokens, 505 * 15 + 7); assert.equal(a.inputTokens, 5050 + 7);
    assert.equal(a.callCount, 506);
    const b = summary.rows.find(row => row.stationId === 'b');
    assert.equal(b.monitoring, '已暂停'); assert.equal(b.totalCNY, 8.25); assert.equal(b.totalUSD, 0);
    assert.equal(summary.rows.find(row => row.stationId === null).totalTokens, 4);
    assert.equal(summary.rows.find(row => row.stationId === 'empty').totalTokens, 0);
    const live = await (await fetch(`http://127.0.0.1:${app.port}/api/stations`)).json();
    assert.equal(a.totalTokens, live.stations.find(station => station.id === 'a').tokens);
    assert.equal(a.totalUSD, live.stations.find(station => station.id === 'a').historyQuotaByUnit.USD);
    const recent = (await get('kind=summary&range=24h&stationId=a')).data;
    assert.equal(recent.rows.length, 1); assert.equal(recent.rows[0].totalTokens, a.totalTokens - 7);
    assert.equal((await get('kind=quota&stationId=empty')).data.count, 0);
    assert.equal((await get('kind=invalid')).status, 400);
    assert.equal((await get('range=invalid')).status, 400);
    assert.equal((await get('stationId=missing')).status, 400);
  });
}

test('history CSV supports Unicode, quoted multiline labels and safe spreadsheet cells', () => {
  const output = csv({ columns: [{ key: 'name', label: '中转站' }, { key: 'amount', label: '校正差额' }], rows: [
    { name: '站点,"甲"\n第二行', amount: -1.125 }, { name: '\t=HYPERLINK("example")', amount: 0 }
  ] });
  assert.ok(output.startsWith('\ufeff"中转站","校正差额"\r\n'));
  assert.ok(output.includes('"站点,""甲""\n第二行","-1.125"'));
  assert.ok(output.includes('"\'\t=HYPERLINK(""example"")"'));
});

test('history export keeps missing timestamps unknown and excludes manual calls', () => {
  const state = { stations: [{ id: 'a', name: 'A', calls: [{ id: 'unknown', tokens: 8 },
    { id: 'manual', sourceType: 'manual-adjustment', tokens: 1000 }] }] };
  const data = buildHistoryExport(state, new URL('http://local/?kind=tokens'));
  assert.equal(data.count, 1); assert.equal(data.rows[0].timestamp, null);
  assert.equal(data.rows[0].tokens, 8); assert.equal(data.rows[0].breakdownEstimated, true);
  assert.equal(buildHistoryExport(state, new URL('http://local/?kind=tokens&range=24h')).count, 0);
});
