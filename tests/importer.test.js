import assert from "node:assert/strict";
import test from "node:test";

import { buildSourceScopedContactId, parseCsv, parseImportText } from "../src/importer.js";
import { MAX_CONTACTS, MAX_IMPORT_RECORDS } from "../src/limits.js";

// 导入边界：同时验证联系人摘要与消息列表两种兼容输入，所有数据均为内存字符串。
const NOW = new Date("2026-08-23T12:00:00+08:00");

function parseJson(value) {
  return parseImportText(JSON.stringify(value), "contacts.json", NOW);
}

test("JSON 联系人摘要可导入并保留合法周期元数据", () => {
  const result = parseJson({
    version: 1,
    contacts: [{
      id: "alice",
      name: "Alice",
      lastMessageAt: "2026-08-01T12:00:00+08:00",
      lastMessage: "周末见",
      cadenceDays: 45,
      tags: ["同学", "跑步"],
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.sourceKind, "contact-summary-compatible");
  assert.equal(result.contacts[0].id, "import-alice");
  assert.equal(result.contacts[0].cadenceDays, 45);
  assert.equal(result.contacts[0].importedCadenceProvided, true);
  assert.deepEqual(result.contacts[0].importedTagNames, ["同学", "跑步"]);
});

test("CSV 支持引号、逗号和双引号转义", () => {
  const csv = [
    "id,name,lastMessageAt,lastMessage,cadenceDays,tags",
    'alice,"Alice, A.",2026-08-01T12:00:00+08:00,"她说""周末见""",30,"同学,跑步"',
  ].join("\r\n");
  const parsedRows = parseCsv(csv);
  assert.equal(parsedRows[0].name, "Alice, A.");
  assert.equal(parsedRows[0].lastMessage, '她说"周末见"');

  const result = parseImportText(csv, "contacts.csv", NOW);
  assert.equal(result.ok, true);
  assert.equal(result.contacts[0].name, "Alice, A.");
  assert.equal(result.contacts[0].lastMessageText, '她说"周末见"');
});

test("消息列表按会话只保留最新一条消息", () => {
  const result = parseJson({ messages: [
    { talker: "wxid-alice", name: "Alice", timestamp: "2026-08-01T10:00:00+08:00", content: "旧消息" },
    { talker: "wxid-alice", name: "Alice", timestamp: "2026-08-02T10:00:00+08:00", content: "新消息" },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].id, "import-wxid-alice");
  assert.equal(result.contacts[0].lastMessageText, "新消息");
  assert.equal(result.contacts[0].lastMessageAt, new Date("2026-08-02T10:00:00+08:00").toISOString());
});

test("跨批次变化的消息 ID 不会改变联系人 ID", () => {
  const first = parseJson({ messages: [
    { id: "message-1", talker: "wxid-alice", name: "Alice", timestamp: "2026-08-01T10:00:00+08:00", content: "第一批" },
  ] });
  const second = parseJson({ messages: [
    { id: "message-999", talker: "wxid-alice", name: "Alice", timestamp: "2026-08-10T10:00:00+08:00", content: "第二批" },
  ] });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.contacts[0].id, "import-wxid-alice");
  assert.equal(second.contacts[0].id, first.contacts[0].id);
});

test("消息模式过滤群聊、公众号和 official 类型，仅保留个人会话", () => {
  const timestamp = "2026-08-01T10:00:00+08:00";
  const result = parseJson({ messages: [
    { talker: "wxid-alice", name: "Alice", timestamp, content: "个人消息" },
    { talker: "family@chatroom", name: "家庭群", timestamp, content: "群消息" },
    { talker: "gh_news", name: "新闻号", timestamp, content: "公众号消息" },
    { talker: "wxid-service", name: "服务号", sessionType: "official", timestamp, content: "服务消息" },
  ] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.contacts.map((item) => item.id), ["import-wxid-alice"]);
  assert.equal(result.warnings.length, 3);
});

test("摘要模式同样过滤群聊、公众号和 official 类型", () => {
  const lastMessageAt = "2026-08-01T10:00:00+08:00";
  const result = parseJson({ contacts: [
    { id: "wxid-alice", name: "Alice", lastMessageAt, lastMessage: "个人消息" },
    { id: "family@chatroom", name: "家庭群", lastMessageAt, lastMessage: "群消息" },
    { id: "gh_news", name: "新闻号", lastMessageAt, lastMessage: "公众号消息" },
    { id: "wxid-service", name: "服务号", sessionType: "official", lastMessageAt, lastMessage: "服务消息" },
  ] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.contacts.map((item) => item.id), ["import-wxid-alice"]);
  assert.equal(result.warnings.length, 3);
});

test("senderUsername 不能冒充会话 ID", () => {
  const result = parseJson({ messages: [
    { senderUsername: "wxid-self", name: "Self", timestamp: "2026-08-01T10:00:00+08:00", content: "无会话归属" },
  ] });
  assert.equal(result.ok, false);
  assert.match(result.error, /没有同时具备|未找到|没有找到可用/);
});

test("拒绝未知版本、null、原始值和无语义对象", () => {
  assert.equal(parseJson({ version: 999, contacts: [] }).ok, false);
  for (const primitive of [null, 42, "hello", true]) {
    const result = parseImportText(JSON.stringify(primitive), "data.json", NOW);
    assert.equal(result.ok, false);
  }
  assert.equal(parseJson({ contacts: [{ foo: "bar" }] }).ok, false);
});

test("拒绝任何深度的原型污染键", () => {
  const topLevel = parseImportText('{"__proto__":{"polluted":true},"contacts":[]}', "data.json", NOW);
  const nested = parseImportText('{"contacts":[{"id":"alice","name":"Alice","lastMessageAt":"2026-08-01","meta":{"constructor":{"polluted":true}}}]}', "data.json", NOW);
  assert.equal(topLevel.ok, false);
  assert.match(topLevel.error, /不安全字段/);
  assert.equal(nested.ok, false);
  assert.match(nested.error, /不安全字段/);
  assert.equal({}.polluted, undefined);
});

test("恶意 HTML 文本只作为普通字符串返回", () => {
  const payload = '<img src=x onerror="globalThis.pwned=true"><script>alert(1)</script>';
  const result = parseJson({ contacts: [{
    id: "alice",
    name: '<svg onload="globalThis.pwned=true">',
    lastMessageAt: "2026-08-01T10:00:00+08:00",
    lastMessage: payload,
  }] });
  assert.equal(result.ok, true);
  assert.equal(result.contacts[0].lastMessageText, payload);
  assert.equal(result.contacts[0].name, '<svg onload="globalThis.pwned=true">');
  assert.equal(globalThis.pwned, undefined);
});

test("周期缺失或非法时明确标记 cadenceProvided=false", () => {
  const result = parseJson({ contacts: [
    { id: "missing", name: "Missing", lastMessageAt: "2026-08-01" },
    { id: "invalid", name: "Invalid", lastMessageAt: "2026-08-01", cadenceDays: 2 },
    { id: "valid", name: "Valid", lastMessageAt: "2026-08-01", cadenceDays: 90 },
  ] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.contacts.map((item) => item.importedCadenceProvided), [false, false, true]);
  assert.deepEqual(result.contacts.map((item) => item.cadenceDays), [30, 30, 90]);
  assert.equal(result.warnings.length, 1);
});

test("空文件、损坏 JSON 与超量记录均失败且不产出联系人", () => {
  assert.equal(parseImportText("", "data.json", NOW).ok, false);
  assert.equal(parseImportText("{broken", "data.json", NOW).ok, false);
  const oversized = { contacts: Array.from({ length: 20_001 }, (_, index) => ({ id: index })) };
  const result = parseJson(oversized);
  assert.equal(result.ok, false);
  assert.match(result.error, /20000/);
});

test("联系人摘要恰好 3000 人可导入，3001 人明确拒绝", () => {
  const rows = Array.from({ length: MAX_CONTACTS + 1 }, (_, index) => ({
    id: `wxid-boundary-${index}`,
    name: `联系人${index}`,
    lastMessageAt: "2026-08-01T10:00:00+08:00",
    lastMessage: `边界消息${index}`,
  }));

  const accepted = parseJson({ contacts: rows.slice(0, MAX_CONTACTS) });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.contacts.length, MAX_CONTACTS);

  const rejected = parseJson({ contacts: rows });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /3001 位联系人.*3000 人上限/);
});

test("3001 个不同个人会话在归纳后仍超限并被拒绝", () => {
  const messages = Array.from({ length: MAX_CONTACTS + 1 }, (_, index) => ({
    talker: `wxid-session-${index}`,
    name: `会话${index}`,
    timestamp: "2026-08-01T10:00:00+08:00",
    content: "你好",
  }));
  const result = parseJson({ messages });
  assert.equal(result.ok, false);
  assert.match(result.error, /归纳后有 3001 位联系人.*3000 人上限/);
});

test("原始消息恰好 20000 条可归纳为一个联系人，20001 条才拒绝", () => {
  const messages = Array.from({ length: MAX_IMPORT_RECORDS }, (_, index) => ({
    talker: "wxid-same-person",
    name: "同一联系人",
    timestamp: new Date(Date.parse("2026-08-01T00:00:00+08:00") + index * 1_000).toISOString(),
    content: `第${index + 1}条消息`,
  }));

  const accepted = parseJson({ messages });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.contacts.length, 1, "原始消息条数不应被误当成联系人条数");
  assert.equal(accepted.contacts[0].lastMessageText, `第${MAX_IMPORT_RECORDS}条消息`);

  const rejected = parseJson({ messages: [...messages, messages[0]] });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /原始记录超过 20000 条/);
});

function portableSource({
  providerId = "reader-a",
  instanceId = "account-a",
  capabilities = ["contacts", "latestInteraction"],
  contacts = [],
} = {}) {
  return {
    version: 1,
    format: "relationship-care-source",
    source: { providerId, instanceId, capabilities },
    contacts,
  };
}

test("通用来源 ID 同时隔离 provider、instance 和 native ID，同一来源重复导入仍稳定", () => {
  const nativeContact = {
    externalKey: "native-same-id",
    name: "同名原始联系人",
    lastMessageAt: "2026-08-01T10:00:00+08:00",
    lastMessage: "来源隔离测试",
  };
  const sourceAFirst = parseJson(portableSource({ contacts: [nativeContact] }));
  const sourceASecond = parseJson(portableSource({ contacts: [{ ...nativeContact, name: "名称更新" }] }));
  const otherProvider = parseJson(portableSource({ providerId: "reader-b", contacts: [nativeContact] }));
  const otherInstance = parseJson(portableSource({ instanceId: "account-b", contacts: [nativeContact] }));

  for (const result of [sourceAFirst, sourceASecond, otherProvider, otherInstance]) assert.equal(result.ok, true);
  assert.equal(sourceAFirst.contacts[0].id, sourceASecond.contacts[0].id, "同一来源实例的稳定 externalKey 必须产生同一内部 ID");
  assert.equal(new Set([
    sourceAFirst.contacts[0].id,
    otherProvider.contacts[0].id,
    otherInstance.contacts[0].id,
  ]).size, 3, "不同 provider 或 instance 的同名 native ID 不得碰撞");
  assert.deepEqual(sourceAFirst.contacts[0].sourceRef, {
    contractVersion: 1,
    providerId: "reader-a",
    instanceId: "account-a",
    externalKey: "native-same-id",
  });
});

test("关系回响来源合同缺少显式 instanceId 时拒绝，避免多账号落入 default 命名空间", () => {
  const payload = portableSource({ contacts: [{ externalKey: "native-a", name: "联系人 A", lastMessageAt: "2026-08-01" }] });
  delete payload.source.instanceId;
  const result = parseJson(payload);
  assert.equal(result.ok, false);
  assert.match(result.error, /source\.instanceId/);
});

test("providerId 65 字符和 instanceId 97 字符均拒绝，尾部不同的超长来源不能截断碰撞", () => {
  const contact = { externalKey: "native-a", name: "联系人 A", lastMessageAt: "2026-08-01" };
  assert.equal(parseJson(portableSource({ providerId: "p".repeat(64), instanceId: "i".repeat(96), contacts: [contact] })).ok, true);

  const providerPrefix = "p".repeat(64);
  const overlongProviders = ["a", "b"].map((tail) => parseJson(portableSource({
    providerId: `${providerPrefix}${tail}`,
    contacts: [contact],
  })));
  const instancePrefix = "i".repeat(96);
  const overlongInstances = ["a", "b"].map((tail) => parseJson(portableSource({
    instanceId: `${instancePrefix}${tail}`,
    contacts: [contact],
  })));

  for (const result of overlongProviders) {
    assert.equal(result.ok, false);
    assert.match(result.error, /source\.providerId/);
  }
  for (const result of overlongInstances) {
    assert.equal(result.ok, false);
    assert.match(result.error, /source\.instanceId/);
  }
});

test("超长 externalKey 被严格拒绝，不能截断后让两个来源联系人发生碰撞", () => {
  const commonPrefix = "x".repeat(128);
  const result = parseJson(portableSource({
    contacts: [
      { externalKey: `${commonPrefix}-a`, name: "联系人 A", lastMessageAt: "2026-08-01" },
      { externalKey: `${commonPrefix}-b`, name: "联系人 B", lastMessageAt: "2026-08-02" },
    ],
  }));

  assert.equal(result.ok, false);
  assert.match(result.error, /稳定 ID/);
  assert.equal(result.contacts, undefined);
});

test("legacy externalKey 在 121/122/128/129 边界兼容旧 ID、稳定哈希且不截断碰撞", () => {
  for (const length of [121, 122, 128]) {
    const prefix = "x".repeat(length - 1);
    const keyA = `${prefix}a`;
    const keyB = `${prefix}b`;
    const firstA = parseJson({ contacts: [{ externalKey: keyA, name: "联系人 A", lastMessageAt: "2026-08-01" }] });
    const secondA = parseJson({ contacts: [{ externalKey: keyA, name: "联系人 A 更新", lastMessageAt: "2026-08-02" }] });
    const firstB = parseJson({ contacts: [{ externalKey: keyB, name: "联系人 B", lastMessageAt: "2026-08-01" }] });
    for (const result of [firstA, secondA, firstB]) assert.equal(result.ok, true, `长度 ${length}`);
    assert.equal(firstA.contacts[0].id, secondA.contacts[0].id, `长度 ${length} 跨批次必须稳定`);
    assert.notEqual(firstA.contacts[0].id, firstB.contacts[0].id, `长度 ${length} 尾部不同不能碰撞`);
    if (length === 121) assert.equal(firstA.contacts[0].id, `import-${keyA}`);
    else assert.match(firstA.contacts[0].id, /^import-legacy-[a-z0-9]{13}$/);
  }

  const prefix129 = "x".repeat(128);
  for (const tail of ["a", "b"]) {
    const rejected = parseJson({ contacts: [{ externalKey: `${prefix129}${tail}`, name: "超长联系人", lastMessageAt: "2026-08-01" }] });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /稳定 ID/);
  }
});

test("导入器拒绝来源身份控制字符且不静默清洗后合并", () => {
  for (const control of ["\u0000", "\n", "\u007f"]) {
    assert.equal(buildSourceScopedContactId(`reader${control}a`, "account-a", "native-a"), null);
    assert.equal(buildSourceScopedContactId("reader-a", `account${control}a`, "native-a"), null);
    assert.equal(buildSourceScopedContactId("reader-a", "account-a", `native${control}a`), null);

    const legacy = parseJson({ contacts: [{ id: `native${control}a`, name: "控制字符联系人", lastMessageAt: "2026-08-01" }] });
    const provider = parseJson(portableSource({ providerId: `reader${control}a`, contacts: [{ externalKey: "native-a", name: "联系人", lastMessageAt: "2026-08-01" }] }));
    const instance = parseJson(portableSource({ instanceId: `account${control}a`, contacts: [{ externalKey: "native-a", name: "联系人", lastMessageAt: "2026-08-01" }] }));
    const external = parseJson(portableSource({ contacts: [{ externalKey: `native${control}a`, name: "联系人", lastMessageAt: "2026-08-01" }] }));
    for (const result of [legacy, provider, instance, external]) assert.equal(result.ok, false);
  }
});

test("联系人摘要和通用来源文件均拒绝重复归一化联系人 ID", () => {
  const legacy = parseJson({ contacts: [
    { id: "native-duplicate", name: "联系人 A", lastMessageAt: "2026-08-01" },
    { id: "native-duplicate", name: "联系人 B", lastMessageAt: "2026-08-02" },
  ] });
  const portable = parseJson(portableSource({ contacts: [
    { externalKey: "native-duplicate", name: "联系人 A", lastMessageAt: "2026-08-01" },
    { externalKey: "native-duplicate", name: "联系人 B", lastMessageAt: "2026-08-02" },
  ] }));
  for (const result of [legacy, portable]) {
    assert.equal(result.ok, false);
    assert.match(result.error, /多个联系人归一化为同一 ID/);
  }
});

test("仅 contacts 能力的 Mac/通用读取器可导入无时间联系人，并统一标为待校验", () => {
  const result = parseJson(portableSource({
    providerId: "mac-reader",
    instanceId: "wechat-main",
    capabilities: ["contacts"],
    contacts: [{ externalKey: "wxid-contact-only", name: "只有联系人资料" }],
  }));

  assert.equal(result.ok, true);
  assert.equal(result.sourceKind, "portable-contact-source");
  assert.deepEqual(result.sourceMeta.capabilities, ["contacts"]);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].lastMessageAt, null);
  assert.equal(result.contacts[0].lastMessageText, "");
  assert.equal(result.contacts[0].needsReview, true);
  assert.match(result.warnings.join("\n"), /只提供联系人.*待校验/);
});
