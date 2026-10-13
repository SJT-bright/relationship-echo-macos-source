import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const SMOKE_PREFIX = "relationship-echo-electron-smoke-";

function waitForClose(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function waitForOwnedProfile(root, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(root) && readdirSync(root).some((name) => name.startsWith(SMOKE_PREFIX))) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Electron smoke 在创建本轮隔离 profile 前已经退出。");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("等待 Electron smoke 创建本轮隔离 profile 超时。");
}

test("macOS POSIX signal bridge 终止 detached smoke 进程树并清理本轮 profile", {
  skip: process.platform === "darwin"
    ? false
    : "当前主机不是 macOS；仅保留 desktop-contract 的静态信号合同，真实 detached 进程组信号由 Mac 构建阶段验证。",
  timeout: 35_000,
}, async () => {
  const ownedTemporaryRoot = mkdtempSync(join(tmpdir(), "relationship-echo-signal-test-"));
  let child = null;
  try {
    child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "run-electron-smoke.mjs")], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, TMPDIR: ownedTemporaryRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const closed = waitForClose(child);
    await waitForOwnedProfile(ownedTemporaryRoot, child);
    assert.equal(child.kill("SIGTERM"), true, "必须把 SIGTERM 交给 smoke harness 的 signal bridge");
    const exit = await closed;

    assert.equal(exit.signal, null, "harness 应捕获信号并以约定退出码结束，而不是被信号直接杀死");
    assert.equal(exit.code, 143);
    assert.match(stderr, /Electron smoke 被 SIGTERM 中断/);
    assert.deepEqual(readdirSync(ownedTemporaryRoot), [], "harness 只能清理本轮 TMPDIR 内自己创建的 profile");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(ownedTemporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
