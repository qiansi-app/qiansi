const { contextBridge, ipcRenderer } = require('electron');

const bridge = {
  setAutostart: (enabled) => ipcRenderer.invoke('autostart:set', enabled),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
};

contextBridge.exposeInMainWorld('qiansi', bridge);
// A renderer bundle cached from the previous name still looks this up.
contextBridge.exposeInMainWorld('agentweave', bridge);
