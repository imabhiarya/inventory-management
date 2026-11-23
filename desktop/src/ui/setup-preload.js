const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  createAdmin: (data) => ipcRenderer.invoke('setup:create-admin', data),
  chooseBackup: () => ipcRenderer.invoke('setup:choose-backup'),
  restoreBackup: () => ipcRenderer.invoke('setup:restore-backup'),
});
