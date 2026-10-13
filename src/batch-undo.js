import { MAX_BATCH_SELECTION, MAX_CONTACTS } from "./limits.js";

const BATCH_ACTIONS = new Set(["add", "remove"]);

function fail(error) {
  return {
    ok: false,
    error,
    candidate: null,
    changedCount: 0,
    changedContactIds: [],
    skippedCount: 0,
    missingCount: 0,
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueContactIds(contactIds, maxCount = MAX_CONTACTS) {
  if (!Array.isArray(contactIds)) {
    throw new TypeError("contactIds 必须是联系人 ID 数组。");
  }

  const uniqueIds = [];
  const seenIds = new Set();
  for (const contactId of contactIds) {
    if (!isNonEmptyString(contactId)) {
      throw new TypeError("contactIds 只能包含非空字符串。");
    }
    if (seenIds.has(contactId)) continue;
    seenIds.add(contactId);
    uniqueIds.push(contactId);
    if (uniqueIds.length > maxCount) {
      throw new RangeError(`contactIds 最多包含 ${maxCount} 位联系人。`);
    }
  }
  return uniqueIds;
}

function cloneState(currentState) {
  if (typeof structuredClone !== "function") {
    throw new Error("当前环境不支持安全的状态深克隆。");
  }
  return structuredClone(currentState);
}

/**
 * 创建一条短期批量撤销意图记录。
 * contactIds 必须仅包含原批次中实际发生标签成员关系变化的联系人。
 */
export function createBatchUndoRecord({
  action,
  tagId,
  tagName,
  contactIds,
  scopeLabel,
  now,
  timeoutMs,
  id,
}) {
  if (!BATCH_ACTIONS.has(action)) {
    throw new TypeError('action 只能是 "add" 或 "remove"。');
  }
  if (!isNonEmptyString(tagId)) throw new TypeError("tagId 必须是非空字符串。");
  if (typeof tagName !== "string") throw new TypeError("tagName 必须是字符串。");
  if (typeof scopeLabel !== "string") throw new TypeError("scopeLabel 必须是字符串。");
  if (!Number.isFinite(now)) throw new TypeError("now 必须是有限的毫秒时间戳。");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("timeoutMs 必须是非负有限数值。");
  }
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(timeoutMs)
    || !Number.isSafeInteger(now + timeoutMs)) {
    throw new TypeError("撤销时间超出安全整数范围。");
  }
  const validStringId = isNonEmptyString(id);
  const validNumericId = Number.isSafeInteger(id);
  if (!validStringId && !validNumericId) {
    throw new TypeError("id 必须是非空字符串或安全整数。");
  }

  const uniqueIds = uniqueContactIds(contactIds, MAX_BATCH_SELECTION);
  return {
    id,
    action,
    tagId,
    tagName,
    contactIds: uniqueIds,
    scopeLabel,
    changedCount: uniqueIds.length,
    createdAt: now,
    expiresAt: now + timeoutMs,
  };
}

/** 到期时刻本身即视为过期，避免定时器延迟扩大撤销窗口。 */
export function isBatchUndoExpired(record, now) {
  if (!Number.isFinite(record?.expiresAt) || !Number.isFinite(now)) return true;
  return now >= record.expiresAt;
}

/**
 * 基于当前权威状态推导批量标签候选；调用方传入的命中列表不被信任，
 * changedContactIds 只包含服务器实际改变了标签成员关系的联系人。
 */
export function buildBatchTagCandidate(currentState, request = {}) {
  const { action, tagId, contactIds } = request && typeof request === "object" && !Array.isArray(request)
    ? request
    : {};
  if (!currentState || typeof currentState !== "object" || Array.isArray(currentState)
    || !Array.isArray(currentState.tags) || !Array.isArray(currentState.contacts)) {
    return fail("当前数据缺少联系人或标签列表。");
  }
  if (!BATCH_ACTIONS.has(action)) return fail("批量操作类型无效。");
  if (!isNonEmptyString(tagId)) return fail("批量操作缺少有效标签 ID。");

  let targetIds;
  try {
    targetIds = new Set(uniqueContactIds(contactIds, MAX_BATCH_SELECTION));
  } catch (error) {
    return fail(error.message);
  }
  if (!currentState.tags.some((tag) => tag && tag.id === tagId)) {
    return fail("目标标签已不存在，无法执行这次批量操作。");
  }

  let candidate;
  try {
    candidate = cloneState(currentState);
  } catch (error) {
    return fail(`无法复制当前数据：${error.message}`);
  }

  const foundTargetIds = new Set();
  const seenContactIds = new Set();
  const changedContactIds = [];
  let skippedCount = 0;
  for (const contact of candidate.contacts) {
    if (!contact || typeof contact !== "object" || Array.isArray(contact) || !isNonEmptyString(contact.id)) {
      return fail("当前数据包含无效联系人。");
    }
    if (seenContactIds.has(contact.id)) return fail("当前数据包含重复的联系人 ID，无法安全批量操作。");
    seenContactIds.add(contact.id);
    if (!targetIds.has(contact.id)) continue;
    foundTargetIds.add(contact.id);
    if (!Array.isArray(contact.customTagIds)) return fail("目标联系人缺少有效标签列表。");

    const currentlyHasTag = contact.customTagIds.includes(tagId);
    const shouldChange = action === "add" ? !currentlyHasTag : currentlyHasTag;
    if (!shouldChange) {
      skippedCount += 1;
      continue;
    }
    contact.customTagIds = action === "add"
      ? [...contact.customTagIds, tagId]
      : contact.customTagIds.filter((contactTagId) => contactTagId !== tagId);
    changedContactIds.push(contact.id);
  }

  return {
    ok: true,
    error: null,
    candidate,
    changedCount: changedContactIds.length,
    changedContactIds,
    skippedCount,
    missingCount: targetIds.size - foundTargetIds.size,
  };
}

/**
 * 基于当前权威状态构建条件式逆操作候选，不恢复旧状态快照。
 */
export function buildInverseBatchTagCandidate(currentState, record) {
  if (!currentState || typeof currentState !== "object" || Array.isArray(currentState)) {
    return fail("当前数据不是可识别的状态对象。");
  }
  if (!Array.isArray(currentState.tags) || !Array.isArray(currentState.contacts)) {
    return fail("当前数据缺少联系人或标签列表。");
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return fail("撤销记录无效。");
  }
  if (!BATCH_ACTIONS.has(record.action)) {
    return fail("撤销记录中的批量操作类型无效。");
  }
  if (!isNonEmptyString(record.tagId)) {
    return fail("撤销记录缺少有效标签 ID。");
  }

  let targetIds;
  try {
    targetIds = new Set(uniqueContactIds(record.contactIds, MAX_CONTACTS));
  } catch (error) {
    return fail(error.message);
  }

  if (!currentState.tags.some((tag) => tag && tag.id === record.tagId)) {
    return fail("目标标签已不存在，无法撤销这次批量操作。");
  }

  let candidate;
  try {
    candidate = cloneState(currentState);
  } catch (error) {
    return fail(`无法复制当前数据：${error.message}`);
  }

  let changedCount = 0;
  const changedContactIds = [];
  let skippedCount = 0;
  const foundTargetIds = new Set();
  const seenContactIds = new Set();

  for (let index = 0; index < candidate.contacts.length; index += 1) {
    const contact = candidate.contacts[index];
    if (!contact || typeof contact !== "object" || Array.isArray(contact)
      || !isNonEmptyString(contact.id)) {
      return fail("当前数据包含无效联系人。");
    }
    if (seenContactIds.has(contact.id)) {
      return fail("当前数据包含重复的联系人 ID，无法安全撤销。");
    }
    seenContactIds.add(contact.id);
    if (!targetIds.has(contact.id)) continue;

    foundTargetIds.add(contact.id);
    if (!Array.isArray(contact.customTagIds)) {
      return fail("目标联系人缺少有效标签列表。");
    }

    const currentlyHasTag = contact.customTagIds.includes(record.tagId);
    if (record.action === "add") {
      if (!currentlyHasTag) {
        skippedCount += 1;
        continue;
      }
      contact.customTagIds = contact.customTagIds.filter((tagId) => tagId !== record.tagId);
      changedCount += 1;
      changedContactIds.push(contact.id);
      continue;
    }

    if (currentlyHasTag) {
      skippedCount += 1;
      continue;
    }
    contact.customTagIds = [...contact.customTagIds, record.tagId];
    changedCount += 1;
    changedContactIds.push(contact.id);
  }

  return {
    ok: true,
    error: null,
    candidate,
    changedCount,
    changedContactIds,
    skippedCount,
    missingCount: targetIds.size - foundTargetIds.size,
  };
}
