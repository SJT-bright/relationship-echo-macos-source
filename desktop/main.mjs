import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, session } from "electron";

import { createLocalServer } from "../server/create-local-server.mjs";
import { preventUnexpectedNavigation } from "./navigation-policy.mjs";
import { publicSmokeResult, resolveDesktopRuntimeProfile } from "./smoke-profile.mjs";

const APP_ID = "com.relationshipecho.app";
const PRODUCT_NAME = "关系回响";
const PRELOAD_PATH = fileURLToPath(new URL("./preload.cjs", import.meta.url));

function safeErrorKind(error) {
  if (error && typeof error === "object") {
    if (typeof error.code === "string") return error.code;
    if (typeof error.name === "string") return error.name;
  }
  return "UnknownError";
}

app.setName(PRODUCT_NAME);
app.setAppUserModelId(APP_ID);
let earlyInitializationFailed = false;
let runtimeProfile = null;
try {
  runtimeProfile = resolveDesktopRuntimeProfile({
    environment: process.env,
    isPackaged: app.isPackaged,
    appDataPath: app.getPath("appData"),
  });
  mkdirSync(runtimeProfile.userDataPath, { recursive: true });
  app.setPath("userData", runtimeProfile.userDataPath);
  if (runtimeProfile.mode === "smoke" && runtimeProfile.sourceOnly) {
    // This source-only probe runs inside restricted CI/agent desktops where
    // Chromium's Windows child-process sandbox may be unavailable. Packaged
    // builds can never enter this branch and keep the production sandbox.
    app.commandLine.appendSwitch("no-sandbox");
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("disable-gpu");
    app.commandLine.appendSwitch("disable-gpu-sandbox");
  }
} catch (error) {
  earlyInitializationFailed = true;
  console.error(`[Relationship Echo] data directory setup failed (${safeErrorKind(error)})`);
  dialog.showErrorBox(
    "关系回响无法启动",
    "无法创建本地数据目录。请检查磁盘空间和“应用程序支持”目录的权限后重新打开应用。",
  );
}

let mainWindow = null;
let localServer = null;
let localServerOrigin = null;
let desktopUrl = null;
let serverStartPromise = null;
let serverClosePromise = null;
let windowCreationPromise = null;
let quitCleanupStarted = false;
let quitAfterCleanup = false;
let startupFailureHandled = false;
let pendingSmokeResult = null;
let smokeResultEmitted = false;

function emitSmokeResult(result) {
  if (runtimeProfile?.mode !== "smoke" || smokeResultEmitted) return;
  smokeResultEmitted = true;
  process.stdout.write(`[relationship-echo-smoke] ${JSON.stringify(publicSmokeResult({
    ...result,
    sourceOnly: runtimeProfile.sourceOnly,
  }))}\n`);
}

function configureSessionSecurity() {
  const appSession = session.defaultSession;
  appSession.setPermissionCheckHandler(() => false);
  appSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  appSession.setDevicePermissionHandler(() => false);
}

async function ensureLocalServer() {
  if (localServer) return;
  if (serverStartPromise) return serverStartPromise;

  serverStartPromise = (async () => {
    const sessionSecret = randomBytes(32).toString("hex");
    const startedServer = await createLocalServer({
      dataDir: app.getPath("userData"),
      host: "127.0.0.1",
      port: 0,
      sessionSecret,
    });

    localServer = startedServer;
    localServerOrigin = new URL(startedServer.origin).origin;
    const initialUrl = new URL("/", localServerOrigin);
    initialUrl.searchParams.set("desktopToken", sessionSecret);
    desktopUrl = initialUrl.toString();
  })();

  try {
    await serverStartPromise;
  } finally {
    serverStartPromise = null;
  }
}

function closeLocalServerOnce() {
  if (serverClosePromise) return serverClosePromise;
  serverClosePromise = Promise.resolve(serverStartPromise)
    .catch(() => undefined)
    .then(() => localServer?.close())
    .finally(() => {
      localServer = null;
      localServerOrigin = null;
      desktopUrl = null;
    });
  return serverClosePromise;
}

async function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  if (windowCreationPromise) return windowCreationPromise;
  if (quitCleanupStarted || quitAfterCleanup) return null;

  windowCreationPromise = createMainWindowOnce();
  try {
    return await windowCreationPromise;
  } finally {
    windowCreationPromise = null;
  }
}

async function createMainWindowOnce() {
  await ensureLocalServer();
  if (quitCleanupStarted || quitAfterCleanup) return null;

  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: "#eef6f5",
    show: false,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: PRELOAD_PATH,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      webviewTag: false,
    },
  });

  mainWindow = window;

  const enforceNavigationPolicy = (event, detailsOrUrl) => {
    preventUnexpectedNavigation(event, detailsOrUrl, localServerOrigin);
  };
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", enforceNavigationPolicy);
  window.webContents.on("will-redirect", enforceNavigationPolicy);
  window.webContents.on("will-frame-navigate", enforceNavigationPolicy);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
  window.once("ready-to-show", () => {
    if (runtimeProfile?.mode !== "smoke"
      && !quitCleanupStarted && !quitAfterCleanup && !window.isDestroyed()) window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  await window.loadURL(desktopUrl);
  if (runtimeProfile?.mode === "smoke") {
    const repository = localServer?.repository;
    const backup = repository ? await repository.createBackup("electron-smoke") : null;
    const dataRoot = repository?.dataDir;
    const databasePath = repository?.databasePath;
    const backupPath = backup?.backupPath;
    const databaseAndBackupsShareRoot = Boolean(
      dataRoot
      && databasePath
      && backupPath
      && dirname(databasePath) === dataRoot
      && dirname(dirname(backupPath)) === dataRoot,
    );
    const databaseExists = Boolean(databasePath && existsSync(databasePath));
    const backupExists = Boolean(backupPath && existsSync(backupPath));
    const rendererSandboxRequested = window.webContents.getLastWebPreferences().sandbox === true;
    const noSandboxSwitchAbsent = !app.commandLine.hasSwitch("no-sandbox")
      && !app.commandLine.hasSwitch("disable-setuid-sandbox");
    const runtimeSecuritySatisfied = rendererSandboxRequested
      && (runtimeProfile.sourceOnly || noSandboxSwitchAbsent);
    pendingSmokeResult = {
      ok: databaseAndBackupsShareRoot && databaseExists && backupExists && runtimeSecuritySatisfied,
      rendererSandboxRequested,
      noSandboxSwitchAbsent,
      databaseExists,
      backupExists,
      databaseAndBackupsShareRoot,
    };
    if (!pendingSmokeResult.ok) process.exitCode = 1;
    setTimeout(() => app.quit(), 50).unref?.();
  }
  return window;
}

async function handleStartupFailure(error) {
  if (startupFailureHandled) return;
  startupFailureHandled = true;
  quitCleanupStarted = true;

  console.error(`[Relationship Echo] startup failed (${safeErrorKind(error)})`);
  if (runtimeProfile?.mode === "smoke") {
    process.exitCode = 1;
  } else {
    dialog.showErrorBox(
      "关系回响无法启动",
      "本地数据服务没有成功启动。请重新打开应用；如果问题持续，请保留应用日志并联系维护人员。",
    );
  }

  try {
    await closeLocalServerOnce();
  } catch (closeError) {
    console.error(`[Relationship Echo] cleanup failed (${safeErrorKind(closeError)})`);
  }

  emitSmokeResult({ ok: false });

  quitAfterCleanup = true;
  app.quit();
}

const hasSingleInstanceLock = !earlyInitializationFailed && app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }

    if (app.isReady()) void createMainWindow().catch(handleStartupFailure);
  });

  app.on("before-quit", (event) => {
    if (quitAfterCleanup) return;

    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;

    void closeLocalServerOnce()
      .then(() => {
        if (runtimeProfile?.mode !== "smoke") return;
        const result = pendingSmokeResult || { ok: false };
        if (!result.ok) process.exitCode = 1;
        emitSmokeResult(result);
      })
      .catch((error) => {
        console.error(`[Relationship Echo] shutdown cleanup failed (${safeErrorKind(error)})`);
        if (runtimeProfile?.mode === "smoke") {
          process.exitCode = 1;
          emitSmokeResult({ ok: false });
        }
      })
      .finally(() => {
        quitAfterCleanup = true;
        app.quit();
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow().catch(handleStartupFailure);
    }
  });

  void app
    .whenReady()
    .then(() => {
      configureSessionSecurity();
      return createMainWindow();
    })
    .catch(handleStartupFailure);
}
