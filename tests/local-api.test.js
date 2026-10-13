import assert from "node:assert/strict";
import test from "node:test";

import { createDemoState } from "../src/data.js";
import { buildSourceScopedContactId } from "../src/importer.js";
import {
  LocalApiError,
  applyAuthoritativeBatchTag,
  consumeAuthoritativeBatchUndo,
  loadAuthoritativeState,
  previewContactSource,
  previewWeFlow,
  saveAuthoritativeState,
} from "../src/local-api.js";

async function withMockFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function authoritativePayload(state = null, overrides = {}) {
  return {
    ok: true,
    state,
    pendingUndo: null,
    serverNow: 1_787_630_000_000,
    storage: { authority: "sqlite" },
    ...overrides,
  };
}

function validState(changeId = "change-next") {
  const state = createDemoState(new Date("2026-08-25T12:00:00+08:00"));
  state.changeId = changeId;
  state.revision = 2;
  return state;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function validPendingUndo(state, overrides = {}) {
  const serverNow = 1_787_630_000_000;
  const tag = state.tags[0];
  return {
    id: "10000000-0000-4000-8000-000000000099",
    action: "add",
    tagId: tag.id,
    tagName: tag.name,
    scopeLabel: "全部筛选结果",
    changedCount: 2,
    createdAt: serverNow,
    expiresAt: serverNow + 45_000,
    stateChangeId: state.changeId,
    ...overrides,
  };
}

async function withControlledRequestTimers(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimerId = 1;
  globalThis.setTimeout = (callback, delay) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  try {
    return await run({
      timers,
      fireOnlyTimer() {
        assert.equal(timers.size, 1, "每个 API 请求应只注册一个截止定时器");
        const [id, timer] = timers.entries().next().value;
        timers.delete(id);
        timer.callback();
      },
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

function responseWhoseBodyHangsUntilAbort(signal, bodyReadStarted) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    text() {
      bodyReadStarted.resolve();
      return new Promise((_resolve, reject) => {
        const rejectForAbort = () => reject(signal.reason || new Error("aborted"));
        if (signal.aborted) rejectForAbort();
        else signal.addEventListener("abort", rejectForAbort, { once: true });
      });
    },
  };
}

test("网络断连被分类为 LOCAL_SERVICE_UNAVAILABLE", async () => {
  await withMockFetch(async () => { throw new TypeError("connection refused"); }, async () => {
    await assert.rejects(
      loadAuthoritativeState(),
      (error) => error instanceof LocalApiError
        && error.code === "LOCAL_SERVICE_UNAVAILABLE"
        && error.status === 0
        && /connection refused/.test(error.message),
    );
  });
});

test("响应流读取失败与 JSON 损坏使用不同错误分类", async () => {
  await withMockFetch(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    text: async () => { throw new Error("stream reset"); },
  }), async () => {
    await assert.rejects(
      loadAuthoritativeState(),
      (error) => error.code === "LOCAL_API_RESPONSE_READ_FAILED" && /stream reset/.test(error.message),
    );
  });

  await withMockFetch(async () => new Response("{broken", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }), async () => {
    await assert.rejects(
      loadAuthoritativeState(),
      (error) => error.code === "LOCAL_API_INVALID_RESPONSE" && error.status === 200,
    );
  });
});

test("非 JSON 的 2xx 响应被识别为端口协议错误", async () => {
  await withMockFetch(async () => new Response(JSON.stringify(authoritativePayload()), {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  }), async () => {
    await assert.rejects(
      loadAuthoritativeState(),
      (error) => error.code === "LOCAL_API_PROTOCOL_ERROR" && /类型不是 JSON/.test(error.message),
    );
  });
});

test("HTTP 错误保留服务端状态、代码和冲突详情", async () => {
  const details = { currentState: { changeId: "server-winner" } };
  await withMockFetch(async () => jsonResponse({
    ok: false,
    error: "状态已变化",
    code: "STATE_CONFLICT",
    details,
  }, 409), async () => {
    await assert.rejects(
      saveAuthoritativeState({ schemaVersion: 1 }, "stale"),
      (error) => error instanceof LocalApiError
        && error.status === 409
        && error.code === "STATE_CONFLICT"
        && error.details?.currentState?.changeId === details.currentState.changeId
        && error.message === "状态已变化",
    );
  });
});

test("2xx 成功载荷缺字段时拒绝，不能把半份响应当成权威状态", async () => {
  await withMockFetch(async () => jsonResponse({ ok: true, state: {} }), async () => {
    await assert.rejects(
      loadAuthoritativeState(),
      (error) => error.code === "LOCAL_API_PROTOCOL_ERROR" && /字段不完整/.test(error.message),
    );
  });

  await withMockFetch(async () => jsonResponse({ ok: true, contacts: [], warnings: [] }), async () => {
    await assert.rejects(
      previewWeFlow({ port: 5031, token: "temporary-token" }),
      (error) => error.code === "LOCAL_API_PROTOCOL_ERROR",
    );
  });
});

test("成功请求固定使用 same-origin、no-store 和相对 API 路径", async () => {
  let observed;
  await withMockFetch(async (path, options) => {
    observed = { path, options };
    return jsonResponse(authoritativePayload());
  }, async () => {
    const payload = await loadAuthoritativeState();
    assert.equal(payload.storage.authority, "sqlite");
  });

  assert.equal(observed.path, "/api/state");
  assert.equal(observed.options.credentials, "same-origin");
  assert.equal(observed.options.cache, "no-store");
  assert.equal(observed.options.headers.Accept, "application/json");
});

test("状态响应必须同时携带权威 pendingUndo 与 serverNow", async (t) => {
  for (const [name, payload] of [
    ["缺 pendingUndo", { ok: true, state: null, serverNow: 1, storage: {} }],
    ["缺 serverNow", { ok: true, state: null, pendingUndo: null, storage: {} }],
    ["pendingUndo 类型错误", { ok: true, state: null, pendingUndo: [], serverNow: 1, storage: {} }],
  ]) {
    await t.test(name, async () => {
      await withMockFetch(async () => jsonResponse(payload), async () => {
        await assert.rejects(loadAuthoritativeState(), (error) => error.code === "LOCAL_API_PROTOCOL_ERROR");
      });
    });
  }
});

test("批量整理命令只提交目标联系人并接收服务端权威撤销", async () => {
  let observed;
  const state = validState("change-next");
  const tag = state.tags[0];
  const pendingUndo = {
    id: "10000000-0000-4000-8000-000000000005",
    action: "add",
    tagId: tag.id,
    tagName: tag.name,
    scopeLabel: "全部筛选结果",
    changedCount: 2,
    createdAt: 1_787_630_000_000,
    expiresAt: 1_787_630_045_000,
    stateChangeId: "change-next",
  };
  await withMockFetch(async (path, options) => {
    observed = { path, options };
    return jsonResponse(authoritativePayload(state, {
      pendingUndo,
      batch: { action: "add", tagId: tag.id, changedCount: 2, skippedCount: 0, missingCount: 1 },
    }));
  }, async () => {
    const result = await applyAuthoritativeBatchTag({
      action: "add",
      tagId: tag.id,
      contactIds: ["a", "b", "c"],
      scopeLabel: "全部筛选结果",
      expectedChangeId: "change-old",
      operationId: pendingUndo.id,
    });
    assert.equal(result.pendingUndo.id, pendingUndo.id);
  });
  assert.equal(observed.path, "/api/state/batch-tag");
  assert.equal(observed.options.method, "POST");
  assert.deepEqual(JSON.parse(observed.options.body), {
    action: "add",
    tagId: tag.id,
    contactIds: ["a", "b", "c"],
    scopeLabel: "全部筛选结果",
    expectedChangeId: "change-old",
    operationId: pendingUndo.id,
  });
});

test("撤销命令只提交服务端 undoId 与 changeId，不上传联系人列表", async () => {
  let observedBody;
  await withMockFetch(async (_path, options) => {
    observedBody = JSON.parse(options.body);
    const state = validState("change-undone");
    return jsonResponse(authoritativePayload(state, {
      clearedUndoId: "undo-server",
      undone: { action: "add", tagId: state.tags[0].id, changedCount: 2, skippedCount: 0, missingCount: 0 },
    }));
  }, async () => {
    await consumeAuthoritativeBatchUndo({
      undoId: "undo-server",
      expectedChangeId: "change-batch",
    });
  });
  assert.deepEqual(observedBody, {
    undoId: "undo-server",
    expectedChangeId: "change-batch",
  });
  assert.equal(Object.hasOwn(observedBody, "contactIds"), false);
});

test("请求截止时间覆盖已收到响应头但正文悬挂，且不真实等待 12 秒", async (t) => {
  for (const scenario of [
    { name: "GET 结果可确定为未完成", request: () => loadAuthoritativeState(), outcomeUnknown: false },
    {
      name: "PUT 结果可能已落盘",
      request: () => saveAuthoritativeState(validState("change-write-timeout"), "change-before"),
      outcomeUnknown: true,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const bodyReadStarted = deferred();
      await withControlledRequestTimers(async ({ timers, fireOnlyTimer }) => {
        await withMockFetch(async (_path, options) => responseWhoseBodyHangsUntilAbort(options.signal, bodyReadStarted), async () => {
          const pending = scenario.request();
          await bodyReadStarted.promise;
          assert.equal([...timers.values()][0].delay, 12_000);
          fireOnlyTimer();
          await assert.rejects(
            pending,
            (error) => error instanceof LocalApiError
              && error.code === "LOCAL_API_TIMEOUT"
              && error.details?.outcomeUnknown === scenario.outcomeUnknown,
          );
          assert.equal(timers.size, 0, "完成后必须清理截止定时器");
        });
      });
    });
  }
});

test("写请求在响应读取、JSON 与协议阶段失败均标记结果未知，明确 4xx 拒绝除外", async (t) => {
  const state = validState("change-write-errors");
  const cases = [
    {
      name: "响应正文读取失败",
      response: () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        text: async () => { throw new Error("stream reset after headers"); },
      }),
      code: "LOCAL_API_RESPONSE_READ_FAILED",
      outcomeUnknown: true,
    },
    {
      name: "成功响应 JSON 损坏",
      response: () => new Response("{broken", { status: 200, headers: { "Content-Type": "application/json" } }),
      code: "LOCAL_API_INVALID_RESPONSE",
      outcomeUnknown: true,
    },
    {
      name: "成功响应类型错误",
      response: () => new Response(JSON.stringify(authoritativePayload(state)), { status: 200, headers: { "Content-Type": "text/plain" } }),
      code: "LOCAL_API_PROTOCOL_ERROR",
      outcomeUnknown: true,
    },
    {
      name: "成功响应深层字段错误",
      response: () => jsonResponse(authoritativePayload({})),
      code: "LOCAL_API_PROTOCOL_ERROR",
      outcomeUnknown: true,
    },
    {
      name: "服务明确 422 拒绝",
      response: () => jsonResponse({ ok: false, error: "状态无效", code: "INVALID_STATE", details: { field: "state" } }, 422),
      code: "INVALID_STATE",
      outcomeUnknown: false,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await withMockFetch(async () => scenario.response(), async () => {
        await assert.rejects(
          saveAuthoritativeState(state, "change-before"),
          (error) => error.code === scenario.code
            && (error.details?.outcomeUnknown === true) === scenario.outcomeUnknown,
        );
      });
    });
  }
});

test("权威 state 与 pendingUndo 执行字段级、时间和标签绑定校验", async (t) => {
  const baseState = validState("change-deep-state");
  const basePending = validPendingUndo(baseState);
  const cases = [
    ["state 结构不完整", () => authoritativePayload({})],
    ["pending 泄露 contactIds", () => authoritativePayload(baseState, { pendingUndo: { ...basePending, contactIds: ["secret"] } })],
    ["pending action 非法", () => authoritativePayload(baseState, { pendingUndo: { ...basePending, action: "toggle" } })],
    ["pending tagId 不存在", () => authoritativePayload(baseState, { pendingUndo: { ...basePending, tagId: "missing-tag" } })],
    ["pending tagName 与权威标签不一致", () => authoritativePayload(baseState, { pendingUndo: { ...basePending, tagName: "伪造标签" } })],
    ["pending changeId 与 state 不一致", () => authoritativePayload(baseState, { pendingUndo: { ...basePending, stateChangeId: "another-change" } })],
    ["pending changedCount 为零", () => authoritativePayload(baseState, { pendingUndo: { ...basePending, changedCount: 0 } })],
    ["pending 创建时间不安全", () => authoritativePayload(baseState, { pendingUndo: { ...basePending, createdAt: Number.MAX_SAFE_INTEGER + 1 } })],
    ["pending 截止时间不晚于创建时间", () => authoritativePayload(baseState, { pendingUndo: { ...basePending, expiresAt: basePending.createdAt } })],
    ["pending 已按 serverNow 到期", () => authoritativePayload(baseState, { pendingUndo: { ...basePending, expiresAt: 1_787_630_000_000 } })],
    ["serverNow 非安全时间戳", () => authoritativePayload(baseState, { pendingUndo: basePending, serverNow: -1 })],
  ];

  for (const [name, payloadFactory] of cases) {
    await t.test(name, async () => {
      await withMockFetch(async () => jsonResponse(payloadFactory()), async () => {
        await assert.rejects(loadAuthoritativeState(), (error) => error.code === "LOCAL_API_PROTOCOL_ERROR");
      });
    });
  }
});

test("批量响应绑定 operationId、action、tagId 与计数，任一错配均拒绝", async (t) => {
  const operationId = "10000000-0000-4000-8000-000000000088";
  const state = validState("change-batch-contract");
  const tagId = state.tags[0].id;
  const pendingUndo = validPendingUndo(state, { id: operationId, tagId, tagName: state.tags[0].name });
  const validBatch = { action: "add", tagId, changedCount: 2, skippedCount: 0, missingCount: 1 };
  const cases = [
    ["pending id 不是本次 operationId", { pendingUndo: { ...pendingUndo, id: "10000000-0000-4000-8000-000000000077" }, batch: validBatch }],
    ["batch action 错配", { pendingUndo, batch: { ...validBatch, action: "remove" } }],
    ["batch tagId 错配", { pendingUndo, batch: { ...validBatch, tagId: state.tags[1].id } }],
    ["batch changedCount 与 pending 错配", { pendingUndo, batch: { ...validBatch, changedCount: 1 } }],
    ["batch 三项计数与本次目标人数不一致", { pendingUndo, batch: { ...validBatch, missingCount: 0 } }],
    ["batch skippedCount 超过人数上限", { pendingUndo, batch: { ...validBatch, skippedCount: 3_001 } }],
    ["batch missingCount 为负数", { pendingUndo, batch: { ...validBatch, missingCount: -1 } }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      await withMockFetch(async () => jsonResponse(authoritativePayload(state, overrides)), async () => {
        await assert.rejects(
          applyAuthoritativeBatchTag({
            action: "add",
            tagId,
            contactIds: ["a", "b", "missing"],
            scopeLabel: "全部筛选结果",
            expectedChangeId: "change-before",
            operationId,
          }),
          (error) => error.code === "LOCAL_API_PROTOCOL_ERROR" && error.details?.outcomeUnknown === true,
        );
      });
    });
  }
});

test("撤销响应严格绑定 clearedUndoId、action、tagId 与计数", async (t) => {
  const undoId = "10000000-0000-4000-8000-000000000066";
  const state = validState("change-undone-contract");
  const tagId = state.tags[0].id;
  const validUndone = { action: "add", tagId, changedCount: 2, skippedCount: 0, missingCount: 0 };
  const cases = [
    ["clearedUndoId 错配", { clearedUndoId: "another-undo", undone: validUndone }],
    ["响应仍保留 pendingUndo", { clearedUndoId: undoId, pendingUndo: validPendingUndo(state), undone: validUndone }],
    ["undone action 与请求错配", { clearedUndoId: undoId, undone: { ...validUndone, action: "remove" } }],
    ["undone tagId 与请求错配", { clearedUndoId: undoId, undone: { ...validUndone, tagId: state.tags[1].id } }],
    ["undone changedCount 超限", { clearedUndoId: undoId, undone: { ...validUndone, changedCount: 3_001 } }],
    ["undone skippedCount 为负数", { clearedUndoId: undoId, undone: { ...validUndone, skippedCount: -1 } }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      await withMockFetch(async () => jsonResponse(authoritativePayload(state, overrides)), async () => {
        await assert.rejects(
          consumeAuthoritativeBatchUndo({
            undoId,
            expectedChangeId: "change-batch",
            expectedAction: "add",
            expectedTagId: tagId,
          }),
          (error) => error.code === "LOCAL_API_PROTOCOL_ERROR" && error.details?.outcomeUnknown === true,
        );
      });
    });
  }
});

function validContactSourcePreview(overrides = {}) {
  return {
    ok: true,
    contacts: [{
      id: buildSourceScopedContactId("reader-a", "account-a", "native-a"),
      name: "来源联系人",
      initials: "来",
      maintenanceIntent: "unset",
      lastMessageAt: null,
      lastMessageText: "",
      lastMessageType: "unknown",
      cadenceDays: 30,
      importedCadenceProvided: false,
      customTagIds: [],
      importedTagNames: [],
      source: "reader-a",
      sourceId: "native-a",
      sourceProviderId: "reader-a",
      sourceRef: {
        contractVersion: 1,
        providerId: "reader-a",
        instanceId: "account-a",
        externalKey: "native-a",
      },
      needsReview: true,
    }],
    warnings: [],
    sourceKind: "portable-contact-source",
    sourceMeta: {
      providerId: "reader-a",
      providerContractVersion: 1,
      capabilities: ["contacts"],
      instanceId: "account-a",
    },
    ...overrides,
  };
}

test("通用来源客户端拒绝 contacts:[null] 与 warnings:[42]，不让畸形 200 响应进入 UI", async (t) => {
  const cases = [
    ["null 联系人", { contacts: [null] }],
    ["数字警告", { warnings: [42] }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      await withMockFetch(async () => jsonResponse(validContactSourcePreview(override)), async () => {
        await assert.rejects(
          previewContactSource({ sourceId: "reader-a", configuration: {} }),
          (error) => error instanceof LocalApiError
            && error.code === "LOCAL_API_PROTOCOL_ERROR"
            && error.details?.outcomeUnknown === true,
        );
      });
    });
  }
});

test("通用来源客户端拒绝来源三方矛盾、目录 provider 错配与未绑定 ID", async () => {
  const baseline = validContactSourcePreview();
  await withMockFetch(async () => jsonResponse(baseline), async () => {
    assert.equal((await previewContactSource({ sourceId: "reader-a", configuration: {} })).contacts.length, 1);
  });

  const contact = baseline.contacts[0];
  const otherRef = { ...contact.sourceRef, providerId: "reader-b" };
  const invalidPayloads = [
    validContactSourcePreview({ contacts: [{
      ...contact,
      id: buildSourceScopedContactId("reader-b", otherRef.instanceId, otherRef.externalKey),
      sourceProviderId: "reader-b",
      sourceRef: otherRef,
    }] }),
    validContactSourcePreview({ contacts: [{ ...contact, sourceProviderId: "reader-b" }] }),
    validContactSourcePreview({ contacts: [{ ...contact, id: "import-src-reader-a-not-bound" }] }),
    validContactSourcePreview({ sourceMeta: { ...baseline.sourceMeta, providerId: "reader-b" } }),
  ];
  for (const payload of invalidPayloads) {
    await withMockFetch(async () => jsonResponse(payload), async () => {
      await assert.rejects(
        previewContactSource({ sourceId: "reader-a", configuration: {} }),
        (error) => error instanceof LocalApiError && error.code === "LOCAL_API_PROTOCOL_ERROR",
      );
    });
  }
});

test("客户端只允许 WeFlow 与通用文件响应使用 legacy null sourceRef", async () => {
  for (const sourceId of ["weflow-http-win32", "portable-contact-file", "mac-reader-bridge", "reader-a"]) {
    const baseline = validContactSourcePreview();
    const payload = validContactSourcePreview({
      contacts: [{
        ...baseline.contacts[0],
        id: `legacy-${sourceId}`,
        source: sourceId,
        sourceProviderId: sourceId,
        sourceRef: null,
      }],
      sourceMeta: { ...baseline.sourceMeta, providerId: sourceId },
    });
    await withMockFetch(async () => jsonResponse(payload), async () => {
      if (["weflow-http-win32", "portable-contact-file"].includes(sourceId)) {
        assert.equal((await previewContactSource({ sourceId, configuration: {} })).contacts.length, 1);
      } else {
        await assert.rejects(
          previewContactSource({ sourceId, configuration: {} }),
          (error) => error instanceof LocalApiError && error.code === "LOCAL_API_PROTOCOL_ERROR",
        );
      }
    });
  }
});

test("客户端拒绝重复联系人 ID 与带控制字符的来源身份", async () => {
  const baseline = validContactSourcePreview();
  const duplicatePayload = validContactSourcePreview({ contacts: [baseline.contacts[0], { ...baseline.contacts[0] }] });
  const controlPayloads = [
    validContactSourcePreview({
      contacts: [{
        ...baseline.contacts[0],
        id: "legacy\ncontact",
        source: "portable-contact-file",
        sourceProviderId: "portable-contact-file",
        sourceRef: null,
      }],
      sourceMeta: { ...baseline.sourceMeta, providerId: "portable-contact-file" },
    }),
    validContactSourcePreview({ contacts: [{
      ...baseline.contacts[0],
      sourceRef: { ...baseline.contacts[0].sourceRef, instanceId: "account\n-a" },
    }] }),
    validContactSourcePreview({ contacts: [{
      ...baseline.contacts[0],
      sourceRef: { ...baseline.contacts[0].sourceRef, externalKey: "native\u0000-a" },
    }] }),
  ];
  for (const [sourceId, payload] of [["reader-a", duplicatePayload], ["portable-contact-file", controlPayloads[0]], ["reader-a", controlPayloads[1]], ["reader-a", controlPayloads[2]]]) {
    await withMockFetch(async () => jsonResponse(payload), async () => {
      await assert.rejects(
        previewContactSource({ sourceId, configuration: {} }),
        (error) => error instanceof LocalApiError && error.code === "LOCAL_API_PROTOCOL_ERROR",
      );
    });
  }
});
