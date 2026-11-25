const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');

function connectionConfig(env = process.env) {
  const url = new URL(env.TOKEN_WATCH_WEB_URL || `http://127.0.0.1:${env.TOKEN_WATCH_WEB_PORT || 4318}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('工作台地址必须是无内嵌凭据的 HTTP/HTTPS 地址');
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/';
  if (local) url.hostname = '127.0.0.1';
  return { url: url.href.replace(/\/$/, ''), local, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
}

class FloatingService {
  constructor({ env = process.env, root = __dirname, nodePath = env.TOKEN_WATCH_NODE_EXE || 'node', fetchImpl = fetch, forkImpl = fork, startupTimeout = 20000 } = {}) {
    this.config = connectionConfig(env);
    this.env = { ...env };
    // Match the double-click Web launcher; do not fall back into virtualized AppData.
    if (!this.env.TOKEN_WATCH_WEB_DATA_DIR && process.platform === 'win32') this.env.TOKEN_WATCH_WEB_DATA_DIR = path.join(os.homedir(), 'token-watch-data');
    this.env.TOKEN_WATCH_WEB_PORT = String(this.config.port);
    this.root = root;
    this.nodePath = nodePath;
    this.fetch = fetchImpl;
    this.fork = forkImpl;
    this.startupTimeout = startupTimeout;
    this.child = null;
    this.pending = null;
    this.closed = false;
  }

  async probe() {
    try {
      const response = await this.fetch(this.config.url + '/api/health', { signal: AbortSignal.timeout(1800) });
      const health = await response.json().catch(() => null);
      if (response.ok && health?.ok === true && health.runtime === 'web' && health.sync && typeof health.uptimeSeconds === 'number') return { ok: true };
      return { ok: false, error: '该地址运行的不是 Token Watch Web，请检查工作台地址或端口占用' };
    } catch (error) {
      return { ok: false, absent: error?.cause?.code === 'ECONNREFUSED', error: '无法连接工作台，请检查服务地址和网络' };
    }
  }

  ensure() {
    if (!this.pending) this.pending = this.connect().finally(() => { this.pending = null; });
    return this.pending;
  }

  async connect() {
    if (this.closed) return { ok: false, error: '应用正在退出' };
    const state = await this.probe();
    if (state.ok || !state.absent || !this.config.local || this.env.FLOATING_START_SERVICE === '0') return state;
    if (this.child) return { ok: false, error: '后台暂未响应，请稍后重试' };
    if (this.closed) return { ok: false, error: '应用正在退出' };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
      const child = this.fork(path.join(this.root, 'scripts', 'floating-web-service.js'), [], {
        cwd: this.root, execPath: this.nodePath, execArgv: [], env: this.env,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
      });
      this.child = child;
      const timer = setTimeout(() => {
        finish({ ok: false, error: '后台启动超时，请检查 Node.js 和数据目录' });
        if (child.connected) child.send({ type: 'shutdown' }, () => {});
      }, this.startupTimeout);
      child.on('message', async (message) => {
        if (message?.type === 'ready') finish(await this.probe());
        if (message?.type === 'error') {
          if (message.code === 'EADDRINUSE') finish(await this.probe());
          else finish({ ok: false, error: message.message });
        }
      });
      child.once('error', () => { this.child = null; finish({ ok: false, error: '无法启动 Node.js 后台，请先安装 Node.js 并运行 npm install' }); });
      child.once('exit', () => { if (this.child === child) this.child = null; finish({ ok: false, error: '后台服务已停止，请重新连接' }); });
    });
  }

  async stop() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 6000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ type: 'shutdown' }, () => {});
      else { child.kill(); clearTimeout(timer); resolve(); }
    });
    this.child = null;
  }
}

module.exports = { FloatingService, connectionConfig };
