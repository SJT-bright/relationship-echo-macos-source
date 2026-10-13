import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { previewWeFlow, WeFlowAdapterError } from "../server/weflow-adapter.mjs";

const TOKEN = "test-only-token";
const MESSAGE_TIME = Date.parse("2026-08-01T10:00:00+08:00");

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function withFakeWeFlow(handler, run) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { error: error.message });
      else response.destroy(error);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(server.address().port);
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections?.();
    await closed;
  }
}

test("真实走 health/contacts/sessions/messages，并按联系人去重归一化", async () => {
  const requests = [];
  await withFakeWeFlow((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push({ pathname: url.pathname, search: url.search, authorization: request.headers.authorization });
    if (url.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    if (url.pathname === "/api/v1/contacts") {
      assert.equal(url.searchParams.get("limit"), "3000");
      sendJson(response, 200, { contacts: [
        { username: "wxid-alice", displayName: "Alice" },
        { username: "wxid-bob", displayName: "Bob" },
        { username: "family@chatroom", displayName: "群聊" },
        { username: "gh_news", displayName: "公众号" },
      ] });
      return;
    }
    if (url.pathname === "/api/v1/sessions") {
      assert.equal(url.searchParams.get("limit"), "3000");
      sendJson(response, 200, { sessions: [
        { username: "wxid-alice", displayName: "Alice session", lastTimestamp: MESSAGE_TIME },
        { username: "wxid-charlie", displayName: "Charlie", lastTimestamp: MESSAGE_TIME - 1_000, lastMessage: "内嵌摘要" },
        { username: "family@chatroom", displayName: "群聊", lastTimestamp: MESSAGE_TIME },
      ] });
      return;
    }
    if (url.pathname === "/api/v1/messages") {
      assert.equal(url.searchParams.get("talker"), "wxid-alice");
      assert.equal(url.searchParams.get("limit"), "1");
      sendJson(response, 200, { messages: [
        { createTime: MESSAGE_TIME, content: "Alice 最近消息", localType: 1 },
      ] });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  }, async (port) => {
    const result = await previewWeFlow({ port, token: TOKEN });
    assert.equal(result.ok, true);
    assert.equal(result.sourceKind, "weflow-direct");
    assert.equal(result.sourceMeta.port, port);
    assert.equal(result.sourceMeta.contacts, 3);
    assert.equal(result.sourceMeta.partial, false);
    assert.deepEqual(result.contacts.map((contact) => contact.sourceId).sort(), [
      "wxid-alice",
      "wxid-bob",
      "wxid-charlie",
    ]);
    const alice = result.contacts.find((contact) => contact.sourceId === "wxid-alice");
    const charlie = result.contacts.find((contact) => contact.sourceId === "wxid-charlie");
    assert.equal(alice.lastMessageText, "Alice 最近消息");
    assert.equal(alice.lastMessageAt, new Date(MESSAGE_TIME).toISOString());
    assert.equal(alice.source, "weflow-direct");
    assert.equal(charlie.lastMessageText, "内嵌摘要");
    assert.equal(requests.filter((item) => item.pathname === "/api/v1/messages").length, 1);
    assert.equal(requests.find((item) => item.pathname === "/health").authorization, undefined);
  });
});

test("WeFlow 401/403 被明确分类为鉴权失败", async () => {
  await withFakeWeFlow((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/health") sendJson(response, 200, { status: "ok" });
    else if (url.pathname === "/api/v1/contacts") sendJson(response, 401, { error: "unauthorized" });
    else sendJson(response, 200, { sessions: [] });
  }, async (port) => {
    await assert.rejects(
      previewWeFlow({ port, token: "bad-token" }),
      (error) => error instanceof WeFlowAdapterError
        && error.status === 401
        && error.code === "WEFLOW_AUTH_FAILED"
        && /Access Token/.test(error.message),
    );
  });
});

test("联系人与会话各自未超限，但去重并集 3001 人时返回明确 422", async () => {
  const contacts = Array.from({ length: 1_501 }, (_, index) => ({
    username: `wxid-contact-${index}`,
    displayName: `联系人${index}`,
  }));
  const sessions = Array.from({ length: 1_500 }, (_, index) => ({
    username: `wxid-session-${index}`,
    displayName: `会话${index}`,
  }));
  await withFakeWeFlow((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/health") sendJson(response, 200, { status: "ok" });
    else if (url.pathname === "/api/v1/contacts") sendJson(response, 200, { contacts, count: contacts.length });
    else if (url.pathname === "/api/v1/sessions") sendJson(response, 200, { sessions, count: sessions.length });
    else sendJson(response, 500, { error: "messages endpoint should not be reached" });
  }, async (port) => {
    await assert.rejects(
      previewWeFlow({ port, token: TOKEN }),
      (error) => error.status === 422
        && error.code === "CONTACT_LIMIT_EXCEEDED"
        && /去重后仍有 3001 位联系人/.test(error.message),
    );
  });
});

test("无 Content-Length 的 chunked 响应超过 12MB 时按字节上限中止", async () => {
  await withFakeWeFlow((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Transfer-Encoding": "chunked",
    });
    response.write('{"status":"ok","padding":"');
    response.end(`${"x".repeat(12 * 1024 * 1024 + 1)}"}`);
  }, async (port) => {
    const startedAt = Date.now();
    await assert.rejects(
      previewWeFlow({ port, token: TOKEN }),
      (error) => error.status === 413 && error.code === "WEFLOW_RESPONSE_TOO_LARGE",
    );
    assert.ok(Date.now() - startedAt < 5_000, "超限响应不应等到请求超时才失败");
  });
});

test("端口、Token 与调用方取消均有独立错误代码", async () => {
  await assert.rejects(
    previewWeFlow({ port: 0, token: TOKEN }),
    (error) => error.status === 422 && error.code === "INVALID_WEFLOW_PORT",
  );
  await assert.rejects(
    previewWeFlow({ port: 5031, token: "" }),
    (error) => error.status === 422 && error.code === "INVALID_WEFLOW_TOKEN",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    previewWeFlow({ port: 9, token: TOKEN, signal: controller.signal }),
    (error) => error.status === 499 && error.code === "WEFLOW_CANCELLED",
  );
});
