const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
env.TOKEN_WATCH_NODE_EXE = process.execPath;

const main = path.join(__dirname, '..', 'floating-main.js');
const background = process.argv.includes('--background');
const args = [main, ...process.argv.slice(2).filter((arg) => arg !== '--background')];
let log;
if (background) {
  const logDir = path.join(os.homedir(), 'token-watch-floating');
  fs.mkdirSync(logDir, { recursive: true });
  log = fs.openSync(path.join(logDir, 'launcher.log'), 'a');
}
const child = spawn(electron, args, { stdio: background ? ['ignore', log, log] : 'inherit', env, windowsHide: true, detached: background });
child.on('error', (error) => {
  console.error('悬浮球启动失败：' + error.message);
  process.exitCode = 1;
});
if (background) { fs.closeSync(log); child.unref(); }
else child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 0;
});
