import { MAX_CONTACTS } from "./limits.js";
import { allowsLegacyNullSourceRef, buildSourceScopedContactId } from "./importer.js";

export const STORAGE_KEY = "relationship-care:state:v1";
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedString(value, minimum, maximum) {
  return typeof value === "string"
    && !/[\u0000-\u001F\u007F]/.test(value)
    && value.trim().length >= minimum
    && value.length <= maximum;
}

function isValidOptionalDate(value) {
  return value === null || value === undefined || (typeof value === "string" && !Number.isNaN(new Date(value).getTime()));
}

function isValidOptionalNote(value) {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  if (value.length > 2_000) return false;
  // 允许换行；拒绝其他控制字符。
  return !/[\u0000-\u0009\u000B-\u001F\u007F]/.test(value);
}

const ANNUAL_DATE_PATTERN = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{2})-(\d{2}))$/;
// 与 domain.js 的按月天数一致；2 月允许 29，供闰年生日使用。
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isValidAnnualDate(value) {
  if (typeof value !== "string") return false;
  const match = ANNUAL_DATE_PATTERN.exec(value);
  if (!match) return false;
  const month = Number(match[2] ?? match[4]);
  const day = Number(match[3] ?? match[5]);
  return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1];
}

function isValidImportantDates(value) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 20) return false;
  return value.every((item) => isPlainObject(item)
    && isBoundedString(item.id, 1, 96)
    && isBoundedString(item.label, 1, 40)
    && isValidAnnualDate(item.date));
}

function isIntegerInRange(value, minimum, maximum) {
  return Number.isInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum;
}

export function validateState(candidate) {
  if (!isPlainObject(candidate)) return { ok: false, error: "本地数据不是可识别的对象。" };
  if (candidate.schemaVersion !== 1) return { ok: false, error: "本地数据版本不受支持。" };
  if (!Array.isArray(candidate.contacts) || !Array.isArray(candidate.tags)) {
    return { ok: false, error: "本地数据缺少联系人或标签列表。" };
  }
  if (candidate.contacts.length > MAX_CONTACTS || candidate.tags.length > 500) {
    return { ok: false, error: `联系人最多 ${MAX_CONTACTS} 位；当前数据没有改变。` };
  }
  if (!isPlainObject(candidate.settings)) return { ok: false, error: "本地数据缺少有效设置。" };
  if (!isIntegerInRange(candidate.settings.inactiveAfterDays, 1, 365)
    || !isIntegerInRange(candidate.settings.defaultCadenceDays, 1, 365)
    || typeof candidate.settings.privacyMode !== "boolean") {
    return { ok: false, error: "本地设置中的节律或隐私字段无效。" };
  }

  const tagIds = new Set();
  for (const tag of candidate.tags) {
    if (!isPlainObject(tag) || !isBoundedString(tag.id, 1, 96) || !isBoundedString(tag.name, 1, 18)) {
      return { ok: false, error: "本地数据包含无效标签。" };
    }
    if (tagIds.has(tag.id)) return { ok: false, error: `标签 ID 重复：${tag.id}` };
    tagIds.add(tag.id);
  }

  const contactIds = new Set();
  for (const contact of candidate.contacts) {
    if (!isPlainObject(contact) || !isBoundedString(contact.id, 1, 128) || !isBoundedString(contact.name, 1, 48)) {
      return { ok: false, error: "本地数据包含无效联系人。" };
    }
    if (contactIds.has(contact.id)) return { ok: false, error: `联系人 ID 重复：${contact.id}` };
    contactIds.add(contact.id);
    if (!["maintain", "ignore", "unset"].includes(contact.maintenanceIntent)) {
      return { ok: false, error: `联系人 ${contact.id} 的维系意愿无效。` };
    }
    if (!isIntegerInRange(contact.cadenceDays, 7, 365)) {
      return { ok: false, error: `联系人 ${contact.id} 的问候节律无效。` };
    }
    if (!isValidOptionalDate(contact.lastMessageAt)
      || !isValidOptionalDate(contact.lastMaintainedAt)
      || !isValidOptionalDate(contact.snoozedUntil)) {
      return { ok: false, error: `联系人 ${contact.id} 包含无效日期。` };
    }
    if (typeof contact.lastMessageText !== "string" || contact.lastMessageText.length > 5_000) {
      return { ok: false, error: `联系人 ${contact.id} 的消息摘要无效。` };
    }
    if (!isValidOptionalNote(contact.personalNote)) {
      return { ok: false, error: `联系人 ${contact.id} 的个人备注无效。` };
    }
    if (contact.birthday !== undefined && !isValidAnnualDate(contact.birthday)) {
      return { ok: false, error: `联系人 ${contact.id} 的生日无效。` };
    }
    if (!isValidImportantDates(contact.importantDates)) {
      return { ok: false, error: `联系人 ${contact.id} 的重要日子无效。` };
    }
    if (contact.source !== undefined && !isBoundedString(contact.source, 1, 96)) {
      return { ok: false, error: `联系人 ${contact.id} 的来源无效。` };
    }
    if (contact.sourceId !== undefined && (typeof contact.sourceId !== "string"
      || /[\u0000-\u001F\u007F]/.test(contact.sourceId)
      || contact.sourceId.length > 128)) {
      return { ok: false, error: `联系人 ${contact.id} 的外部来源 ID 无效。` };
    }
    if (contact.sourceProviderId !== undefined
      && !SOURCE_ID_PATTERN.test(contact.sourceProviderId)) {
      return { ok: false, error: `联系人 ${contact.id} 的数据源标识无效。` };
    }
    if ((contact.sourceRef === undefined || contact.sourceRef === null)
      && contact.sourceProviderId !== undefined
      && !allowsLegacyNullSourceRef(contact.sourceProviderId)) {
      return { ok: false, error: `联系人 ${contact.id} 缺少可验证的来源引用。` };
    }
    if (contact.sourceRef !== undefined && contact.sourceRef !== null) {
      const ref = contact.sourceRef;
      if (!isPlainObject(ref)
        || ref.contractVersion !== 1
        || !SOURCE_ID_PATTERN.test(ref.providerId || "")
        || !isBoundedString(ref.instanceId, 1, 96)
        || !isBoundedString(ref.externalKey, 1, 128)
        || contact.sourceProviderId !== ref.providerId
        || contact.id !== buildSourceScopedContactId(ref.providerId, ref.instanceId, ref.externalKey)) {
        return { ok: false, error: `联系人 ${contact.id} 的来源引用无效。` };
      }
    }
    if (!Array.isArray(contact.customTagIds) || contact.customTagIds.length > 100
      || contact.customTagIds.some((tagId) => typeof tagId !== "string" || !tagIds.has(tagId))) {
      return { ok: false, error: `联系人 ${contact.id} 引用了不存在或无效的标签。` };
    }
  }
  if (candidate.revision !== undefined && !isIntegerInRange(candidate.revision, 0, Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: "本地数据修订号无效。" };
  }
  if (candidate.changeId !== undefined && !isBoundedString(candidate.changeId, 1, 160)) {
    return { ok: false, error: "本地数据变更标识无效。" };
  }
  return { ok: true, error: null };
}

export function loadState(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { state: null, error: null };
    const parsed = JSON.parse(raw);
    const validation = validateState(parsed);
    if (!validation.ok) return { state: null, error: validation.error };
    return { state: parsed, error: null };
  } catch (error) {
    return { state: null, error: `无法恢复本地数据：${error.message}` };
  }
}

export function saveState(storage, state) {
  try {
    const validation = validateState(state);
    if (!validation.ok) return { ok: false, error: validation.error };
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: `保存失败：${error.message}` };
  }
}

export function clearState(storage) {
  try {
    storage.removeItem(STORAGE_KEY);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: `清空失败：${error.message}` };
  }
}

export function serializeBackup(state) {
  const validation = validateState(state);
  if (!validation.ok) throw new Error(validation.error);
  return JSON.stringify({
    ...state,
    exportedAt: new Date().toISOString(),
    exportFormat: "relationship-care-backup",
  }, null, 2);
}

export function parseBackup(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    const validation = validateState(parsed);
    if (!validation.ok) return { state: null, error: validation.error };
    return { state: parsed, error: null };
  } catch (error) {
    return { state: null, error: `备份文件无法解析：${error.message}` };
  }
}
