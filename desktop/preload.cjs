"use strict";

const { contextBridge } = require("electron");

const PLATFORM_NAMES = Object.freeze({
  darwin: "macos",
  win32: "windows",
  linux: "linux",
});

const desktopInfo = Object.freeze({
  platform: PLATFORM_NAMES[process.platform] ?? "unsupported",
  versions: Object.freeze({
    electron: String(process.versions.electron ?? "unknown"),
    chromium: String(process.versions.chrome ?? "unknown"),
  }),
});

contextBridge.exposeInMainWorld("relationshipEcho", desktopInfo);
