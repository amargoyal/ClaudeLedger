/**
 * Post-process the generated iOS project.
 *
 * `npx cap add ios` scaffolds a stock Capacitor app, and a stock Capacitor app
 * cannot do the one thing this one exists to do: reach a plain-HTTP server on the
 * local network. Three separate iOS mechanisms have to be satisfied, and missing
 * any of them fails silently at runtime rather than at build time —
 *
 *   - App Transport Security blocks cleartext HTTP outright;
 *   - iOS 14+ additionally requires the local-network privacy permission, which
 *     only appears if the usage-description key exists;
 *   - the pairing QR encodes a claudeledger:// URL, which does nothing unless the
 *     scheme is registered.
 *
 * Everything here is idempotent, so it runs after every `cap sync`. `ios/` is
 * generated and git-ignored, which is exactly why this lives in a script instead
 * of being edited by hand once and forgotten.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderAppIcon } from '../src/mark.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(ROOT, 'ios', 'App', 'App');
const PLIST = join(APP_DIR, 'Info.plist');
const ASSETS = join(APP_DIR, 'Assets.xcassets');

const PAPER = [0xf6, 0xf1, 0xe8];

if (!existsSync(PLIST)) {
  console.error('No ios/ project yet. Run: npm run ios:add');
  process.exit(1);
}

// --------------------------------------------------------------------- plist

/**
 * PlistBuddy has no upsert, so every write is "try Set, fall back to Add". Using
 * it rather than hand-editing XML keeps the file a valid plist even when Xcode
 * has rewritten it into binary format.
 */
function plist(args) {
  // stderr is discarded because "Does Not Exist" is the normal, expected answer
  // on the Print and Set probes below — it is control flow, not a problem.
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', args, PLIST], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function set(path, type, value) {
  try {
    plist(`Set ${path} ${value}`);
  } catch {
    plist(`Add ${path} ${type} ${value}`);
  }
}

function ensureContainer(path, type) {
  try {
    plist(`Print ${path}`);
    return false;
  } catch {
    plist(`Add ${path} ${type}`);
    return true;
  }
}

set(':CFBundleDisplayName', 'string', 'Ledger');

// A phone can only talk to the Mac over plain HTTP on a private address. This
// exception covers exactly that and nothing else — it is not NSAllowsArbitraryLoads.
ensureContainer(':NSAppTransportSecurity', 'dict');
set(':NSAppTransportSecurity:NSAllowsLocalNetworking', 'bool', 'true');

set(
  ':NSLocalNetworkUsageDescription',
  'string',
  'Claude Ledger connects to the Mac running Claude Ledger to read your Claude Code usage.',
);

// Registering the scheme is what makes the pairing QR do anything when scanned
// with the built-in Camera app.
ensureContainer(':CFBundleURLTypes', 'array');
ensureContainer(':CFBundleURLTypes:0', 'dict');
set(':CFBundleURLTypes:0:CFBundleURLName', 'string', 'com.amargoyal.claudeledger');
ensureContainer(':CFBundleURLTypes:0:CFBundleURLSchemes', 'array');
try {
  const existing = plist('Print :CFBundleURLTypes:0:CFBundleURLSchemes');
  if (!existing.includes('claudeledger')) plist('Add :CFBundleURLTypes:0:CFBundleURLSchemes: string claudeledger');
} catch {
  plist('Add :CFBundleURLTypes:0:CFBundleURLSchemes: string claudeledger');
}

// The status bar is styled from JS to follow light/dark, which only takes effect
// with the view-controller-based setting turned off.
set(':UIViewControllerBasedStatusBarAppearance', 'bool', 'false');

console.log('Info.plist configured');

// --------------------------------------------------------------------- assets

function writeAsset(dir, name, buffer, contents) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), buffer);
  if (contents) writeFileSync(join(dir, 'Contents.json'), `${JSON.stringify(contents, null, 2)}\n`);
}

// iOS masks the icon itself and rejects an alpha channel, so this is the
// full-bleed opaque square rather than the inset rounded tile macOS wants.
const icon = renderAppIcon(1024, { inset: 0, radius: 0, background: [0, 0, 0] });
writeAsset(join(ASSETS, 'AppIcon.appiconset'), 'AppIcon-512@2x.png', icon, {
  images: [{ filename: 'AppIcon-512@2x.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
  info: { author: 'xcode', version: 1 },
});
console.log('AppIcon written');

// Launch image: the mark floating well inside a field of paper, so the launch
// and the first frame of the app are the same colour.
const splash = renderAppIcon(1366, {
  inset: Math.round(1366 * 0.38),
  radius: 1366 * 0.045,
  background: PAPER,
});
const splashDir = join(ASSETS, 'Splash.imageset');
if (existsSync(splashDir)) {
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    writeFileSync(join(splashDir, name), splash);
  }
  console.log('Splash images written');
}

// -------------------------------------------------------------------- version

/*
 * Capacitor scaffolds the project at 1.0 and never touches it again, so without
 * this the iOS build silently reports a different version from the Mac one
 * forever. package.json is the single source of truth for both.
 */
const project = join(ROOT, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
if (existsSync(project)) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const before = readFileSync(project, 'utf8');
  const after = before.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`);
  if (after !== before) {
    writeFileSync(project, after);
    console.log(`MARKETING_VERSION set to ${version}`);
  }

  if (after.includes('DEVELOPMENT_TEAM = ""')) {
    console.log(
      '\nNext: open Xcode, pick your Apple ID under Signing & Capabilities, then run to your phone.',
    );
  }
}
