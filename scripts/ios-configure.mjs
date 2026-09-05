/**
 * Post-process the generated iOS project.
 *
 * `npx cap add ios` scaffolds a stock Capacitor app, and a stock Capacitor app
 * cannot do the one thing this one exists to do: reach a plain-HTTP server on a
 * Mac, on this Wi-Fi or across a tailnet. Three separate iOS mechanisms have to
 * be satisfied, and missing any of them fails silently at runtime rather than at
 * build time —
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

/*
 * The phone talks to the Mac over plain HTTP, and to two kinds of address.
 *
 * `NSAllowsLocalNetworking` covers the LAN one — 192.168/16 and the rest of the
 * private ranges. It does not cover a tailnet address: Tailscale assigns out of
 * 100.64.0.0/10, which is carrier-grade NAT space and not "local" as far as App
 * Transport Security is concerned, so the request is refused before it is made.
 * That failure is silent and looks exactly like the Mac being asleep, which is
 * the failure the tailnet path exists to end.
 *
 * There is no narrower exception that fits. `NSExceptionDomains` takes names, and
 * the tailnet address is a bare IP that differs per machine, so pinning one would
 * be pinning this developer's Mac into the build. Hence arbitrary loads, with the
 * tradeoff stated rather than buried: cleartext is allowed to any host, and what
 * defends the connection is that the phone only ever talks to an address this Mac
 * handed it, over a bearer token, and that the tailnet leg is WireGuard-encrypted
 * end to end regardless of what ATS thinks of it.
 */
ensureContainer(':NSAppTransportSecurity', 'dict');
set(':NSAppTransportSecurity:NSAllowsLocalNetworking', 'bool', 'true');
set(':NSAppTransportSecurity:NSAllowsArbitraryLoads', 'bool', 'true');

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

// ------------------------------------------------------------ scene lifecycle

/*
 * iOS 26 made UIScene adoption mandatory. An app built against that SDK which
 * still launches through UIApplicationDelegate alone traps at startup inside
 * `__UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` — a bare
 * EXC_BREAKPOINT in AppDelegate.swift with the launch screen left on screen.
 *
 * Capacitor 7.6 still ships the pre-scene template, so the adoption is added
 * here. The delegate lives inside AppDelegate.swift rather than its own file so
 * that no entry has to be spliced into project.pbxproj to compile it.
 */
const SCENE_MARK = '// --- claude-ledger: UIScene adoption';

const appDelegate = join(ROOT, 'ios', 'App', 'App', 'AppDelegate.swift');
if (existsSync(appDelegate)) {
  const current = readFileSync(appDelegate, 'utf8');
  // Rewritten rather than skipped when it is already there: this block changes,
  // and a stale copy from an earlier run would silently outlive the fix.
  const before = current.includes(SCENE_MARK)
    ? current.slice(0, current.indexOf(SCENE_MARK)).trimEnd()
    : current;
  {
    const scene = `
${SCENE_MARK} (added by scripts/ios-configure.mjs) ---
/*
 * UIKit owns the window and the storyboard here; this delegate exists to satisfy
 * scene adoption and to keep the \`claudeledger://pair\` links working, which
 * arrive through the scene rather than through UIApplicationDelegate once scenes
 * are in play. Capacitor's proxy is what its plugins listen to.
 */
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        // The web view is created when the bridge controller loads its view,
        // which has not happened yet.
        DispatchQueue.main.async { [weak self] in
            self?.paintChrome(windowScene)
        }
        if let url = connectionOptions.urlContexts.first?.url {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        guard let windowScene = scene as? UIWindowScene else { return }
        paintChrome(windowScene)
    }

    /*
     * Hand the safe areas to the page.
     *
     * Capacitor paints the web view with the ios.backgroundColor config — one static
     * colour, so on a phone in dark mode the strip behind the status bar stayed
     * paper white while everything the page drew was ink. Clearing the web view
     * lets the page's own background cover that strip, which means it follows the
     * app's Appearance setting rather than only the system's.
     *
     * The window keeps a colour of its own for the one place the page cannot
     * reach: the rubber band at the end of a scroll.
     */
    private func paintChrome(_ windowScene: UIWindowScene) {
        let paper = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0x16 / 255, green: 0x13 / 255, blue: 0x0F / 255, alpha: 1)
                : UIColor(red: 0xF6 / 255, green: 0xF1 / 255, blue: 0xE8 / 255, alpha: 1)
        }
        let windows = window.map { [$0] } ?? windowScene.windows
        for window in windows {
            window.backgroundColor = paper
            window.rootViewController?.view.backgroundColor = paper
            guard let bridge = window.rootViewController as? CAPBridgeViewController else { continue }
            bridge.webView?.isOpaque = false
            bridge.webView?.backgroundColor = .clear
            bridge.webView?.scrollView.backgroundColor = .clear
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
    }
}
`;
    const next = `${before.trimEnd()}\n${scene}`;
    if (next !== current) {
      writeFileSync(appDelegate, next);
      console.log('SceneDelegate written to AppDelegate.swift');
    }
  }
}

const infoPlist = join(ROOT, 'ios', 'App', 'App', 'Info.plist');
if (existsSync(infoPlist)) {
  const before = readFileSync(infoPlist, 'utf8');
  if (!before.includes('UIApplicationSceneManifest')) {
    const manifest = [
      '\t<key>UIApplicationSceneManifest</key>',
      '\t<dict>',
      '\t\t<key>UIApplicationSupportsMultipleScenes</key>',
      '\t\t<false/>',
      '\t\t<key>UISceneConfigurations</key>',
      '\t\t<dict>',
      '\t\t\t<key>UIWindowSceneSessionRoleApplication</key>',
      '\t\t\t<array>',
      '\t\t\t\t<dict>',
      '\t\t\t\t\t<key>UISceneConfigurationName</key>',
      '\t\t\t\t\t<string>Default Configuration</string>',
      '\t\t\t\t\t<key>UISceneDelegateClassName</key>',
      '\t\t\t\t\t<string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>',
      '\t\t\t\t\t<key>UISceneStoryboardFile</key>',
      '\t\t\t\t\t<string>Main</string>',
      '\t\t\t\t</dict>',
      '\t\t\t</array>',
      '\t\t</dict>',
      '\t</dict>',
      '</dict>',
    ].join('\n');
    writeFileSync(infoPlist, before.replace(/<\/dict>\s*<\/plist>\s*$/, `${manifest}\n</plist>\n`));
    console.log('UIApplicationSceneManifest added to Info.plist');
  }
}

// ---------------------------------------------------------- deployment target

/*
 * Xcode 26 will not build a simulator slice below iOS 15.0, and Capacitor
 * scaffolds both the project and the Podfile at 14.0. `ios/` is not in the repo,
 * so this is the only durable place to state the floor: whoever runs
 * `npm run ios:add` on a fresh checkout gets a project that builds.
 *
 * The pods need their own pass. `assertDeploymentTarget` only raises the pods
 * that ask for less than the podspec minimum, which left most of them at 14.0.
 */
const IOS_MIN = '15.0';

const podfile = join(ROOT, 'ios', 'App', 'Podfile');
if (existsSync(podfile)) {
  const before = readFileSync(podfile, 'utf8');
  let after = before.replace(/platform :ios, '1[0-4](\.\d+)?'/, `platform :ios, '${IOS_MIN}'`);
  if (!after.includes("config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']")) {
    after = after.replace(
      /post_install do \|installer\|\n(\s*)assertDeploymentTarget\(installer\)\n/,
      (m, indent) =>
        `${m}${indent}installer.pods_project.targets.each do |target|\n` +
        `${indent}  target.build_configurations.each do |config|\n` +
        `${indent}    config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${IOS_MIN}'\n` +
        `${indent}  end\n` +
        `${indent}end\n`,
    );
  }
  if (after !== before) {
    writeFileSync(podfile, after);
    console.log(`Podfile pinned to iOS ${IOS_MIN} — run \`pod install\` in ios/App`);
  }
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
  /*
   * `cap sync` rewrites the project back to Capacitor's scaffold target, so the
   * floor is re-applied here on every sync rather than set once by hand.
   */
  const after = before
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
    .replace(/IPHONEOS_DEPLOYMENT_TARGET = 1[0-4](\.\d+)?;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_MIN};`);
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
