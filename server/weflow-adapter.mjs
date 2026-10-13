import { MAX_CONTACTS } from "../src/limits.js";
import { parseImportText } from "../src/importer.js";

const MAX_WEFLOW_RESPONSE_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const MESSAGE_CONCURRENCY = 12;
const MESSAGE_PREVIEW_BUDGET_MS = 45_000;

export class WeFlowAdapterError extends Error {
  constructor(message, { status = 502, code = "WEFLOW_ERROR" } = {}) {
    super(message);
    this.name = "WeFlowAdapterError";
    this.status = status;
    this.code = code;
  }
}

function cleanText(value, maximum = 240) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maximum);
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
  }
  return null;
}

function isPrivateConversation(id, type = "") {
  const normalizedId = cleanText(id, 128);
  const normalizedType = String(type || "").toLowerCase();
  return Boolean(normalizedId)
    && !normalizedId.includes("@chatroom")
    && !normalizedId.startsWith("gh_")
    && !["group", "official", "public", "subscription"].includes(normalizedType)
    && Number(type) !== 2;
}

function isoTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  const date = Number.isFinite(number)
    ? new Date(number < 10_000_000_000 ? number * 1_000 : number)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function placeholderForType(type) {
  const normalized = String(type ?? "").toLowerCase();
  if (["3", "image", "photo"].includes(normalized)) return "[图片]";
  if (["34", "voice", "audio"].includes(normalized)) return "[语音]";
  if (["43", "video"].includes(normalized)) return "[视频]";
  if (["47", "emoji"].includes(normalized)) return "[表情]";
  if (["49", "file", "link"].includes(normalized)) return "[文件或链接]";
  return "";
}

async function readLimitedBody(response, controller) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_WEFLOW_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch {}
      controller.abort();
      throw new WeFlowAdapterError("WeFlow 返回内容过大，已停止读取。", { status: 413, code: "WEFLOW_RESPONSE_TOO_LARGE" });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function fetchWeFlowJson(baseUrl, pathname, token = "", { signal } = {}) {
  const controller = new AbortController();
  let requestTimedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? "WEFLOW_AUTH_FAILED" : "WEFLOW_HTTP_ERROR";
      const message = code === "WEFLOW_AUTH_FAILED"
        ? "WeFlow 拒绝了 Access Token，请在 WeFlow 的 API 服务设置中重新复制。"
        : `WeFlow 接口返回 ${response.status}。`;
      throw new WeFlowAdapterError(message, { status: response.status === 401 || response.status === 403 ? 401 : 502, code });
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_WEFLOW_RESPONSE_BYTES) {
      controller.abort();
      throw new WeFlowAdapterError("WeFlow 返回内容过大，已停止读取。", { status: 413, code: "WEFLOW_RESPONSE_TOO_LARGE" });
    }
    const text = await readLimitedBody(response, controller);
    try {
      return JSON.parse(text);
    } catch {
      throw new WeFlowAdapterError("WeFlow 返回的不是有效 JSON，请确认 API 服务版本。", { code: "WEFLOW_INVALID_JSON" });
    }
  } catch (error) {
    if (error instanceof WeFlowAdapterError) throw error;
    if (controller.signal.aborted && signal?.aborted) {
      throw new WeFlowAdapterError("WeFlow 预览已取消。", { status: 499, code: "WEFLOW_CANCELLED" });
    }
    if (requestTimedOut || error?.name === "AbortError") {
      throw new WeFlowAdapterError("连接 WeFlow 超时，请确认 API 服务已经启动。", { status: 504, code: "WEFLOW_TIMEOUT" });
    }
    throw new WeFlowAdapterError("无法连接 WeFlow，请确认 WeFlow 已启动、API 服务已开启，并检查端口（默认 5031）。", { code: "WEFLOW_UNAVAILABLE" });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function latestMessageFromPayload(payload) {
  const rows = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!rows.length) return null;
  return [...rows].sort((a, b) => Number(firstValue(b, ["createTime", "timestamp", "time"]) || 0) - Number(firstValue(a, ["createTime", "timestamp", "time"]) || 0))[0];
}

function payloadHasMore(payload) {
  return payload?.hasMore === true
    || payload?.has_more === true
    || Boolean(payload?.nextCursor)
    || Boolean(payload?.next_cursor);
}

export async function previewWeFlow({ port = 5031, token, signal } = {}) {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new WeFlowAdapterError("WeFlow 端口必须在 1 到 65535 之间。", { status: 422, code: "INVALID_WEFLOW_PORT" });
  }
  const accessToken = String(token || "").trim();
  if (!accessToken || accessToken.length > 2_048) {
    throw new WeFlowAdapterError("请输入 WeFlow API 服务的 Access Token。", { status: 422, code: "INVALID_WEFLOW_TOKEN" });
  }

  const baseUrl = `http://127.0.0.1:${parsedPort}`;
  const health = await fetchWeFlowJson(baseUrl, "/health", "", { signal });
  if (health?.status !== "ok") {
    throw new WeFlowAdapterError("WeFlow 健康检查未返回 ok。", { code: "WEFLOW_UNHEALTHY" });
  }

  const [contactsPayload, sessionsPayload] = await Promise.all([
    fetchWeFlowJson(baseUrl, `/api/v1/contacts?limit=${MAX_CONTACTS}`, accessToken, { signal }),
    fetchWeFlowJson(baseUrl, `/api/v1/sessions?limit=${MAX_CONTACTS}`, accessToken, { signal }),
  ]);
  const contacts = Array.isArray(contactsPayload?.contacts) ? contactsPayload.contacts : [];
  const sessions = Array.isArray(sessionsPayload?.sessions) ? sessionsPayload.sessions : [];
  const reportedCount = Math.max(Number(contactsPayload?.count || contacts.length), Number(sessionsPayload?.count || sessions.length));
  if (reportedCount > MAX_CONTACTS) {
    throw new WeFlowAdapterError(`WeFlow 中有 ${reportedCount} 个联系人或会话，超过本应用 ${MAX_CONTACTS} 人上限。请先缩小范围。`, {
      status: 422,
      code: "CONTACT_LIMIT_EXCEEDED",
    });
  }
  if (payloadHasMore(contactsPayload) || payloadHasMore(sessionsPayload)) {
    throw new WeFlowAdapterError(`WeFlow 仍有下一页数据，无法在 ${MAX_CONTACTS} 人上限内完整预览。请先缩小范围。`, {
      status: 422,
      code: "CONTACT_LIMIT_EXCEEDED",
    });
  }

  const sessionById = new Map();
  sessions.forEach((session) => {
    const id = cleanText(firstValue(session, ["username", "id", "sessionId"]), 128);
    if (isPrivateConversation(id, firstValue(session, ["type", "sessionType"]))) sessionById.set(id, session);
  });
  const contactById = new Map();
  contacts.forEach((contact) => {
    const id = cleanText(firstValue(contact, ["username", "wxid", "id"]), 128);
    if (isPrivateConversation(id, firstValue(contact, ["type", "contactType"]))) contactById.set(id, contact);
  });
  sessionById.forEach((session, id) => {
    if (!contactById.has(id)) contactById.set(id, { username: id, displayName: session.displayName });
  });
  if (contactById.size > MAX_CONTACTS) {
    throw new WeFlowAdapterError(`过滤群聊并去重后仍有 ${contactById.size} 位联系人，超过本应用 ${MAX_CONTACTS} 人上限。当前数据没有改变。`, {
      status: 422,
      code: "CONTACT_LIMIT_EXCEEDED",
    });
  }

  const warnings = [];
  const candidates = [...contactById.entries()].sort(([, left], [, right]) => {
    const leftSession = sessionById.get(firstValue(left, ["username", "wxid", "id"])) || {};
    const rightSession = sessionById.get(firstValue(right, ["username", "wxid", "id"])) || {};
    return Number(firstValue(rightSession, ["lastTimestamp", "lastMessageAt"]) || 0)
      - Number(firstValue(leftSession, ["lastTimestamp", "lastMessageAt"]) || 0);
  });
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), MESSAGE_PREVIEW_BUDGET_MS);
  const messageSignal = signal ? AbortSignal.any([signal, deadlineController.signal]) : deadlineController.signal;
  let emptyMessageCount = 0;
  let failedMessageCount = 0;
  let skippedMessageCount = 0;
  const failureSamples = [];
  let summaries;
  try {
    summaries = await mapWithConcurrency(candidates, MESSAGE_CONCURRENCY, async ([id, contact], index) => {
      if (signal?.aborted) {
        throw new WeFlowAdapterError("WeFlow 预览已取消。", { status: 499, code: "WEFLOW_CANCELLED" });
      }
      const session = sessionById.get(id) || {};
      let message = null;
      let fetchFailed = false;
      let messageMissing = false;
      let deadlineSkipped = false;
      const embeddedText = firstValue(session, ["lastMessage", "lastMessageText", "content"]);
      if (!embeddedText && firstValue(session, ["lastTimestamp", "lastMessageAt"])) {
        if (deadlineController.signal.aborted) {
          deadlineSkipped = true;
          skippedMessageCount += 1;
        } else {
          try {
            const payload = await fetchWeFlowJson(baseUrl, `/api/v1/messages?talker=${encodeURIComponent(id)}&limit=1`, accessToken, { signal: messageSignal });
            message = latestMessageFromPayload(payload);
            if (!message) {
              messageMissing = true;
              emptyMessageCount += 1;
            }
          } catch (error) {
            if (signal?.aborted) throw error;
            if (deadlineController.signal.aborted) {
              deadlineSkipped = true;
              skippedMessageCount += 1;
            } else if (error?.code === "WEFLOW_AUTH_FAILED") {
              throw error;
            } else {
              fetchFailed = true;
              failedMessageCount += 1;
              if (failureSamples.length < 3) failureSamples.push(error.message);
            }
          }
        }
      }
      const messageType = firstValue(message, ["localType", "type", "msgType"]);
      const content = cleanText(firstValue(message, ["content", "parsedContent", "rawContent"]) || embeddedText || placeholderForType(messageType), 240);
      return {
        id,
        username: id,
        name: cleanText(firstValue(contact, ["remark", "displayName", "nickname", "alias"]) || firstValue(session, ["displayName", "name"]) || id, 48),
        lastMessageAt: isoTimestamp(firstValue(message, ["createTime", "timestamp", "time"]) || firstValue(session, ["lastTimestamp", "lastMessageAt"])),
        lastMessage: content,
        lastMessageType: cleanText(messageType || "unknown", 24),
        sourceId: id,
        needsReview: fetchFailed || messageMissing || deadlineSkipped,
        _index: index,
      };
    });
  } finally {
    clearTimeout(deadlineTimer);
  }

  if (skippedMessageCount) {
    warnings.push(`最近消息读取达到 ${Math.round(MESSAGE_PREVIEW_BUDGET_MS / 1_000)} 秒总预算；${skippedMessageCount} 位联系人保留了会话时间并标记为待校验。`);
  }
  if (failedMessageCount) {
    warnings.push(`${failedMessageCount} 位联系人的最近消息读取失败，已保留会话时间并标记为待校验${failureSamples.length ? `（示例：${failureSamples.join("；")}）` : ""}。`);
  }
  if (emptyMessageCount) {
    warnings.push(`${emptyMessageCount} 位联系人的消息接口返回 0 条，已保留会话时间并标记为待校验。`);
  }

  const normalized = parseImportText(JSON.stringify({ version: 1, contacts: summaries }), "weflow-direct.json", new Date());
  if (!normalized.ok) {
    throw new WeFlowAdapterError(normalized.error, { status: 422, code: "WEFLOW_NORMALIZATION_FAILED" });
  }
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  normalized.contacts.forEach((contact) => {
    contact.source = "weflow-direct";
    contact.needsReview = Boolean(contact.needsReview || summaryById.get(contact.sourceId)?.needsReview);
  });
  const zeroMessageCount = summaries.filter((item) => item.lastMessageAt && !item.lastMessage).length;
  if (emptyMessageCount > 0
    && !failedMessageCount
    && !skippedMessageCount
    && zeroMessageCount === summaries.filter((item) => item.lastMessageAt).length) {
    warnings.unshift("WeFlow 会话可读，但消息接口全部返回空内容；这通常表示当前 WeFlow/微信数据库版本的消息 API 不兼容。时间仍已保留，请先核对预览。 ");
  }
  return {
    ok: true,
    contacts: normalized.contacts,
    warnings: [...warnings, ...normalized.warnings].slice(0, 20),
    sourceKind: "weflow-direct",
    sourceMeta: {
      port: parsedPort,
      contacts: normalized.contacts.length,
      partial: skippedMessageCount + failedMessageCount + emptyMessageCount > 0,
    },
    error: null,
  };
}
