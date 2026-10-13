import { parseTimestamp } from "./domain.js";
import { MAX_CONTACTS, MAX_IMPORT_RECORDS } from "./limits.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SOURCE_CAPABILITIES = new Set(["contacts", "sessions", "latestInteraction"]);
const LEGACY_NULL_SOURCE_REF_PROVIDER_IDS = new Set(["weflow-http-win32", "portable-contact-file"]);

export function allowsLegacyNullSourceRef(providerId) {
  return LEGACY_NULL_SOURCE_REF_PROVIDER_IDS.has(String(providerId || ""));
}

function cleanText(value, maximum = 160) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maximum);
}

function cleanIdentifier(value, maximum = 128) {
  const raw = String(value ?? "");
  if (/[\u0000-\u001F\u007F]/.test(raw)) return "";
  const cleaned = raw.trim();
  return cleaned && cleaned.length <= maximum ? cleaned : "";
}

function findForbiddenKey(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return null;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return key;
    const nested = findForbiddenKey(value[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
  }
  return null;
}

function sourceExternalKey(raw) {
  const source = firstValue(raw, ["externalKey", "identityKey", "id", "wxid", "talker", "username", "userName", "contactId"]);
  return cleanIdentifier(source, 128);
}

function stableHash(value) {
  let hash = 0xcbf29ce484222325n;
  for (const character of String(value)) {
    hash ^= BigInt(character.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36).padStart(13, "0");
}

export function buildSourceScopedContactId(providerId, instanceId, externalKey) {
  const safeProviderId = cleanIdentifier(providerId, 64);
  const safeInstanceId = cleanIdentifier(instanceId, 96);
  const safeExternalKey = cleanIdentifier(externalKey, 128);
  if (!SOURCE_ID_PATTERN.test(safeProviderId) || !safeInstanceId || !safeExternalKey) return null;
  return `import-src-${safeProviderId}-${stableHash(`${safeProviderId}\u0000${safeInstanceId}\u0000${safeExternalKey}`)}`;
}

function stableContactId(raw, index, sourceContext = null) {
  const cleaned = sourceExternalKey(raw);
  if (sourceContext && cleaned) {
    return buildSourceScopedContactId(sourceContext.providerId, sourceContext.instanceId, cleaned);
  }
  if (!cleaned) return `import-row-${index + 1}`;
  return cleaned.length <= 121 ? `import-${cleaned}` : `import-legacy-${stableHash(cleaned)}`;
}

function messagePlaceholder(rawType) {
  const type = String(rawType ?? "").toLowerCase();
  if (["3", "image", "photo"].includes(type)) return "[图片]";
  if (["34", "voice", "audio"].includes(type)) return "[语音]";
  if (["43", "video"].includes(type)) return "[视频]";
  if (["49", "file", "link"].includes(type)) return "[文件或链接]";
  return "";
}

function shouldExcludeConversation(raw, knownSessionId = null) {
  const sessionId = cleanText(knownSessionId || firstValue(raw, ["id", "wxid", "talker", "username", "userName", "contactId", "conversationId", "sessionId", "peerId"]), 96);
  const sessionKind = String(firstValue(raw, ["sessionType", "contactType", "conversationType", "type"]) || "").toLowerCase();
  return sessionId.includes("@chatroom")
    || sessionId.startsWith("gh_")
    || ["group", "official", "public", "subscription"].includes(sessionKind);
}

function normalizeContact(raw, index, now, sourceContext = null) {
  const id = stableContactId(raw, index, sourceContext);
  const sourceName = firstValue(raw, ["remark", "displayName", "name", "nickName", "nickname", "accountName", "talkerName"]);
  const fallbackName = id.replace(/^import-/, "");
  const name = cleanText(sourceName || fallbackName, 48) || `待校验联系人 ${index + 1}`;
  const rawTimestamp = firstValue(raw, ["lastMessageAt", "lastMessageTime", "timestamp", "createTime", "time"]);
  const parsedTimestamp = parseTimestamp(rawTimestamp, now);
  const rawType = firstValue(raw, ["lastMessageType", "type", "msgType"]);
  const rawMessage = firstValue(raw, ["lastMessage", "lastMessageText", "content", "text", "message"]);
  const lastMessageText = cleanText(rawMessage || messagePlaceholder(rawType), 240);
  const maintenanceIntent = ["maintain", "ignore", "unset"].includes(raw.maintenanceIntent)
    ? raw.maintenanceIntent
    : "unset";
  const tagNames = Array.isArray(raw.tags)
    ? raw.tags.map((tag) => cleanText(typeof tag === "string" ? tag : tag?.name, 18)).filter(Boolean)
    : cleanText(raw.tags, 200).split(/[，,;；]/).map((tag) => tag.trim()).filter(Boolean);
  const rawCadence = raw.cadenceDays;
  const cadenceNumber = Number(rawCadence);
  const importedCadenceProvided = rawCadence !== undefined
    && rawCadence !== null
    && rawCadence !== ""
    && Number.isInteger(cadenceNumber)
    && cadenceNumber >= 7
    && cadenceNumber <= 365;
  const warnings = [];
  if (rawTimestamp !== null && !parsedTimestamp) warnings.push(`第 ${index + 1} 行的时间字段无效，已标记为待校验。`);
  if (rawCadence !== undefined && rawCadence !== null && rawCadence !== "" && !importedCadenceProvided) {
    warnings.push(`第 ${index + 1} 行的问候周期无效，将使用现有值或全局默认值。`);
  }

  return {
    contact: {
      id,
      name,
      initials: Array.from(name)[0] || "?",
      maintenanceIntent,
      lastMessageAt: parsedTimestamp?.toISOString() || null,
      lastMessageText,
      lastMessageType: cleanText(rawType || "unknown", 24),
      cadenceDays: importedCadenceProvided ? cadenceNumber : 30,
      importedCadenceProvided,
      customTagIds: [],
      importedTagNames: [...new Set(tagNames)].slice(0, 20),
      source: sourceContext?.providerId || "compatible-import",
      sourceId: cleanText(sourceExternalKey(raw), 128),
      sourceProviderId: sourceContext?.providerId || "portable-contact-file",
      sourceRef: sourceContext ? {
        contractVersion: 1,
        providerId: sourceContext.providerId,
        instanceId: sourceContext.instanceId,
        externalKey: cleanText(firstValue(raw, ["externalKey", "identityKey"]) || sourceExternalKey(raw), 128),
      } : null,
      needsReview: !sourceName
        || (rawTimestamp !== null && !parsedTimestamp)
        || Boolean(sourceContext && !sourceContext.capabilities.includes("latestInteraction")),
    },
    warnings,
  };
}

function isMessageLike(row) {
  return Boolean(row && typeof row === "object" && (
    "talker" in row || "conversationId" in row || "sessionId" in row || "peerId" in row
  ));
}

function hasContactIdentity(row, requiresInteraction = true) {
  const stableId = sourceExternalKey(row);
  const name = firstValue(row, ["remark", "displayName", "name", "nickName", "nickname", "accountName", "talkerName"]);
  const hasTimeField = ["lastMessageAt", "lastMessageTime", "timestamp", "createTime", "time"].some((key) => key in row);
  return Boolean(stableId && name && (!requiresInteraction || hasTimeField));
}

function normalizeMessages(rows, now, sourceContext = null) {
  const sessions = new Map();
  const warnings = [];

  rows.forEach((raw, index) => {
    const sessionId = cleanIdentifier(firstValue(raw, ["talker", "conversationId", "sessionId", "peerId"]), 128);
    if (!sessionId) {
      warnings.push(`第 ${index + 1} 条消息缺少会话 ID，已跳过。`);
      return;
    }
    if (shouldExcludeConversation(raw, sessionId)) {
      warnings.push(`第 ${index + 1} 条消息不是个人联系人会话，已跳过。`);
      return;
    }
    const timestamp = parseTimestamp(firstValue(raw, ["timestamp", "createTime", "time"]), now);
    if (!timestamp) {
      warnings.push(`第 ${index + 1} 条消息时间无效，已跳过。`);
      return;
    }
    const previous = sessions.get(sessionId);
    if (!previous || timestamp > previous.timestamp) sessions.set(sessionId, { raw, timestamp });
  });

  const contacts = [];
  [...sessions.entries()].forEach(([sessionId, entry], index) => {
    const withSession = { ...entry.raw, externalKey: sessionId, talker: sessionId, timestamp: entry.timestamp.toISOString() };
    const normalized = normalizeContact(withSession, index, now, sourceContext);
    normalized.contact.sourceId = sessionId;
    contacts.push(normalized.contact);
    warnings.push(...normalized.warnings);
  });
  return { contacts, warnings };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  row.push(field.replace(/\r$/, ""));
  if (row.some((value) => value !== "")) rows.push(row);
  if (!rows.length) return [];
  const headers = rows.shift().map((header) => cleanText(header.replace(/^\uFEFF/, ""), 80));
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export function parseImportText(text, filename = "import.json", now = new Date()) {
  const rawText = String(text || "").replace(/^\uFEFF/, "");
  if (!rawText.trim()) return { ok: false, error: "文件是空的，现有数据没有改变。" };

  let parsed;
  const csvMode = filename.toLowerCase().endsWith(".csv");
  try {
    parsed = csvMode ? parseCsv(rawText) : JSON.parse(rawText);
  } catch (error) {
    return { ok: false, error: `文件无法解析：${error.message}。现有数据没有改变。` };
  }

  const forbiddenKey = findForbiddenKey(parsed);
  if (forbiddenKey) return { ok: false, error: `文件包含不安全字段“${forbiddenKey}”，已停止导入。` };
  if (!csvMode && parsed && !Array.isArray(parsed) && parsed.version !== undefined && ![1, "1"].includes(parsed.version)) {
    return { ok: false, error: `文件版本 ${cleanText(parsed.version, 24)} 不受支持，已停止导入。` };
  }

  let sourceContext = null;
  const sourceWarnings = [];
  if (!csvMode && parsed?.format === "relationship-care-source") {
    const providerId = cleanIdentifier(parsed?.source?.providerId, 64);
    const instanceId = cleanIdentifier(parsed?.source?.instanceId, 96);
    if (!SOURCE_ID_PATTERN.test(providerId)) {
      return { ok: false, error: "关系回响数据源文件缺少有效的 source.providerId，现有数据没有改变。" };
    }
    if (!instanceId) {
      return { ok: false, error: "关系回响数据源文件缺少 source.instanceId，现有数据没有改变。" };
    }
    const rawCapabilities = parsed?.source?.capabilities === undefined
      ? ["contacts", "latestInteraction"]
      : parsed.source.capabilities;
    if (!Array.isArray(rawCapabilities)
      || !rawCapabilities.length
      || rawCapabilities.some((capability) => !SOURCE_CAPABILITIES.has(capability))
      || !rawCapabilities.includes("contacts")) {
      return { ok: false, error: "关系回响数据源文件的 source.capabilities 无效，至少需要 contacts。" };
    }
    const capabilities = [...new Set(rawCapabilities)];
    sourceContext = { providerId, instanceId, capabilities };
    if (!capabilities.includes("latestInteraction")) {
      sourceWarnings.push("这个读取器只提供联系人，没有最近互动时间；已导入并统一标记为待校验。你可以稍后手动设置维系意愿。");
    }
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.contacts)
      ? parsed.contacts
      : Array.isArray(parsed?.messages)
        ? parsed.messages
        : null;
  if (!rows) return { ok: false, error: "未找到 contacts 或 messages 列表。请使用 JSON/CSV 兼容格式。" };
  if (rows.length > MAX_IMPORT_RECORDS) {
    return { ok: false, error: `原始记录超过 ${MAX_IMPORT_RECORDS} 条，请先在 WeFlow 中缩小时间范围或拆分文件。` };
  }

  const messageMode = rows.some(isMessageLike)
    && !rows.some((row) => row && typeof row === "object" && !Array.isArray(row) && "lastMessageAt" in row);
  if (messageMode) {
    const result = normalizeMessages(rows, now, sourceContext);
    if (!result.contacts.length) return { ok: false, error: "没有找到可用的个人会话。群聊、公众号和无效时间记录已被过滤。" };
    if (result.contacts.length > MAX_CONTACTS) {
      return { ok: false, error: `归纳后有 ${result.contacts.length} 位联系人，超过 ${MAX_CONTACTS} 人上限。` };
    }
    return {
      ok: true,
      contacts: result.contacts,
      warnings: [...sourceWarnings, ...result.warnings].slice(0, 20),
      sourceKind: sourceContext ? "portable-contact-source" : "weflow-message-compatible",
      sourceMeta: sourceContext ? { ...sourceContext, providerContractVersion: 1 } : null,
      error: null,
    };
  }

  const contacts = [];
  const warnings = [...sourceWarnings];
  const normalizedContactIds = new Set();
  let duplicateContactId = null;
  const requiresInteraction = !sourceContext || sourceContext.capabilities.includes("latestInteraction");
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      warnings.push(`第 ${index + 1} 行不是对象，已跳过。`);
      return;
    }
    if (!hasContactIdentity(row, requiresInteraction)) {
      warnings.push(`第 ${index + 1} 行缺少稳定 ID、姓名${requiresInteraction ? "或最近联系时间字段" : ""}，已跳过。`);
      return;
    }
    if (shouldExcludeConversation(row)) {
      warnings.push(`第 ${index + 1} 行不是个人联系人会话，已跳过。`);
      return;
    }
    const normalized = normalizeContact(row, index, now, sourceContext);
    if (normalizedContactIds.has(normalized.contact.id)) {
      duplicateContactId = normalized.contact.id;
      return;
    }
    normalizedContactIds.add(normalized.contact.id);
    contacts.push(normalized.contact);
    warnings.push(...normalized.warnings);
  });
  if (duplicateContactId) return { ok: false, error: `文件中有多个联系人归一化为同一 ID（${duplicateContactId}），为避免错误合并已停止导入。` };
  if (!contacts.length) return { ok: false, error: `文件中没有同时具备稳定 ID、姓名${requiresInteraction ? "和时间字段" : ""}的联系人，现有数据没有改变。` };
  if (contacts.length > MAX_CONTACTS) {
    return { ok: false, error: `文件中有 ${contacts.length} 位联系人，超过 ${MAX_CONTACTS} 人上限。` };
  }
  return {
    ok: true,
    contacts,
    warnings: warnings.slice(0, 20),
    sourceKind: sourceContext ? "portable-contact-source" : "contact-summary-compatible",
    sourceMeta: sourceContext ? { ...sourceContext, providerContractVersion: 1 } : null,
    error: null,
  };
}
