const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('./server');

const ROOT = __dirname;

function parseArgs(args = []) {
  let mode = 'desktop';
  let openBrowser = false;
  for (const arg of args) {
    if (arg === '--web') mode = 'web';
    else if (arg === '--test') mode = 'test';
    else if (arg === '--open') openBrowser = true;
    else if (arg === '--help' || arg === '-h') mode = 'help';
    else if (arg.trim()) throw new Error(`未知参数：${arg}`);
  }
  return openBrowser ? { mode, openBrowser } : { mode };
}

function buildLaunchConfig({ mode = 'desktop', platform = process.platform, tempDir = os.tmpdir(), homeDir = os.homedir(), env = process.env } = {}) {
  if (mode === 'test') {
    return {
      mode,
      desktop: true,
      dataDir: path.join(tempDir, 'token-watch-test')
    };
  }
  if (mode === 'web') {
    const webDataDir = env.TOKEN_WATCH_WEB_DATA_DIR || (platform === 'win32'
      ? path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'token-watch-web')
      : path.join(homeDir, '.token-watch-web'));
    const port = Number(env.TOKEN_WATCH_WEB_PORT || 4318);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Web 端口必须是 0 至 65535 的整数');
    return { mode, desktop: false, dataDir: webDataDir, runtime: 'web', port };
  }
  if (mode === 'desktop') return { mode, desktop: true };
  if (mode === 'help') return { mode, desktop: false };
  throw new Error(`未知运行模式：${mode}`);
}

function printHelp() {
  console.log([
    'Token Watch',
    '',
    'npm run app              正常使用：打开桌面端并使用正式数据',
    'npm run app -- --test    测试模式：打开桌面端并使用独立测试数据',
    'npm run web              独立 Web 工作台：使用独立配置和日志',
    'npm run web -- --open    启动 Web 工作台并打开浏览器',
    'npm run app -- --web     Web 工作台兼容入口',
    ''
  ].join('\n'));
}

function startWeb(config) {
  const server = createServer({ dataDir: config.dataDir, runtime: config.runtime, port: config.port, pricingEnabled: true, harnessEnabled: true, workBuddyEnabled: true, sqliteEnabled: true });
  const close = async () => { await server.close().catch(() => {}); };
  process.once('SIGINT', () => close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => close().finally(() => process.exit(0)));
  return server.ready.then((port) => {
    console.log(`Token Watch Web 地址：http://127.0.0.1:${port}`);
    console.log(`Web 数据目录：${config.dataDir}`);
    console.log('按 Ctrl+C 停止服务');
    if (config.openBrowser) {
      const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const browser = spawn(command, [`http://127.0.0.1:${port}`], { stdio: 'ignore', detached: true, windowsHide: true });
      browser.on('error', () => console.warn('无法自动打开浏览器，请打开上方地址。'));
      browser.unref();
    }
    return server;
  });
}

function startDesktop(config) {
  const electronBinary = require('electron');
  const env = { ...process.env };
  if (config.dataDir) env.TOKEN_WATCH_DATA_DIR = config.dataDir;
  const child = spawn(electronBinary, [ROOT], { cwd: ROOT, env, stdio: 'inherit' });
  child.on('error', (error) => { console.error(`Token Watch 启动失败：${error.message}`); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 0;
  });
  return child;
}

async function main(args = process.argv.slice(2)) {
  const parsed = parseArgs(args);
  const config = { ...buildLaunchConfig(parsed), openBrowser: parsed.openBrowser };
  if (config.mode === 'help') {
    printHelp();
    return null;
  }
  return config.desktop ? startDesktop(config) : startWeb(config);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Token Watch 启动失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, buildLaunchConfig, main };
