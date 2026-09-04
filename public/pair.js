/* Pairing window renderer. Talks to the main process over the preload bridge. */
import { qrSvg } from './qr.js';

const api = globalThis.pairing;
const $ = (id) => document.getElementById(id);

let state = null;
/** Address the user picked, remembered across polls so the select doesn't jump. */
let chosenAddress = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function ago(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function activeHost() {
  if (!state?.addresses?.length || !state.port) return null;
  const pick =
    state.addresses.find((a) => a.address === chosenAddress) ?? state.addresses[0];
  return `${pick.address}:${state.port}`;
}

function renderShare() {
  const on = Boolean(state?.sharing);
  const sw = $('share-switch');
  sw.setAttribute('aria-checked', String(on));

  const host = activeHost();
  $('share-sub').textContent = on
    ? host
      ? `On — reachable at ${host}`
      : 'On, but this Mac has no network address. Join a Wi‑Fi network.'
    : 'Off — nothing is reachable from the network.';

  const err = $('share-error');
  if (state?.error) {
    err.hidden = false;
    err.textContent = state.error;
  } else {
    err.hidden = true;
  }

  $('pair-panel').hidden = !on;
}

function renderAddresses() {
  const select = $('address-select');
  const addresses = state?.addresses ?? [];
  const wanted = chosenAddress ?? addresses[0]?.address ?? '';

  // Only rebuild when the interface list actually changed — this runs on a timer
  // and replacing the options every second would fight an open dropdown.
  const signature = addresses.map((a) => `${a.iface}:${a.address}`).join('|');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    clear(select);
    for (const a of addresses) {
      const option = el('option', null, `${a.address}  (${a.iface})`);
      option.value = a.address;
      select.append(option);
    }
  }
  if (select.value !== wanted) select.value = wanted;
}

function renderCode() {
  const pairing = state?.pairing;
  const code = $('code');
  const countdown = $('countdown');

  const host = activeHost();
  // The same pairing works in mobile Safari, which is the whole install story for
  // anyone who hasn't built the app in Xcode.
  $('browser-url').textContent = host
    ? `http://${host}/${pairing?.active ? `?code=${pairing.code}` : ''}`
    : '—';

  if (!pairing?.active) {
    code.textContent = '— — — — — —';
    countdown.textContent = 'Press “New code” to start.';
    clear($('qr-box'));
    lastQrPayload = null;
    return;
  }

  code.textContent = pairing.code.split('').join(' ');
  const left = Math.max(0, pairing.expiresAt - Date.now());
  const mins = Math.floor(left / 60_000);
  const secs = Math.floor((left % 60_000) / 1000);
  countdown.textContent =
    left > 0 ? `Expires in ${mins}:${String(secs).padStart(2, '0')}` : 'Expired.';

  renderQr(pairing.code);
}

/** Rebuilt only when the payload changes — encoding is cheap but not free. */
let lastQrPayload = null;

function renderQr(code) {
  const host = activeHost();
  const box = $('qr-box');
  if (!host) {
    clear(box);
    lastQrPayload = null;
    return;
  }
  /*
   * An http address, not the `claudeledger://` link the app ultimately opens.
   *
   * The Camera app offers to open an http URL every time and is unreliable
   * about custom schemes — often it recognises the code and then does nothing,
   * which reads as "pairing is broken". So the scan lands on a page this Mac
   * serves, and that page hands the phone to the app, with a button and a
   * browser fallback for when it cannot.
   */
  const payload = `http://${host}/pair?code=${code}`;
  if (payload === lastQrPayload) return;
  lastQrPayload = payload;

  clear(box);
  try {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    // The symbol itself is always dark-on-light: an inverted QR is legal but
    // plenty of scanners refuse it, and this one has to work first time.
    box.append(qrSvg(payload, { size: 178, dark: '#29241d', light: '#fffdf8' }));
    box.style.background = dark ? '#fffdf8' : '#fffdf8';
  } catch (err) {
    box.append(el('div', 'none', err.message));
  }
}

function renderDevices() {
  const wrap = $('devices');
  clear(wrap);
  const devices = state?.devices ?? [];
  if (!devices.length) {
    wrap.append(el('div', 'none', 'No phones paired yet.'));
    return;
  }
  for (const d of devices) {
    const row = el('div', 'device');
    const main = el('div', 'device-main');
    main.append(el('div', 'device-name', d.name));
    main.append(el('div', 'device-meta', `Paired ${ago(d.pairedAt)} · last seen ${ago(d.lastSeen)}`));
    const remove = el('button', 'link-danger', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      state = await api.revoke(d.id);
      render();
    });
    row.append(main, remove);
    wrap.append(row);
  }
}

function render() {
  renderShare();
  renderAddresses();
  renderCode();
  renderDevices();
}

$('share-switch').addEventListener('click', async () => {
  const sw = $('share-switch');
  sw.disabled = true;
  try {
    state = await api.setSharing(!state?.sharing);
    // Turning sharing on with no code open leaves a pairing panel with nothing to
    // pair against, so open one straight away.
    if (state?.sharing && !state.pairing?.active) state = await api.newCode();
  } finally {
    sw.disabled = false;
  }
  render();
});

$('new-code').addEventListener('click', async () => {
  state = await api.newCode();
  render();
});

$('address-select').addEventListener('change', (event) => {
  chosenAddress = event.target.value;
  render();
});

async function poll() {
  state = await api.state();
  render();
}

await poll();

/*
 * Opening this window is the intent to pair, so it arrives ready: sharing on and
 * a code already counting down. Requiring the toggle first meant the QR — the
 * only thing the window is for — was two clicks away every single time.
 *
 * Only ever switched on, never off: sharing is the user's setting, and closing
 * the window already retires the code without retiring the listener.
 */
if (!state?.sharing) state = await api.setSharing(true);
if (state?.sharing && !state.pairing?.active) state = await api.newCode();
render();

// One second, because the panel shows a live countdown and a device can pair at
// any moment — both need to appear without the user touching anything.
setInterval(poll, 1000);
