'use strict';

// Minimal bridge for the menu bar popover. The popover renderer stays sandboxed
// with no Node and no network of its own; everything goes through these calls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ledger', {
  getAccount: () => ipcRenderer.invoke('ledger:account'),
  refresh: () => ipcRenderer.invoke('ledger:refresh'),
  openDashboard: () => ipcRenderer.send('ledger:open-dashboard'),
  quit: () => ipcRenderer.send('ledger:quit'),
  close: () => ipcRenderer.send('ledger:close'),
  resize: (height) => ipcRenderer.send('ledger:resize', height),
  /** Fired each time the popover is shown, so it can re-read fresh values. */
  onShow: (fn) => ipcRenderer.on('ledger:shown', () => fn()),
});
