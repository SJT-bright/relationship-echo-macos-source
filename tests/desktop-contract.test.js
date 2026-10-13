import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { preventUnexpectedNavigation } from "../desktop/navigation-policy.mjs";

const ROOT = join(import.meta.dirname, "..");
const read = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8");

test("desktop package metadata pins the supported Electron toolchain", () => {
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(packageJson.main, "desktop/main.mjs");
  assert.equal(packageJson.productName, "关系回响");
  assert.equal(packageJson.devDependencies.electron, "43.4.1");
  assert.equal(packageJson.devDependencies["electron-builder"], "26.15.7");
  assert.equal(packageJson.scripts["app:dev"], "electron .");
  assert.equal(
    packageJson.scripts["dist:mac"],
    "electron-builder --mac --universal -c.mac.notarize=true -c.mac.forceCodeSigning=true -c.mac.hardenedRuntime=true",
  );
  assert.equal(
    packageJson.scripts["dist:mac:dir"],
    "electron-builder --mac dir --universal -c.mac.notarize=false -c.mac.forceCodeSigning=false -c.mac.hardenedRuntime=false -c.mac.identity=null",
  );
  assert.doesNotMatch(packageJson.devDependencies.electron, /^[~^]/);
  assert.doesNotMatch(packageJson.devDependencies["electron-builder"], /^[~^]/);

  const packageLock = JSON.parse(read("package-lock.json"));
  assert.equal(packageLock.lockfileVersion, 3);
  assert.equal(packageLock.packages[""].devDependencies.electron, "43.4.1");
  assert.equal(packageLock.packages[""].devDependencies["electron-builder"], "26.15.7");
  assert.equal(packageLock.packages["node_modules/electron"].version, "43.4.1");
  assert.equal(packageLock.packages["node_modules/electron-builder"].version, "26.15.7");
});

test("desktop main process binds a dynamic loopback server and app-scoped data directory", () => {
  const main = read("desktop/main.mjs");
  const profile = read("desktop/smoke-profile.mjs");

  assert.match(main, /createLocalServer\(\{/);
  assert.match(main, /dataDir:\s*app\.getPath\("userData"\)/);
  assert.match(main, /host:\s*"127\.0\.0\.1"/);
  assert.match(main, /port:\s*0/);
  assert.match(main, /randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(main, /desktopToken/);
  assert.match(main, /resolveDesktopRuntimeProfile\(\{/);
  assert.match(main, /mkdirSync\(runtimeProfile\.userDataPath, \{ recursive: true \}\)/);
  assert.match(main, /app\.setPath\("userData", runtimeProfile\.userDataPath\)/);
  assert.ok(
    main.indexOf('app.setPath("userData", runtimeProfile.userDataPath)') < main.indexOf("requestSingleInstanceLock()"),
    "smoke/standard userData must be selected before the single-instance lock",
  );
  assert.match(main, /data directory setup failed/);
  assert.match(main, /earlyInitializationFailed/);
  assert.match(profile, /USER_DATA_DIRECTORY\s*=\s*"Relationship Echo"/);
  assert.match(profile, /SOURCE_SMOKE_REQUIRES_SOURCE/);
  assert.match(profile, /PACKAGED_SMOKE_REQUIRES_PACKAGED/);
  assert.match(profile, /RELATIONSHIP_ECHO_ELECTRON_SMOKE_RUN_ID/);
  assert.match(profile, /\^\[a-f0-9\]\{32\}\$/);
  assert.match(profile, /mkdtempSync/);
  assert.doesNotMatch(`${main}\n${profile}`, /RELATIONSHIP_CARE_DATA_DIR|--user-data-dir/);
});

test("desktop lifecycle is single-instance and closes the local server exactly once before quit", () => {
  const main = read("desktop/main.mjs");
  const smokeHarness = read("scripts/run-electron-smoke.mjs");

  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\("second-instance"/);
  assert.match(main, /app\.on\("before-quit"/);
  assert.match(main, /serverStartPromise/);
  assert.match(main, /serverClosePromise/);
  assert.match(main, /windowCreationPromise/);
  assert.match(main, /Promise\.resolve\(serverStartPromise\)/);
  assert.match(main, /closeLocalServerOnce\(\)/);
  assert.match(main, /process\.platform !== "darwin"/);
  assert.match(main, /app\.on\("activate"/);
  assert.match(main, /await ensureLocalServer\(\);\s*if \(quitCleanupStarted \|\| quitAfterCleanup\) return null;/);
  assert.match(
    main,
    /if \(runtimeProfile\?\.mode !== "smoke"\s*&& !quitCleanupStarted && !quitAfterCleanup && !window\.isDestroyed\(\)\) window\.show\(\)/,
  );
  assert.doesNotMatch(main, /shell\.openExternal|exec\(|spawn\(/);
  assert.match(main, /dialog\.showErrorBox/);
  assert.match(main, /runtimeProfile\?\.mode !== "smoke"/);
  assert.match(main, /setTimeout\(\(\) => app\.quit\(\), 50\)/);
  assert.match(main, /pendingSmokeResult/);
  assert.match(main, /smokeResultEmitted/);
  assert.ok(
    main.indexOf("closeLocalServerOnce()", main.indexOf('app.on("before-quit"'))
      < main.indexOf("emitSmokeResult(result)", main.indexOf('app.on("before-quit"')),
    "smoke success must only be emitted after local server and SQLite cleanup",
  );
  assert.match(main, /shutdown cleanup failed[^]*process\.exitCode = 1;[^]*emitSmokeResult\(\{ ok: false \}\)/);
  assert.match(main, /getLastWebPreferences\(\)\.sandbox === true/);
  assert.match(main, /hasSwitch\("no-sandbox"\)/);
  assert.match(smokeHarness, /for \(const \[signalName, exitCode\] of \[\["SIGHUP", 129\], \["SIGINT", 130\], \["SIGTERM", 143\]\]\)/);
  assert.match(smokeHarness, /process\.on\(signalName, handler\)/);
  assert.match(smokeHarness, /process\.removeListener\(signalName, handler\)/);
  assert.match(smokeHarness, /lstatSync\(logicalDistRoot\)/);
  assert.match(smokeHarness, /logicalDistInfo\.isSymbolicLink\(\)/);
});

test("BrowserWindow and session defaults fail closed", () => {
  const main = read("desktop/main.mjs");

  for (const contract of [
    /nodeIntegration:\s*false/,
    /contextIsolation:\s*true/,
    /sandbox:\s*true/,
    /webSecurity:\s*true/,
    /devTools:\s*!app\.isPackaged/,
    /webviewTag:\s*false/,
    /minWidth:\s*960/,
    /minHeight:\s*680/,
    /setPermissionCheckHandler\(\(\) => false\)/,
    /setPermissionRequestHandler\([^]*callback\(false\)/,
    /setDevicePermissionHandler\(\(\) => false\)/,
    /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/,
    /will-navigate/,
    /will-redirect/,
    /will-frame-navigate/,
    /will-attach-webview/,
    /select-bluetooth-device/,
  ]) {
    assert.match(main, contract);
  }
});

test("navigation policy accepts same-origin legacy and details signatures but denies redirects away", () => {
  const origin = "http://127.0.0.1:54321";
  const legacyEvent = { prevented: 0, preventDefault() { this.prevented += 1; } };
  assert.equal(preventUnexpectedNavigation(legacyEvent, `${origin}/contacts`, origin), true);
  assert.equal(legacyEvent.prevented, 0);

  const detailsEvent = { url: `${origin}/frame`, prevented: 0, preventDefault() { this.prevented += 1; } };
  assert.equal(preventUnexpectedNavigation(detailsEvent, undefined, origin), true);
  assert.equal(detailsEvent.prevented, 0);

  const redirectEvent = { url: "https://example.invalid/", prevented: 0, preventDefault() { this.prevented += 1; } };
  assert.equal(preventUnexpectedNavigation(redirectEvent, undefined, origin), false);
  assert.equal(redirectEvent.prevented, 1);

  const malformedEvent = { prevented: 0, preventDefault() { this.prevented += 1; } };
  assert.equal(preventUnexpectedNavigation(malformedEvent, "not a url", origin), false);
  assert.equal(malformedEvent.prevented, 1);
});

test("preload exposes only an immutable platform and version snapshot", () => {
  const preload = read("desktop/preload.cjs");

  assert.match(preload, /contextBridge\.exposeInMainWorld\("relationshipEcho", desktopInfo\)/);
  assert.match(preload, /Object\.freeze\(\{/);
  assert.match(preload, /platform:/);
  assert.match(preload, /versions:/);
  assert.doesNotMatch(preload, /ipcRenderer|shell|remote|webFrame|send\(|invoke\(/);
});

test("electron-builder creates a hardened universal Mac app from an explicit allowlist", () => {
  const builder = read("electron-builder.yml");

  for (const contract of [
    /appId:\s*com\.relationshipecho\.app/,
    /productName:\s*关系回响/,
    /asar:\s*true/,
    /icon:\s*build\/icon\.png/,
    /target:\s*dmg/,
    /target:\s*zip/,
    /- universal/,
    /category:\s*public\.app-category\.productivity/,
    /minimumSystemVersion:\s*"12\.0"/,
    /hardenedRuntime:\s*true/,
    /forceCodeSigning:\s*false/,
    /entitlements:\s*build\/entitlements\.mac\.plist/,
    /notarize:\s*false/,
    /- index\.html/,
    /- styles\.css/,
    /- favicon\.svg/,
    /- src\/\*\*\/\*/,
    /- server\/\*\*\/\*/,
    /- desktop\/\*\*\/\*/,
    /- assets\/\*\*\/\*/,
    /- samples\/\*\*\/\*/,
    /- package\.json/,
  ]) {
    assert.match(builder, contract);
  }

  for (const excluded of [
    "!tests/**/*",
    "!**/*.test.*",
    "!**/*.sqlite",
    "!**/*.sqlite-*",
    "!**/relationship-care-data/**/*",
    "!**/backups/**/*",
    "!**/logs/**/*",
    "!**/*.log",
    "!**/.tmp/**/*",
    "!**/.impeccable/**/*",
    "!**/.review*/**/*",
    "!**/review/**/*",
  ]) {
    assert.ok(builder.includes(excluded), `missing builder exclusion: ${excluded}`);
  }

  assert.doesNotMatch(builder, /CSC_LINK\s*:|CSC_KEY_PASSWORD\s*:|APPLE_ID\s*:|APPLE_APP_SPECIFIC_PASSWORD\s*:/);
});
