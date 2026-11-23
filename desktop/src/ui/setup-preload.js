const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  createAdmin: (data) => ipcRenderer.invoke('setup:create-admin', data),
});
