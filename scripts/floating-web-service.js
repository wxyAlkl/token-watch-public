// Dedicated Node process: Electron's embedded Node may not provide node:sqlite.
const { buildLaunchConfig } = require('../launcher');
const { createServer } = require('../server');

let service;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  try { await service?.close(); } finally { clearTimeout(deadline); process.exit(0); }
}
process.on('message', (message) => { if (message?.type === 'shutdown') close(); });
process.once('disconnect', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);

try {
  const config = buildLaunchConfig({ mode: 'web' });
  service = createServer({ ...config, pricingEnabled: true, harnessEnabled: true, workBuddyEnabled: true, sqliteEnabled: true });
  service.ready.then((port) => {
    if (!process.connected) return close();
    process.send({ type: 'ready', port });
  }).catch((error) => {
    if (process.connected) process.send({ type: 'error', code: error.code, message: error.code === 'EADDRINUSE' ? '端口已被占用' : 'Web 后台启动失败，请检查 Node.js 版本和数据目录权限' });
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 50);
  });
} catch {
  if (process.connected) process.send({ type: 'error', message: 'Web 后台启动失败，需要支持 node:sqlite 的 Node.js（建议 22.13 或更新版本）' });
  setTimeout(() => process.exit(1), 50);
}
