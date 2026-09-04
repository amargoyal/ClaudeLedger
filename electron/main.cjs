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
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// Windows groups taskbar buttons, jump lists and notifications by this id. Without
// it a packaged build shows up as a generic "electron.app.Electron".
if (isWin) app.setAppUserModelId('com.amargoyal.claudeledger');

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
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

/** Surface colours per theme, used for native window backgrounds. */
const SURFACE = {
  window: { light: '#F6F1E8', dark: '#16130F' },
  panel: { light: '#FFFDF8', dark: '#26231F' },
  pair: { light: '#F6F1E8', dark: '#1F1C19' },
};

/**
 * Read the persisted theme before the first window exists.
 *
 * This has to happen at creation time, not after the renderer boots: a window
 * created with a light `backgroundColor` and then told to go dark flashes white
 * for a frame on every launch.
 */
function readTheme() {
  try {
    const theme = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')).theme;
    if (theme === 'light' || theme === 'dark' || theme === 'system') return theme;
  } catch {
    /* first run */
  }
  return 'system';
}

function saveTheme(theme) {
  try {
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify({ theme }));
  } catch {
    /* non-fatal */
  }
}

/** Window control glyph colour for the Windows overlay, per theme. */
const SYMBOL = { light: '#29241D', dark: '#F7F3EA' };

const surface = (kind) => SURFACE[kind][nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

const overlay = (kind) => ({
  color: surface(kind),
  symbolColor: SYMBOL[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'],
  height: 36,
});

/**
 * Frameless chrome, per platform.
 *
 * macOS keeps the inset traffic lights over a hidden title bar. Windows uses the
 * Window Controls Overlay: minimise/maximise/close stay native (and stay where a
 * Windows user reaches for them), while the app paints the rest of the strip, so
 * the same `.drag-strip` handle works on both. Elsewhere, take the normal frame.
 * @param {'window'|'panel'|'pair'} kind which surface colour the bar should match
 * @param {number} inset traffic light offset, macOS only
 */
function chromeOptions(kind, inset) {
  if (isMac) {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: inset, y: inset } };
  }
  if (isWin) {
    // The menu bar would otherwise render as a strip inside the frameless window;
    // Alt still summons it.
    return { titleBarStyle: 'hidden', titleBarOverlay: overlay(kind), autoHideMenuBar: true };
  }
  return {};
}

/**
 * Window icon for platforms that don't get one from the bundle. Only present
 * after `npm run icon`, and only used unpackaged — a packaged Windows build takes
 * its icon from the executable.
 */
function windowIcon() {
  if (isMac) return {};
  const file = path.join(__dirname, '..', 'build', 'icon.png');
  return fs.existsSync(file) ? { icon: file } : {};
}

/**
 * Point every native surface at the chosen theme.
 *
 * `nativeTheme.themeSource` is the lever that matters: it also decides what
 * `prefers-color-scheme` reports inside *every* renderer, so the popover and the
 * pairing window follow without needing to be told.
 */
function setTheme(theme) {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
  saveTheme(theme);
  applySurfaces();
}

function applySurfaces() {
  paint(mainWindow, 'window');
  paint(panel, 'panel');
  paint(pairWindow, 'pair');
}

/** Repaint one window's native background — and, on Windows, its control overlay. */
function paint(win, kind) {
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(surface(kind));
  // The overlay is drawn by the OS, so it does not follow the page's CSS: left
  // alone it keeps the light bar behind the buttons after a switch to dark.
  if (isWin && kind !== 'panel') win.setTitleBarOverlay(overlay(kind));
}

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
let pairWindow = null;
let tray = null;
let serverInfo = null;
let serverModule = null;
let lan = null;
let lanError = null;
let lanModule = null;
/** Loaded with the rest; only spawns anything when the relay switch is used. */
let tunnelModule = null;
/** Only for its duration formatter; the projections themselves arrive with the account. */
let burnModule = null;
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
    backgroundColor: surface('window'),
    ...chromeOptions('window', 14),
    ...windowIcon(),
    webPreferences: {
      // The dashboard renderer only talks to the local HTTP API. The preload adds
      // exactly one call — setting the theme, which needs to reach native surfaces.
      preload: path.join(__dirname, 'preload-main.cjs'),
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
    // On Windows the notification area sits on the taskbar, which is itself always
    // on top: without this the popover opens behind it.
    alwaysOnTop: !isMac,
    // Deliberately NOT transparent + vibrancy. A translucent popover over an
    // arbitrary desktop has no contrast guarantee — text was genuinely hard to
    // read against busy backdrops. A solid surface that follows the system theme
    // is legible every time.
    backgroundColor: surface('panel'),
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

  /**
   * Treat a close request on the popover as a request to quit the whole app.
   *
   * Nothing in the UI ever closes this window — dismissing it calls `hide()` — so
   * a close can only have come from outside the process: a Windows installer or
   * uninstaller asking the app to exit, `taskkill` without `/f`, or a shutdown.
   * The app deliberately keeps running with no windows open so the tray item
   * stays live, which means that polite request would otherwise go unanswered and
   * the installer would stall on "Claude Ledger cannot be closed".
   *
   * Quitting here is safe: window state is written on every move and resize, and
   * `before-quit` still closes the servers.
   *
   * The visibility guard rules out the one close a person can actually trigger:
   * Cmd/Ctrl+W from the Window menu while the popover is open and focused. An
   * external request arrives whether the popover is on screen or not, and it is
   * hidden in every case that matters here.
   */
  panel.on('close', () => {
    if (!panel.isVisible()) app.quit();
  });

  // Keep the native surface in step with the CSS, which follows prefers-color-scheme.
  nativeTheme.on('updated', () => paint(panel, 'panel'));

  return panel;
}

/**
 * Centre the popover on the tray icon, kept inside the display's work area.
 *
 * Below the icon when there's room, above it when there isn't — which is what
 * decides the two real cases without naming them: the macOS menu bar is at the
 * top of the screen, the Windows notification area is usually at the bottom.
 */
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
  const below = trayBounds.y + trayBounds.height + 4;
  const y =
    below + height + 8 <= work.y + work.height
      ? below
      : Math.max(work.y + 8, trayBounds.y - height - 4);
  panel.setPosition(x, Math.round(y), false);
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

// --------------------------------------------------------------- phone pairing

/**
 * The pairing window is the only place sharing can be switched on.
 *
 * Deliberately a window rather than a menu item that silently starts a listener:
 * opening a port that serves your usage data to the local network is not
 * something that should happen without a screen explaining it, showing which
 * address is live, and listing what is currently paired.
 */
function createPairWindow(port) {
  pairWindow = new BrowserWindow({
    width: 520,
    height: 700,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: surface('pair'),
    ...chromeOptions('pair', 12),
    ...windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload-pair.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  pairWindow.loadURL(`http://127.0.0.1:${port}/pair.html`);
  pairWindow.once('ready-to-show', () => pairWindow.show());
  pairWindow.on('closed', () => {
    pairWindow = null;
  });
  nativeTheme.on('updated', () => paint(pairWindow, 'pair'));
  return pairWindow;
}

function openPairWindow() {
  if (!serverInfo) return;
  hidePanel();
  if (!pairWindow) createPairWindow(serverInfo.port);
  pairWindow.show();
  pairWindow.focus();
}

function pairState() {
  return {
    sharing: Boolean(lan),
    port: lan?.port ?? null,
    addresses: lanModule ? lanModule.lanAddresses() : [],
    pairing: lanModule ? lanModule.pairingState() : { active: false },
    devices: lanModule ? lanModule.listDevices() : [],
    relay: tunnelModule ? tunnelModule.tunnelState() : { installed: false, running: false, origin: null },
    error: lanError,
  };
}

async function setSharing(on) {
  lanError = null;
  if (on && !lan) {
    try {
      lan = await serverModule.startLanServer();
    } catch (err) {
      lan = null;
      lanError =
        err?.code === 'EADDRINUSE'
          ? 'Port 4317 is already in use by another program. Quit it and try again.'
          : (err?.message ?? 'Could not start sharing.');
    }
  } else if (!on && lan) {
    // Closing the listener without also closing the pairing window would leave a
    // live code on screen for a service that no longer answers.
    lanModule?.stopPairing();
    tunnelModule?.stopTunnel();
    await lan.stop();
    lan = null;
  }
  return pairState();
}

/**
 * The internet path, switched on by hand.
 *
 * A LAN address only answers on this Wi-Fi, so a phone on cellular gets a page
 * that never loads. This puts a Cloudflare quick tunnel in front of the same
 * phone-facing listener, which makes one https address that answers anywhere —
 * and publishes it, which is why it is off until asked for and why the pairing
 * window says what it does.
 */
async function setRelay(on) {
  if (!tunnelModule) return pairState();
  if (on) {
    // Nothing to tunnel to until the listener exists.
    if (!lan) await setSharing(true);
    if (lan) await tunnelModule.startTunnel({ port: lan.port });
  } else {
    tunnelModule.stopTunnel();
  }
  return pairState();
}

async function stopSharing() {
  tunnelModule?.stopTunnel();
  if (lan) {
    await lan.stop();
    lan = null;
  }
}

// --------------------------------------------------------------------- menu bar

function planLabel(account) {
  const a = account?.account;
  if (a?.hasMax) return 'Claude Max';
  if (a?.hasPro) return 'Claude Pro';
  return account?.subscriptionType ? `Claude ${account.subscriptionType}` : 'Claude';
}

/**
 * The session window — the limit that actually interrupts work. Everything else
 * lives in the popover.
 * @returns {string|null} e.g. "62%", or null when there's nothing to show
 */
function sessionPercent(account) {
  if (account?.status !== 'connected') return null;
  const session = account.limits?.windows?.find(
    (w) => w.group === 'session' || w.kind === 'session' || w.key === 'five_hour',
  );
  if (!session || session.utilization == null) return null;
  return `${session.utilization.toFixed(0)}%`;
}

/**
 * The session window's own reading of how long it has left, when the readings
 * support one and it matters.
 *
 * Only when the window would run out before it resets. Otherwise the honest
 * answer is "the window resets first", and printing a duration for that would
 * turn a fine afternoon into a countdown.
 */
function sessionRunway(account) {
  const projection = account?.projections?.session;
  if (!projection?.willExhaustBeforeReset) return null;
  return burnModule ? burnModule.shortDuration(projection.minutesToExhaust) : null;
}

/**
 * Menu bar title text. macOS only — `setTitle` is a no-op elsewhere.
 *
 * A percentage with no derivative does not answer the question anyone has, which
 * is whether to start the long thing now. 62% is comfortable four hours into a
 * window and alarming twenty minutes in.
 */
function trayTitle(account) {
  if (account?.status !== 'connected') return ' —';
  const pct = sessionPercent(account);
  if (!pct) return '';
  const runway = sessionRunway(account);
  return runway ? ` ${pct} · ${runway}` : ` ${pct}`;
}

/**
 * Tooltip text. On Windows this carries the number as well as the plan: there is
 * no title beside a notification area icon, so the tooltip is the only place the
 * session figure can show without opening the popover.
 */
function trayTooltip(account) {
  if (account?.status !== 'connected') return 'Claude Ledger — not connected';
  const pct = isMac ? null : sessionPercent(account);
  const projection = account?.projections?.session;
  const rate = projection ? ` · ${projection.ratePerHour.toFixed(1)}%/hr` : '';
  return `Claude Ledger — ${planLabel(account)}${pct ? ` · session ${pct}` : ''}${rate}`;
}

/** Right-click menu — the popover is the primary surface, this is the shortcut. */
function trayContextMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => openWindow() },
    { label: 'Refresh Now', click: () => refreshTray({ force: true }) },
    { type: 'separator' },
    {
      label: lan ? 'Phone Sharing — On…' : 'Pair a Phone…',
      click: () => openPairWindow(),
    },
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
    if (isMac) tray.setTitle(trayTitle(lastAccount));
    tray.setToolTip(trayTooltip(lastAccount));
  }
  return lastAccount;
}

/**
 * Build the tray image in memory from the same glyph as the app icon — no separate
 * asset files to keep in sync.
 */
async function trayImage() {
  const mark = await importLocal('src/mark.js');

  if (isMac) {
    // Template images are recoloured by macOS for light/dark menu bars and for the
    // highlighted state, so only the alpha channel matters.
    // 18pt rather than the conventional 16pt: the menu bar allows it and the mark
    // is legible at that size where 16 read as cramped.
    const image = nativeImage.createFromBuffer(mark.renderTemplateMark(18), { scaleFactor: 1 });
    image.addRepresentation({ scaleFactor: 2, buffer: mark.renderTemplateMark(36) });
    image.setTemplateImage(true);
    return image;
  }

  // Windows draws the bitmap as given, so this is the colour tile — see
  // renderTrayTile. 16px logical, with a 2x representation for scaled displays.
  const image = nativeImage.createFromBuffer(mark.renderTrayTile(16), { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: mark.renderTrayTile(32) });
  return image;
}

async function createTray() {
  tray = new Tray(await trayImage());
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
  if (process.env.LEDGER_SHOW_PAIR === '1') setTimeout(() => openPairWindow(), 600);
}

// -------------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.on('ledger:set-theme', (_event, theme) => setTheme(theme));

  ipcMain.handle('pair:state', () => pairState());
  ipcMain.handle('pair:set-sharing', (_event, on) => setSharing(on));
  ipcMain.handle('pair:set-relay', (_event, on) => setRelay(Boolean(on)));
  ipcMain.handle('pair:new-code', () => {
    lanModule?.startPairing();
    return pairState();
  });
  ipcMain.handle('pair:revoke', (_event, id) => {
    lanModule?.revokeDevice(id);
    return pairState();
  });
  ipcMain.on('pair:close', () => pairWindow?.close());

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
  const viewMenu = {
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
  };

  // The app menu is spelled out rather than `{ role: 'appMenu' }` so "Pair a
  // Phone…" can sit where a Mac user looks for it. Windows has no such menu — and
  // no `about`/`services`/`hide` roles either — so the same items go under File,
  // which is where a Windows user looks for them.
  const firstMenu = isMac
    ? {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Pair a Phone…', accelerator: 'CmdOrCtrl+P', click: () => openPairWindow() },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }
    : {
        label: 'File',
        submenu: [
          { label: 'Pair a Phone…', accelerator: 'CmdOrCtrl+P', click: () => openPairWindow() },
          { type: 'separator' },
          { role: 'quit', label: 'Quit Claude Ledger' },
        ],
      };

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([firstMenu, viewMenu, { role: 'editMenu' }, { role: 'windowMenu' }]),
  );
}

app.whenReady().then(async () => {
  // Before any window is created, so the first frame is already the right colour.
  nativeTheme.themeSource = readTheme();
  buildAppMenu();
  registerIpc();

  try {
    serverModule = await importLocal('server.js');
    lanModule = await importLocal('src/lan.js');
    tunnelModule = await importLocal('src/tunnel.js');
    burnModule = await importLocal('src/burn.js');
    // Port 0 = let the OS pick a free port, bound to loopback only.
    serverInfo = await serverModule.startServer({ port: 0, host: '127.0.0.1' });
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
  // Keep running so the tray item stays live — the menu bar on macOS, the
  // notification area on Windows. Both offer "Open Dashboard" and "Quit", so
  // there's a way back and a way out. If the tray failed to start there is
  // neither, and a closed window would leave an invisible process behind.
  if (!isMac && !tray) app.quit();
});

app.on('before-quit', () => {
  serverInfo?.server?.close();
  // Sharing is scoped to a running app, so the port must not outlive it.
  void stopSharing();
});
