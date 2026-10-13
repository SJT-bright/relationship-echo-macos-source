import assert from "node:assert/strict";
import test from "node:test";

import {
  ContactSourceError,
  createContactSourceRegistry,
  createDefaultContactSourceRegistry,
} from "../server/contact-source-registry.mjs";
import { buildSourceScopedContactId } from "../src/importer.js";

function descriptor(overrides = {}) {
  return {
    id: "test-reader",
    displayName: "测试读取器",
    description: "用于验证通用联系人数据源合同。",
    platforms: ["any"],
    transport: "adapter",
    availability: "available",
    handledBy: "server",
    capabilities: ["contacts"],
    privacy: "local-adapter",
    ...overrides,
  };
}

function previewContact(overrides = {}) {
  const sourceRef = {
    contractVersion: 1,
    providerId: "test-reader",
    instanceId: "account-a",
    externalKey: "native-a",
  };
  return {
    id: buildSourceScopedContactId(sourceRef.providerId, sourceRef.instanceId, sourceRef.externalKey),
    name: "测试联系人",
    initials: "测",
    maintenanceIntent: "unset",
    lastMessageAt: null,
    lastMessageText: "",
    lastMessageType: "unknown",
    cadenceDays: 30,
    importedCadenceProvided: false,
    customTagIds: [],
    importedTagNames: [],
    source: "test-reader",
    sourceId: "native-a",
    sourceProviderId: "test-reader",
    sourceRef,
    needsReview: true,
    ...overrides,
  };
}

function previewContactFor(providerId, overrides = {}) {
  const sourceRef = {
    contractVersion: 1,
    providerId,
    instanceId: "account-a",
    externalKey: "native-a",
  };
  return previewContact({
    id: buildSourceScopedContactId(providerId, sourceRef.instanceId, sourceRef.externalKey),
    source: providerId,
    sourceProviderId: providerId,
    sourceRef,
    ...overrides,
  });
}

function previewResult(overrides = {}) {
  return {
    ok: true,
    contacts: [previewContact()],
    warnings: [],
    sourceKind: "portable-contact-source",
    sourceMeta: { instanceId: "account-a", partial: false },
    ...overrides,
  };
}

test("默认 registry 描述三个来源，并按 win32/darwin 标记宿主支持状态", () => {
  const windows = createDefaultContactSourceRegistry({ platform: "win32", weflowPreview: async () => previewResult() }).list();
  const mac = createDefaultContactSourceRegistry({ platform: "darwin", weflowPreview: async () => previewResult() }).list();
  assert.deepEqual(windows.map((source) => source.id), [
    "weflow-http-win32",
    "portable-contact-file",
    "mac-reader-bridge",
  ]);
  for (const source of windows) {
    assert.ok(source.displayName.trim());
    assert.ok(source.description.trim());
    assert.ok(source.capabilities.includes("contacts"));
    assert.equal(Object.isFrozen(source), true);
    assert.equal(Object.isFrozen(source.platforms), true);
    assert.equal(Object.isFrozen(source.capabilities), true);
  }
  assert.equal(windows.find((source) => source.id === "weflow-http-win32").supportedOnHost, true);
  assert.equal(windows.find((source) => source.id === "mac-reader-bridge").supportedOnHost, false);
  assert.equal(mac.find((source) => source.id === "weflow-http-win32").supportedOnHost, false);
  assert.equal(mac.find((source) => source.id === "mac-reader-bridge").supportedOnHost, true);
  assert.equal(mac.find((source) => source.id === "portable-contact-file").supportedOnHost, true);
});

test("registry 在调用 provider 前拒绝不支持当前平台的来源", async () => {
  let called = false;
  const registry = createContactSourceRegistry({ platform: "darwin" }).register(
    descriptor({ id: "windows-reader", platforms: ["win32"] }),
    async () => { called = true; return previewResult(); },
  );
  await assert.rejects(
    registry.preview("windows-reader"),
    (error) => error instanceof ContactSourceError
      && error.status === 409
      && error.code === "CONTACT_SOURCE_PLATFORM_UNSUPPORTED",
  );
  assert.equal(called, false);
});

test("registry 将 null、数组和字符串配置统一拒绝为 422 配置错误", async () => {
  let called = 0;
  const registry = createContactSourceRegistry({ platform: "win32" }).register(
    descriptor(),
    async () => { called += 1; return previewResult(); },
  );
  for (const configuration of [null, [], "token"]) {
    await assert.rejects(
      registry.preview("test-reader", configuration),
      (error) => error instanceof ContactSourceError
        && error.status === 422
        && error.code === "INVALID_CONTACT_SOURCE_CONFIGURATION",
    );
  }
  assert.equal(called, 0, "无效配置不能进入 provider");
});

test("registry 拒绝畸形 provider 预览，不能把 null 联系人或数字警告传给 UI", async (t) => {
  const cases = [
    ["联系人不是数组", { contacts: null }],
    ["联系人元素为 null", { contacts: [null] }],
    ["联系人字段不完整", { contacts: [{}] }],
    ["警告元素不是字符串", { warnings: [42] }],
    ["sourceKind 缺失", { sourceKind: "" }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      const registry = createContactSourceRegistry({ platform: "win32" }).register(
        descriptor(),
        async () => previewResult(override),
      );
      await assert.rejects(
        registry.preview("test-reader"),
        (error) => error instanceof ContactSourceError
          && error.status === 502
          && error.code === "CONTACT_SOURCE_PROTOCOL_ERROR"
          && error.details?.providerId === "test-reader",
      );
    });
  }
});

test("registry 拒绝与请求 provider 矛盾或未绑定到来源引用的联系人 ID", async () => {
  const sourceRef = {
    contractVersion: 1,
    providerId: "test-reader",
    instanceId: "account-a",
    externalKey: "native-a",
  };
  let contact = previewContact({
    id: buildSourceScopedContactId(sourceRef.providerId, sourceRef.instanceId, sourceRef.externalKey),
    sourceProviderId: "test-reader",
    sourceRef,
  });
  const registry = createContactSourceRegistry({ platform: "win32" }).register(
    descriptor(),
    async () => previewResult({ contacts: [contact] }),
  );
  assert.equal((await registry.preview("test-reader", {})).contacts[0].sourceProviderId, "test-reader");

  const otherRef = { ...sourceRef, providerId: "other-reader" };
  const invalidContacts = [
    { ...contact, id: buildSourceScopedContactId("other-reader", "account-a", "native-a"), sourceProviderId: "other-reader", sourceRef: otherRef },
    { ...contact, sourceProviderId: "other-reader" },
    { ...contact, id: "import-src-test-reader-not-bound" },
  ];
  for (const invalidContact of invalidContacts) {
    contact = invalidContact;
    await assert.rejects(
      registry.preview("test-reader", {}),
      (error) => error instanceof ContactSourceError
        && error.status === 502
        && error.code === "CONTACT_SOURCE_PROTOCOL_ERROR",
    );
  }
});

test("registry 只允许 WeFlow 与通用文件使用 legacy null sourceRef", async () => {
  for (const providerId of ["weflow-http-win32", "portable-contact-file", "mac-reader-bridge", "test-reader"]) {
    const registry = createContactSourceRegistry({ platform: "win32" }).register(
      descriptor({ id: providerId }),
      async () => previewResult({ contacts: [previewContactFor(providerId, {
        id: `legacy-${providerId}`,
        sourceRef: null,
      })] }),
    );
    if (["weflow-http-win32", "portable-contact-file"].includes(providerId)) {
      assert.equal((await registry.preview(providerId, {})).contacts.length, 1, providerId);
    } else {
      await assert.rejects(
        registry.preview(providerId, {}),
        (error) => error instanceof ContactSourceError && error.code === "CONTACT_SOURCE_PROTOCOL_ERROR",
      );
    }
  }
});

test("registry 深校验完整预览字段并拒绝重复联系人 ID", async () => {
  let contacts = [previewContact()];
  const registry = createContactSourceRegistry({ platform: "win32" }).register(
    descriptor(),
    async () => previewResult({ contacts }),
  );
  assert.equal((await registry.preview("test-reader", {})).contacts.length, 1);

  const invalidOverrides = [
    { initials: null },
    { lastMessageAt: "not-a-date" },
    { lastMessageType: "x".repeat(49) },
    { importedCadenceProvided: "false" },
    { customTagIds: [42] },
    { importedTagNames: [""] },
    { source: "" },
    { sourceId: null },
  ];
  for (const override of invalidOverrides) {
    contacts = [previewContact(override)];
    await assert.rejects(
      registry.preview("test-reader", {}),
      (error) => error instanceof ContactSourceError && error.code === "CONTACT_SOURCE_PROTOCOL_ERROR",
    );
  }
  const duplicate = previewContact();
  contacts = [duplicate, { ...duplicate }];
  await assert.rejects(
    registry.preview("test-reader", {}),
    (error) => error instanceof ContactSourceError && error.code === "CONTACT_SOURCE_PROTOCOL_ERROR",
  );
});

test("registry 拒绝来源身份控制字符，包括 legacy 联系人 ID", async () => {
  const invalidContacts = [
    previewContact({ id: "bad\ncontact-id", sourceProviderId: "portable-contact-file", sourceRef: null }),
    previewContact({ sourceRef: { ...previewContact().sourceRef, instanceId: "account\n-a" } }),
    previewContact({ sourceRef: { ...previewContact().sourceRef, externalKey: "native\u0000-a" } }),
  ];
  let contact = invalidContacts[0];
  const registry = createContactSourceRegistry({ platform: "win32" }).register(
    descriptor({ id: "portable-contact-file" }),
    async () => previewResult({ contacts: [contact] }),
  );
  for (const invalidContact of invalidContacts) {
    contact = invalidContact;
    await assert.rejects(
      registry.preview("portable-contact-file", {}),
      (error) => error instanceof ContactSourceError && error.code === "CONTACT_SOURCE_PROTOCOL_ERROR",
    );
  }
});

test("WeFlow provider 保留自身安全元数据，并补齐 registry 合同与联系人来源", async () => {
  let observed = null;
  const registry = createDefaultContactSourceRegistry({
    platform: "win32",
    weflowPreview: async (configuration) => {
      observed = configuration;
      return previewResult({
        sourceKind: "weflow-direct",
        contacts: [previewContactFor("weflow-http-win32")],
        sourceMeta: {
          port: 5031,
          contacts: 1,
          partial: true,
          instanceId: "wechat-main",
          token: "must-not-leak",
          apiKey: "must-not-leak",
          providerId: "spoofed-provider",
          capabilities: ["admin"],
          nested: { secret: true },
        },
      });
    },
  });
  const result = await registry.preview("weflow-http-win32", { port: 5031, token: "ephemeral" });

  assert.deepEqual(observed, { port: 5031, token: "ephemeral", signal: undefined });
  assert.equal(result.sourceKind, "weflow-direct");
  assert.equal(result.sourceMeta.port, 5031);
  assert.equal(result.sourceMeta.partial, true);
  assert.equal(result.sourceMeta.providerId, "weflow-http-win32");
  assert.equal(result.sourceMeta.providerContractVersion, 1);
  assert.deepEqual(result.sourceMeta.capabilities, ["contacts", "sessions", "latestInteraction"]);
  assert.equal(result.contacts[0].sourceProviderId, "weflow-http-win32");
  assert.deepEqual(Object.keys(result.sourceMeta).sort(), [
    "capabilities",
    "contacts",
    "instanceId",
    "partial",
    "port",
    "providerContractVersion",
    "providerId",
  ]);
  for (const forbidden of ["token", "apiKey", "nested"]) {
    assert.equal(Object.hasOwn(result.sourceMeta, forbidden), false, `${forbidden} 不能进入来源元数据`);
  }
});
