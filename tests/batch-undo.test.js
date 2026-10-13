import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBatchTagCandidate,
  buildInverseBatchTagCandidate,
  createBatchUndoRecord,
  isBatchUndoExpired,
} from "../src/batch-undo.js";

function makeState(contacts = []) {
  return {
    schemaVersion: 1,
    revision: 7,
    changeId: "change-current",
    settings: {
      inactiveAfterDays: 600,
      defaultCadenceDays: 30,
      privacyMode: true,
      nested: { preserved: true },
    },
    tags: [
      { id: "tag-focus", name: "重点维系", color: "#765" },
      { id: "tag-other", name: "其他标签", color: "#456" },
    ],
    contacts,
    extra: { untouched: ["yes"] },
  };
}

function makeContact(id, customTagIds, overrides = {}) {
  return {
    id,
    name: `联系人 ${id}`,
    customTagIds,
    maintenanceIntent: "maintain",
    cadenceDays: 30,
    lastMessageText: "最近一条信息",
    note: { source: "weflow", preserved: true },
    ...overrides,
  };
}

function makeRecord(action, contactIds, overrides = {}) {
  return createBatchUndoRecord({
    action,
    tagId: "tag-focus",
    tagName: "重点维系",
    contactIds,
    scopeLabel: "全部筛选结果",
    now: 1_000,
    timeoutMs: 45_000,
    id: "undo-1",
    ...overrides,
  });
}

test("createBatchUndoRecord 只保存撤销意图字段，并稳定去重联系人 ID", () => {
  const sourceIds = ["a", "b", "a"];
  const record = makeRecord("add", sourceIds);

  assert.deepEqual(record, {
    id: "undo-1",
    action: "add",
    tagId: "tag-focus",
    tagName: "重点维系",
    contactIds: ["a", "b"],
    scopeLabel: "全部筛选结果",
    changedCount: 2,
    createdAt: 1_000,
    expiresAt: 46_000,
  });
  assert.notStrictEqual(record.contactIds, sourceIds);
  for (const forbidden of ["previousState", "candidate", "expectedChangeId", "contacts", "contactObjects"]) {
    assert.equal(Object.hasOwn(record, forbidden), false);
  }

  sourceIds.push("c");
  assert.deepEqual(record.contactIds, ["a", "b"]);
});

test("createBatchUndoRecord 拒绝无效动作、时间和联系人 ID", () => {
  assert.throws(() => makeRecord("toggle", ["a"]), /action/);
  assert.throws(() => makeRecord("add", ["a"], { now: Number.NaN }), /now/);
  assert.throws(() => makeRecord("add", ["a"], { timeoutMs: -1 }), /timeoutMs/);
  assert.throws(() => makeRecord("add", ["a", ""]), /contactIds/);
  assert.throws(() => makeRecord("add", ["a"], { id: makeContact("private", []) }), /id/);
  assert.throws(() => makeRecord("add", ["a"], { id: Number.NaN }), /id/);
  assert.doesNotThrow(() => makeRecord("add", ["a"], { id: 1 }));
  assert.equal(makeRecord("add", Array.from({ length: 50 }, (_, index) => `id-${index}`)).changedCount, 50);
  assert.throws(
    () => makeRecord("add", Array.from({ length: 51 }, (_, index) => `id-${index}`)),
    /最多包含 50/,
  );
});

test("isBatchUndoExpired 在 expiresAt 边界及之后均返回 true", () => {
  const record = makeRecord("add", ["a"]);

  assert.equal(isBatchUndoExpired(record, record.expiresAt - 1), false);
  assert.equal(isBatchUndoExpired(record, record.expiresAt), true);
  assert.equal(isBatchUndoExpired(record, record.expiresAt + 1), true);
  assert.equal(isBatchUndoExpired(record, Number.NaN), true);
  assert.equal(isBatchUndoExpired({}, record.expiresAt), true);
});

test("撤销 add 只为当前仍有目标标签的联系人移除该标签", () => {
  const original = makeState([
    makeContact("changed", ["tag-other", "tag-focus", "tag-other"], { nickname: "保留昵称" }),
    makeContact("already-undone", ["tag-other"]),
    makeContact("not-target", ["tag-focus", "tag-other"]),
  ]);
  const before = structuredClone(original);
  const result = buildInverseBatchTagCandidate(original, makeRecord("add", ["changed", "already-undone"]));

  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.changedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.missingCount, 0);
  assert.deepEqual(result.candidate.contacts[0].customTagIds, ["tag-other", "tag-other"]);
  assert.equal(result.candidate.contacts[0].nickname, "保留昵称");
  assert.deepEqual(result.candidate.contacts[1], original.contacts[1]);
  assert.deepEqual(result.candidate.contacts[2], original.contacts[2]);
  assert.deepEqual(original, before, "原状态不能被修改");
});

test("撤销 remove 只为当前仍无目标标签的联系人加入一次标签", () => {
  const original = makeState([
    makeContact("changed", ["tag-other", "tag-other"]),
    makeContact("already-undone", ["tag-focus", "tag-other"]),
    makeContact("not-target", []),
  ]);
  const result = buildInverseBatchTagCandidate(original, makeRecord("remove", ["changed", "already-undone"]));

  assert.equal(result.ok, true);
  assert.equal(result.changedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.missingCount, 0);
  assert.deepEqual(result.candidate.contacts[0].customTagIds, ["tag-other", "tag-other", "tag-focus"]);
  assert.deepEqual(result.candidate.contacts[1].customTagIds, ["tag-focus", "tag-other"]);
  assert.deepEqual(result.candidate.contacts[2].customTagIds, []);
});

test("候选状态是完整深克隆，并保留其他字段与其他标签", () => {
  const original = makeState([
    makeContact("a", ["tag-focus", "tag-other"], { profile: { city: "杭州" } }),
    makeContact("b", ["tag-other"]),
  ]);
  const result = buildInverseBatchTagCandidate(original, makeRecord("add", ["a"]));

  assert.equal(result.ok, true);
  assert.notStrictEqual(result.candidate, original);
  assert.notStrictEqual(result.candidate.settings, original.settings);
  assert.notStrictEqual(result.candidate.settings.nested, original.settings.nested);
  assert.notStrictEqual(result.candidate.tags, original.tags);
  assert.notStrictEqual(result.candidate.tags[0], original.tags[0]);
  assert.notStrictEqual(result.candidate.contacts, original.contacts);
  assert.notStrictEqual(result.candidate.contacts[0], original.contacts[0]);
  assert.notStrictEqual(result.candidate.contacts[0].profile, original.contacts[0].profile);
  assert.notStrictEqual(result.candidate.contacts[1], original.contacts[1]);
  assert.notStrictEqual(result.candidate.extra, original.extra);
  assert.deepEqual(result.candidate.tags, original.tags);
  assert.deepEqual(result.candidate.settings, original.settings);
  assert.deepEqual(result.candidate.extra, original.extra);
  assert.deepEqual(result.candidate.contacts[0].customTagIds, ["tag-other"]);
});

test("缺失联系人计入 missingCount，其余联系人仍可撤销", () => {
  const original = makeState([makeContact("present", ["tag-focus"])]);
  const result = buildInverseBatchTagCandidate(
    original,
    makeRecord("add", ["present", "deleted", "deleted"]),
  );

  assert.equal(result.ok, true);
  assert.equal(result.changedCount, 1);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.missingCount, 1);
  assert.equal(result.changedCount + result.skippedCount + result.missingCount, 2);
});

test("标签不存在时整体失败且不返回可提交 candidate", () => {
  const original = makeState([makeContact("a", ["tag-other"])]);
  original.tags = original.tags.filter((tag) => tag.id !== "tag-focus");
  const before = structuredClone(original);
  const result = buildInverseBatchTagCandidate(original, makeRecord("remove", ["a"]));

  assert.equal(result.ok, false);
  assert.match(result.error, /标签已不存在/);
  assert.equal(result.candidate, null);
  assert.equal(result.changedCount, 0);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.missingCount, 0);
  assert.deepEqual(original, before);
});

test("当前状态含重复联系人 ID 时失败关闭且不返回 candidate", () => {
  const original = makeState([
    makeContact("duplicate", ["tag-focus"]),
    makeContact("duplicate", ["tag-focus"]),
  ]);
  const result = buildInverseBatchTagCandidate(original, makeRecord("add", ["duplicate"]));

  assert.equal(result.ok, false);
  assert.match(result.error, /重复的联系人 ID/);
  assert.equal(result.candidate, null);
  assert.equal(result.changedCount, 0);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.missingCount, 0);
  assert.deepEqual(original.contacts[0].customTagIds, ["tag-focus"]);
  assert.deepEqual(original.contacts[1].customTagIds, ["tag-focus"]);
});

test("撤销是幂等的：对第一次候选再次执行只会跳过", () => {
  const initial = makeState([
    makeContact("a", ["tag-focus"]),
    makeContact("b", ["tag-focus", "tag-other"]),
  ]);
  const record = makeRecord("add", ["a", "b"]);
  const first = buildInverseBatchTagCandidate(initial, record);
  const second = buildInverseBatchTagCandidate(first.candidate, record);

  assert.equal(first.ok, true);
  assert.equal(first.changedCount, 2);
  assert.equal(second.ok, true);
  assert.equal(second.changedCount, 0);
  assert.equal(second.skippedCount, 2);
  assert.equal(second.missingCount, 0);
  assert.deepEqual(second.candidate, first.candidate);
});

test("remove 的逆操作同样幂等", () => {
  const initial = makeState([makeContact("a", ["tag-other"])]);
  const record = makeRecord("remove", ["a"]);
  const first = buildInverseBatchTagCandidate(initial, record);
  const second = buildInverseBatchTagCandidate(first.candidate, record);

  assert.equal(first.changedCount, 1);
  assert.deepEqual(first.candidate.contacts[0].customTagIds, ["tag-other", "tag-focus"]);
  assert.equal(second.changedCount, 0);
  assert.equal(second.skippedCount, 1);
});

test("历史 3000 人撤销记录仍可逆，但不再通过新建记录入口产生", () => {
  const contactIds = Array.from({ length: 3_000 }, (_, index) => `contact-${index}`);
  const state = makeState(contactIds.map((id, index) => makeContact(
    id,
    index % 2 === 0 ? ["tag-other", "tag-focus"] : ["tag-other"],
  )));
  const record = {
    id: "legacy-undo-3000",
    action: "add",
    tagId: "tag-focus",
    tagName: "重点维系",
    contactIds,
    scopeLabel: "旧版 3000 人批次",
    changedCount: contactIds.length,
    createdAt: 1_000,
    expiresAt: 46_000,
  };
  const result = buildInverseBatchTagCandidate(state, record);

  assert.equal(result.ok, true);
  assert.equal(result.changedCount, 1_500);
  assert.equal(result.skippedCount, 1_500);
  assert.equal(result.missingCount, 0);
  assert.equal(result.candidate.contacts.length, 3_000);
  assert.deepEqual(result.candidate.contacts[0].customTagIds, ["tag-other"]);
  assert.deepEqual(result.candidate.contacts[1].customTagIds, ["tag-other"]);
  assert.deepEqual(state.contacts[0].customTagIds, ["tag-other", "tag-focus"]);
});

test("buildBatchTagCandidate 由权威状态推导实际 add 变化并返回去重后的联系人", () => {
  const original = makeState([
    makeContact("needs-add", ["tag-other"]),
    makeContact("already-has", ["tag-focus"]),
  ]);
  const before = structuredClone(original);
  const result = buildBatchTagCandidate(original, {
    action: "add",
    tagId: "tag-focus",
    contactIds: ["needs-add", "already-has", "missing", "needs-add"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.changedCount, 1);
  assert.deepEqual(result.changedContactIds, ["needs-add"]);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.missingCount, 1);
  assert.deepEqual(result.candidate.contacts[0].customTagIds, ["tag-other", "tag-focus"]);
  assert.deepEqual(result.candidate.contacts[1].customTagIds, ["tag-focus"]);
  assert.deepEqual(original, before);
});

test("buildBatchTagCandidate 由权威状态推导实际 remove 变化，未知和重复 ID 不扩大计数", () => {
  const original = makeState([
    makeContact("needs-remove", ["tag-focus", "tag-other", "tag-focus"]),
    makeContact("already-absent", ["tag-other"]),
  ]);
  const result = buildBatchTagCandidate(original, {
    action: "remove",
    tagId: "tag-focus",
    contactIds: ["needs-remove", "already-absent", "unknown", "unknown"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.changedCount, 1);
  assert.deepEqual(result.changedContactIds, ["needs-remove"]);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.missingCount, 1);
  assert.deepEqual(result.candidate.contacts[0].customTagIds, ["tag-other"]);
});

test("buildBatchTagCandidate 拒绝不存在标签、无效动作和无效联系人 ID", () => {
  const state = makeState([makeContact("a", [])]);
  assert.match(buildBatchTagCandidate(state, { action: "add", tagId: "missing", contactIds: ["a"] }).error, /标签已不存在/);
  assert.match(buildBatchTagCandidate(state, { action: "toggle", tagId: "tag-focus", contactIds: ["a"] }).error, /操作类型/);
  assert.match(buildBatchTagCandidate(state, { action: "add", tagId: "tag-focus", contactIds: [""] }).error, /contactIds/);
  assert.match(buildBatchTagCandidate(state, null).error, /操作类型/);
  assert.match(buildBatchTagCandidate(state, {
    action: "add",
    tagId: "tag-focus",
    contactIds: Array.from({ length: 51 }, (_, index) => `too-many-${index}`),
  }).error, /最多包含 50/);
});

test("buildBatchTagCandidate 接受恰好 50 个显式目标并拒绝第 51 个", () => {
  const contacts = Array.from({ length: 51 }, (_, index) => makeContact(`contact-${index}`, []));
  const state = makeState(contacts);
  const accepted = buildBatchTagCandidate(state, {
    action: "add",
    tagId: "tag-focus",
    contactIds: contacts.slice(0, 50).map((contact) => contact.id),
  });
  const rejected = buildBatchTagCandidate(state, {
    action: "add",
    tagId: "tag-focus",
    contactIds: contacts.map((contact) => contact.id),
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.changedCount, 50);
  assert.equal(accepted.changedContactIds.length, 50);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /最多包含 50/);
  assert.deepEqual(state.contacts.map((contact) => contact.customTagIds), Array.from({ length: 51 }, () => []));
});
