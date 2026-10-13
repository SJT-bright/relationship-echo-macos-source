import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_HIDE_AFTER_DAYS,
  FREQUENCY,
  MAINTENANCE,
  applyContactFilters,
  collectUpcomingAnnualDates,
  daysUntilAnnualDate,
  deriveContact,
  deriveContacts,
  differenceInLocalDays,
  formatAnnualDate,
  isAutomaticallyHidden,
  markMaintained,
  parseAnnualDate,
  parseTimestamp,
  partitionContactsByVisibility,
  snoozeContact,
} from "../src/domain.js";

// 纯领域状态机：覆盖正常分类、提醒边界、日期异常与证据保留。
const NOW = new Date("2026-08-23T12:00:00+08:00");

function contact(overrides = {}) {
  return {
    id: "wxid-alice",
    name: "Alice",
    maintenanceIntent: MAINTENANCE.MAINTAIN,
    lastMessageAt: "2026-07-01T12:00:00+08:00",
    lastMessageText: "上次聊到旅行",
    cadenceDays: 30,
    customTagIds: [],
    ...overrides,
  };
}

test("活跃度与维系意愿是两条独立轴", () => {
  const frequentIgnored = deriveContact(contact({
    lastMessageAt: "2026-08-20T12:00:00+08:00",
    maintenanceIntent: MAINTENANCE.IGNORE,
  }), { inactiveAfterDays: 30, defaultCadenceDays: 30 }, NOW);
  assert.equal(frequentIgnored.frequency, FREQUENCY.FREQUENT);
  assert.equal(frequentIgnored.maintenanceIntent, MAINTENANCE.IGNORE);
  assert.deepEqual(frequentIgnored.systemLabelIds, [FREQUENCY.FREQUENT, MAINTENANCE.IGNORE]);
  assert.equal(frequentIgnored.eligible, false);

  const infrequentMaintained = deriveContact(contact(), {
    inactiveAfterDays: 30,
    defaultCadenceDays: 30,
  }, NOW);
  assert.equal(infrequentMaintained.frequency, FREQUENCY.INFREQUENT);
  assert.equal(infrequentMaintained.maintenanceIntent, MAINTENANCE.MAINTAIN);
  assert.equal(infrequentMaintained.eligible, true);
  assert.equal(infrequentMaintained.isDue, true);
});

test("达到不活跃阈值当天即归为不常联系人", () => {
  const result = deriveContact(contact({ lastMessageAt: "2026-07-24T08:00:00+08:00" }), {
    inactiveAfterDays: 30,
    defaultCadenceDays: 30,
  }, NOW);
  assert.equal(result.daysSince, 30);
  assert.equal(result.frequency, FREQUENCY.INFREQUENT);
});

test("满 600 天当天自动隐藏，599 天和未知日期仍可见", () => {
  const atThreshold = new Date(NOW);
  atThreshold.setDate(atThreshold.getDate() - AUTO_HIDE_AFTER_DAYS);
  const beforeThreshold = new Date(NOW);
  beforeThreshold.setDate(beforeThreshold.getDate() - (AUTO_HIDE_AFTER_DAYS - 1));

  const hiddenContact = deriveContact(contact({ id: "hidden", lastMessageAt: atThreshold.toISOString() }), {
    inactiveAfterDays: 30,
    defaultCadenceDays: 30,
  }, NOW);
  const visibleContact = deriveContact(contact({ id: "visible", lastMessageAt: beforeThreshold.toISOString() }), {
    inactiveAfterDays: 30,
    defaultCadenceDays: 30,
  }, NOW);
  const unknownContact = deriveContact(contact({ id: "unknown", lastMessageAt: null }), {
    inactiveAfterDays: 30,
    defaultCadenceDays: 30,
  }, NOW);

  assert.equal(hiddenContact.daysSince, 600);
  assert.equal(isAutomaticallyHidden(hiddenContact), true);
  assert.equal(isAutomaticallyHidden(visibleContact), false);
  assert.equal(isAutomaticallyHidden(unknownContact), false);
  assert.deepEqual(
    partitionContactsByVisibility([hiddenContact, visibleContact, unknownContact]),
    { visible: [visibleContact, unknownContact], hidden: [hiddenContact] },
  );
});

test("最近手动标记问候会让旧消息联系人重新回到可见区", () => {
  const oldMessageAt = new Date(NOW);
  oldMessageAt.setDate(oldMessageAt.getDate() - 900);
  const result = deriveContact(contact({
    lastMessageAt: oldMessageAt.toISOString(),
    lastMaintainedAt: "2026-08-22T12:00:00+08:00",
  }), { inactiveAfterDays: 30, defaultCadenceDays: 30 }, NOW);

  assert.equal(result.daysSince, 1);
  assert.equal(isAutomaticallyHidden(result), false);
});

test("没有任何互动证据但需要维系时产生首次问候", () => {
  const result = deriveContact(contact({ lastMessageAt: null, lastMessageText: "" }), {
    inactiveAfterDays: 30,
    defaultCadenceDays: 30,
  }, NOW);
  assert.equal(result.frequency, FREQUENCY.UNKNOWN);
  assert.equal(result.firstGreeting, true);
  assert.equal(result.eligible, true);
  assert.equal(result.isDue, true);
  assert.equal(result.reminderState, "first-greeting");
  assert.equal(result.nextReminderAt.getTime(), new Date(2026, 7, 23).getTime());
});

test("没有互动证据且未设置维系意愿时不会误提醒", () => {
  const result = deriveContact(contact({
    lastMessageAt: null,
    lastMessageText: "",
    maintenanceIntent: MAINTENANCE.UNSET,
  }), { inactiveAfterDays: 30, defaultCadenceDays: 30 }, NOW);
  assert.equal(result.firstGreeting, false);
  assert.equal(result.nextReminderAt, null);
  assert.equal(result.isDue, false);
});

test("标记已问候只增加维护时间并保留来源消息证据", () => {
  const original = contact({
    lastMessageAt: "2026-07-10T10:00:00+08:00",
    lastMessageText: "不能被覆盖的原始摘要",
    snoozedUntil: "2026-08-30T10:00:00+08:00",
  });
  const result = markMaintained(original, NOW);
  assert.equal(result.lastMessageAt, original.lastMessageAt);
  assert.equal(result.lastMessageText, original.lastMessageText);
  assert.equal(result.lastMaintainedAt, NOW.toISOString());
  assert.equal(result.snoozedUntil, null);
  assert.equal(original.lastMaintainedAt, undefined);
});

for (const days of [3, 7, 14, 90]) {
  test(`稍后提醒支持 ${days} 天`, () => {
    const result = snoozeContact(contact(), days, NOW);
    assert.equal(differenceInLocalDays(result.snoozedUntil, NOW), days);
  });
}

test("稍后提醒的最大值被限制为 90 天", () => {
  const result = snoozeContact(contact(), 999, NOW);
  assert.equal(differenceInLocalDays(result.snoozedUntil, NOW), 90);
});

test("不活跃阈值大于个人周期时使用较大值避免过早提醒", () => {
  const result = deriveContact(contact({
    lastMessageAt: "2026-06-24T12:00:00+08:00",
    cadenceDays: 30,
  }), { inactiveAfterDays: 90, defaultCadenceDays: 30 }, NOW);
  assert.equal(result.reminderIntervalDays, 90);
  assert.equal(result.frequency, FREQUENCY.FREQUENT);
  assert.equal(result.eligible, false);
  assert.equal(result.daysUntilDue, 30);
});

test("节律与不活跃阈值的计算上限为 365 天", () => {
  const result = deriveContact(contact({ cadenceDays: 999 }), {
    inactiveAfterDays: 999,
    defaultCadenceDays: 999,
  }, NOW);
  assert.equal(result.cadenceDays, 365);
  assert.equal(result.reminderIntervalDays, 365);
});

test("跨夏令时切换的相邻本地日期仍相差一天", () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const before = new Date(2026, 2, 8, 0, 30);
    const after = new Date(2026, 2, 9, 0, 30);
    assert.equal((after.getTime() - before.getTime()) / 3_600_000, 23);
    assert.equal(differenceInLocalDays(after, before), 1);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("纯日期按本地零点解析且拒绝日历溢出", () => {
  const parsed = parseTimestamp("2026-08-01", NOW);
  assert.ok(parsed);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 7);
  assert.equal(parsed.getDate(), 1);
  assert.equal(parsed.getHours(), 0);
  assert.equal(parseTimestamp("2026-02-30", NOW), null);
});

test("按聊天时段筛选联系人", () => {
  const contacts = deriveContacts([
    contact({
      id: "c0-6",
      lastMessageAt: "2026-08-19T12:00:00+08:00",
    }),
    contact({
      id: "c7-13",
      lastMessageAt: "2026-08-10T12:00:00+08:00",
    }),
    contact({
      id: "c14-29",
      lastMessageAt: "2026-07-28T12:00:00+08:00",
    }),
    contact({
      id: "c30-59",
      lastMessageAt: "2026-07-20T12:00:00+08:00",
    }),
    contact({
      id: "c60-plus",
      lastMessageAt: "2026-06-01T12:00:00+08:00",
    }),
    contact({
      id: "unknown",
      lastMessageAt: null,
    }),
  ], {
    inactiveAfterDays: 30,
    defaultCadenceDays: 30,
  }, NOW);

  const baseFilters = {
    query: "",
    frequency: "all",
    maintenance: "all",
    tagId: "all",
    dueOnly: false,
  };

  assert.deepEqual(applyContactFilters(contacts, { ...baseFilters, timeRange: "all" }).map((item) => item.id), [
    "c0-6",
    "c7-13",
    "c14-29",
    "c30-59",
    "c60-plus",
    "unknown",
  ]);
  assert.deepEqual(applyContactFilters(contacts, { ...baseFilters, timeRange: "0-6" }).map((item) => item.id), ["c0-6"]);
  assert.deepEqual(applyContactFilters(contacts, { ...baseFilters, timeRange: "14-29" }).map((item) => item.id), ["c14-29"]);
  assert.deepEqual(applyContactFilters(contacts, { ...baseFilters, timeRange: "7-13" }).map((item) => item.id), ["c7-13"]);
  assert.deepEqual(applyContactFilters(contacts, { ...baseFilters, timeRange: "30-59" }).map((item) => item.id), ["c30-59"]);
  assert.deepEqual(applyContactFilters(contacts, { ...baseFilters, timeRange: "60-179" }).map((item) => item.id), ["c60-plus"]);
  assert.deepEqual(applyContactFilters(contacts, { ...baseFilters, timeRange: "180+" }).map((item) => item.id), []);
  assert.deepEqual(applyContactFilters(contacts, { ...baseFilters, timeRange: "unknown" }).map((item) => item.id), ["unknown"]);
});

test("时间解析拒绝非法、过早和超过七天的未来时间", () => {
  assert.equal(parseTimestamp("not-a-date", NOW), null);
  assert.equal(parseTimestamp("1999-12-31T23:59:59Z", NOW), null);
  assert.equal(parseTimestamp("2026-08-31T12:00:01+08:00", NOW), null);
  assert.ok(parseTimestamp("2026-08-30T12:00:00+08:00", NOW));
});

test("年度日期解析支持只记月日，拒绝越界值", () => {
  assert.deepEqual(parseAnnualDate("1990-08-15"), { year: 1990, month: 8, day: 15, hasYear: true });
  assert.deepEqual(parseAnnualDate("08-15"), { month: 8, day: 15, hasYear: false });
  assert.equal(parseAnnualDate("13-01"), null);
  assert.equal(parseAnnualDate("02-31"), null);
  assert.equal(parseAnnualDate("1899-01-01"), null);
  assert.equal(parseAnnualDate("生日"), null);
  assert.equal(parseAnnualDate(""), null);
  assert.equal(formatAnnualDate(parseAnnualDate("1990-8-5")), "1990-08-05");
  assert.equal(formatAnnualDate(parseAnnualDate("8-5")), "08-05");
});

test("距下次年度日期按本地日历跨年计算，今天为 0", () => {
  const now = new Date(2026, 7, 31, 15, 0, 0); // 2026-08-31
  assert.equal(daysUntilAnnualDate("08-31", now), 0);
  assert.equal(daysUntilAnnualDate("09-05", now), 5);
  assert.equal(daysUntilAnnualDate("08-30", now), 364, "已过日期顺延到明年");
  assert.equal(daysUntilAnnualDate("01-01", now), 123);
  assert.equal(daysUntilAnnualDate("1990-08-31", now), 0);
  assert.equal(daysUntilAnnualDate("not-a-date", now), null);
});

test("临近生日与纪念日按天数排序并推断年龄", () => {
  const now = new Date(2026, 7, 31, 9, 0, 0); // 2026-08-31
  const contact = {
    birthday: "1990-09-02",
    importantDates: [
      { id: "d1", label: "结婚纪念日", date: "05-20" },
      { id: "d2", label: "乔迁", date: "09-04" },
    ],
  };
  const upcoming = collectUpcomingAnnualDates(contact, 7, now);
  assert.deepEqual(upcoming.map((item) => [item.label, item.daysUntil]), [
    ["生日", 2],
    ["乔迁", 4],
  ]);
  assert.equal(upcoming[0].age, 36);
  assert.equal(collectUpcomingAnnualDates(contact, 0, now).length, 0, "窗口外不返回");
  assert.equal(collectUpcomingAnnualDates({}, 7, now).length, 0);
});
