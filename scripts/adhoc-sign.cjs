'use strict';

/**
 * Ad-hoc sign the packaged .app, as an electron-builder `afterPack` hook.
 *
 * `mac.identity: null` tells electron-builder to skip code signing entirely, which
 * leaves the bundle with nothing but Electron's own linker-signed main binary:
 * `Sealed Resources=none`, `Info.plist=not bound`, and `codesign --verify` failing
 * with "code has no resources but signature indicates they must be present".
 *
 * That is fine as long as the app never carries a quarantine attribute — which is
 * why it runs from `dist/` on the build machine — but the moment a user downloads
 * the DMG, Gatekeeper evaluates it, finds no valid signature, and reports
 * *"Claude Ledger is damaged and can't be opened"*. Right-click → Open does not
 * bypass that particular verdict.
 *
 * A real ad-hoc signature seals the resources and binds Info.plist, so the bundle
 * verifies. It is still unidentified — a first launch needs right-click → Open, or
 * one `xattr -dr com.apple.quarantine` — but it is no longer reported as damaged.
 *
 * Identity `-` means ad-hoc. `--deep` is discouraged for Developer ID builds
 * (each nested component should get its own explicit signature), but for an ad-hoc
 * signature with no entitlements it is exactly the bottom-up walk we want.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], {
    stdio: 'inherit',
  });
  // Fail the build rather than ship a bundle that Gatekeeper will call damaged.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed and verified  ${app}`);
};
