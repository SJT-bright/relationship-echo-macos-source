import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const ELECTRON_SMOKE_ENV = "RELATIONSHIP_ECHO_ELECTRON_SMOKE";
export const PACKAGED_ELECTRON_SMOKE_ENV = "RELATIONSHIP_ECHO_PACKAGED_SMOKE";
export const ELECTRON_SMOKE_RUN_ID_ENV = "RELATIONSHIP_ECHO_ELECTRON_SMOKE_RUN_ID";
export const SMOKE_DIRECTORY_PREFIX = "relationship-echo-electron-smoke-";
const USER_DATA_DIRECTORY = "Relationship Echo";
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/;

function profileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isContainedBy(parentPath, childPath) {
  const relativePath = relative(parentPath, childPath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

function readBinarySwitch(environment, name) {
  const value = environment[name];
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw profileError("SMOKE_CONFIG_INVALID", `${name} 只能是 0 或 1。`);
}

export function resolveDesktopRuntimeProfile({
  environment = process.env,
  isPackaged,
  appDataPath,
  temporaryRoot = tmpdir(),
  createTemporaryDirectory = mkdtempSync,
} = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw profileError("SMOKE_CONFIG_INVALID", "桌面运行环境配置无效。");
  }
  if (typeof isPackaged !== "boolean") {
    throw profileError("SMOKE_CONFIG_INVALID", "缺少桌面发行状态。");
  }
  if (typeof appDataPath !== "string" || !isAbsolute(appDataPath)) {
    throw profileError("SMOKE_CONFIG_INVALID", "桌面数据根目录必须是绝对路径。");
  }

  const sourceSmokeRequested = readBinarySwitch(environment, ELECTRON_SMOKE_ENV);
  const packagedSmokeRequested = readBinarySwitch(environment, PACKAGED_ELECTRON_SMOKE_ENV);
  if (sourceSmokeRequested && packagedSmokeRequested) {
    throw profileError("SMOKE_CONFIG_INVALID", "源码和发行版 smoke 不能同时启用。");
  }

  const smokeRequested = sourceSmokeRequested || packagedSmokeRequested;
  const runId = environment[ELECTRON_SMOKE_RUN_ID_ENV];
  if (!smokeRequested) {
    if (runId !== undefined && runId !== "") {
      throw profileError("SMOKE_CONFIG_INVALID", "未启用 smoke 时不能提供运行标识。");
    }
    return Object.freeze({
      mode: "standard",
      sourceOnly: false,
      userDataPath: join(resolve(appDataPath), USER_DATA_DIRECTORY),
    });
  }

  if (sourceSmokeRequested && isPackaged) {
    throw profileError("SOURCE_SMOKE_REQUIRES_SOURCE", "源码 smoke 不能在发行版中运行。");
  }
  if (packagedSmokeRequested && !isPackaged) {
    throw profileError("PACKAGED_SMOKE_REQUIRES_PACKAGED", "发行版 smoke 只能在最终 App 中运行。");
  }
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw profileError("SMOKE_RUN_ID_INVALID", "smoke 运行标识无效。");
  }

  const resolvedTemporaryRoot = resolve(temporaryRoot);
  const ownedPrefix = `${SMOKE_DIRECTORY_PREFIX}${runId}-`;
  const prefixPath = join(resolvedTemporaryRoot, ownedPrefix);
  const createdPath = resolve(createTemporaryDirectory(prefixPath));
  const relativeCreatedPath = relative(resolvedTemporaryRoot, createdPath);
  if (!isContainedBy(resolvedTemporaryRoot, createdPath)
    || relativeCreatedPath.includes(sep)
    || !relativeCreatedPath.startsWith(ownedPrefix)) {
    throw profileError("SMOKE_PATH_ESCAPE", "内部 smoke 目录没有位于本轮拥有的系统临时目录中。");
  }

  return Object.freeze({
    mode: "smoke",
    sourceOnly: sourceSmokeRequested,
    userDataPath: createdPath,
  });
}

export function publicSmokeResult({
  ok,
  sourceOnly,
  rendererSandboxRequested,
  noSandboxSwitchAbsent,
  databaseExists,
  backupExists,
  databaseAndBackupsShareRoot,
} = {}) {
  return Object.freeze({
    event: "electron-smoke-result",
    version: 2,
    ok: ok === true,
    sourceOnly: sourceOnly === true,
    appCreatedTemporaryRoot: true,
    rendererSandboxRequested: rendererSandboxRequested === true,
    noSandboxSwitchAbsent: noSandboxSwitchAbsent === true,
    databaseExists: databaseExists === true,
    backupExists: backupExists === true,
    databaseAndBackupsShareRoot: databaseAndBackupsShareRoot === true,
  });
}
