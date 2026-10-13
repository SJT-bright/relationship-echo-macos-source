import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createProbeServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { createLocalServer } from "../server/create-local-server.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = [];
const openServers = [];

function temporaryRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `relationship-care-${label}-`));
  temporaryRoots.push(root);
  return root;
}

async function startFactoryServer(options = {}) {
  const root = temporaryRoot("factory");
  const instance = await createLocalServer({
    dataDir: join(root, "data"),
    rootDir: projectRoot,
    port: 0,
    ...options,
  });
  openServers.push(instance);
  return instance;
}

function request(origin, pathname, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const url = new URL(pathname, origin);
    const req = httpRequest(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolveRequest({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on("error", rejectRequest);
    if (body !== null) req.write(body);
    req.end();
  });
}

function closeProbe(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

after(async () => {
  await Promise.allSettled(openServers.map((instance) => instance.close()));
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("导入 createLocalServer 工厂不会监听端口或创建数据目录", () => {
  const root = temporaryRoot("import");
  const untouchedDataDir = join(root, "must-not-exist");
  const moduleUrl = pathToFileURL(join(projectRoot, "server", "create-local-server.mjs")).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `const loaded = await import(${JSON.stringify(moduleUrl)}); if (typeof loaded.createLocalServer !== "function") process.exitCode = 2;`,
  ], {
    cwd: projectRoot,
    env: { ...process.env, RELATIONSHIP_CARE_DATA_DIR: untouchedDataDir },
    encoding: "utf8",
    timeout: 3_000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(untouchedDataDir), false);
});

test("port=0 返回实际监听端口且无 secret 时保持网页与 API 兼容", async () => {
  const instance = await startFactoryServer();
  assert.ok(Number.isInteger(instance.port) && instance.port > 0);
  assert.equal(instance.origin, `http://127.0.0.1:${instance.port}`);
  assert.equal(instance.server.address().port, instance.port);

  const page = await request(instance.origin, "/");
  const health = await request(instance.origin, "/api/health");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
});

test("启用 desktop secret 后未授权、错误 token 与错误 cookie 均为 403", async () => {
  const sessionSecret = "desktop-session-secret-with-strong-entropy-123";
  const instance = await startFactoryServer({ sessionSecret });

  for (const response of [
    await request(instance.origin, "/"),
    await request(instance.origin, "/api/health"),
    await request(instance.origin, "/?desktopToken=wrong-token"),
    await request(instance.origin, "/", { headers: { Cookie: "relationship_echo_session=wrong-cookie" } }),
  ]) {
    assert.equal(response.status, 403);
    assert.equal(response.json.code, "DESKTOP_SESSION_FORBIDDEN");
    assert.doesNotMatch(`${JSON.stringify(response.headers)}${response.text}`, new RegExp(sessionSecret));
  }
});

test("正确 desktop bootstrap 设置严格 HttpOnly cookie、清除 URL 并授权静态页与 API", async () => {
  const sessionSecret = "desktop-session-secret-for-bootstrap-456789";
  const instance = await startFactoryServer({ sessionSecret });
  const bootstrap = await request(instance.origin, `/?desktopToken=${encodeURIComponent(sessionSecret)}`);

  assert.equal(bootstrap.status, 302);
  assert.equal(bootstrap.headers.location, "/");
  const setCookie = String(bootstrap.headers["set-cookie"] || "");
  assert.match(setCookie, /^relationship_echo_session=[A-Za-z0-9_-]+;/);
  assert.match(setCookie, /; HttpOnly;/i);
  assert.match(setCookie, /; SameSite=Strict;/i);
  assert.match(setCookie, /; Path=\//i);
  assert.doesNotMatch(setCookie, new RegExp(sessionSecret));

  const cookie = setCookie.split(";", 1)[0];
  const page = await request(instance.origin, "/", { headers: { Cookie: cookie } });
  const health = await request(instance.origin, "/api/health", { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
});

test("close 幂等地释放动态端口并关闭 SQLite", async () => {
  const instance = await startFactoryServer();
  const { port } = instance;
  const firstClose = instance.close();
  const secondClose = instance.close();
  assert.strictEqual(secondClose, firstClose);
  await firstClose;

  assert.equal(instance.server.listening, false);
  assert.throws(() => instance.repository.loadState());

  const probe = createProbeServer();
  await new Promise((resolveListening, rejectListening) => {
    probe.once("error", rejectListening);
    probe.listen(port, "127.0.0.1", resolveListening);
  });
  await closeProbe(probe);
});

test("close 会在宽限期后中止半包请求，等待 handler 结束再关闭 SQLite", async () => {
  const lifecycle = [];
  const instance = await startFactoryServer({
    shutdownGraceMs: 50,
    onLifecycleEvent: (event) => lifecycle.push(event),
  });
  const requestSeen = new Promise((resolveRequest) => instance.server.once("request", resolveRequest));
  const url = new URL("/api/state", instance.origin);
  const stalled = httpRequest(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": "100",
      Origin: instance.origin,
    },
  });
  stalled.on("error", () => {});
  stalled.write("{");
  await requestSeen;

  await Promise.race([
    instance.close(),
    new Promise((_, rejectTimeout) => setTimeout(
      () => rejectTimeout(new Error("server close timed out with a stalled request")),
      1_000,
    )),
  ]);

  assert.equal(instance.server.listening, false);
  assert.throws(() => instance.repository.loadState());
  assert.ok(lifecycle.some((event) => event.phase === "force-closing-connections"));
  assert.equal(lifecycle.at(-1)?.phase, "repository-closed");
  assert.equal(lifecycle.at(-1)?.activeRequests, 0);
  stalled.destroy();
});
