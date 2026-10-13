import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer as createProbeServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { createDemoState } from "../src/data.js";

// HTTP 黑盒测试：服务只使用隔离临时目录，绝不接触正式 relationship-care-data。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-08-23T12:00:00+08:00");
let port;
let serverProcess;
let testDataDir;
let startupOutput = "";

function request(pathname, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = httpRequest({ hostname: "127.0.0.1", port, path: pathname, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const json = (response.headers["content-type"] || "").includes("application/json") && text ? JSON.parse(text) : null;
        resolveRequest({ status: response.statusCode, headers: response.headers, body: text, json });
      });
    });
    outgoing.on("error", rejectRequest);
    outgoing.end(body);
  });
}

function jsonRequest(pathname, { method = "GET", body, headers = {} } = {}) {
  const serialized = body === undefined ? null : JSON.stringify(body);
  return request(pathname, {
    method,
    body: serialized,
    headers: { Accept: "application/json", ...(serialized === null ? {} : { "Content-Type": "application/json" }), ...headers },
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function backupFiles() {
  return readdirSync(join(testDataDir, "backups")).filter((name) => name.endsWith(".sqlite"));
}

before(async () => {
  testDataDir = mkdtempSync(join(tmpdir(), "relationship-care-server-test-"));
  const probe = createProbeServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  port = probe.address().port;
  probe.close();
  await once(probe, "close");

  serverProcess = spawn(process.execPath, ["server.mjs", "--port", String(port)], {
    cwd: projectRoot,
    env: { ...process.env, RELATIONSHIP_CARE_DATA_DIR: testDataDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stdout.setEncoding("utf8");
  serverProcess.stderr.setEncoding("utf8");
  await new Promise((resolveStartup, rejectStartup) => {
    const timeout = setTimeout(() => rejectStartup(new Error("server startup timed out")), 5_000);
    let stderr = "";
    serverProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    serverProcess.once("exit", (code) => {
      clearTimeout(timeout);
      rejectStartup(new Error(`server exited before startup (${code}): ${stderr}`));
    });
    serverProcess.stdout.on("data", (chunk) => {
      startupOutput += chunk;
      if (!startupOutput.includes("已启动") || !startupOutput.includes("数据目录")) return;
      clearTimeout(timeout);
      resolveStartup();
    });
  });
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = once(serverProcess, "exit");
    serverProcess.kill();
    await exited;
  }
  if (testDataDir) rmSync(testDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test("测试服务明确使用隔离临时 SQLite 目录", () => {
  assert.ok(startupOutput.includes(testDataDir));
  assert.doesNotMatch(startupOutput, /relationship-care-data/);
});

test("静态白名单返回正确 MIME，生产源码不公开", async () => {
  for (const [pathname, expected] of [["/", /^text\/html/], ["/styles.css", /^text\/css/], ["/src/app.js", /^text\/javascript/], ["/src/batch-undo.js", /^text\/javascript/], ["/samples/contacts.sample.json", /^application\/json/]]) {
    const response = await request(pathname);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers["content-type"], expected, pathname);
  }
  for (const privatePath of ["/server.mjs", "/server/state-repository.mjs", "/package.json", "/.git/config"]) {
    assert.equal((await request(privatePath)).status, 404, privatePath);
  }
});

test("生成式 WebP 外观资产由静态白名单以正确 MIME 提供", async () => {
  for (const pathname of [
    "/assets/appearance/backgrounds/echo-glass-dark-portrait.webp",
    "/assets/appearance/skins/control-primary.webp",
    "/assets/appearance/illustrations/contact-source.webp",
    "/assets/appearance/contact/contact-card-surface-v2.webp",
    "/assets/appearance/contact/avatar-echo-medallion-v2.webp",
    "/assets/appearance/contact/contact-action-primary-v2.webp",
    "/assets/appearance/contact/contact-action-secondary-v2.webp",
    "/assets/appearance/contact/brand-echo-flourish-v2.webp",
  ]) {
    const response = await request(pathname);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers["content-type"], /^image\/webp$/, pathname);
    assert.ok(response.body.length > 0, pathname);
  }
});

test("联系人来源目录公开跨平台描述，旧 WeFlow alias 仍可达且 405 Allow 准确", async () => {
  const catalog = await jsonRequest("/api/contact-sources");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.json.contractVersion, 1);
  assert.deepEqual(catalog.json.sources.map((source) => source.id), [
    "weflow-http-win32",
    "portable-contact-file",
    "mac-reader-bridge",
  ]);
  for (const source of catalog.json.sources) {
    assert.ok(source.displayName);
    assert.ok(source.description);
    assert.ok(source.capabilities.includes("contacts"));
  }
  const weflow = catalog.json.sources.find((source) => source.id === "weflow-http-win32");
  const portable = catalog.json.sources.find((source) => source.id === "portable-contact-file");
  const mac = catalog.json.sources.find((source) => source.id === "mac-reader-bridge");
  assert.equal(weflow.supportedOnHost, process.platform === "win32");
  assert.equal(portable.supportedOnHost, true);
  assert.equal(mac.supportedOnHost, process.platform === "darwin");

  const catalogWrongMethod = await jsonRequest("/api/contact-sources", { method: "POST", body: {} });
  assert.equal(catalogWrongMethod.status, 405);
  assert.equal(catalogWrongMethod.headers.allow, "GET");

  const providerWrongMethod = await jsonRequest("/api/contact-sources/weflow-http-win32/preview");
  assert.equal(providerWrongMethod.status, 405);
  assert.equal(providerWrongMethod.headers.allow, "POST");

  for (const method of ["GET", "PUT", "DELETE"]) {
    const aliasWrongMethod = await jsonRequest("/api/weflow/preview", { method });
    assert.equal(aliasWrongMethod.status, 405, method);
    assert.equal(aliasWrongMethod.headers.allow, "POST", method);
    assert.equal(aliasWrongMethod.json.code, "METHOD_NOT_ALLOWED", method);
  }

  const alias = await jsonRequest("/api/weflow/preview", { method: "POST", body: {} });
  if (process.platform === "win32") {
    assert.equal(alias.status, 422);
    assert.equal(alias.json.code, "INVALID_WEFLOW_TOKEN");
  } else {
    assert.equal(alias.status, 409);
    assert.equal(alias.json.code, "CONTACT_SOURCE_PLATFORM_UNSUPPORTED");
  }
  assert.notEqual(alias.json.code, "NOT_FOUND", "旧 WeFlow alias 必须继续路由到通用 provider");
});

test("联系人来源 HTTP 预览将 null 配置返回 422 而不是 500", { skip: process.platform !== "win32" }, async () => {
  const response = await jsonRequest("/api/contact-sources/weflow-http-win32/preview", { method: "POST", body: null });
  assert.equal(response.status, 422);
  assert.equal(response.json.code, "INVALID_CONTACT_SOURCE_CONFIGURATION");
  assert.notEqual(response.status, 500);
});

test("浏览器入口递归 import、re-export 与动态 import 的完整模块图都能由生产白名单提供", async () => {
  const pending = ["/src/app.js"];
  const visited = new Set();
  while (pending.length) {
    const pathname = pending.pop();
    if (visited.has(pathname)) continue;
    visited.add(pathname);
    const response = await request(pathname);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers["content-type"], /^text\/javascript/, pathname);
    const specifiers = [
      ...response.body.matchAll(/\bfrom\s+["']([^"']+)["']/g),
      ...response.body.matchAll(/\bimport\s+["']([^"']+)["']/g),
      ...response.body.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      // 没有 import map；浏览器入口的每个模块必须是可由同源静态白名单直接提供的相对路径。
      assert.match(specifier, /^\.\.?\//, `${pathname} 的模块引用不是相对路径：${specifier}`);
      pending.push(new URL(specifier, `http://localhost${pathname}`).pathname);
    }
  }
  assert.deepEqual([...visited].sort(), [
    "/src/app.js",
    "/src/background-prompt.js",
    "/src/batch-undo.js",
    "/src/contact-selection.js",
    "/src/data.js",
    "/src/domain.js",
    "/src/importer.js",
    "/src/limits.js",
    "/src/local-api.js",
    "/src/storage.js",
    "/src/visual-theme.js",
  ]);
});

test("静态和 API 响应设置安全头", async () => {
  for (const pathname of ["/", "/api/health"]) {
    const response = await request(pathname);
    assert.match(response.headers["content-security-policy"], /default-src 'self'/);
    assert.match(response.headers["content-security-policy"], /connect-src 'self'/);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
  }
});

test("HEAD 无实体，静态 POST 返回 405 和 Allow", async () => {
  const head = await request("/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  const post = await request("/", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
});

test("畸形 URL 返回 JSON 400 且服务继续可用", async () => {
  const malformed = await request("/%E0%A4%A");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.code, "MALFORMED_URL");
  assert.equal(malformed.json.error, "Bad request");
  assert.equal((await request("/")).status, 200);
});

test("API 未知路由、非法 JSON、媒体类型和方法均返回 JSON 错误", async () => {
  assert.equal((await jsonRequest("/api/unknown")).json.code, "NOT_FOUND");
  const malformed = await request("/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{broken" });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.code, "INVALID_JSON");
  const wrongType = await request("/api/state", { method: "PUT", body: "{}" });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.json.code, "UNSUPPORTED_MEDIA_TYPE");
  const wrongMethod = await jsonRequest("/api/state", { method: "POST", body: {} });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "GET, PUT");
});

test("API 拒绝异常 Host 和跨来源写入", async () => {
  const wrongHost = await request("/api/health", { headers: { Host: "attacker.example" } });
  assert.equal(wrongHost.status, 403);
  assert.equal(wrongHost.json.code, "INVALID_HOST");
  const wrongOrigin = await jsonRequest("/api/state", { method: "PUT", body: { state: createDemoState(NOW), expectedChangeId: null }, headers: { Origin: "https://attacker.example" } });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.json.code, "INVALID_ORIGIN");
});

test("同一基线的两个 CAS 写入只有一个成功、另一个 409", async () => {
  const initial = await jsonRequest("/api/state", { method: "PUT", body: { state: createDemoState(NOW), expectedChangeId: null } });
  assert.equal(initial.status, 200);
  assert.equal(initial.json.storage.authority, "sqlite");
  const expectedChangeId = initial.json.state.changeId;
  const left = clone(initial.json.state);
  const right = clone(initial.json.state);
  left.dataMode = "cas-left";
  right.dataMode = "cas-right";
  const responses = await Promise.all([
    jsonRequest("/api/state", { method: "PUT", body: { state: left, expectedChangeId } }),
    jsonRequest("/api/state", { method: "PUT", body: { state: right, expectedChangeId } }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const winner = responses.find((response) => response.status === 200).json.state;
  const conflict = responses.find((response) => response.status === 409).json;
  assert.equal(conflict.code, "STATE_CONFLICT");
  assert.equal(conflict.details.currentState.changeId, winner.changeId);
});

test("destructive 先创建快照，但不会绕过 expectedChangeId", async () => {
  const current = (await jsonRequest("/api/state")).json.state;
  const replacement = { ...clone(current), dataMode: "destructive-replacement" };
  const accepted = await jsonRequest("/api/state", { method: "PUT", body: { state: replacement, expectedChangeId: current.changeId, destructive: true } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.backupCreated, true);

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  const backupsBefore = backupFiles().length;
  const stale = { ...clone(accepted.json.state), dataMode: "must-not-win" };
  const conflict = await jsonRequest("/api/state", { method: "PUT", body: { state: stale, expectedChangeId: "stale-change-id", destructive: true } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "STATE_CONFLICT");
  assert.ok(backupFiles().length > backupsBefore);
  const unchanged = (await jsonRequest("/api/state")).json.state;
  assert.equal(unchanged.changeId, accepted.json.state.changeId);
  assert.equal(unchanged.dataMode, "destructive-replacement");
});

test("无效状态返回 422 且 SQLite 状态不变", async () => {
  const before = (await jsonRequest("/api/state")).json.state;
  const invalid = clone(before);
  invalid.contacts[0].maintenanceIntent = "invalid-intent";
  const response = await jsonRequest("/api/state", { method: "PUT", body: { state: invalid, expectedChangeId: before.changeId } });
  assert.equal(response.status, 422);
  assert.equal(response.json.code, "INVALID_STATE");
  assert.equal((await jsonRequest("/api/state")).json.state.changeId, before.changeId);
});

test("批量标签 API 从权威状态推导变化，GET 可恢复公共撤销且不泄露 contactIds", async () => {
  const before = (await jsonRequest("/api/state")).json;
  assert.equal(before.pendingUndo, null);
  assert.equal(Number.isSafeInteger(before.serverNow), true);
  const tag = before.state.tags[0];
  const target = before.state.contacts.find((contact) => !contact.customTagIds.includes(tag.id));
  const response = await jsonRequest("/api/state/batch-tag", {
    method: "POST",
    body: {
      expectedChangeId: before.state.changeId,
      action: "add",
      tagId: tag.id,
      tagName: "伪造名称不会进入权威记录",
      contactIds: [target.id, ...Array.from({ length: 49 }, (_, index) => `unknown-${index}`)],
      scopeLabel: "本页手动勾选 50 人",
      operationId: "10000000-0000-4000-8000-000000000001",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.pendingUndo.id, "10000000-0000-4000-8000-000000000001");
  assert.equal(response.json.batch.changedCount, 1);
  assert.equal(response.json.batch.missingCount, 49);
  assert.equal(response.json.pendingUndo.tagName, tag.name);
  assert.equal(response.json.pendingUndo.stateChangeId, response.json.state.changeId);
  assert.equal(Object.hasOwn(response.json.pendingUndo, "contactIds"), false);
  assert.equal(response.body.includes(target.id), true, "state 本身仍需包含联系人");

  const rejected = await jsonRequest("/api/state/batch-tag", {
    method: "POST",
    body: {
      expectedChangeId: response.json.state.changeId,
      action: "remove",
      tagId: tag.id,
      contactIds: Array.from({ length: 51 }, (_, index) => `too-many-${index}`),
      scopeLabel: "非法 51 人",
      operationId: "10000000-0000-4000-8000-000000000099",
    },
  });
  assert.equal(rejected.status, 422);
  assert.equal(rejected.json.code, "INVALID_BATCH_TAG");
  assert.match(rejected.json.error, /最多包含 50/);
  assert.equal(rejected.json.details.currentState.changeId, response.json.state.changeId);
  assert.equal(rejected.json.details.pendingUndo.id, response.json.pendingUndo.id);

  const recovered = await jsonRequest("/api/state");
  assert.equal(recovered.json.state.changeId, response.json.state.changeId, "51 人请求不得改变权威状态");
  assert.deepEqual(recovered.json.pendingUndo, response.json.pendingUndo);
  assert.equal(Object.hasOwn(recovered.json.pendingUndo, "contactIds"), false);
});

test("批量 HTTP API 拒绝无效 UUID operationId，且保持权威状态与 pending 不变", async (t) => {
  const before = (await jsonRequest("/api/state")).json;
  const tag = before.state.tags[0];
  const target = before.state.contacts[0];
  for (const invalidOperationId of [null, "not-a-uuid", "10000000-0000-3000-8000-000000000001", "10000000-0000-4000-7000-000000000001"]) {
    await t.test(String(invalidOperationId), async () => {
      const response = await jsonRequest("/api/state/batch-tag", {
        method: "POST",
        body: {
          expectedChangeId: before.state.changeId,
          action: target.customTagIds.includes(tag.id) ? "remove" : "add",
          tagId: tag.id,
          contactIds: [target.id],
          scopeLabel: "无效 operationId 不得写入",
          operationId: invalidOperationId,
        },
      });
      assert.equal(response.status, 422);
      assert.equal(response.json.code, "INVALID_BATCH_TAG");
      assert.equal(response.json.details.currentState.changeId, before.state.changeId);
      assert.equal(response.json.details.pendingUndo.id, before.pendingUndo.id);
    });
  }
  const after = (await jsonRequest("/api/state")).json;
  assert.equal(after.state.changeId, before.state.changeId);
  assert.equal(after.pendingUndo.id, before.pendingUndo.id);
});

test("撤销 API 校验旧 ID，并在成功后原子消费 pendingUndo", async () => {
  const current = (await jsonRequest("/api/state")).json;
  const wrong = await jsonRequest("/api/state/batch-tag/undo", {
    method: "POST",
    body: { expectedChangeId: current.state.changeId, undoId: "old-undo-id" },
  });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.code, "UNDO_NOT_FOUND");
  assert.equal(wrong.json.details.currentState.changeId, current.state.changeId);
  assert.equal(wrong.json.details.pendingUndo.id, current.pendingUndo.id);
  assert.equal(Number.isSafeInteger(wrong.json.details.serverNow), true);

  const undone = await jsonRequest("/api/state/batch-tag/undo", {
    method: "POST",
    body: { expectedChangeId: current.state.changeId, undoId: current.pendingUndo.id },
  });
  assert.equal(undone.status, 200);
  assert.equal(undone.json.pendingUndo, null);
  assert.equal(undone.json.clearedUndoId, current.pendingUndo.id);
  assert.equal(undone.json.undone.changedCount, 1);
  assert.equal((await jsonRequest("/api/state")).json.pendingUndo, null);
});

test("第二批替换第一条撤销；普通 PUT 成功清除而 CAS 失败保留", async () => {
  const initial = (await jsonRequest("/api/state")).json;
  const firstTag = initial.state.tags[0];
  const firstTarget = initial.state.contacts.find((contact) => !contact.customTagIds.includes(firstTag.id));
  const first = await jsonRequest("/api/state/batch-tag", { method: "POST", body: {
    expectedChangeId: initial.state.changeId,
    action: "add",
    tagId: firstTag.id,
    contactIds: [firstTarget.id],
    scopeLabel: "第一批",
    operationId: "10000000-0000-4000-8000-000000000002",
  } });
  const secondTag = first.json.state.tags[1];
  const secondTarget = first.json.state.contacts.find((contact) => !contact.customTagIds.includes(secondTag.id));
  const second = await jsonRequest("/api/state/batch-tag", { method: "POST", body: {
    expectedChangeId: first.json.state.changeId,
    action: "add",
    tagId: secondTag.id,
    contactIds: [secondTarget.id],
    scopeLabel: "第二批",
    operationId: "10000000-0000-4000-8000-000000000003",
  } });
  assert.notEqual(second.json.pendingUndo.id, first.json.pendingUndo.id);

  const staleCandidate = clone(second.json.state);
  staleCandidate.dataMode = "stale-must-fail";
  const conflict = await jsonRequest("/api/state", { method: "PUT", body: {
    state: staleCandidate,
    expectedChangeId: first.json.state.changeId,
  } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.details.pendingUndo.id, second.json.pendingUndo.id);

  const ordinary = clone(second.json.state);
  ordinary.dataMode = "ordinary-clears-undo";
  const accepted = await jsonRequest("/api/state", { method: "PUT", body: {
    state: ordinary,
    expectedChangeId: second.json.state.changeId,
  } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.clearedUndoId, second.json.pendingUndo.id);
  assert.equal(accepted.json.pendingUndo, null);
});

test("批量 API 错误也返回最新权威 state、pendingUndo 与 serverNow", async () => {
  const current = (await jsonRequest("/api/state")).json;
  const invalid = await jsonRequest("/api/state/batch-tag", { method: "POST", body: {
    expectedChangeId: current.state.changeId,
    action: "toggle",
    tagId: current.state.tags[0].id,
    contactIds: [current.state.contacts[0].id],
    operationId: "10000000-0000-4000-8000-000000000004",
  } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.json.code, "INVALID_BATCH_TAG");
  assert.equal(invalid.json.details.currentState.changeId, current.state.changeId);
  assert.equal(invalid.json.details.pendingUndo, null);
  assert.equal(Number.isSafeInteger(invalid.json.details.serverNow), true);
});
