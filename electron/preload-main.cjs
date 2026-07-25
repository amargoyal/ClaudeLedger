'use strict';

// The dashboard renderer talks to the local HTTP API for everything it needs, so
// this bridge exists for the one thing HTTP can't do: move native surfaces. The
// theme has to reach the window background, the popover and the pairing window,
// none of which this document can style.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ledgerShell', {
  /** @param {'system'|'light'|'dark'} theme */
  setTheme: (theme) => ipcRenderer.send('ledger:set-theme', theme),
});
