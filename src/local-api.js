import { MAX_BATCH_SELECTION, MAX_CONTACTS } from "./limits.js";
import { allowsLegacyNullSourceRef, buildSourceScopedContactId } from "./importer.js";
import { validateState } from "./storage.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const WEFLOW_REQUEST_TIMEOUT_MS = 60_000;
const CONTACT_SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

class LocalApiError extends Error {
  constructor(message, { status = 0, code = "LOCAL_API_ERROR", details = null } = {}) {
    super(message);
    this.name = "LocalApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function readResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new LocalApiError(`本机服务响应读取失败：${error.message}`, {
      status: response.status,
      code: "LOCAL_API_RESPONSE_READ_FAILED",
    });
  }
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new LocalApiError(`本机服务返回 ${response.status}，但错误响应无法解析。`, {
          status: response.status,
          code: "LOCAL_API_INVALID_RESPONSE",
        });
      }
      throw new LocalApiError("本机服务返回了无效 JSON；请确认当前运行的是联系人维系服务。", {
        status: response.status,
        code: "LOCAL_API_INVALID_RESPONSE",
      });
    }
  }
  if (!response.ok) {
    throw new LocalApiError(payload?.error || `本机服务返回 ${response.status}。`, {
      status: response.status,
      code: payload?.code || "LOCAL_API_HTTP_ERROR",
      details: payload?.details || null,
    });
  }
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new LocalApiError("本机服务成功响应的类型不是 JSON；请检查端口是否被其他程序占用。", {
      status: response.status,
      code: "LOCAL_API_PROTOCOL_ERROR",
    });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.ok !== true) {
    throw new LocalApiError("本机服务响应缺少有效的 ok 标记。", {
      status: response.status,
      code: "LOCAL_API_PROTOCOL_ERROR",
    });
  }
  return payload;
}

function protocolError(message) {
  return new LocalApiError(message, { status: 200, code: "LOCAL_API_PROTOCOL_ERROR" });
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value, maximum = 160) {
  return typeof value === "string"
    && !/[\u0000-\u001F\u007F]/.test(value)
    && value.trim().length > 0
    && value.length <= maximum;
}

function isSafeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CONTACTS;
}

function isValidOptionalDate(value) {
  return value === null || value === undefined
    || (typeof value === "string" && value.length <= 64 && !Number.isNaN(new Date(value).getTime()));
}

function hasValidSourceRef(sourceRef) {
  return sourceRef === null || sourceRef === undefined || (isObject(sourceRef)
    && sourceRef.contractVersion === 1
    && CONTACT_SOURCE_ID_PATTERN.test(sourceRef.providerId || "")
    && isNonEmptyString(sourceRef.instanceId, 96)
    && isNonEmptyString(sourceRef.externalKey, 128));
}

function hasConsistentSourceIdentity(contact, expectedProviderId) {
  if (contact.sourceRef === null || contact.sourceRef === undefined) {
    return allowsLegacyNullSourceRef(expectedProviderId);
  }
  const providerId = contact.sourceRef.providerId;
  return contact.sourceProviderId === providerId
    && (expectedProviderId === null || providerId === expectedProviderId)
    && contact.id === buildSourceScopedContactId(
      providerId,
      contact.sourceRef.instanceId,
      contact.sourceRef.externalKey,
    );
}

function hasValidPreviewContact(contact, expectedProviderId = null) {
  return isObject(contact)
    && isNonEmptyString(contact.id, 128)
    && isNonEmptyString(contact.name, 48)
    && typeof contact.initials === "string"
    && contact.initials.length <= 8
    && ["maintain", "ignore", "unset"].includes(contact.maintenanceIntent)
    && isValidOptionalDate(contact.lastMessageAt)
    && typeof contact.lastMessageText === "string"
    && contact.lastMessageText.length <= 5_000
    && typeof contact.lastMessageType === "string"
    && contact.lastMessageType.length <= 48
    && Number.isInteger(contact.cadenceDays)
    && contact.cadenceDays >= 7
    && contact.cadenceDays <= 365
    && typeof contact.importedCadenceProvided === "boolean"
    && Array.isArray(contact.customTagIds)
    && contact.customTagIds.length <= 100
    && contact.customTagIds.every((tagId) => typeof tagId === "string" && tagId.length <= 96)
    && Array.isArray(contact.importedTagNames)
    && contact.importedTagNames.length <= 20
    && contact.importedTagNames.every((name) => isNonEmptyString(name, 18))
    && typeof contact.source === "string"
    && contact.source.length <= 96
    && typeof contact.sourceId === "string"
    && !/[\u0000-\u001F\u007F]/.test(contact.sourceId)
    && contact.sourceId.length <= 128
    && typeof contact.needsReview === "boolean"
    && hasValidSourceRef(contact.sourceRef)
    && (expectedProviderId === null || contact.sourceProviderId === expectedProviderId)
    && hasConsistentSourceIdentity(contact, expectedProviderId);
}

function hasValidContactPreviewPayload(payload, expectedProviderId = null) {
  return Array.isArray(payload.contacts)
    && payload.contacts.length <= MAX_CONTACTS
    && payload.contacts.every((contact) => hasValidPreviewContact(contact, expectedProviderId))
    && new Set(payload.contacts.map((contact) => contact.id)).size === payload.contacts.length
    && Array.isArray(payload.warnings)
    && payload.warnings.length <= 20
    && payload.warnings.every((warning) => typeof warning === "string" && warning.length <= 1_000)
    && isNonEmptyString(payload.sourceKind, 96)
    && isObject(payload.sourceMeta)
    && payload.sourceMeta.providerContractVersion === 1
    && CONTACT_SOURCE_ID_PATTERN.test(payload.sourceMeta.providerId || "")
    && Array.isArray(payload.sourceMeta.capabilities)
    && payload.sourceMeta.capabilities.includes("contacts");
}

function hasValidPendingUndo(record, state, serverNow) {
  if (record === null) return true;
  if (!isObject(record) || !state || Object.hasOwn(record, "contactIds")) return false;
  const tag = state.tags.find((candidate) => candidate.id === record.tagId);
  return isNonEmptyString(record.id)
    && ["add", "remove"].includes(record.action)
    && isNonEmptyString(record.tagId, 96)
    && typeof record.tagName === "string"
    && record.tagName.length <= 18
    && typeof record.scopeLabel === "string"
    && record.scopeLabel.length <= 120
    && Number.isSafeInteger(record.changedCount)
    && record.changedCount >= 1
    && record.changedCount <= MAX_CONTACTS
    && isSafeTimestamp(record.createdAt)
    && isSafeTimestamp(record.expiresAt)
    && record.expiresAt > record.createdAt
    && record.expiresAt > serverNow
    && isNonEmptyString(record.stateChangeId)
    && record.stateChangeId === state.changeId
    && Boolean(tag)
    && tag.name === record.tagName;
}

function hasAuthoritativeEnvelope(payload, { allowNullState = false } = {}) {
  if (!Object.hasOwn(payload, "state")
    || !Object.hasOwn(payload, "pendingUndo")
    || !isSafeTimestamp(payload.serverNow)
    || !isObject(payload.storage)) return false;
  if (payload.state === null) return allowNullState && payload.pendingUndo === null;
  if (!validateState(payload.state).ok) return false;
  return hasValidPendingUndo(payload.pendingUndo, payload.state, payload.serverNow);
}

function createRequestDeadline(sourceSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromSource = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) abortFromSource();
  else sourceSignal?.addEventListener("abort", abortFromSource, { once: true });
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("本机数据服务请求超时", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup() {
      globalThis.clearTimeout(timeoutId);
      sourceSignal?.removeEventListener("abort", abortFromSource);
    },
  };
}

async function request(path, options = {}, validatePayload = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const method = String(options.method || "GET").toUpperCase();
  const outcomeCanBeUnknown = !["GET", "HEAD"].includes(method);
  const deadline = createRequestDeadline(options.signal, timeoutMs);
  try {
    const response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      signal: deadline.signal,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const payload = await readResponse(response);
    if (validatePayload && !validatePayload(payload)) {
      throw protocolError("本机服务响应字段不完整或类型不正确。请重启本地预览服务。" );
    }
    return payload;
  } catch (error) {
    if (deadline.didTimeOut()) {
      throw new LocalApiError(`本机数据服务在 ${Math.round(timeoutMs / 1000)} 秒内没有响应。`, {
        code: "LOCAL_API_TIMEOUT",
        details: { outcomeUnknown: outcomeCanBeUnknown },
      });
    }
    if (error instanceof LocalApiError) {
      const explicitClientRejection = error.status >= 400 && error.status < 500
        && !["LOCAL_API_RESPONSE_READ_FAILED", "LOCAL_API_INVALID_RESPONSE", "LOCAL_API_PROTOCOL_ERROR"].includes(error.code);
      if (outcomeCanBeUnknown && !explicitClientRejection) {
        error.details = { ...(isObject(error.details) ? error.details : {}), outcomeUnknown: true };
      }
      throw error;
    }
    throw new LocalApiError(`无法连接本机数据服务：${error.message}`, {
      code: "LOCAL_SERVICE_UNAVAILABLE",
      details: { outcomeUnknown: outcomeCanBeUnknown },
    });
  } finally {
    deadline.cleanup();
  }
}

export function loadAuthoritativeState() {
  return request("/api/state", {}, (payload) => hasAuthoritativeEnvelope(payload, { allowNullState: true }));
}

export function saveAuthoritativeState(state, expectedChangeId, { destructive = false } = {}) {
  return request("/api/state", {
    method: "PUT",
    body: JSON.stringify({ state, expectedChangeId, destructive }),
  }, (payload) => hasAuthoritativeEnvelope(payload));
}

export function applyAuthoritativeBatchTag({ action, tagId, contactIds, scopeLabel, expectedChangeId, operationId }) {
  const validTargets = Array.isArray(contactIds) && contactIds.every((contactId) => isNonEmptyString(contactId));
  const targetCount = validTargets ? new Set(contactIds).size : 0;
  return request("/api/state/batch-tag", {
    method: "POST",
    body: JSON.stringify({ action, tagId, contactIds, scopeLabel, expectedChangeId, operationId }),
  }, (payload) => hasAuthoritativeEnvelope(payload)
    && isObject(payload.pendingUndo)
    && payload.pendingUndo.id === operationId
    && isObject(payload.batch)
    && payload.batch.action === action
    && payload.batch.tagId === tagId
    && isNonNegativeCount(payload.batch.changedCount)
    && payload.batch.changedCount === payload.pendingUndo.changedCount
    && isNonNegativeCount(payload.batch.skippedCount)
    && isNonNegativeCount(payload.batch.missingCount)
    && targetCount >= 1
    && targetCount <= MAX_BATCH_SELECTION
    && payload.batch.changedCount + payload.batch.skippedCount + payload.batch.missingCount === targetCount);
}

export function consumeAuthoritativeBatchUndo({ undoId, expectedChangeId, expectedAction = null, expectedTagId = null }) {
  return request("/api/state/batch-tag/undo", {
    method: "POST",
    body: JSON.stringify({ undoId, expectedChangeId }),
  }, (payload) => hasAuthoritativeEnvelope(payload)
    && payload.pendingUndo === null
    && payload.clearedUndoId === undoId
    && isObject(payload.undone)
    && ["add", "remove"].includes(payload.undone.action)
    && isNonEmptyString(payload.undone.tagId, 96)
    && (expectedAction === null || payload.undone.action === expectedAction)
    && (expectedTagId === null || payload.undone.tagId === expectedTagId)
    && isNonNegativeCount(payload.undone.changedCount)
    && isNonNegativeCount(payload.undone.skippedCount)
    && isNonNegativeCount(payload.undone.missingCount));
}

export function createDiskBackup() {
  return request("/api/storage/backup", {
    method: "POST",
    body: JSON.stringify({ reason: "manual" }),
  }, (payload) => payload.backup && typeof payload.backup.filename === "string"
    && payload.storage && typeof payload.storage === "object");
}

function hasValidContactSourceDescriptor(source) {
  return isObject(source)
    && CONTACT_SOURCE_ID_PATTERN.test(source.id || "")
    && isNonEmptyString(source.displayName, 80)
    && isNonEmptyString(source.description, 240)
    && Array.isArray(source.platforms)
    && source.platforms.every((platform) => isNonEmptyString(platform, 24))
    && Array.isArray(source.capabilities)
    && source.capabilities.includes("contacts")
    && source.capabilities.every((capability) => isNonEmptyString(capability, 48))
    && typeof source.supportedOnHost === "boolean"
    && ["server", "browser"].includes(source.handledBy);
}

export function listContactSources() {
  return request("/api/contact-sources", {}, (payload) => payload.contractVersion === 1
    && Array.isArray(payload.sources)
    && payload.sources.length >= 2
    && payload.sources.every(hasValidContactSourceDescriptor));
}

export function previewContactSource({ sourceId, configuration = {}, signal }) {
  if (!CONTACT_SOURCE_ID_PATTERN.test(sourceId || "")) {
    return Promise.reject(new LocalApiError("联系人数据源 ID 无效。", {
      status: 0,
      code: "INVALID_CONTACT_SOURCE_ID",
    }));
  }
  return request(`/api/contact-sources/${sourceId}/preview`, {
    method: "POST",
    body: JSON.stringify(configuration),
    signal,
  }, (payload) => hasValidContactPreviewPayload(payload, sourceId)
    && payload.sourceMeta.providerId === sourceId, WEFLOW_REQUEST_TIMEOUT_MS);
}

export function previewWeFlow({ port, token, signal }) {
  return request("/api/weflow/preview", {
    method: "POST",
    body: JSON.stringify({ port, token }),
    signal,
  }, (payload) => hasValidContactPreviewPayload(payload, "weflow-http-win32")
    && payload.sourceKind === "weflow-direct", WEFLOW_REQUEST_TIMEOUT_MS);
}

export { LocalApiError };
