'use strict';

// CommonJS on purpose: it can dynamically import the ESM modules in src/ without
// depending on Electron's ESM entry-point support.
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const isDev = !app.isPackaged;

/**
 * Give the dev build its own userData directory.
 *
 * Both builds otherwise share one, which means they share the single-instance
 * lock: launching `npm start` while the installed app is running silently quits
 * the new process and just focuses the old window. That cost real debugging time —
 * changes appeared to have no effect because the old build was still on screen.
 * Must run before app ready.
 */
if (isDev) app.setPath('userData', `${app.getPath('userData')}-dev`);

/**
 * How often the menu bar re-reads the account. This must be shorter than the
 * usage cache TTL in src/anthropic.js, not equal to it: when both were 5 minutes,
 * a tick would often find the cache aged 4:59, treat it as fresh, and skip the
 * refetch — so the indicator actually updated every ~10 minutes.
 *
 * Polling more often costs no extra requests. The TTL decides when a network call
 * happens (still at most one per 5 minutes); this only decides how soon after the
 * cache expires the title catches up.
 */
const TRAY_POLL_MS = 60_000;

const PANEL_WIDTH = 330;
const PANEL_MIN_HEIGHT = 160;
const PANEL_MAX_HEIGHT = 720;

const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {
    /* first run */
  }
  return null;
}

function saveWindowState(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {
    /* non-fatal */
  }
}

let mainWindow = null;
let panel = null;
let tray = null;
let serverInfo = null;
let anthropic = null;
let lastAccount = null;

// Only one instance — a second launch focuses the existing window instead of
// starting a second HTTP listener and a second menu bar item.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openWindow());
}

/** Import an ESM module from src/ by path, working inside app.asar too. */
function importLocal(relative) {
  return import(pathToFileURL(path.join(__dirname, '..', relative)).href);
}

// ------------------------------------------------------------------ main window

function createWindow(port) {
  // Restore the last size and position; a dashboard you resize should stay that
  // way across launches.
  const saved = readWindowState();
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1320,
    height: saved?.height ?? 900,
    ...(Number.isFinite(saved?.x) && Number.isFinite(saved?.y) ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#F6F1E8',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      // The dashboard renderer only talks to the local HTTP API — no Node needed.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (saved?.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());

  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) {
    mainWindow.on(ev, () => saveWindowState(mainWindow));
  }
  mainWindow.loadURL(`http://127.0.0.1:${port}/?shell=electron`);

  const isLocal = (url) => url.startsWith(`http://127.0.0.1:${port}`);

  // Anything that isn't the local dashboard opens in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

/**
 * Show the dashboard, creating the window if it was closed. Closing the window
 * doesn't quit on macOS, so the menu bar item stays useful either way.
 * @param {string} [hash] section to scroll to, e.g. 'limits'
 */
function openWindow(hash) {
  if (!serverInfo) return;
  hidePanel();
  if (!mainWindow) createWindow(serverInfo.port);

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();

  if (hash) {
    const target = `http://127.0.0.1:${serverInfo.port}/?shell=electron#${hash}`;
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', () => mainWindow.loadURL(target));
    } else {
      mainWindow.loadURL(target);
    }
  }
}

// ---------------------------------------------------------------- popover panel

function createPanel(port) {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    // Deliberately NOT transparent + vibrancy. A translucent popover over an
    // arbitrary desktop has no contrast guarantee — text was genuinely hard to
    // read against busy backdrops. A solid surface that follows the system theme
    // is legible every time.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#26231F' : '#FFFDF8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  panel.loadURL(`http://127.0.0.1:${port}/panel.html`);
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-away dismissal, the standard behaviour for a menu bar popover.
  panel.on('blur', () => hidePanel());
  panel.on('closed', () => {
    panel = null;
  });

  // Keep the native surface in step with the CSS, which follows prefers-color-scheme.
  nativeTheme.on('updated', () => {
    if (panel && !panel.isDestroyed()) {
      panel.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#26231F' : '#FFFDF8');
    }
  });

  return panel;
}

/** Centre the popover under the tray icon, kept inside the display's work area. */
function positionPanel() {
  if (!panel || !tray) return;
  const trayBounds = tray.getBounds();
  const { width, height } = panel.getBounds();
  const work = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }).workArea;

  const x = Math.round(
    Math.min(
      Math.max(work.x + 8, trayBounds.x + trayBounds.width / 2 - width / 2),
      work.x + work.width - width - 8,
    ),
  );
  const y = Math.round(Math.min(trayBounds.y + trayBounds.height + 4, work.y + work.height - height - 8));
  panel.setPosition(x, y, false);
}

function showPanel() {
  if (!panel || !serverInfo) return;
  positionPanel();
  panel.show();
  panel.focus();
  // Values may have moved since the popover was last open.
  panel.webContents.send('ledger:shown');
}

let lastPanelHideAt = 0;

function hidePanel() {
  if (panel && panel.isVisible()) {
    panel.hide();
    lastPanelHideAt = Date.now();
  }
}

/**
 * Clicking the tray icon opens the popover, and clicking it again closes it.
 *
 * The second half of that needs the guard below: focusing the tray blurs the
 * popover, and the blur handler hides it a beat *before* this click handler runs.
 * Without the guard the click always saw an already-hidden window and reopened it,
 * so the icon could never dismiss the popover.
 */
function togglePanel() {
  if (!panel) return;
  if (panel.isVisible()) {
    hidePanel();
    return;
  }
  if (Date.now() - lastPanelHideAt < 300) return;
  showPanel();
}

// --------------------------------------------------------------------- menu bar

function planLabel(account) {
  const a = account?.account;
  if (a?.hasMax) return 'Claude Max';
  if (a?.hasPro) return 'Claude Pro';
  return account?.subscriptionType ? `Claude ${account.subscriptionType}` : 'Claude';
}

/**
 * The menu bar title is the session window — the limit that actually interrupts
 * work. Everything else lives in the popover.
 */
function trayTitle(account) {
  if (account?.status !== 'connected') return ' —';
  const session = account.limits?.windows?.find(
    (w) => w.group === 'session' || w.kind === 'session' || w.key === 'five_hour',
  );
  if (!session || session.utilization == null) return '';
  return ` ${session.utilization.toFixed(0)}%`;
}

/** Right-click menu — the popover is the primary surface, this is the shortcut. */
function trayContextMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => openWindow() },
    { label: 'Refresh Now', click: () => refreshTray({ force: true }) },
    { type: 'separator' },
    { role: 'quit', label: 'Quit Claude Ledger' },
  ]);
}

async function refreshTray({ force = false } = {}) {
  if (!anthropic) return null;
  if (force) anthropic.invalidateAccountCache();

  try {
    lastAccount = await anthropic.fetchAccount();
  } catch (err) {
    lastAccount = { status: 'error', error: err?.message ?? 'Unknown error' };
  }

  if (tray && !tray.isDestroyed()) {
    tray.setTitle(trayTitle(lastAccount));
    tray.setToolTip(
      lastAccount?.status === 'connected'
        ? `Claude Ledger — ${planLabel(lastAccount)}`
        : 'Claude Ledger — not connected',
    );
  }
  return lastAccount;
}

async function createTray() {
  const mark = await importLocal('src/mark.js');
  // Built in memory from the same glyph as the app icon — no separate asset files
  // to keep in sync. Template images are recoloured by macOS for light/dark menu
  // bars, so only the alpha channel matters.
  // 18pt rather than the conventional 16pt: the menu bar allows it and the mark
  // is legible at that size where 16 read as cramped.
  const image = nativeImage.createFromBuffer(mark.renderTemplateMark(18), { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: mark.renderTemplateMark(36) });
  image.setTemplateImage(true);

  tray = new Tray(image);
  tray.setIgnoreDoubleClickEvents(true);
  // No setContextMenu: that would make a left click open a menu instead of the
  // popover. Right-click gets the menu explicitly.
  tray.on('click', () => togglePanel());
  tray.on('right-click', () => tray.popUpContextMenu(trayContextMenu()));

  await refreshTray();
  setInterval(() => refreshTray(), TRAY_POLL_MS);

  // Development affordance: the popover normally only opens on a tray click,
  // which is awkward to drive from a script or a test.
  if (process.env.LEDGER_SHOW_PANEL === '1') setTimeout(() => showPanel(), 600);
}

// -------------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('ledger:account', async () => lastAccount ?? (await refreshTray()));
  ipcMain.handle('ledger:refresh', async () => refreshTray({ force: true }));
  ipcMain.on('ledger:open-dashboard', () => openWindow());
  ipcMain.on('ledger:quit', () => app.quit());
  ipcMain.on('ledger:close', () => hidePanel());
  ipcMain.on('ledger:resize', (_event, height) => {
    if (!panel || panel.isDestroyed()) return;
    const h = Math.round(Number(height));
    if (!Number.isFinite(h)) return;
    panel.setContentSize(PANEL_WIDTH, Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, h)));
    if (panel.isVisible()) positionPanel();
  });
}

// ------------------------------------------------------------------ app lifecycle

function buildAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'View',
        submenu: [
          {
            label: 'Refresh Data',
            accelerator: 'CmdOrCtrl+R',
            click: () => {
              mainWindow?.webContents.reload();
              refreshTray({ force: true });
            },
          },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
        ],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

app.whenReady().then(async () => {
  buildAppMenu();
  registerIpc();

  try {
    const { startServer } = await importLocal('server.js');
    // Port 0 = let the OS pick a free port, bound to loopback only.
    serverInfo = await startServer({ port: 0, host: '127.0.0.1' });
  } catch (err) {
    dialog.showErrorBox(
      'Claude Ledger could not start',
      `The local data server failed to start.\n\n${err?.stack ?? err}`,
    );
    app.quit();
    return;
  }

  createWindow(serverInfo.port);

  // A failed menu bar item shouldn't take the dashboard down with it.
  try {
    anthropic = await importLocal('src/anthropic.js');
    createPanel(serverInfo.port);
    await createTray();
  } catch (err) {
    console.error('menu bar item unavailable:', err);
  }

  app.on('activate', () => openWindow());
});

app.on('window-all-closed', () => {
  // macOS keeps running so the menu bar item stays live.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  serverInfo?.server?.close();
});
