import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createStateRepository } from "../server/state-repository.mjs";
import { createDemoState } from "../src/data.js";
import {
  AUTO_HIDE_AFTER_DAYS,
  MAINTENANCE,
  addLocalDays,
  applyContactFilters,
  deriveContacts,
  markMaintained,
  partitionContactsByVisibility,
  sortByReminderPriority,
} from "../src/domain.js";

// 该文件组合应用正在使用的纯函数与临时 SQLite 仓库，覆盖完整的自动隐藏工作流。
// 测试数据只写入操作系统临时目录，绝不读取或修改正式 relationship-care-data。
const NOW = new Date("2026-08-23T12:00:00+08:00");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function atDaysAgo(days) {
  return addLocalDays(NOW, -days).toISOString();
}

function makeContact({ id, name, daysAgo, message = "上次聊到近况" }) {
  return {
    id,
    name,
    initials: name.slice(0, 1),
    maintenanceIntent: MAINTENANCE.MAINTAIN,
    lastMessageAt: atDaysAgo(daysAgo),
    lastMessageText: message,
    lastMessageType: "text",
    cadenceDays: 30,
    customTagIds: [],
    source: "weflow-direct",
  };
}

function makeState(contacts) {
  const state = createDemoState(NOW);
  state.dataMode = "weflow-direct";
  state.tags = [];
  state.contacts = contacts;
  return state;
}

function deriveLedgerSets(state) {
  const derived = sortByReminderPriority(deriveContacts(state.contacts, state.settings, NOW));
  return partitionContactsByVisibility(derived);
}

function pageOf(contacts, filters, page, pageSize) {
  const filtered = applyContactFilters(contacts, filters);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    contacts: filtered.slice(start, start + pageSize),
    filtered,
    page: safePage,
    totalPages,
  };
}

async function withTemporaryRepository(run) {
  const dataDir = mkdtempSync(join(tmpdir(), "relationship-care-auto-hide-test-"));
  const repository = createStateRepository({ dataDir });
  try {
    assert.equal(
      resolve(repository.databasePath).startsWith(resolve(dataDir)),
      true,
      "自动隐藏测试只能使用本次创建的临时 SQLite 目录",
    );
    return await run(repository);
  } finally {
    repository.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test("600 天联系人默认隐藏，查看详情并标记已问候后回到默认台账且 SQLite 仍保留证据", async () => {
  await withTemporaryRepository(async (repository) => {
    const oldMessageAt = atDaysAgo(AUTO_HIDE_AFTER_DAYS);
    const originalMessage = "六百天前讨论过毕业旅行";
    const target = makeContact({
      id: "wxid-quiet-600",
      name: "沉睡联系人",
      daysAgo: AUTO_HIDE_AFTER_DAYS,
      message: originalMessage,
    });
    const active = makeContact({ id: "wxid-active", name: "近期联系人", daysAgo: 10 });

    const firstSave = repository.compareAndSwapState(makeState([target, active]), {
      expectedChangeId: null,
    });
    const persistedBefore = repository.loadState().state;
    assert.equal(persistedBefore.contacts.length, 2, "隐藏只是视图规则，不能从 SQLite 删除联系人");
    assert.ok(persistedBefore.contacts.some((contact) => contact.id === target.id));

    const before = deriveLedgerSets(persistedBefore);
    assert.deepEqual(before.visible.map((contact) => contact.id), [active.id]);
    assert.deepEqual(before.hidden.map((contact) => contact.id), [target.id]);

    // 模拟点击“查看已隐藏”，再按搜索与“只看已到期”缩小结果，然后点击详情。
    const hiddenView = pageOf(before.hidden, {
      query: "毕业旅行",
      frequency: "all",
      maintenance: "all",
      tagId: "all",
      dueOnly: true,
    }, 1, 25);
    assert.equal(hiddenView.contacts.length, 1);
    const openedDetail = hiddenView.contacts.find((contact) => contact.id === target.id);
    assert.ok(openedDetail, "已隐藏联系人仍应能从详情入口被选中");
    assert.equal(openedDetail.lastMessageAt, oldMessageAt);
    assert.equal(openedDetail.lastMessageText, originalMessage);
    assert.equal(openedDetail.isDue, true);

    // 详情页“标记为已问候”走的就是 markMaintained，再通过 CAS 写回 SQLite。
    const candidate = clone(firstSave.state);
    candidate.contacts = candidate.contacts.map((contact) => (
      contact.id === target.id ? markMaintained(contact, NOW) : contact
    ));
    const secondSave = repository.compareAndSwapState(candidate, {
      expectedChangeId: firstSave.state.changeId,
    });

    const persistedAfter = repository.loadState().state;
    const storedTarget = persistedAfter.contacts.find((contact) => contact.id === target.id);
    assert.ok(storedTarget, "标记已问候后联系人必须继续保存在 SQLite");
    assert.equal(storedTarget.lastMaintainedAt, NOW.toISOString());
    assert.equal(storedTarget.lastMessageAt, oldMessageAt, "不能用手动问候时间覆盖 WeFlow 消息证据");
    assert.equal(storedTarget.lastMessageText, originalMessage);
    assert.equal(secondSave.state.revision, firstSave.state.revision + 1);
    assert.equal(repository.storageStatus().historyCount, 1);

    const after = deriveLedgerSets(persistedAfter);
    assert.equal(after.hidden.some((contact) => contact.id === target.id), false);
    assert.equal(after.visible.some((contact) => contact.id === target.id), true);

    const defaultSearch = pageOf(after.visible, { query: "沉睡联系人", dueOnly: false }, 1, 25);
    assert.deepEqual(defaultSearch.contacts.map((contact) => contact.id), [target.id]);
    const dueOnlyAfterGreeting = pageOf(after.visible, { query: "沉睡联系人", dueOnly: true }, 1, 25);
    assert.equal(dueOnlyAfterGreeting.contacts.length, 0, "刚标记问候的联系人不应继续留在到期队列");
  });
});

test("搜索、到期筛选与分页只作用于已选可见集合，不会让 600 天联系人泄漏回默认台账", () => {
  const hiddenContacts = Array.from({ length: 52 }, (_, index) => makeContact({
    id: `wxid-hidden-${String(index).padStart(2, "0")}`,
    name: `隐藏联系人${String(index).padStart(2, "0")}`,
    daysAgo: AUTO_HIDE_AFTER_DAYS + index,
    message: index === 50 ? "唯一检索暗号" : `旧消息${index}`,
  }));
  const activeContacts = [
    makeContact({ id: "wxid-visible-a", name: "默认甲", daysAgo: 5 }),
    makeContact({ id: "wxid-visible-b", name: "默认乙", daysAgo: 20 }),
  ];
  const { visible, hidden } = deriveLedgerSets(makeState([...hiddenContacts, ...activeContacts]));

  assert.equal(visible.length, 2);
  assert.equal(hidden.length, 52);
  assert.equal(visible.some((contact) => contact.id.startsWith("wxid-hidden-")), false);

  const dueHidden = { query: "", dueOnly: true };
  const firstPage = pageOf(hidden, dueHidden, 1, 25);
  const secondPage = pageOf(hidden, dueHidden, 2, 25);
  const thirdPage = pageOf(hidden, dueHidden, 3, 25);
  assert.deepEqual(
    [firstPage.contacts.length, secondPage.contacts.length, thirdPage.contacts.length],
    [25, 25, 2],
  );
  assert.equal(new Set([
    ...firstPage.contacts,
    ...secondPage.contacts,
    ...thirdPage.contacts,
  ].map((contact) => contact.id)).size, 52, "切换分页不能重复或丢失已隐藏联系人");

  const resizedFirst = pageOf(hidden, dueHidden, 1, 50);
  const resizedSecond = pageOf(hidden, dueHidden, 2, 50);
  assert.deepEqual([resizedFirst.contacts.length, resizedSecond.contacts.length], [50, 2]);

  const searchedHidden = pageOf(hidden, { query: "唯一检索暗号", dueOnly: true }, 1, 25);
  assert.deepEqual(searchedHidden.contacts.map((contact) => contact.id), ["wxid-hidden-50"]);

  const sameSearchOnDefaultLedger = pageOf(visible, { query: "唯一检索暗号", dueOnly: true }, 1, 25);
  assert.equal(sameSearchOnDefaultLedger.contacts.length, 0, "筛选不得绕过先分区、后筛选的可见性边界");
  assert.deepEqual(visible.map((contact) => contact.id).sort(), ["wxid-visible-a", "wxid-visible-b"]);
});
