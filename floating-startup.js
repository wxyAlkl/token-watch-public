const path = require('node:path');

function loginItemOptions(root, env = process.env) {
  return {
    path: path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'),
    args: [path.join(root, 'Start-Token-Watch.vbs')]
  };
}

function startupController(app, root, platform = process.platform, env = process.env) {
  const options = loginItemOptions(root, env);
  return {
    supported: platform === 'win32',
    enabled: () => platform === 'win32' && app.getLoginItemSettings(options).openAtLogin === true,
    setEnabled(value) {
      if (platform !== 'win32') throw new Error('开机启动目前仅支持 Windows');
      app.setLoginItemSettings({ ...options, openAtLogin: value === true });
    }
  };
}

module.exports = { loginItemOptions, startupController };
