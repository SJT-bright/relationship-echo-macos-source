export const MS_PER_DAY = 86_400_000;
export const AUTO_HIDE_AFTER_DAYS = 600;

export const FREQUENCY = Object.freeze({
  FREQUENT: "frequent",
  INFREQUENT: "infrequent",
  UNKNOWN: "unknown",
});

export const MAINTENANCE = Object.freeze({
  MAINTAIN: "maintain",
  IGNORE: "ignore",
  UNSET: "unset",
});

export const SYSTEM_LABELS = Object.freeze({
  frequent: { id: "frequent", label: "常联系人", axis: "frequency" },
  infrequent: { id: "infrequent", label: "不常联系人", axis: "frequency" },
  maintain: { id: "maintain", label: "需要维系", axis: "maintenance" },
  ignore: { id: "ignore", label: "不需要维系", axis: "maintenance" },
});

export function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export function startOfLocalDay(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function parseDateValue(value) {
  if (value === null || value === undefined || value === "") return null;

  let date;
  if (value instanceof Date) {
    date = new Date(value);
  } else if (typeof value === "number" || /^\d{10,16}$/.test(String(value).trim())) {
    let numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    if (numeric < 10_000_000_000) numeric *= 1000;
    date = new Date(numeric);
  } else {
    const text = String(value).trim();
    const localDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (localDateMatch) {
      const [, yearText, monthText, dayText] = localDateMatch;
      const year = Number(yearText);
      const month = Number(monthText) - 1;
      const day = Number(dayText);
      date = new Date(year, month, day, 0, 0, 0, 0);
      if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
    } else {
      date = new Date(text);
    }
  }

  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function parseTimestamp(value, now = new Date()) {
  const date = parseDateValue(value);
  if (!date) return null;
  const earliest = new Date("2000-01-01T00:00:00Z").getTime();
  const latest = now.getTime() + 7 * MS_PER_DAY;
  if (date.getTime() < earliest || date.getTime() > latest) {
    return null;
  }
  return date;
}

export function parsePlannedTimestamp(value, now = new Date()) {
  const date = parseDateValue(value);
  if (!date) return null;
  const earliest = new Date("2000-01-01T00:00:00Z").getTime();
  const latest = now.getTime() + 366 * MS_PER_DAY;
  if (date.getTime() < earliest || date.getTime() > latest) return null;
  return date;
}

export function addLocalDays(value, days) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + Number(days));
  return date;
}

export function differenceInLocalDays(later, earlier) {
  const laterDay = startOfLocalDay(later);
  const earlierDay = startOfLocalDay(earlier);
  if (!laterDay || !earlierDay) return null;
  const laterNumber = Date.UTC(laterDay.getFullYear(), laterDay.getMonth(), laterDay.getDate());
  const earlierNumber = Date.UTC(earlierDay.getFullYear(), earlierDay.getMonth(), earlierDay.getDate());
  return Math.round((laterNumber - earlierNumber) / MS_PER_DAY);
}

export function latestInteraction(contact, now = new Date()) {
  const candidates = [
    parseTimestamp(contact.lastMessageAt, now),
    parseTimestamp(contact.lastMaintainedAt, now),
  ].filter(Boolean);
  if (!candidates.length) return null;
  return new Date(Math.max(...candidates.map((date) => date.getTime())));
}

export function deriveContact(contact, settings = {}, now = new Date()) {
  const inactiveAfterDays = clampNumber(settings.inactiveAfterDays, 1, 365, 30);
  const cadenceDays = clampNumber(contact.cadenceDays, 7, 365, settings.defaultCadenceDays || 30);
  const interactionAt = latestInteraction(contact, now);
  const sourceMessageAt = parseTimestamp(contact.lastMessageAt, now);
  const daysSince = interactionAt ? Math.max(0, differenceInLocalDays(now, interactionAt)) : null;
  const frequency = daysSince === null
    ? FREQUENCY.UNKNOWN
    : daysSince >= inactiveAfterDays
      ? FREQUENCY.INFREQUENT
      : FREQUENCY.FREQUENT;

  const maintenanceIntent = Object.values(MAINTENANCE).includes(contact.maintenanceIntent)
    ? contact.maintenanceIntent
    : MAINTENANCE.UNSET;
  const firstGreeting = !interactionAt && maintenanceIntent === MAINTENANCE.MAINTAIN;
  const reminderIntervalDays = Math.max(cadenceDays, inactiveAfterDays);
  const calculatedDueAt = interactionAt
    ? addLocalDays(interactionAt, reminderIntervalDays)
    : firstGreeting
      ? startOfLocalDay(now)
      : null;
  const snoozedUntil = parsePlannedTimestamp(contact.snoozedUntil, now);
  const nextReminderAt = calculatedDueAt && snoozedUntil && snoozedUntil > calculatedDueAt
    ? snoozedUntil
    : calculatedDueAt;
  const daysUntilDue = nextReminderAt ? differenceInLocalDays(nextReminderAt, now) : null;
  const eligible = maintenanceIntent === MAINTENANCE.MAINTAIN
    && (frequency === FREQUENCY.INFREQUENT || firstGreeting);
  const isSnoozed = Boolean(snoozedUntil && differenceInLocalDays(snoozedUntil, now) > 0);
  const isDue = Boolean(eligible && nextReminderAt && daysUntilDue <= 0 && !isSnoozed);

  let reminderState = "none";
  if (isSnoozed) reminderState = "snoozed";
  else if (isDue && firstGreeting) reminderState = "first-greeting";
  else if (isDue && daysUntilDue < 0) reminderState = "overdue";
  else if (isDue) reminderState = "today";
  else if (eligible && daysUntilDue !== null && daysUntilDue <= 7) reminderState = "upcoming";
  else if (eligible) reminderState = "scheduled";

  return {
    ...contact,
    cadenceDays,
    maintenanceIntent,
    interactionAt,
    sourceMessageAt,
    daysSince,
    frequency,
    firstGreeting,
    reminderIntervalDays,
    nextReminderAt,
    daysUntilDue,
    eligible,
    isSnoozed,
    isDue,
    reminderState,
    systemLabelIds: [frequency, maintenanceIntent].filter((id) => SYSTEM_LABELS[id]),
  };
}

export function deriveContacts(contacts, settings, now = new Date()) {
  return contacts.map((contact) => deriveContact(contact, settings, now));
}

export function isAutomaticallyHidden(contact, thresholdDays = AUTO_HIDE_AFTER_DAYS) {
  return typeof contact?.daysSince === "number"
    && Number.isFinite(contact.daysSince)
    && contact.daysSince >= thresholdDays;
}

export function partitionContactsByVisibility(contacts, thresholdDays = AUTO_HIDE_AFTER_DAYS) {
  const visible = [];
  const hidden = [];
  contacts.forEach((contact) => {
    (isAutomaticallyHidden(contact, thresholdDays) ? hidden : visible).push(contact);
  });
  return { visible, hidden };
}

export function sortByReminderPriority(contacts) {
  return [...contacts].sort((left, right) => {
    if (left.isDue !== right.isDue) return left.isDue ? -1 : 1;
    const leftDue = left.daysUntilDue ?? Number.POSITIVE_INFINITY;
    const rightDue = right.daysUntilDue ?? Number.POSITIVE_INFINITY;
    if (leftDue !== rightDue) return leftDue - rightDue;
    return String(left.name).localeCompare(String(right.name), "zh-CN");
  });
}

export function applyContactFilters(contacts, filters = {}) {
  const query = String(filters.query || "").trim().toLocaleLowerCase("zh-CN");
  return contacts.filter((contact) => {
    if (filters.frequency && filters.frequency !== "all" && contact.frequency !== filters.frequency) {
      return false;
    }
    if (filters.maintenance && filters.maintenance !== "all" && contact.maintenanceIntent !== filters.maintenance) {
      return false;
    }
    if (filters.tagId && filters.tagId !== "all" && !contact.customTagIds?.includes(filters.tagId)) {
      return false;
    }
    if (filters.dueOnly && !contact.isDue) return false;
    if (filters.timeRange && filters.timeRange !== "all") {
      if (filters.timeRange === "unknown") {
        if (contact.daysSince !== null && contact.daysSince !== undefined) return false;
      } else if (typeof contact.daysSince === "number") {
        const isPlusRange = filters.timeRange.endsWith("+");
        if (isPlusRange) {
          const min = Number(filters.timeRange.slice(0, -1));
          if (!Number.isFinite(min) || contact.daysSince < min) return false;
        } else {
          const [minText, maxText] = filters.timeRange.split("-");
          const min = Number(minText);
          const max = Number(maxText);
          if (!Number.isFinite(min) || !Number.isFinite(max) || contact.daysSince < min || contact.daysSince > max) return false;
        }
      } else {
        return false;
      }
    }
    if (!query) return true;
    const haystack = [
      contact.name,
      contact.alias,
      contact.lastMessageText,
      contact.personalNote,
      ...(Array.isArray(contact.importantDates) ? contact.importantDates.map((item) => item?.label) : []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("zh-CN");
    return haystack.includes(query);
  });
}

export function setMaintenanceIntent(contact, intent) {
  const nextIntent = Object.values(MAINTENANCE).includes(intent) ? intent : MAINTENANCE.UNSET;
  return { ...contact, maintenanceIntent: nextIntent };
}

export function markMaintained(contact, at = new Date()) {
  return {
    ...contact,
    lastMaintainedAt: at.toISOString(),
    snoozedUntil: null,
  };
}

export function snoozeContact(contact, days = 7, at = new Date()) {
  const safeDays = clampNumber(days, 1, 90, 7);
  return {
    ...contact,
    snoozedUntil: addLocalDays(at, safeDays).toISOString(),
  };
}

export function createCustomTag(name, existingTags = [], now = Date.now()) {
  const normalized = String(name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 18);
  if (!normalized) return { tag: null, error: "请输入标签名称。" };
  const duplicate = existingTags.some((tag) => tag.name.toLocaleLowerCase("zh-CN") === normalized.toLocaleLowerCase("zh-CN"));
  if (duplicate) return { tag: null, error: "这个标签已经存在。" };
  const slug = normalized.toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "tag";
  return {
    tag: { id: `tag-${slug}-${String(now).slice(-5)}`, name: normalized },
    error: null,
  };
}

export function makeGreetingDraft(contact) {
  const summary = String(contact.lastMessageText || "").trim().replace(/\s+/g, " ").slice(0, 28);
  if (!summary || summary.startsWith("[")) {
    return `嗨，最近还好吗？有段时间没联系了，想起你，来问候一下。`;
  }
  return `嗨，最近还好吗？上次聊到“${summary}${contact.lastMessageText.length > 28 ? "…" : ""}”，想起你了，最近怎么样？`;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isValidMonthDay(month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1];
}

export function parseAnnualDate(value) {
  const text = String(value ?? "").trim();
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (full) {
    const year = Number(full[1]);
    const month = Number(full[2]);
    const day = Number(full[3]);
    if (year < 1900 || year > 2100 || !isValidMonthDay(month, day)) return null;
    return { year, month, day, hasYear: true };
  }
  const short = /^(\d{1,2})-(\d{1,2})$/.exec(text);
  if (short) {
    const month = Number(short[1]);
    const day = Number(short[2]);
    if (!isValidMonthDay(month, day)) return null;
    return { month, day, hasYear: false };
  }
  return null;
}

export function formatAnnualDate(parsed) {
  const month = String(parsed.month).padStart(2, "0");
  const day = String(parsed.day).padStart(2, "0");
  return parsed.hasYear ? `${parsed.year}-${month}-${day}` : `${month}-${day}`;
}

export function daysUntilAnnualDate(value, now = new Date()) {
  const parsed = parseAnnualDate(value);
  if (!parsed) return null;
  const today = startOfLocalDay(now);
  for (let offset = 0; offset <= 1; offset += 1) {
    const candidate = new Date(today.getFullYear() + offset, parsed.month - 1, parsed.day);
    const days = differenceInLocalDays(candidate, today);
    if (days >= 0) return days;
  }
  return null;
}

export function collectUpcomingAnnualDates(contact, withinDays = 7, now = new Date()) {
  const results = [];
  const push = (kind, label, value) => {
    const daysUntil = daysUntilAnnualDate(value, now);
    if (daysUntil === null || daysUntil > withinDays) return;
    const parsed = parseAnnualDate(value);
    const entry = { kind, label, date: value, daysUntil };
    if (kind === "birthday" && parsed?.hasYear) {
      const today = startOfLocalDay(now);
      const occurredThisYear = new Date(today.getFullYear(), parsed.month - 1, parsed.day) >= today;
      entry.age = today.getFullYear() + (occurredThisYear ? 0 : 1) - parsed.year;
    }
    results.push(entry);
  };
  if (contact?.birthday) push("birthday", "生日", contact.birthday);
  (contact?.importantDates || []).forEach((item) => {
    if (item?.label && item?.date) push("date", String(item.label), item.date);
  });
  results.sort((a, b) => a.daysUntil - b.daysUntil);
  return results;
}
