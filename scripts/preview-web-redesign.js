// Disposable fixture server for manual browser QA. Never loads real credentials or CLI files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../server');
const initSqlJs = require('sql.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-watch-redesign-'));
  let remaining = 88.5;
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/spend') { remaining -= 1; res.end('{}'); return; }
    if (req.url.startsWith('/failed')) { res.statusCode = 503; res.end('{"error":"Fixture unavailable"}'); return; }
    res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'fixture-model' }, { id: 'fixture-long-model' }] } : { balance: remaining, balanceLimit: 100, unit: 'USD' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const now = Date.now();
  const calls = Array.from({ length: 125 }, (_, i) => ({
    id: `demo-${i}`, timestamp: new Date(now - i * 3600000).toISOString(), model: i % 2 ? 'fixture-model' : 'fixture-long-model',
    sourceType: i % 3 ? 'local-proxy' : 'codex-cli', sourceApp: i % 3 ? '本地代理' : 'Codex',
    inputTokens: 1000 + i * 10, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 50,
    tokens: 4250 + i * 10, cost: .05, costUnit: 'USD', costSource: 'estimated', statusCode: 200, stream: Boolean(i % 2),
    duration: 2.4, ttft: .3, detail: '隔离测试调用'
  }));
  const station = (id, name, extra = {}) => ({
    id, name, tokenName: '测试令牌', baseUrl: `${upstreamUrl}/v1`, statsUrl: `${upstreamUrl}/usage`, apiKey: 'fixture-key',
    balance: 90, balanceKnown: true, balanceUnit: 'USD', balanceUnitCustomized: true, spendSource: 'remote',
    modelStatus: 'online', status: 'online', usageStatus: 'online', calls: [], ...extra
  });
  fs.writeFileSync(path.join(root, 'stations.json'), JSON.stringify({ settings: { refreshMinutes: 60 }, stations: [
    station('daily', 'Atlas · 日额度', { quotaPolicy: { mode: 'daily', limit: 100 }, calls }),
    station('weekly', 'Nova · 周额度', { quotaPolicy: { mode: 'weekly', limit: 500 }, balanceUnit: 'CNY' }),
    station('error', '需关注 · 用量接口异常', { statsUrl: `${upstreamUrl}/failed`, balance: 2, usageStatus: 'error', usageError: 'Fixture unavailable', quotaPolicy: { mode: 'prepaid', lowBalanceThreshold: 5 } }),
    station('paused', '已暂停 · 长名称与超大 Token 用量验证', { disabled: true, calls: [{ ...calls[0], id: 'large', inputTokens: 123456789012, tokens: 123456792262 }], balance: 123456789.12 }),
    station('unknown', '未配置 · 未知余额', { apiKey: '', balance: null, balanceKnown: false, statsUrl: '', modelStatus: 'unknown', usageStatus: 'unknown', status: 'unknown' })
  ], quotaConsumptionLogs: [{ id: 'quota-demo', stationId: 'daily', stationName: 'Atlas · 日额度', periodStartAt: new Date(now - 120000).toISOString(), periodEndAt: new Date(now - 60000).toISOString(), previousBalance: 95, currentBalance: 90, amount: 5, unit: 'USD' }] }));
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT, sort_index INTEGER)');
  db.run('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?)', ['fixture-import', 'codex', '导入测试站点', JSON.stringify({ auth: {}, config: `[model_providers.custom]\nname = "Fixture"\nbase_url = "${upstreamUrl}/v1"\nexperimental_bearer_token = "import-fixture-key"` }), '{}', 1]);
  const dbPath = path.join(root, 'cc-switch.db');
  fs.writeFileSync(dbPath, Buffer.from(db.export())); db.close();
  const missing = path.join(root, 'no-cli-data');
  const options = { sqliteEnabled: true, dataDir: root, port: 0, ccSwitchDbPath: dbPath,
    cliPaths: { codexSessions: missing, codexConfig: missing, claudeProjects: missing, harnessSessions: missing } };
  const app = createServer({ ...options, runtime: 'web' });
  await app.ready;
  fs.mkdirSync(path.join(root, 'desktop'));
  fs.writeFileSync(path.join(root, 'desktop', 'stations.json'), JSON.stringify({ stations: [], settings: { refreshMinutes: 60 } }));
  const desktop = createServer({ ...options, runtime: 'desktop', dataDir: path.join(root, 'desktop') });
  await desktop.ready;
  const output = path.resolve(__dirname, '../output/web-redesign');
  fs.mkdirSync(output, { recursive: true });
  const info = { url: `http://127.0.0.1:${app.port}`, desktopUrl: `http://127.0.0.1:${desktop.port}`, upstreamUrl, dataDir: root };
  fs.writeFileSync(path.join(output, 'preview.json'), JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info));
  process.on('SIGINT', async () => { await app.close(); await desktop.close(); upstream.close(); process.exit(0); });
})().catch(error => { console.error(error); process.exitCode = 1; });
