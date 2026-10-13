import assert from "node:assert/strict";
import test from "node:test";

import { createDemoState } from "../src/data.js";
import { buildSourceScopedContactId } from "../src/importer.js";
import { MAX_CONTACTS } from "../src/limits.js";
import {
  STORAGE_KEY,
  loadState,
  parseBackup,
  saveState,
  serializeBackup,
  validateState,
} from "../src/storage.js";

// 持久化合同：深校验每层结构，并用可控 fake storage 注入写入失败。
const NOW = new Date("2026-08-23T12:00:00+08:00");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mutateState(mutator) {
  const state = clone(createDemoState(NOW));
  mutator(state);
  return state;
}

test("演示数据满足完整状态合同", () => {
  assert.deepEqual(validateState(createDemoState(NOW)), { ok: true, error: null });
});

test("拒绝 null 联系人，防止恢复后渲染崩溃", () => {
  const state = mutateState((candidate) => candidate.contacts.push(null));
  assert.equal(validateState(state).ok, false);
  assert.match(validateState(state).error, /无效联系人/);
});

test("拒绝重复联系人 ID 与重复标签 ID", () => {
  const duplicateContact = mutateState((state) => state.contacts.push(clone(state.contacts[0])));
  assert.equal(validateState(duplicateContact).ok, false);
  assert.match(validateState(duplicateContact).error, /联系人 ID 重复/);

  const duplicateTag = mutateState((state) => state.tags.push(clone(state.tags[0])));
  assert.equal(validateState(duplicateTag).ok, false);
  assert.match(validateState(duplicateTag).error, /标签 ID 重复/);
});

test("拒绝无效维系枚举、日期和设置", () => {
  const invalidEnum = mutateState((state) => { state.contacts[0].maintenanceIntent = "maybe"; });
  assert.equal(validateState(invalidEnum).ok, false);

  const invalidDate = mutateState((state) => { state.contacts[0].lastMessageAt = "not-a-date"; });
  assert.equal(validateState(invalidDate).ok, false);

  const invalidSettings = mutateState((state) => { state.settings.inactiveAfterDays = 0; });
  assert.equal(validateState(invalidSettings).ok, false);

  const invalidPrivacy = mutateState((state) => { state.settings.privacyMode = "false"; });
  assert.equal(validateState(invalidPrivacy).ok, false);
});

test("拒绝缺失标签外键，保证备份深层引用完整性", () => {
  const state = mutateState((candidate) => candidate.contacts[0].customTagIds.push("tag-does-not-exist"));
  const result = validateState(state);
  assert.equal(result.ok, false);
  assert.match(result.error, /不存在或无效的标签/);
});

test("拒绝越界周期、过长消息和无效 changeId", () => {
  const invalidCadence = mutateState((state) => { state.contacts[0].cadenceDays = 6; });
  assert.equal(validateState(invalidCadence).ok, false);

  const oversizedMessage = mutateState((state) => { state.contacts[0].lastMessageText = "x".repeat(5_001); });
  assert.equal(validateState(oversizedMessage).ok, false);

  const invalidChangeId = mutateState((state) => { state.changeId = ""; });
  assert.equal(validateState(invalidChangeId).ok, false);
});

test("持久化层拒绝 sourceRef、sourceProviderId 与联系人 ID 不一致", () => {
  const sourceRef = {
    contractVersion: 1,
    providerId: "reader-a",
    instanceId: "account-a",
    externalKey: "native-a",
  };
  const valid = mutateState((state) => {
    Object.assign(state.contacts[0], {
      id: buildSourceScopedContactId(sourceRef.providerId, sourceRef.instanceId, sourceRef.externalKey),
      sourceProviderId: "reader-a",
      sourceRef,
    });
  });
  assert.equal(validateState(valid).ok, true);

  const contradictoryProvider = clone(valid);
  contradictoryProvider.contacts[0].sourceProviderId = "reader-b";
  const unboundId = clone(valid);
  unboundId.contacts[0].id = "import-src-reader-a-not-bound";
  for (const state of [contradictoryProvider, unboundId]) {
    const result = validateState(state);
    assert.equal(result.ok, false);
    assert.match(result.error, /来源引用无效/);
  }
});

test("持久化层只允许 WeFlow 与通用文件保留 legacy null sourceRef", () => {
  for (const providerId of ["weflow-http-win32", "portable-contact-file", "mac-reader-bridge", "reader-a"]) {
    const state = mutateState((candidate) => {
      Object.assign(candidate.contacts[0], {
        id: `legacy-${providerId}`,
        sourceProviderId: providerId,
        sourceRef: null,
      });
    });
    const result = validateState(state);
    assert.equal(result.ok, ["weflow-http-win32", "portable-contact-file"].includes(providerId), providerId);
    if (!result.ok) assert.match(result.error, /缺少可验证的来源引用/);
  }
});

test("持久化层拒绝来源身份中的控制字符", () => {
  const validRef = {
    contractVersion: 1,
    providerId: "reader-a",
    instanceId: "account-a",
    externalKey: "native-a",
  };
  const states = [
    mutateState((candidate) => {
      Object.assign(candidate.contacts[0], {
        id: "legacy\ncontact",
        sourceProviderId: "portable-contact-file",
        sourceRef: null,
      });
    }),
    mutateState((candidate) => {
      const ref = { ...validRef, instanceId: "account\n-a" };
      Object.assign(candidate.contacts[0], { id: "invalid-ref", sourceProviderId: "reader-a", sourceRef: ref });
    }),
    mutateState((candidate) => {
      const ref = { ...validRef, externalKey: "native\u0000-a" };
      Object.assign(candidate.contacts[0], { id: "invalid-ref", sourceProviderId: "reader-a", sourceRef: ref });
    }),
  ];
  for (const state of states) assert.equal(validateState(state).ok, false);
});

test("备份序列化与恢复可以无损往返", () => {
  const original = createDemoState(NOW);
  original.changeId = "test-change-id";
  const serialized = serializeBackup(original);
  const parsed = parseBackup(serialized);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.state.contacts, original.contacts);
  assert.deepEqual(parsed.state.tags, original.tags);
  assert.deepEqual(parsed.state.settings, original.settings);
  assert.equal(parsed.state.changeId, original.changeId);
  assert.equal(parsed.state.exportFormat, "relationship-care-backup");
  assert.ok(!Number.isNaN(new Date(parsed.state.exportedAt).getTime()));
});

test("loadState 拒绝结构损坏的 JSON 而不返回部分状态", () => {
  const storage = {
    getItem(key) {
      assert.equal(key, STORAGE_KEY);
      return JSON.stringify({ schemaVersion: 1, contacts: [null], tags: [], settings: {} });
    },
  };
  const result = loadState(storage);
  assert.equal(result.state, null);
  assert.ok(result.error);
});

test("Storage setItem 失败时旧值保持不变", () => {
  const oldState = createDemoState(NOW);
  const oldValue = JSON.stringify(oldState);
  const fakeStorage = {
    value: oldValue,
    getItem() {
      return this.value;
    },
    setItem() {
      throw new Error("quota exceeded");
    },
  };
  const candidate = mutateState((state) => { state.contacts = []; });
  const result = saveState(fakeStorage, candidate);
  assert.equal(result.ok, false);
  assert.match(result.error, /quota exceeded/);
  assert.equal(fakeStorage.value, oldValue);
  assert.equal(loadState(fakeStorage).state.contacts.length, oldState.contacts.length);
});

test("成功保存后可按同一 changeId 和 revision 恢复", () => {
  const values = new Map();
  const fakeStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const candidate = createDemoState(NOW);
  candidate.revision = 8;
  candidate.changeId = "authority-sentinel-8";
  assert.equal(saveState(fakeStorage, candidate).ok, true);
  const loaded = loadState(fakeStorage);
  assert.equal(loaded.error, null);
  assert.equal(loaded.state.revision, 8);
  assert.equal(loaded.state.changeId, "authority-sentinel-8");
});

test("状态校验接受 3000 位联系人并拒绝第 3001 位", () => {
  const state = createDemoState(NOW);
  const template = state.contacts[0];
  state.contacts = Array.from({ length: MAX_CONTACTS }, (_, index) => ({
    ...template,
    id: `contact-${index}`,
    name: `联系人${index}`,
  }));
  assert.deepEqual(validateState(state), { ok: true, error: null });

  state.contacts.push({ ...template, id: "contact-over-limit", name: "超限联系人" });
  const rejected = validateState(state);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /联系人最多 3000 位/);
});

test("个人备注可选、允许换行、拒绝控制字符并限制长度", () => {
  const withNote = mutateState((state) => { state.contacts[0].personalNote = "女儿今年高考\n喜欢爬山"; });
  assert.deepEqual(validateState(withNote), { ok: true, error: null });

  const undefinedNote = mutateState((state) => { state.contacts[0].personalNote = undefined; });
  assert.deepEqual(validateState(undefinedNote), { ok: true, error: null });

  const controlCharNote = mutateState((state) => { state.contacts[0].personalNote = "备注\u0007响铃"; });
  assert.equal(validateState(controlCharNote).ok, false);
  assert.match(validateState(controlCharNote).error, /个人备注无效/);

  const longNote = mutateState((state) => { state.contacts[0].personalNote = "字".repeat(2001); });
  assert.equal(validateState(longNote).ok, false);

  const boundaryNote = mutateState((state) => { state.contacts[0].personalNote = "字".repeat(2000); });
  assert.deepEqual(validateState(boundaryNote), { ok: true, error: null });

  const nonStringNote = mutateState((state) => { state.contacts[0].personalNote = 42; });
  assert.equal(validateState(nonStringNote).ok, false);
});

test("生日与重要日子校验：支持月日、拒绝越界与坏结构", () => {
  const withDates = mutateState((state) => {
    state.contacts[0].birthday = "1990-02-29";
    state.contacts[0].importantDates = [{ id: "date-1", label: "结婚纪念日", date: "05-20" }];
  });
  assert.deepEqual(validateState(withDates), { ok: true, error: null });

  const badBirthday = mutateState((state) => { state.contacts[0].birthday = "1990-02-30"; });
  assert.equal(validateState(badBirthday).ok, false);
  assert.match(validateState(badBirthday).error, /生日无效/);

  const shortBirthday = mutateState((state) => { state.contacts[0].birthday = "1990-8-5"; });
  assert.equal(validateState(shortBirthday).ok, false, "存储合同要求零填充规范格式");

  const missingLabel = mutateState((state) => {
    state.contacts[0].importantDates = [{ id: "date-1", label: "", date: "05-20" }];
  });
  assert.equal(validateState(missingLabel).ok, false);
  assert.match(validateState(missingLabel).error, /重要日子无效/);

  const badDateItem = mutateState((state) => {
    state.contacts[0].importantDates = [{ id: "date-1", label: "乔迁", date: "13-01" }];
  });
  assert.equal(validateState(badDateItem).ok, false);

  const nonArrayDates = mutateState((state) => { state.contacts[0].importantDates = "纪念日"; });
  assert.equal(validateState(nonArrayDates).ok, false);
});
