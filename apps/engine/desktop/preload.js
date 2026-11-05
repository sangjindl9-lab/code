const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('eum', {
  state: () => ipcRenderer.invoke('state'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  pair: (v) => ipcRenderer.invoke('pair', v),
  settings: (v) => ipcRenderer.invoke('settings', v),
  autostart: (on) => ipcRenderer.invoke('autostart', on),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
});
