'use strict';

// Bridge for the pairing window. Same shape as preload.cjs: the renderer stays
// sandboxed with no Node and no network of its own, and everything it can do is
// listed here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pairing', {
  state: () => ipcRenderer.invoke('pair:state'),
  setSharing: (on) => ipcRenderer.invoke('pair:set-sharing', Boolean(on)),
  newCode: () => ipcRenderer.invoke('pair:new-code'),
  revoke: (id) => ipcRenderer.invoke('pair:revoke', String(id)),
  close: () => ipcRenderer.send('pair:close'),
});
