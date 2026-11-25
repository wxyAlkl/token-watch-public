const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, shell } = require('electron');
const { createServer } = require('./server');

let window;
let localServer;

async function createWindow() {
  const dataDir = process.env.TOKEN_WATCH_DATA_DIR || app.getPath('userData');
  const userStateFile = path.join(dataDir, 'stations.json');
  if (fs.existsSync(userStateFile)) {
    try {
      const oldState = JSON.parse(fs.readFileSync(userStateFile, 'utf8'));
      if (oldState.stations?.some((station) => station.metricsSource === '演示数据')) {
        fs.copyFileSync(path.join(__dirname, 'data', 'stations.json'), userStateFile);
      }
    } catch {
      fs.rmSync(userStateFile, { force: true });
    }
  }
  localServer = createServer({ dataDir, port: 0, pricingEnabled: true, harnessEnabled: true, workBuddyEnabled: true, sqliteEnabled: true });
  const port = await localServer.ready;
  window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#f5f7fa',
    title: 'Token Watch',
    icon: path.join(__dirname, 'public', 'icons', 'token-watch.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  await window.loadURL(`http://127.0.0.1:${port}/`);
  window.on('closed', () => { window = null; });
}

app.whenReady().then(createWindow).catch((error) => {
  console.error('Token Watch failed to start:', error);
  app.quit();
});

app.on('window-all-closed', async () => {
  if (localServer) await localServer.close().catch(() => {});
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
