import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import electronPath from "electron";
import {
  ELECTRON_SMOKE_ENV,
  ELECTRON_SMOKE_RUN_ID_ENV,
  PACKAGED_ELECTRON_SMOKE_ENV,
  SMOKE_DIRECTORY_PREFIX,
} from "../desktop/smoke-profile.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = resolve(tmpdir());
const outputLimit = 1024 * 1024;
const smokeMarker = "[relationship-echo-smoke] ";

function isContainedBy(parentPath, childPath) {
  const relativePath = relative(parentPath, childPath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") > outputLimit) {
    throw new Error("Electron smoke 输出超过安全上限。");
  }
  return next;
}

function resolveInvocation(argumentsList) {
  if (argumentsList.length === 0) {
    return {
      executable: electronPath,
      arguments: [projectRoot],
      sourceOnly: true,
      label: "源码",
    };
  }
  if (argumentsList.length !== 2 || argumentsList[0] !== "--packaged-app") {
    throw new Error("用法：run-electron-smoke.mjs [--packaged-app /绝对路径/关系回响.app]");
  }
  if (process.platform !== "darwin") {
    throw new Error("最终 Mac App smoke 只能在 macOS 上运行。");
  }

  const requestedApp = argumentsList[1];
  if (!isAbsolute(requestedApp) || basename(requestedApp) !== "关系回响.app") {
    throw new Error("最终 App 必须是 dist 内名为“关系回响.app”的绝对路径。");
  }
  if (lstatSync(requestedApp).isSymbolicLink()) {
    throw new Error("最终 App 路径不能是符号链接。");
  }

  const trustedProjectRoot = realpathSync(projectRoot);
  const logicalDistRoot = join(projectRoot, "dist");
  const logicalDistInfo = lstatSync(logicalDistRoot);
  if (!logicalDistInfo.isDirectory() || logicalDistInfo.isSymbolicLink()) {
    throw new Error("当前项目的 dist 必须是真实目录，不能是符号链接。");
  }
  const distRoot = realpathSync(logicalDistRoot);
  if (!isContainedBy(trustedProjectRoot, distRoot)) {
    throw new Error("当前项目的 dist 目录逃出了项目根目录。");
  }
  const packagedApp = realpathSync(requestedApp);
  if (!isContainedBy(distRoot, packagedApp)) {
    throw new Error("最终 App 必须位于当前项目的 dist 目录内。");
  }

  const executable = join(packagedApp, "Contents", "MacOS", "关系回响");
  const executableInfo = lstatSync(executable);
  if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) {
    throw new Error("最终 App 的主可执行文件无效。");
  }
  const resolvedExecutable = realpathSync(executable);
  if (!isContainedBy(packagedApp, resolvedExecutable)) {
    throw new Error("最终 App 的主可执行文件逃出了 App 包。");
  }

  return {
    executable: resolvedExecutable,
    arguments: [],
    sourceOnly: false,
    label: "最终 Mac App",
  };
}

function unixProcessGroupExists(pid) {
  if (process.platform === "win32" || !pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function childHasClosed(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildClose(child, timeoutMs) {
  if (childHasClosed(child)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolveWait(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
  });
}

async function waitForOwnedProcessTree(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = process.platform === "win32"
      ? !childHasClosed(child)
      : unixProcessGroupExists(child.pid);
    if (!active) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return process.platform === "win32"
    ? childHasClosed(child)
    : !unixProcessGroupExists(child.pid);
}

function createOwnedProcessTerminator(child) {
  let terminationPromise = null;
  return function terminateOwnedProcess() {
    if (terminationPromise) return terminationPromise;
    terminationPromise = (async () => {
      if (!child.pid) return;
      const treeActive = process.platform === "win32"
        ? !childHasClosed(child)
        : unixProcessGroupExists(child.pid);
      if (!treeActive) return;

      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }

      if (await waitForOwnedProcessTree(child, 3_000)) return;
      if (process.platform === "win32") {
        try { child.kill("SIGKILL"); } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      if (!await waitForOwnedProcessTree(child, 3_000)) {
        throw new Error("Electron smoke 归属进程树未在安全时限内退出。");
      }
      await waitForChildClose(child, 500);
    })();
    return terminationPromise;
  };
}

function cleanupOwnedSmokeDirectories(ownedPrefix) {
  const failures = [];
  for (const name of readdirSync(temporaryRoot)) {
    if (!name.startsWith(ownedPrefix)) continue;
    const candidate = resolve(join(temporaryRoot, name));
    const relativePath = relative(temporaryRoot, candidate);
    if (!relativePath || relativePath.includes(sep) || basename(candidate) !== name) continue;
    try {
      const info = lstatSync(candidate);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      rmSync(candidate, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    } catch (error) {
      failures.push({ name, code: error?.code || "CLEANUP_FAILED" });
    }
  }
  return failures;
}

async function main() {
  const invocation = resolveInvocation(process.argv.slice(2));
  const runId = randomBytes(16).toString("hex");
  const ownedPrefix = `${SMOKE_DIRECTORY_PREFIX}${runId}-`;
  const environment = {
    ...process.env,
    [ELECTRON_SMOKE_ENV]: invocation.sourceOnly ? "1" : "0",
    [PACKAGED_ELECTRON_SMOKE_ENV]: invocation.sourceOnly ? "0" : "1",
    [ELECTRON_SMOKE_RUN_ID_ENV]: runId,
  };
  const child = spawn(invocation.executable, invocation.arguments, {
    cwd: projectRoot,
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const terminateOwnedProcess = createOwnedProcessTerminator(child);
  let stdout = "";
  let stderr = "";
  let outputOverflowError = null;
  let timeout = null;
  let signalError = null;
  const signalHandlers = new Map();

  try {
    const exit = await new Promise((resolveExit, rejectExit) => {
      let settled = false;
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        rejectExit(error);
        void terminateOwnedProcess().catch(() => undefined);
      };
      for (const [signalName, exitCode] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
        const handler = () => {
          if (!signalError) {
            signalError = new Error(`Electron smoke 被 ${signalName} 中断。`);
            signalError.exitCode = exitCode;
          }
          process.exitCode = signalError.exitCode;
          rejectOnce(signalError);
          void terminateOwnedProcess().catch(() => undefined);
        };
        signalHandlers.set(signalName, handler);
        process.on(signalName, handler);
      }
      const appendOutput = (streamName, chunk) => {
        if (outputOverflowError) return;
        try {
          if (streamName === "stdout") stdout = appendBounded(stdout, chunk);
          else stderr = appendBounded(stderr, chunk);
        } catch (error) {
          outputOverflowError = error;
          rejectOnce(error);
        }
      };

      child.stdout.on("data", (chunk) => appendOutput("stdout", chunk));
      child.stderr.on("data", (chunk) => appendOutput("stderr", chunk));
      child.once("error", rejectOnce);
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        resolveExit({ code, signal });
      });
      timeout = setTimeout(() => {
        rejectOnce(new Error("Electron smoke 在 30 秒内没有自动退出。"));
      }, 30_000);
      timeout.unref?.();
    });

    if (signalError) throw signalError;
    if (exit.code !== 0) {
      throw new Error(`Electron smoke 退出失败（code=${exit.code}, signal=${exit.signal || "none"}）。`);
    }
    if (/shutdown cleanup failed/i.test(stderr)) {
      throw new Error("Electron smoke 检测到服务或 SQLite 关闭失败。");
    }
    if (!await waitForOwnedProcessTree(child, 3_000)) {
      throw new Error("Electron smoke 主进程退出后仍有归属 helper 进程残留。");
    }
    if (signalError) throw signalError;

    const markerLines = stdout.split(/\r?\n/).filter((line) => line.startsWith(smokeMarker));
    if (markerLines.length !== 1) throw new Error(`Electron smoke 结果数量异常：${markerLines.length}`);
    const result = JSON.parse(markerLines[0].slice(smokeMarker.length));
    const expectedKeys = [
      "appCreatedTemporaryRoot",
      "backupExists",
      "databaseAndBackupsShareRoot",
      "databaseExists",
      "event",
      "noSandboxSwitchAbsent",
      "ok",
      "rendererSandboxRequested",
      "sourceOnly",
      "version",
    ];
    if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expectedKeys)) {
      throw new Error("Electron smoke 公开结果字段超出固定合同。");
    }
    if (result.event !== "electron-smoke-result" || result.version !== 2) {
      throw new Error("Electron smoke 结果版本或事件名称无效。");
    }
    if (!result.ok || result.sourceOnly !== invocation.sourceOnly
      || !result.rendererSandboxRequested
      || result.noSandboxSwitchAbsent !== !invocation.sourceOnly
      || !result.appCreatedTemporaryRoot || !result.databaseExists
      || !result.backupExists || !result.databaseAndBackupsShareRoot) {
      throw new Error("Electron smoke 没有通过数据、备份与运行形态验证。");
    }
    if (/desktopToken|password|contacts|dataDir|databasePath|secret/i.test(markerLines[0])) {
      throw new Error("Electron smoke 公开结果包含不允许的敏感字段。");
    }
    process.stdout.write(`Electron ${invocation.label} smoke 通过：本地服务、SQLite、备份与正常退出均已验证。\n`);
  } catch (error) {
    try {
      await terminateOwnedProcess();
    } catch (terminationError) {
      process.stderr.write(`Electron smoke 进程清理失败：${terminationError.message}\n`);
    }
    const stderrBytes = Buffer.byteLength(stderr, "utf8");
    process.stderr.write(`Electron smoke 失败：${error.message}${stderrBytes ? `；子进程 stderr=${stderrBytes} 字节` : ""}\n`);
    process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : 1;
  } finally {
    if (timeout) clearTimeout(timeout);
    for (const [signalName, handler] of signalHandlers) process.removeListener(signalName, handler);
    const treeStillActive = process.platform === "win32"
      ? !childHasClosed(child)
      : unixProcessGroupExists(child.pid);
    if (treeStillActive) {
      try {
        await terminateOwnedProcess();
      } catch (error) {
        process.stderr.write(`Electron smoke 最终进程清理失败：${error.message}\n`);
        process.exitCode = 1;
      }
    }
    const cleanupFailures = cleanupOwnedSmokeDirectories(ownedPrefix);
    if (cleanupFailures.length) {
      process.stderr.write(`Electron smoke 临时目录清理失败：${JSON.stringify(cleanupFailures)}\n`);
      process.exitCode = 1;
    }
  }
}

await main().catch((error) => {
  process.stderr.write(`Electron smoke 无法启动：${error.message}\n`);
  process.exitCode = 1;
});
