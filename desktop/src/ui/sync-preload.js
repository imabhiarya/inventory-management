const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syncApi', {
  get: () => ipcRenderer.invoke('sync:get'),
  save: (data) => ipcRenderer.invoke('sync:save', data),
  disable: () => ipcRenderer.invoke('sync:disable'),
  now: () => ipcRenderer.invoke('sync:now'),
  onStatus: (fn) => ipcRenderer.on('sync:status', (_e, st) => fn(st)),
});
