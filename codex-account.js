const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
let desktopBinary;

async function codexBinary() {
  if (process.platform !== 'win32') return 'codex';
  if (desktopBinary && fs.existsSync(desktopBinary)) return desktopBinary;
  // A desktop shortcut can have a different PATH from an interactive shell.
  try {
    const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await runFile(shell, ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); (Get-AppxPackage -Name OpenAI.Codex).InstallLocation'],
    { windowsHide: true, timeout: 5000 });
    if (path.isAbsolute(stdout.trim())) {
      const candidate = path.join(stdout.trim(), 'app', 'resources', 'codex.exe');
      if (fs.existsSync(candidate)) return (desktopBinary = candidate);
    }
  } catch { /* A standalone CLI can also provide the account protocol. */ }
  return 'codex.exe';
}

function openClient(executable) {
  const child = spawn(executable, ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  let failure;
  function disconnect(error) {
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
  }
  child.on('error', error => disconnect(new Error(error.code === 'ENOENT' ? '未找到 Codex 客户端' : '无法启动 Codex 客户端')));
  child.stdin.on('error', () => disconnect(new Error('Codex 客户端连接中断')));
  child.once('close', () => disconnect(new Error('Codex 客户端已退出')));
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry || message.method) return;
    if (message.error) entry.reject(new Error('Codex 接口查询失败'));
    else entry.resolve(message.result);
  });
  function send(message) { child.stdin.write(JSON.stringify(message) + '\n'); }
  function read(method, params = {}) {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    let timer;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      timer = setTimeout(() => reject(new Error('Codex 查询超时')), 10000);
      send({ id, method, params });
    }).finally(() => { clearTimeout(timer); pending.delete(id); });
  }
  function close() {
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timer = setTimeout(() => child.kill(), 1000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
  return { read, send, close };
}

function quotaWindows(result) {
  const buckets = Object.values(result.rateLimitsByLimitId || {});
  if (!buckets.length && result.rateLimits) buckets.push(result.rateLimits);
  const windows = [];
  for (const bucket of buckets) {
    for (const kind of ['primary', 'secondary']) {
      const item = bucket?.[kind];
      if (!item) continue;
      const percent = item.usedPercent;
      windows.push({
        bucket: bucket.limitName || bucket.limitId || 'codex', kind,
        minutes: item.windowDurationMins ?? null,
        remaining: Number.isFinite(percent) ? Math.max(0, Math.min(100, 100 - percent)) : null,
        resetsAt: Number.isFinite(item.resetsAt) ? item.resetsAt : null
      });
    }
  }
  return windows;
}

async function readAccount(client) {
  try {
    await client.read('initialize', { clientInfo: { name: 'token_watch', title: 'Token Watch', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    client.send({ method: 'initialized' });
    const { account } = await client.read('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') return { status: 'login-required' };
    const [quota, usage] = await Promise.allSettled([client.read('account/rateLimits/read'), client.read('account/usage/read')]);
    const data = usage.status === 'fulfilled' ? usage.value : null;
    return {
      status: 'connected', plan: account.planType ?? null,
      windows: quota.status === 'fulfilled' ? quotaWindows(quota.value) : null,
      usage: data && {
        total: data.summary?.lifetimeTokens ?? null,
        days: (data.dailyUsageBuckets || []).map(({ startDate, tokens }) => ({ date: startDate, tokens }))
          .sort((a, b) => b.date.localeCompare(a.date))
      }
    };
  } finally { client.close(); }
}

function createAccountMonitor(probe = async () => readAccount(openClient(await codexBinary()))) {
  let pending;
  let cached;
  return function snapshot(force = false) {
    if (pending) return pending;
    if (!force && cached && Date.now() - cached.checkedAt < 45000) return Promise.resolve(cached);
    pending = probe().then(result => ({ ...result, checkedAt: Date.now() }))
      .then(result => (cached = result)).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createAccountMonitor, readAccount };
