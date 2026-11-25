const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EnvHttpProxyAgent, fetch } = require('undici');

const execFileAsync = promisify(execFile);

async function readWindowsProxy() {
  const script = '$p = Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"; @{ enabled = $p.ProxyEnable; server = $p.ProxyServer } | ConvertTo-Json -Compress';
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 5000, maxBuffer: 16384
  });
  return JSON.parse(stdout);
}

function systemProxyUrls(config) {
  if (Number(config?.enabled) !== 1 || typeof config.server !== 'string') return {};
  const proxyUrl = (value) => {
    if (!value) return undefined;
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('系统代理仅支持 HTTP/HTTPS 地址');
    return url.toString();
  };
  const server = config.server.trim();
  if (!server) return {};
  if (!server.includes('=')) return { httpProxy: proxyUrl(server), httpsProxy: proxyUrl(server) };
  const entries = Object.fromEntries(server.split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()];
  }));
  return { httpProxy: proxyUrl(entries.http), httpsProxy: proxyUrl(entries.https) };
}

function createNetwork({ env = process.env, platform = process.platform, readProxy = readWindowsProxy, cacheMs = 30000 } = {}) {
  let settings;
  let checkedAt = 0;
  let pending;
  let agent;
  let signature = '';

  async function proxySettings() {
    const httpProxy = env.http_proxy || env.HTTP_PROXY;
    const httpsProxy = env.https_proxy || env.HTTPS_PROXY || httpProxy;
    if (httpProxy || httpsProxy) return { httpProxy, httpsProxy };
    if (platform !== 'win32') return {};
    if (settings && Date.now() - checkedAt < cacheMs) return settings;
    if (!pending) {
      pending = readProxy().then((config) => {
        settings = systemProxyUrls(config);
        checkedAt = Date.now();
        return settings;
      }).catch(() => {
        // A failed system-proxy read must not silently switch an established proxy to direct.
        if (settings) return settings;
        throw new Error('无法读取 Windows 系统代理设置，请检查系统代理或配置 HTTPS_PROXY');
      }).finally(() => { pending = undefined; });
    }
    return pending;
  }

  async function dispatcher(url) {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host === '[::1]' || host.startsWith('127.')) return undefined;
    const config = await proxySettings();
    const noProxy = env.no_proxy || env.NO_PROXY || '';
    const key = JSON.stringify({ ...config, noProxy });
    if (key !== signature) {
      const previous = agent;
      agent = config.httpProxy || config.httpsProxy ? new EnvHttpProxyAgent({ ...config, noProxy }) : undefined;
      signature = key;
      if (previous) void previous.close().catch(() => {});
    }
    return agent;
  }

  return { dispatcher, close: async () => { if (agent) await agent.close(); } };
}

const network = createNetwork();
module.exports = { createNetwork, systemProxyUrls, dispatcher: network.dispatcher, fetch };
