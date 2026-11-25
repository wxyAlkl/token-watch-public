const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('floating', {
  getSummary: () => ipcRenderer.invoke('floating:get-summary'),
  setChannel: mode => ipcRenderer.invoke('floating:set-channel', mode),
  getTuckState: () => ipcRenderer.invoke('floating:get-tuck-state'),
  getIslandState: () => ipcRenderer.invoke('floating:get-island-state'),
  setIslandReducedMotion: (enabled) => ipcRenderer.invoke('floating:set-island-reduced-motion', enabled),
  hover: () => ipcRenderer.invoke('floating:hover'),
  leave: () => ipcRenderer.invoke('floating:leave'),
  togglePanel: () => ipcRenderer.invoke('floating:toggle-panel'),
  hidePanel: () => ipcRenderer.invoke('floating:hide-panel'),
  hideBall: () => ipcRenderer.invoke('floating:hide-ball'),
  openDashboard: () => ipcRenderer.invoke('floating:open-dashboard'),
  refresh: () => ipcRenderer.invoke('floating:refresh'),
  quit: () => ipcRenderer.invoke('floating:quit'),
  showMenu: () => ipcRenderer.invoke('floating:menu'),
  dragStart: () => ipcRenderer.invoke('floating:drag-start'),
  dragEnd: () => ipcRenderer.invoke('floating:drag-end'),
  onSummary: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('floating:summary', listener);
    return () => ipcRenderer.removeListener('floating:summary', listener);
  },
  onTuckState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('floating:tuck-state', listener);
    return () => ipcRenderer.removeListener('floating:tuck-state', listener);
  },
  onIslandState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('floating:island-state', listener);
    return () => ipcRenderer.removeListener('floating:island-state', listener);
  }
});
