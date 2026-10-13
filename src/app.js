import {
  AUTO_HIDE_AFTER_DAYS,
  FREQUENCY,
  MAINTENANCE,
  SYSTEM_LABELS,
  addLocalDays,
  applyContactFilters,
  collectUpcomingAnnualDates,
  createCustomTag,
  deriveContacts,
  formatAnnualDate,
  makeGreetingDraft,
  markMaintained,
  parseAnnualDate,
  partitionContactsByVisibility,
  setMaintenanceIntent,
  snoozeContact,
  sortByReminderPriority,
} from "./domain.js";
import { createDemoState } from "./data.js";
import {
  buildBatchTagCandidate,
  isBatchUndoExpired,
} from "./batch-undo.js";
import {
  MAX_BATCH_SELECTION,
  reconcileContactSelection,
  selectCurrentPage,
  summarizeContactSelection,
  toggleContactSelection,
} from "./contact-selection.js";
import { parseImportText } from "./importer.js";
import { initTextScale, initVisualTheme } from "./visual-theme.js";
import { ALLOWED_PAGE_SIZES, DEFAULT_PAGE_SIZE, MAX_CONTACTS, MAX_IMPORT_FILE_BYTES } from "./limits.js";
import {
  LocalApiError,
  applyAuthoritativeBatchTag,
  consumeAuthoritativeBatchUndo,
  createDiskBackup,
  listContactSources,
  loadAuthoritativeState,
  previewContactSource,
  saveAuthoritativeState,
} from "./local-api.js";
import {
  STORAGE_KEY,
  loadState,
  parseBackup,
  saveState,
  serializeBackup,
  validateState,
} from "./storage.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function element(tagName, options = {}, children = []) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.type) node.type = options.type;
  if (options.title) node.title = options.title;
  if (options.hidden) node.hidden = true;
  if (options.dataset) Object.assign(node.dataset, options.dataset);
  if (options.attributes) {
    Object.entries(options.attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  }
  const childList = Array.isArray(children) ? children : [children];
  childList.filter((child) => child !== null && child !== undefined).forEach((child) => {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

const initialLoad = loadState(window.localStorage);
let state = initialLoad.state || createDemoState();
let pendingImport = null;
let selectedContactId = null;
let pendingConfirmation = null;
let toastTimer = null;
let currentPage = 1;
let pageSize = DEFAULT_PAGE_SIZE;
let searchTimer = null;
let importOperationId = 0;
let weflowPreviewController = null;
let contactSourceCatalog = [];
let weflowSupportedOnHost = false;
let lastBatchUndo = null;
let authorityRequestSequence = 0;
let authorityHydrationFlight = null;
let authority = {
  ready: false,
  storage: null,
  error: null,
};

const filters = {
  query: "",
  frequency: "all",
  maintenance: "all",
  tagId: "all",
  timeRange: "all",
  dueOnly: false,
  hiddenOnly: false,
};
let bulkTagId = "";
let selectedContactIds = new Set();
let ledgerSortMode = "priority";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dayFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  weekday: "long",
});

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const frequencyFilterLabel = {
  all: "全部频率",
  infrequent: "不常联系人",
  frequent: "常联系人",
};

const maintenanceFilterLabel = {
  all: "全部维系意愿",
  maintain: "需要维系",
  ignore: "不需要维系",
};

const timeRangeLabelByValue = {
  all: "全部时段",
  "0-6": "0–6 天",
  "7-13": "7–13 天",
  "14-29": "14–29 天",
  "30-59": "30–59 天",
  "60-179": "60–179 天",
  "180+": "180+ 天",
  unknown: "待校验/未知",
};

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "待校验";
  return dateFormatter.format(date).replaceAll("/", "-");
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : dateTimeFormatter.format(date).replaceAll("/", "-");
}

function formatDaysAgo(days) {
  if (days === null || days === undefined) return "尚未联系";
  if (days === 0) return "今天";
  if (days === 1) return "1 天前";
  return `${days} 天前`;
}

function formatReminder(contact) {
  if (contact.maintenanceIntent === MAINTENANCE.IGNORE) return { main: "无需提醒", sub: "不需要维系", tone: "" };
  if (contact.maintenanceIntent === MAINTENANCE.UNSET) return { main: "尚未设置", sub: "请确认维系意愿", tone: "" };
  if (contact.reminderState === "first-greeting") return { main: "首次问候", sub: "还没有互动记录", tone: "due" };
  if (!contact.nextReminderAt) return { main: "待校验", sub: "缺少有效互动时间", tone: "" };
  if (contact.reminderState === "snoozed") return { main: formatDate(contact.nextReminderAt), sub: "已稍后提醒", tone: "upcoming" };
  if (contact.reminderState === "overdue") return { main: `逾期 ${Math.abs(contact.daysUntilDue)} 天`, sub: formatDate(contact.nextReminderAt), tone: "due" };
  if (contact.reminderState === "today") return { main: "今天", sub: formatDate(contact.nextReminderAt), tone: "due" };
  if (contact.daysUntilDue === 1) return { main: "明天", sub: formatDate(contact.nextReminderAt), tone: "upcoming" };
  return { main: `${contact.daysUntilDue} 天后`, sub: formatDate(contact.nextReminderAt), tone: contact.daysUntilDue <= 7 ? "upcoming" : "" };
}

function anonymizedName(contact) {
  const index = Math.max(0, state.contacts.findIndex((item) => item.id === contact.id));
  return `联系人 ${String(index + 1).padStart(2, "0")}`;
}

function visibleName(contact) {
  return state.settings.privacyMode ? anonymizedName(contact) : contact.name;
}

function visibleMessage(contact) {
  if (state.settings.privacyMode) return "消息摘要已隐藏";
  return contact.lastMessageText || "没有可显示的消息摘要";
}

function getTagName(tagId) {
  if (tagId === "all" || !tagId) return "全部标签";
  const tag = state.tags.find((item) => item.id === tagId);
  return tag?.name || "未知标签";
}

function getCurrentFilterSummary() {
  const scopeText = filters.hiddenOnly ? "查看已隐藏" : "查看当前";
  const queryText = filters.query ? `，关键词“${filters.query}”` : "";
  const dueText = filters.dueOnly ? "，仅看待问候" : "";
  const tagText = getTagName(filters.tagId);
  return `${scopeText} · ${frequencyFilterLabel[filters.frequency] || filters.frequency} · ${maintenanceFilterLabel[filters.maintenance] || filters.maintenance} · ${tagText} · ${timeRangeLabelByValue[filters.timeRange] || "自定义时段"}${dueText}${queryText}`;
}

function contactSourceKind(contact = {}) {
  const provider = String(contact.sourceProviderId || contact.sourceRef?.providerId || contact.source || "").toLowerCase();
  if (provider === "demo") return "demo";
  if (provider === "mac-reader-bridge" || provider.includes("mac-reader") || provider.includes("mac-bridge")) return "mac";
  if (provider === "weflow-direct" || provider.includes("weflow")) return "weflow";
  if (provider === "portable-contact-file" || provider === "local-import" || provider.includes("portable") || provider.includes("local-file")) return "portable";
  return "compatible";
}

function sourceLabel(contact) {
  const sourceKind = contactSourceKind(contact);
  if (sourceKind === "demo") return "演示数据";
  if (sourceKind === "mac") return "Mac 读取桥";
  if (sourceKind === "weflow") return "WeFlow";
  if (sourceKind === "portable") return "本地文件";
  return "兼容来源";
}

function toneForId(id) {
  const score = [...String(id)].reduce((total, character) => total + character.charCodeAt(0), 0);
  return `tone-${(score % 8) + 1}`;
}

function announce(message) {
  $("#app-status").textContent = message;
}

function showToast(message, type = "success") {
  const toast = $("#toast");
  window.clearTimeout(toastTimer);
  toast.replaceChildren();
  toast.append(
    element("span", { className: "toast-message", text: message }),
  );
  toast.classList.toggle("is-error", type === "error");
  toast.hidden = false;
  announce(message);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function renderBatchUndo() {
  const panel = $("#batch-undo-panel");
  const message = $("#batch-undo-message");
  const button = $("#batch-undo-action");
  if (!lastBatchUndo) {
    panel.hidden = true;
    panel.removeAttribute("aria-busy");
    return;
  }

  const currentTagName = state.tags.find((tag) => tag.id === lastBatchUndo.tagId)?.name || lastBatchUndo.tagName;
  const inFlight = lastBatchUndo.status === "in-flight";
  const reconciling = lastBatchUndo.status === "reconciling";
  const remainingSeconds = Math.max(0, Math.ceil((lastBatchUndo.expiresAt - Date.now()) / 1000));
  message.textContent = reconciling
    ? "请求响应超时，正在读取本机数据库核对最终结果…"
    : inFlight
    ? `正在撤销“${currentTagName}”标签的批量操作…`
    : !authority.ready
      ? "本机数据服务暂不可写；重新连接后才能继续撤销。"
    : lastBatchUndo.lastError
      ? "上次撤销保存失败；可在撤销窗口结束前重试。"
      : `刚刚整理了 ${lastBatchUndo.changedCount} 位联系人；还可撤销约 ${remainingSeconds} 秒。`;
  button.disabled = inFlight || reconciling || !authority.ready;
  button.textContent = reconciling ? "核对中…" : inFlight ? "撤销中…" : "撤销";
  if (inFlight || reconciling) panel.setAttribute("aria-busy", "true");
  else panel.removeAttribute("aria-busy");
  panel.hidden = false;
}

function clearBatchUndo(expectedId = null) {
  if (!lastBatchUndo || (expectedId !== null && lastBatchUndo.id !== expectedId)) return false;
  const panel = $("#batch-undo-panel");
  const activeElement = document.activeElement;
  const focusFellBackToPage = activeElement === document.body || activeElement === null;
  const restoreFocus = panel.contains(activeElement)
    || (lastBatchUndo.restoreFocusAfterDisable && focusFellBackToPage);
  window.clearTimeout(lastBatchUndo.timerId);
  lastBatchUndo = null;
  renderBatchUndo();
  if (restoreFocus) {
    $("#bulk-tag-select").focus({ preventScroll: true });
    announce("最近一次批量操作的撤销入口已关闭。焦点已返回快速整理标签。" );
  }
  return true;
}

function scheduleBatchUndoExpiry(record) {
  window.clearTimeout(record.timerId);
  const delay = Math.max(0, record.expiresAt - Date.now());
  record.timerId = window.setTimeout(() => {
    if (lastBatchUndo?.id !== record.id) return;
    if (lastBatchUndo.status === "in-flight" || lastBatchUndo.status === "reconciling") {
      lastBatchUndo.expiredWhileInFlight = true;
      renderBatchUndo();
      return;
    }
    clearBatchUndo(record.id);
  }, delay);
}

function setBatchUndo(record, { focus = true, announceAvailability = focus } = {}) {
  window.clearTimeout(lastBatchUndo?.timerId);
  lastBatchUndo = {
    ...record,
    status: ["in-flight", "reconciling"].includes(record.status) ? record.status : "available",
    timerId: null,
    lastError: record.lastError || null,
    expiredWhileInFlight: Boolean(record.expiredWhileInFlight),
  };
  scheduleBatchUndoExpiry(lastBatchUndo);
  renderBatchUndo();
  if (focus) $("#batch-undo-action").focus({ preventScroll: true });
  if (announceAvailability) {
    const remainingSeconds = Math.max(0, Math.ceil((lastBatchUndo.expiresAt - Date.now()) / 1000));
    announce(`已整理 ${lastBatchUndo.changedCount} 位联系人，可在约 ${remainingSeconds} 秒内撤销。${focus ? "焦点已移到撤销按钮。" : ""}`);
  }
}

function normalizeAuthoritativeBatchUndo(record, serverNow) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if ((record.action !== "add" && record.action !== "remove")
    || (typeof record.id !== "string" || !record.id.trim())
    || (typeof record.tagId !== "string" || !record.tagId.trim())
    || typeof record.tagName !== "string"
    || typeof record.scopeLabel !== "string"
    || !Number.isInteger(record.changedCount)
    || record.changedCount < 1
    || record.changedCount > MAX_CONTACTS
    || !Number.isFinite(record.createdAt)
    || !Number.isFinite(record.expiresAt)
    || !Number.isFinite(serverNow)
    || record.expiresAt <= record.createdAt
    || record.expiresAt <= serverNow
    || (record.stateChangeId && record.stateChangeId !== stateIdentity(state))) {
    return null;
  }
  return {
    id: record.id,
    action: record.action,
    tagId: record.tagId,
    tagName: record.tagName,
    scopeLabel: record.scopeLabel,
    changedCount: record.changedCount,
    createdAt: record.createdAt,
    authoritativeExpiresAt: record.expiresAt,
    expiresAt: record.expiresAt,
    stateChangeId: record.stateChangeId || stateIdentity(state),
  };
}

function syncBatchUndoFromAuthority(record, serverNow, { focus = false, announceAvailability = false } = {}) {
  const normalized = normalizeAuthoritativeBatchUndo(record, serverNow);
  if (!normalized) {
    if (lastBatchUndo) clearBatchUndo(lastBatchUndo.id);
    return null;
  }
  if (lastBatchUndo?.id === normalized.id) {
    const runtimeState = {
      status: lastBatchUndo.status,
      lastError: lastBatchUndo.lastError,
      restoreFocusAfterDisable: lastBatchUndo.restoreFocusAfterDisable,
      expiredWhileInFlight: lastBatchUndo.expiredWhileInFlight,
    };
    setBatchUndo({ ...normalized, ...runtimeState }, { focus: false, announceAvailability: false });
    return lastBatchUndo;
  }
  if (lastBatchUndo) clearBatchUndo(lastBatchUndo.id);
  setBatchUndo(normalized, { focus, announceAvailability });
  return lastBatchUndo;
}

function invalidateBatchUndoForStructuralChange(tagId = null) {
  if (!lastBatchUndo) return;
  if (tagId && lastBatchUndo.tagId !== tagId) return;
  clearBatchUndo(lastBatchUndo.id);
}

function cloneState(source = state) {
  if (typeof structuredClone === "function") return structuredClone(source);
  return JSON.parse(JSON.stringify(source));
}

function stateIdentity(candidate) {
  if (!candidate) return null;
  return candidate.changeId || `revision:${Number(candidate.revision || 0)}`;
}

const AUTHORITY_UNAVAILABLE_ERROR_CODES = new Set([
  "LOCAL_SERVICE_UNAVAILABLE",
  "LOCAL_API_TIMEOUT",
  "LOCAL_API_RESPONSE_READ_FAILED",
  "LOCAL_API_INVALID_RESPONSE",
  "LOCAL_API_PROTOCOL_ERROR",
]);

function isAuthorityUnavailableError(error) {
  if (!(error instanceof LocalApiError)) return false;
  return AUTHORITY_UNAVAILABLE_ERROR_CODES.has(error.code) || Number(error.status) >= 500;
}

function isUnknownWriteResult(error) {
  return error instanceof LocalApiError
    && error.details?.outcomeUnknown === true;
}

function markAuthorityUnavailable(error) {
  authority = {
    ready: false,
    storage: authority.storage,
    error: `本机数据服务暂不可写：${error.message}`,
  };
  renderAll();
}

async function commitCandidate(candidate, message = "更改已写入本机数据库。", { destructive = false, expectedIdentity = stateIdentity(state) } = {}) {
  if (!authority.ready) {
    showToast(authority.error || "本机数据服务尚未就绪，本次更改未保存。", "error");
    return false;
  }
  const validation = validateState(candidate);
  if (!validation.ok) {
    showToast(`${validation.error} 本次更改未保存。`, "error");
    return false;
  }

  const requestContext = {
    id: ++authorityRequestSequence,
    baselineIdentity: stateIdentity(state),
    undoIdAtStart: lastBatchUndo?.id ?? null,
  };

  try {
    const result = await saveAuthoritativeState(candidate, expectedIdentity, { destructive });
    const currentIdentity = stateIdentity(state);
    const resultIdentity = stateIdentity(result.state);
    const responseCanApply = currentIdentity === requestContext.baselineIdentity
      || (resultIdentity !== null && currentIdentity === resultIdentity);
    if (!responseCanApply) {
      showToast("较早的保存响应已忽略；当前页面保留较新的本机数据，请确认后再继续。", "error");
      return false;
    }
    state = result.state;
    authority.storage = result.storage;
    const cacheResult = saveState(window.localStorage, state);
    syncBatchUndoFromAuthority(result.pendingUndo, result.serverNow);
    renderStorageDetails();
    const backupNotices = [result.backupWarning, ...(result.backupWarnings || [])].filter(Boolean);
    if (!cacheResult.ok) {
      showToast(`本机数据已保存，但浏览器恢复缓存更新失败：${cacheResult.error}`, "error");
    } else if (backupNotices.length) {
      showToast(`${message || "数据已写入本机数据库。"} 快照提示：${backupNotices.join("；")}`, "error");
    } else if (message) {
      showToast(message);
    }
    return true;
  } catch (error) {
    if (error instanceof LocalApiError && error.code === "STATE_CONFLICT") {
      const latest = error.details?.currentState;
      const latestPendingUndo = error.details?.pendingUndo ?? null;
      const latestServerNow = error.details?.serverNow;
      const latestIsValid = Boolean(latest && validateState(latest).ok);
      const currentIdentity = stateIdentity(state);
      const latestIdentity = latestIsValid ? stateIdentity(latest) : null;
      const responseCanApply = currentIdentity === requestContext.baselineIdentity
        || (latestIdentity !== null && currentIdentity === latestIdentity);
      if (responseCanApply && latestIsValid) {
        state = latest;
        clearContactSelection();
        saveState(window.localStorage, state);
        syncBatchUndoFromAuthority(latestPendingUndo, latestServerNow);
        renderAll();
        if ($("#contact-dialog").open) renderContactDialog();
      }
      const invalidatedRelatedUndo = requestContext.undoIdAtStart !== null
        && lastBatchUndo?.id !== requestContext.undoIdAtStart;
      if (!responseCanApply) {
        showToast("较早请求的冲突响应已忽略；当前页面保留较新的本机数据。", "error");
      } else {
        showToast(invalidatedRelatedUndo
          ? "另一个页面刚刚更新了本机数据。本页已同步；为避免修改新数据，相关批量撤销已失效。"
          : "另一个页面刚刚更新了本机数据。本页已同步，本次更改未保存，请重试。", "error");
      }
      return false;
    }
    if (requestContext.id === authorityRequestSequence && isUnknownWriteResult(error)) {
      showToast("保存响应超时，正在读取本机数据库核对最终结果…", "error");
      const reconciled = await hydrateAuthoritativeState({ announceChange: true });
      showToast(reconciled
        ? "已按本机数据库权威状态核对完成；请以当前页面显示为准。"
        : "保存结果暂时无法核对；页面已进入只读状态，恢复连接后会再次同步。", reconciled ? "success" : "error");
      return false;
    }
    if (requestContext.id !== authorityRequestSequence
      && stateIdentity(state) !== requestContext.baselineIdentity) {
      return false;
    }
    if (requestContext.id === authorityRequestSequence && isAuthorityUnavailableError(error)) {
      markAuthorityUnavailable(error);
      showToast(`${authority.error}。请确认本地 API 已启动；切回本页时会自动重连。`, "error");
      return false;
    }
    showToast(`${error.message} 本次更改未保存。`, "error");
    return false;
  }
}

async function hydrateAuthoritativeState({ announceChange = false } = {}) {
  if (authorityHydrationFlight) {
    if (announceChange) {
      authorityHydrationFlight.announceRequested = true;
      authorityHydrationFlight.refreshRequested = true;
    }
    return authorityHydrationFlight.promise;
  }

  const flight = {
    announceRequested: announceChange,
    identityChangeObserved: false,
    announcementDelivered: false,
    refreshRequested: false,
    promise: null,
  };
  authorityHydrationFlight = flight;

  const performHydration = async () => {
    const requestContext = {
      id: ++authorityRequestSequence,
      baselineIdentity: stateIdentity(state),
      undoIdAtStart: lastBatchUndo?.id ?? null,
    };
    try {
      let payload = await loadAuthoritativeState();
      if (!payload.state) {
        let initialState = createDemoState();
        if (initialLoad.state) {
          const shouldMigrate = await requestCacheMigrationChoice(initialLoad.state.contacts.length);
          initialState = shouldMigrate ? initialLoad.state : createDemoState();
        }
        try {
          payload = await saveAuthoritativeState(initialState, null);
        } catch (error) {
          if (!(error instanceof LocalApiError) || error.code !== "STATE_CONFLICT") throw error;
          payload = await loadAuthoritativeState();
          if (!payload.state) throw error;
        }
      }
      const currentIdentity = stateIdentity(state);
      const payloadIdentity = stateIdentity(payload.state);
      const responseCanApply = currentIdentity === requestContext.baselineIdentity
        || (payloadIdentity !== null && currentIdentity === payloadIdentity);
      if (!responseCanApply) return true;

      state = payload.state;
      const identityChanged = stateIdentity(state) !== requestContext.baselineIdentity;
      if (identityChanged) clearContactSelection();
      syncBatchUndoFromAuthority(payload.pendingUndo, payload.serverNow);
      const undoChanged = (lastBatchUndo?.id ?? null) !== requestContext.undoIdAtStart;
      flight.identityChangeObserved ||= identityChanged || undoChanged;
      authority = { ready: true, storage: payload.storage, error: null };
      const cacheResult = saveState(window.localStorage, state);
      const invalidatedRelatedUndo = requestContext.undoIdAtStart !== null
        && lastBatchUndo?.id !== requestContext.undoIdAtStart;
      const shouldDeliverChangeNotice = flight.announceRequested
        && flight.identityChangeObserved
        && !flight.announcementDelivered;
      renderAll();
      if ($("#contact-dialog").open) renderContactDialog();
      if ($("#import-dialog").open) renderImportResult();
      if (!cacheResult.ok) {
        showToast(`本机数据库状态已加载，但浏览器恢复缓存更新失败：${cacheResult.error}${invalidatedRelatedUndo ? "；最近一次批量撤销已失效" : ""}`, "error");
        if (shouldDeliverChangeNotice) flight.announcementDelivered = true;
      } else if (shouldDeliverChangeNotice || invalidatedRelatedUndo) {
        showToast(invalidatedRelatedUndo
          ? "本机数据已更新，本页已同步；最近一次批量撤销已失效。"
          : "另一个页面更新了本机数据，本页已同步。" );
        if (shouldDeliverChangeNotice) flight.announcementDelivered = true;
      }
      return true;
    } catch (error) {
      if (requestContext.id !== authorityRequestSequence
        || stateIdentity(state) !== requestContext.baselineIdentity) {
        return false;
      }
      authority = {
        ready: false,
        storage: authority.storage,
        error: `本机数据服务不可用：${error.message}`,
      };
      renderAll();
      showToast(`${authority.error} 当前只显示恢复缓存，写入已停用。`, "error");
      return false;
    }
  };

  const operation = (async () => {
    let result = false;
    do {
      flight.refreshRequested = false;
      result = await performHydration();
    } while (flight.refreshRequested);
    return result;
  })();

  flight.promise = operation.finally(() => {
    if (authorityHydrationFlight === flight) authorityHydrationFlight = null;
  });
  return flight.promise;
}

function currentDerivedContacts() {
  return sortByReminderPriority(deriveContacts(state.contacts, state.settings, new Date()));
}

function currentContactSets() {
  return partitionContactsByVisibility(currentDerivedContacts());
}

async function updateContact(contactId, updater, message) {
  const candidate = cloneState();
  candidate.contacts = candidate.contacts.map((contact) => contact.id === contactId ? updater(contact) : contact);
  if (!await commitCandidate(candidate, message)) return false;
  renderAll();
  if ($("#contact-dialog").open && selectedContactId === contactId) renderContactDialog();
  return true;
}

function makeAvatar(contact, options = {}) {
  const normalized = typeof options === "string" ? { sizeClass: options } : options;
  const {
    sizeClass = "",
    className = "",
    text,
    privacySensitive = true,
  } = normalized;
  const glyph = text ?? ((privacySensitive && state.settings.privacyMode)
    ? "•"
    : (contact.initials || Array.from(contact.name || "?")[0]));
  return element("span", {
    className: `avatar-token echo-avatar ${toneForId(contact.id || contact.name)} ${sizeClass} ${className}`.trim(),
    attributes: { "aria-hidden": "true" },
  }, [
    element("span", { className: "echo-avatar-surface", attributes: { "aria-hidden": "true" } }),
    element("span", { className: "echo-avatar-glyph", text: glyph }),
    element("span", { className: "echo-avatar-glint", attributes: { "aria-hidden": "true" } }),
  ]);
}

function makeTagChip(text, className = "") {
  return element("span", { className: `tag-chip ${className}`.trim(), text });
}

function makeSourceBadge(contact) {
  const sourceKind = contactSourceKind(contact);
  const label = sourceLabel(contact);
  return element("span", {
    className: `source-badge source-${sourceKind}`,
    text: label,
    title: contact.needsReview ? `${label} · 数据待校验` : label,
  });
}

function contactStatus(contact) {
  if (contact.needsReview || contact.frequency === FREQUENCY.UNKNOWN) {
    return { key: "review", label: "待校验" };
  }
  if (contact.maintenanceIntent === MAINTENANCE.UNSET) return { key: "unset", label: "待设置" };
  if (contact.maintenanceIntent === MAINTENANCE.IGNORE) return { key: "quiet", label: "无需提醒" };
  if (contact.isDue || ["first-greeting", "overdue", "today"].includes(contact.reminderState)) {
    return { key: "due", label: "待问候" };
  }
  if (!contact.sourceMessageAt) return { key: "review", label: "待校验" };
  if (contact.reminderState === "upcoming" || contact.reminderState === "snoozed" || (contact.daysUntilDue !== null && contact.daysUntilDue <= 7)) {
    return { key: "upcoming", label: "将提醒" };
  }
  return { key: "steady", label: "节律平稳" };
}

function makeContactStatusBadge(contact) {
  const status = contactStatus(contact);
  return element("span", {
    className: `contact-status-badge is-${status.key}`,
    text: status.label,
    attributes: { "data-status": status.key },
  });
}

function makeRecordGreetingButton(contact, className) {
  const name = visibleName(contact);
  return element("button", {
    className,
    type: "button",
    text: "记录问候",
    dataset: { action: "maintained", contactId: contact.id },
    attributes: { "aria-label": `记录与${name}的本次问候` },
  });
}

function makeOpenContactButton(contact, className) {
  const name = visibleName(contact);
  return element("button", {
    className,
    type: "button",
    text: "打开关系卡",
    dataset: { contactId: contact.id },
    attributes: { "aria-label": `打开${name}的关系卡` },
  });
}

function renderDialTicks() {
  const svg = $("#dial-ticks");
  if (svg.childElementCount) return;
  const namespace = "http://www.w3.org/2000/svg";
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 60; index += 1) {
    const angle = (index / 60) * Math.PI * 2 - Math.PI / 2;
    const major = index % 5 === 0;
    const outer = 206;
    const inner = major ? 188 : 197;
    const line = document.createElementNS(namespace, "line");
    line.setAttribute("x1", String(220 + Math.cos(angle) * inner));
    line.setAttribute("y1", String(220 + Math.sin(angle) * inner));
    line.setAttribute("x2", String(220 + Math.cos(angle) * outer));
    line.setAttribute("y2", String(220 + Math.sin(angle) * outer));
    line.setAttribute("class", major ? "dial-tick major" : "dial-tick");
    fragment.append(line);
  }
  svg.append(fragment);
}

function renderChronometer(contacts) {
  renderDialTicks();
  const dueContacts = contacts.filter((contact) => contact.isDue);
  const dueCountEl = $("#due-count");
  const nextDueCount = String(dueContacts.length);
  if (dueCountEl.textContent !== nextDueCount) {
    dueCountEl.textContent = nextDueCount;
    dueCountEl.classList.remove("is-updated");
    void dueCountEl.offsetWidth;
    dueCountEl.classList.add("is-updated");
  }
  const candidates = contacts.filter((contact) => contact.daysSince !== null && contact.maintenanceIntent !== MAINTENANCE.IGNORE);
  const buckets = [
    { label: "0–6天", angle: -90, contacts: [] },
    { label: "7–14天", angle: 0, contacts: [] },
    { label: "15–29天", angle: 90, contacts: [] },
    { label: "30天+", angle: 180, contacts: [] },
  ];
  candidates.forEach((contact) => {
    const bucketIndex = contact.daysSince < 7 ? 0 : contact.daysSince < 15 ? 1 : contact.daysSince < 30 ? 2 : 3;
    buckets[bucketIndex].contacts.push(contact);
  });
  const nodes = $("#contact-nodes");
  const fragment = document.createDocumentFragment();

  buckets.filter((bucket) => bucket.contacts.length).forEach((bucket) => {
    const contact = bucket.contacts[0];
    const count = bucket.contacts.length;
    const angle = bucket.angle * Math.PI / 180;
    const radius = 30;
    const left = 50 + Math.cos(angle) * radius;
    const top = 50 + Math.sin(angle) * radius;
    const toneClass = bucket.contacts.some((item) => item.isDue) ? "is-due" : bucket.contacts.some((item) => item.reminderState === "upcoming") ? "is-upcoming" : "";
    const isGroup = count > 1;
    const dataset = isGroup ? { scrollTarget: "contacts-panel" } : { contactId: contact.id };
    const description = isGroup ? `${bucket.label}共有${count}位联系人，前往联系人台账查看` : `查看${visibleName(contact)}，上次互动${formatDaysAgo(contact.daysSince)}`;
    const button = element("button", {
      className: `dial-contact ${toneClass}`.trim(),
      type: "button",
      title: description,
      dataset,
      attributes: { "aria-label": description },
    }, [
      makeAvatar(contact, {
        sizeClass: "avatar dial-avatar",
        text: isGroup ? (count > 99 ? "99+" : `+${count}`) : undefined,
        privacySensitive: !isGroup,
      }),
      element("small", { text: isGroup ? bucket.label : `${contact.daysSince}天` }),
    ]);
    button.style.left = `${left}%`;
    button.style.top = `${top}%`;
    fragment.append(button);
  });
  nodes.replaceChildren(fragment);
}

function collectUpcomingContacts(contacts) {
  return contacts
    .filter((contact) => contact.maintenanceIntent === MAINTENANCE.MAINTAIN
      && !contact.isDue
      && contact.daysUntilDue !== null
      && contact.daysUntilDue > 0
      && contact.daysUntilDue <= 7)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue)
    .slice(0, 4);
}

function renderQueueUpcoming(contacts) {
  const section = $("#queue-upcoming");
  const list = $("#queue-upcoming-list");
  if (!section || !list) return;
  const upcoming = collectUpcomingContacts(contacts);
  if (!upcoming.length) {
    section.hidden = true;
    list.replaceChildren();
    return;
  }
  const rows = upcoming.map((contact) => element("button", {
    className: "upcoming-row",
    type: "button",
    dataset: { contactId: contact.id },
    attributes: {
      "aria-label": `打开${visibleName(contact)}的关系卡；${contact.daysUntilDue <= 1 ? "明天" : `${contact.daysUntilDue} 天后`}到期`,
    },
  }, [
    makeAvatar(contact, { sizeClass: "upcoming-avatar" }),
    element("strong", { className: "private-name", text: visibleName(contact) }),
    element("span", { className: "upcoming-when", text: contact.daysUntilDue <= 1 ? "明天到期" : `${contact.daysUntilDue} 天后` }),
  ]));
  list.replaceChildren(...rows);
  section.hidden = false;
}

function renderQueueDates(contacts) {
  const section = $("#queue-dates");
  const list = $("#queue-dates-list");
  if (!section || !list) return;
  const rows = [];
  contacts.forEach((contact) => {
    collectUpcomingAnnualDates(contact, 7).forEach((item) => rows.push({ contact, item }));
  });
  rows.sort((a, b) => a.item.daysUntil - b.item.daysUntil);
  const top = rows.slice(0, 4);
  if (!top.length) {
    section.hidden = true;
    list.replaceChildren();
    return;
  }
  const fragment = document.createDocumentFragment();
  top.forEach(({ contact, item }) => {
    const label = item.kind === "birthday"
      ? (item.age !== undefined ? `${item.age} 岁生日` : "生日")
      : item.label;
    fragment.append(element("button", {
      className: "upcoming-row",
      type: "button",
      dataset: { contactId: contact.id },
      attributes: {
        "aria-label": `打开${visibleName(contact)}的关系卡；${label}${item.daysUntil === 0 ? "就是今天" : item.daysUntil === 1 ? "明天" : `${item.daysUntil} 天后`}`,
      },
    }, [
      makeAvatar(contact, { sizeClass: "upcoming-avatar" }),
      element("strong", { className: "private-name", text: visibleName(contact) }),
      element("span", { className: "upcoming-tag", text: label }),
      element("span", { className: "upcoming-when", text: item.daysUntil === 0 ? "今天" : item.daysUntil === 1 ? "明天" : `${item.daysUntil} 天后` }),
    ]));
  });
  list.replaceChildren(fragment);
  section.hidden = false;
}

function renderQueue(contacts) {
  const queue = $("#queue-list");
  const dueContacts = contacts.filter((contact) => contact.isDue);
  $("#queue-count").textContent = `${dueContacts.length} 位`;
  renderQueueUpcoming(contacts);
  renderQueueDates(contacts);
  const fragment = document.createDocumentFragment();

  if (!dueContacts.length) {
    const empty = element("div", { className: "queue-empty" }, [
      element("div", {}, [
        element("span", { text: "✓", attributes: { "aria-hidden": "true" } }),
        element("h3", { text: "今天没有到期联系人" }),
        element("p", { text: "不是所有沉默都需要打破。将到期的人会按你的节律出现在这里。" }),
      ]),
    ]);
    queue.replaceChildren(empty);
    $("#queue-more").hidden = true;
    return;
  }

  dueContacts.slice(0, 3).forEach((contact, index) => {
    const overdueDays = Math.abs(contact.daysUntilDue || 0);
    const nameButton = element("button", {
      className: "queue-name private-name",
      type: "button",
      text: visibleName(contact),
      dataset: { contactId: contact.id },
      attributes: { "aria-label": `打开${visibleName(contact)}的关系卡` },
    });
    const main = element("div", { className: "queue-main" }, [
      element("div", { className: "queue-name-row" }, [
        nameButton,
        makeContactStatusBadge(contact),
      ]),
      element("div", { className: "queue-meta" }, [
        makeSourceBadge(contact),
        element("span", { className: "queue-overdue", text: contact.reminderState === "first-greeting" ? "首次问候" : overdueDays ? `逾期 ${overdueDays} 天` : "今天到期" }),
      ]),
      element("p", { className: "queue-message private-copy", text: visibleMessage(contact) }),
      element("span", { className: "queue-date", text: `上次互动：${formatDaysAgo(contact.daysSince)}` }),
    ]);
    const actions = element("div", { className: "queue-actions" }, [
      makeRecordGreetingButton(contact, "mini-action primary contact-action-record"),
      element("button", { className: "mini-action", type: "button", text: "稍后 7 天", dataset: { action: "snooze", contactId: contact.id, days: "7" } }),
    ]);
    fragment.append(element("div", { className: "queue-item" }, [
      element("span", { className: "queue-rank", text: String(index + 1), attributes: { "aria-hidden": "true" } }),
      makeAvatar(contact, { sizeClass: "queue-avatar" }),
      main,
      actions,
    ]));
  });
  queue.replaceChildren(fragment);
  $("#queue-more").hidden = false;
  $("#queue-more").textContent = `查看全部待问候联系人（${dueContacts.length}） →`;
}

const ledgerSorters = {
  priority: null,
  recent: (a, b) => (a.daysSince ?? Number.POSITIVE_INFINITY) - (b.daysSince ?? Number.POSITIVE_INFINITY),
  name: (a, b) => visibleName(a).localeCompare(visibleName(b), "zh-Hans-CN"),
};

function applyLedgerSortOrder(contacts) {
  const sorter = ledgerSorters[ledgerSortMode];
  return sorter ? [...contacts].sort(sorter) : contacts;
}

function getFilteredLedgerContacts() {
  const { visible, hidden } = currentContactSets();
  return applyLedgerSortOrder(applyContactFilters(filters.hiddenOnly ? hidden : visible, filters));
}

function getLedgerPageWindow(filteredContacts = getFilteredLedgerContacts()) {
  const totalPages = Math.max(1, Math.ceil(filteredContacts.length / pageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = filteredContacts.length ? (safePage - 1) * pageSize : 0;
  const endIndex = Math.min(startIndex + pageSize, filteredContacts.length);
  return {
    page: safePage,
    totalPages,
    startIndex,
    endIndex,
    pageContacts: filteredContacts.slice(startIndex, endIndex),
  };
}

function getCurrentLedgerPageContacts() {
  return getLedgerPageWindow(getFilteredLedgerContacts()).pageContacts;
}

function clearContactSelection({ announceChange = false, reason = "" } = {}) {
  if (!selectedContactIds.size) return false;
  selectedContactIds = new Set();
  if (announceChange) announce(reason || "联系人选择已清空，请重新勾选。");
  return true;
}

function selectedContactsOnCurrentPage(pageContacts = getCurrentLedgerPageContacts()) {
  selectedContactIds = reconcileContactSelection(selectedContactIds, pageContacts.map((contact) => contact.id));
  return pageContacts.filter((contact) => selectedContactIds.has(contact.id));
}

function batchPreviewFor(action, pageContacts = getCurrentLedgerPageContacts()) {
  const tag = state.tags.find((item) => item.id === bulkTagId);
  const selectedContacts = selectedContactsOnCurrentPage(pageContacts);
  if (!tag || !selectedContacts.length) return null;
  const changedCount = selectedContacts.filter((contact) => {
    const hasTag = contact.customTagIds?.includes(tag.id);
    return action === "add" ? !hasTag : hasTag;
  }).length;
  return { changedCount };
}

function renderBatchSelectionState(pageContacts = getCurrentLedgerPageContacts()) {
  const pageIds = pageContacts.map((contact) => contact.id);
  selectedContactIds = reconcileContactSelection(selectedContactIds, pageIds);
  const summary = summarizeContactSelection(selectedContactIds, pageIds);
  const tag = state.tags.find((item) => item.id === bulkTagId);
  const selectionEnabled = authority.ready && Boolean(tag) && summary.pageCount > 0;
  const addPreview = batchPreviewFor("add", pageContacts);
  const removePreview = batchPreviewFor("remove", pageContacts);

  const pageCount = $("#batch-page-count");
  const selectedCount = $("#batch-selected-count");
  if (pageCount) pageCount.textContent = `本页 ${summary.pageCount} 人`;
  if (selectedCount) selectedCount.textContent = `已选 ${summary.selectedCount} 人`;

  const selectPageButton = $("#select-page-contacts");
  if (selectPageButton) {
    selectPageButton.disabled = !selectionEnabled;
    selectPageButton.textContent = summary.checked ? "取消全选" : `全选本页（${summary.pageCount}）`;
  }
  const clearButton = $("#clear-contact-selection");
  if (clearButton) clearButton.disabled = summary.selectedCount === 0;

  const pageCheckbox = $("#select-page-checkbox");
  if (pageCheckbox) {
    pageCheckbox.disabled = !selectionEnabled;
    pageCheckbox.checked = summary.checked;
    pageCheckbox.indeterminate = summary.indeterminate;
    pageCheckbox.setAttribute("aria-checked", summary.indeterminate ? "mixed" : String(summary.checked));
  }

  $$('[data-select-contact]').forEach((checkbox) => {
    checkbox.disabled = !selectionEnabled;
    checkbox.checked = selectedContactIds.has(checkbox.dataset.selectContact);
    const row = checkbox.closest("tr");
    row?.classList.toggle("is-selected", checkbox.checked);
    row?.setAttribute("aria-selected", String(checkbox.checked));
  });

  const addButton = $("#batch-add-tag");
  const removeButton = $("#batch-remove-tag");
  const canSubmit = authority.ready && Boolean(tag) && summary.selectedCount > 0;
  addButton.disabled = !canSubmit || !addPreview?.changedCount;
  removeButton.disabled = !canSubmit || !removePreview?.changedCount;
  addButton.textContent = `加入标签${summary.selectedCount ? `（变化 ${addPreview?.changedCount || 0}）` : ""}`;
  removeButton.textContent = `移除标签${summary.selectedCount ? `（变化 ${removePreview?.changedCount || 0}）` : ""}`;

  const batchWriteStatus = $("#batch-write-status");
  if (!authority.ready) {
    batchWriteStatus.textContent = "本机数据服务暂不可写；恢复连接后可继续整理。";
  } else if (!tag) {
    batchWriteStatus.textContent = "第 1 步：先选择或新建一个关系标签。";
  } else if (!summary.pageCount) {
    batchWriteStatus.textContent = "当前筛选没有可勾选的联系人。";
  } else if (!summary.selectedCount) {
    batchWriteStatus.textContent = `已选择“${tag.name}”；第 2 步请勾选本页联系人。`;
  } else {
    batchWriteStatus.textContent = `已选择“${tag.name}”和 ${summary.selectedCount} 位联系人；可以执行第 3 步。`;
  }

  $("#batch-step-tag")?.classList.toggle("is-complete", Boolean(tag));
  $("#batch-step-contacts")?.classList.toggle("is-active", Boolean(tag));
  $("#batch-step-contacts")?.classList.toggle("is-disabled", !tag);
  $("#batch-step-contacts")?.classList.toggle("is-complete", summary.selectedCount > 0);
  $("#batch-step-apply")?.classList.toggle("is-active", summary.selectedCount > 0);
  $("#batch-step-apply")?.classList.toggle("is-disabled", summary.selectedCount === 0);
}

function selectBulkTag(tagId, { focus = false, announceChange = true } = {}) {
  const nextTagId = state.tags.some((tag) => tag.id === tagId) ? tagId : "";
  const changed = nextTagId !== bulkTagId;
  bulkTagId = nextTagId;
  if (changed) {
    clearContactSelection();
    if (announceChange) announce(nextTagId
      ? `已选择“${getTagName(nextTagId)}”标签，请勾选当前页联系人。`
      : "快速整理标签已清空，请重新选择标签。");
  }
  renderLedger();
  if (focus) $("#bulk-tag-select")?.focus({ preventScroll: true });
}

function renderTagFilter() {
  const tagSelect = $("#tag-filter");
  const bulkSelect = $("#bulk-tag-select");
  const quickList = $("#quick-bulk-tag-list");

  const tagOptions = [element("option", { text: "全部标签", attributes: { value: "all" } })];
  state.tags.forEach((tag) => tagOptions.push(element("option", { text: tag.name, attributes: { value: tag.id } })));
  tagSelect.replaceChildren(...tagOptions);
  tagSelect.value = state.tags.some((tag) => tag.id === filters.tagId) ? filters.tagId : "all";
  filters.tagId = tagSelect.value;

  const bulkOptions = [element("option", { text: "选择标签", attributes: { value: "" } })];
  state.tags.forEach((tag) => bulkOptions.push(element("option", { text: tag.name, attributes: { value: tag.id } })));
  bulkSelect.replaceChildren(...bulkOptions);
  bulkTagId = state.tags.some((tag) => tag.id === bulkTagId) ? bulkTagId : "";
  bulkSelect.value = bulkTagId;

  if (quickList) {
    const usageByTagId = new Map();
    state.contacts.forEach((contact) => {
      new Set(contact.customTagIds || []).forEach((tagId) => {
        usageByTagId.set(tagId, (usageByTagId.get(tagId) || 0) + 1);
      });
    });
    const topTags = state.tags
      .map((tag) => ({ ...tag, usage: usageByTagId.get(tag.id) || 0 }))
      .sort((a, b) => b.usage - a.usage || (a.name || "").localeCompare(b.name || ""))
      .slice(0, 5);

    quickList.replaceChildren(...topTags.map((tag) => element("button", {
      className: "quick-bulk-tag",
      type: "button",
      text: `${tag.name}${tag.usage ? `（${tag.usage}）` : ""}`,
      dataset: { quickTag: tag.id },
      attributes: {
        title: `快速选择“${tag.name}”（命中 ${tag.usage} 人）`,
        "aria-pressed": tag.id === bulkTagId ? "true" : "false",
      },
    })));
    if (!topTags.length) {
      quickList.replaceChildren(element("p", { className: "quiet-line", text: "还没有关系标签，可直接在左侧新建" }));
    }
  }
  renderBatchSelectionState();
}

async function applyBatchTag(action) {
  if (!authority.ready) {
    showToast(authority.error || "本机数据服务当前不可写，快速整理已停用。", "error");
    return;
  }
  if (!bulkTagId) {
    showToast("请先在“快速整理标签”里选择一个标签。", "error");
    return;
  }
  const tag = state.tags.find((item) => item.id === bulkTagId);
  if (!tag) {
    showToast("所选标签不存在，请重新选择。", "error");
    return;
  }
  const pageContacts = getCurrentLedgerPageContacts();
  const targets = selectedContactsOnCurrentPage(pageContacts);
  if (!targets.length) {
    showToast("请先在当前页勾选至少一位联系人。", "error");
    return;
  }
  const targetContactIds = targets.slice(0, MAX_BATCH_SELECTION).map((contact) => contact.id);
  const candidateIdentity = stateIdentity(state);
  const preview = buildBatchTagCandidate(state, {
    action,
    tagId: tag.id,
    contactIds: targetContactIds,
  });
  if (!preview.ok) {
    showToast(preview.error || "当前筛选无法执行这次快速整理。", "error");
    return;
  }
  if (!preview.changedCount) {
    showToast(action === "add"
      ? `已选联系人都已经有“${tag.name}”标签，无需重复加入。`
      : `已选联系人都没有“${tag.name}”标签，无需移除。`, "error");
    return;
  }
  const changedIds = new Set(preview.changedContactIds);
  const changedNames = targets.filter((contact) => changedIds.has(contact.id)).map(visibleName);
  const changedCount = preview.changedCount;
  const shouldAdd = action === "add" ? "加入" : "移除";
  const scopeText = `本页手动勾选 ${targets.length} 人`;
  const previewNames = changedNames.slice(0, 3).map((name) => `“${name}”`);
  const sampleText = previewNames.length
    ? `${previewNames.join("、")}${changedCount - previewNames.length > 0 ? `、…共 ${changedNames.length} 位` : ""}`
    : "无";
  const filtersText = getCurrentFilterSummary();
  const unchangedCount = Math.max(0, targets.length - changedCount);
  requestConfirmation({
    title: `${shouldAdd}“${tag.name}”标签`,
    copy: `当前筛选：${filtersText}\n已手动勾选 ${targets.length} 人，实际变更 ${changedCount} 人，无需变更 ${unchangedCount} 人。\n示例：${sampleText}\n只会处理本次勾选的联系人。`,
    actionLabel: "确认执行",
    cancelLabel: "取消",
    tone: "primary",
    onConfirm: async () => {
      if (pendingConfirmation?.busy) return;
      if (!authority.ready) {
        showToast(authority.error || "本机数据服务当前不可写，快速整理已停用。", "error");
        return;
      }
      setConfirmationBusy(true, "正在保存…");
      const requestContext = {
        id: ++authorityRequestSequence,
        baselineIdentity: stateIdentity(state),
        undoIdAtStart: lastBatchUndo?.id ?? null,
        operationId: globalThis.crypto.randomUUID(),
      };
      try {
        const result = await applyAuthoritativeBatchTag({
          action,
          tagId: tag.id,
          contactIds: targetContactIds,
          scopeLabel: scopeText,
          expectedChangeId: candidateIdentity,
          operationId: requestContext.operationId,
        });
        const currentIdentity = stateIdentity(state);
        const resultIdentity = stateIdentity(result.state);
        const responseCanApply = currentIdentity === requestContext.baselineIdentity
          || (resultIdentity !== null && currentIdentity === resultIdentity);
        if (!responseCanApply) {
          closeConfirmation();
          showToast("较早的快速整理响应已忽略；当前页面保留较新的本机数据。", "error");
          return;
        }
        state = result.state;
        authority.storage = result.storage;
        const cacheResult = saveState(window.localStorage, state);
        closeConfirmation();
        syncBatchUndoFromAuthority(result.pendingUndo, result.serverNow, {
          focus: true,
          announceAvailability: true,
        });
        clearContactSelection();
        renderAll();
        const actualChangedCount = result.batch.changedCount;
        const backupNotices = [result.backupWarning, ...(result.backupWarnings || [])].filter(Boolean);
        if (!cacheResult.ok) {
          showToast(`快速整理已写入本机数据库，但浏览器恢复缓存更新失败：${cacheResult.error}；仍可在 45 秒内撤销。焦点已移到撤销按钮。`, "error");
        } else if (backupNotices.length) {
          showToast(`${shouldAdd}“${tag.name}”标签 ${actualChangedCount} 位联系人（${scopeText}）；可在 45 秒内撤销。焦点已移到撤销按钮。快照提示：${backupNotices.join("；")}`, "error");
        } else {
          showToast(`${shouldAdd}“${tag.name}”标签 ${actualChangedCount} 位联系人（${scopeText}）；可在 45 秒内撤销。焦点已移到撤销按钮。`);
        }
      } catch (error) {
        if (error instanceof LocalApiError && error.code === "STATE_CONFLICT") {
          const latest = error.details?.currentState;
          const latestIsValid = Boolean(latest && validateState(latest).ok);
          const responseCanApply = stateIdentity(state) === requestContext.baselineIdentity;
          if (responseCanApply && latestIsValid) {
            state = latest;
            clearContactSelection();
            saveState(window.localStorage, state);
            syncBatchUndoFromAuthority(error.details?.pendingUndo ?? null, error.details?.serverNow);
            closeConfirmation();
            renderAll();
            showToast("另一个页面刚刚更新了本机数据。本页已同步，这次快速整理未保存。", "error");
            return;
          }
        }
        if (requestContext.id === authorityRequestSequence && isUnknownWriteResult(error)) {
          setConfirmationBusy(true, "正在核对本机数据库…");
          const reconciled = await hydrateAuthoritativeState({ announceChange: true });
          const completedThisOperation = lastBatchUndo?.id === requestContext.operationId;
          closeConfirmation();
          if (reconciled && completedThisOperation && lastBatchUndo) {
            clearContactSelection();
            renderLedger();
            $("#batch-undo-action").focus({ preventScroll: true });
            const remainingSeconds = Math.max(0, Math.ceil((lastBatchUndo.expiresAt - Date.now()) / 1000));
            announce(`本机数据库核对完成：快速整理已经写入，可在约 ${remainingSeconds} 秒内撤销。焦点已移到撤销按钮。`);
          }
          showToast(!reconciled
            ? "快速整理结果暂时无法核对；页面已进入只读状态，恢复连接后会再次同步。"
            : completedThisOperation
              ? "响应虽然中断，但已从本机数据库确认本次快速整理成功；当前撤销入口只对应本次操作。焦点已移到撤销按钮。"
              : "已同步本机数据库最终状态，但无法把当前变化归因于本页刚才的操作；没有自动重试，也没有代替你撤销其他页面的批次。",
          reconciled && completedThisOperation ? "success" : "error");
          return;
        }
        if (requestContext.id === authorityRequestSequence && isAuthorityUnavailableError(error)) {
          markAuthorityUnavailable(error);
        }
        showToast(`${error.message} 快速整理未保存。`, "error");
        setConfirmationBusy(false);
        $("#confirm-action").focus({ preventScroll: true });
      }
    },
  });
}

async function undoLastBatchTagAction() {
  if (!lastBatchUndo) {
    showToast("当前没有可撤销的快速整理记录。", "error");
    return;
  }
  if (!authority.ready) {
    showToast(authority.error || "本机数据服务当前不可写，暂时不能撤销。", "error");
    return;
  }
  const record = lastBatchUndo;
  if (record.status === "in-flight" || record.status === "reconciling") return;
  if (isBatchUndoExpired(record, Date.now())) {
    clearBatchUndo(record.id);
    showToast("撤销窗口已过期（超过 45 秒）。", "error");
    return;
  }

  record.status = "in-flight";
  record.lastError = null;
  record.restoreFocusAfterDisable = $("#batch-undo-panel").contains(document.activeElement);
  renderBatchUndo();
  announce(`正在撤销“${record.tagName}”标签的批量操作，请稍候。`);
  const undoVerb = record.action === "add" ? "移除" : "加入";
  const expectedIdentity = stateIdentity(state);
  const requestContext = {
    id: ++authorityRequestSequence,
    baselineIdentity: expectedIdentity,
    undoIdAtStart: record.id,
  };
  try {
    const result = await consumeAuthoritativeBatchUndo({
      undoId: record.id,
      expectedChangeId: expectedIdentity,
      expectedAction: record.action,
      expectedTagId: record.tagId,
    });
    const currentIdentity = stateIdentity(state);
    const resultIdentity = stateIdentity(result.state);
    const responseCanApply = currentIdentity === requestContext.baselineIdentity
      || (resultIdentity !== null && currentIdentity === resultIdentity);
    if (!responseCanApply) return;
    state = result.state;
    authority.storage = result.storage;
    const cacheResult = saveState(window.localStorage, state);
    syncBatchUndoFromAuthority(result.pendingUndo, result.serverNow);
    if ($("#contact-dialog").open) renderContactDialog();
    renderAll();
    const message = `已撤销${record.scopeLabel ? `（${record.scopeLabel}）` : ""}：为 ${result.undone.changedCount} 位联系人${undoVerb}“${record.tagName}”标签。`;
    showToast(cacheResult.ok ? message : `${message} 浏览器恢复缓存更新失败：${cacheResult.error}`, cacheResult.ok ? "success" : "error");
    return;
  } catch (error) {
    const terminalUndoErrors = new Set(["UNDO_EXPIRED", "UNDO_NOT_FOUND", "UNDO_REPLACED", "UNDO_STATE_MISMATCH", "STATE_CONFLICT"]);
    const latest = error instanceof LocalApiError ? error.details?.currentState : null;
    const latestIsValid = Boolean(latest && validateState(latest).ok);
    const responseCanApply = stateIdentity(state) === requestContext.baselineIdentity;
    if (terminalUndoErrors.has(error.code) && responseCanApply && latestIsValid) {
      state = latest;
      authority.storage = error.details?.storage || authority.storage;
      saveState(window.localStorage, state);
      syncBatchUndoFromAuthority(error.details?.pendingUndo ?? null, error.details?.serverNow);
      renderAll();
      showToast(error.code === "UNDO_EXPIRED"
        ? "撤销窗口已过期（超过 45 秒）。"
        : "本机数据库状态已经变化，最近一次撤销入口已同步更新。", "error");
      return;
    }
    if (requestContext.id === authorityRequestSequence && isUnknownWriteResult(error)) {
      if (lastBatchUndo?.id === record.id) {
        record.status = "reconciling";
        record.expiredWhileInFlight = false;
        renderBatchUndo();
      }
      showToast("撤销响应超时，正在读取本机数据库核对最终结果…", "error");
      const reconciled = await hydrateAuthoritativeState({ announceChange: true });
      if (lastBatchUndo?.id === record.id) {
        const currentRecord = lastBatchUndo;
        currentRecord.status = "available";
        currentRecord.expiredWhileInFlight = false;
        currentRecord.lastError = "响应超时；本机数据库显示这次撤销尚未完成。";
        scheduleBatchUndoExpiry(currentRecord);
        renderBatchUndo();
        if (currentRecord.restoreFocusAfterDisable
          && (document.activeElement === document.body || document.activeElement === null)) {
          $("#batch-undo-action").focus({ preventScroll: true });
        }
        currentRecord.restoreFocusAfterDisable = false;
        showToast(reconciled
          ? "本机数据库显示这次撤销尚未完成；在剩余时间内可以重试。"
          : "撤销结果暂时无法核对；恢复本机数据连接后再继续。", "error");
      } else {
        showToast(reconciled
          ? "已按本机数据库权威状态完成核对；当前页面就是最终结果。"
          : "撤销结果暂时无法核对；页面已进入只读状态。", reconciled ? "success" : "error");
      }
      return;
    }
    if (requestContext.id === authorityRequestSequence && isAuthorityUnavailableError(error)) {
      markAuthorityUnavailable(error);
    }
    if (lastBatchUndo?.id !== record.id) return;
    if (isBatchUndoExpired(record, Date.now())) {
      clearBatchUndo(record.id);
      return;
    }
    record.status = "available";
    record.expiredWhileInFlight = false;
    record.lastError = "保存失败，可在窗口结束前重试。";
    scheduleBatchUndoExpiry(record);
    renderBatchUndo();
    showToast(`${error.message} 可在撤销窗口结束前重试。`, "error");
    if (record.restoreFocusAfterDisable
      && (document.activeElement === document.body || document.activeElement === null)) {
      $("#batch-undo-action").focus({ preventScroll: true });
    }
    record.restoreFocusAfterDisable = false;
  }
}

function makeSystemChips(contact) {
  const chips = [];
  if (contact.frequency === FREQUENCY.FREQUENT) chips.push(makeTagChip("常联系人", "system-frequency"));
  if (contact.frequency === FREQUENCY.INFREQUENT) chips.push(makeTagChip("不常联系人", "system-frequency"));
  if (contact.frequency === FREQUENCY.UNKNOWN) chips.push(makeTagChip("联系时间待校验", "needs-review"));
  if (contact.maintenanceIntent === MAINTENANCE.MAINTAIN) chips.push(makeTagChip("需要维系", "system-maintain"));
  if (contact.maintenanceIntent === MAINTENANCE.IGNORE) chips.push(makeTagChip("不需要维系", "system-ignore"));
  if (contact.maintenanceIntent === MAINTENANCE.UNSET) chips.push(makeTagChip("维系意愿未设置"));
  return chips;
}

function renderVisibilityControl(visibleCount, hiddenCount) {
  const button = $("#hidden-contact-filter");
  const hiddenMode = Boolean(filters.hiddenOnly);
  button.disabled = hiddenCount === 0 && !hiddenMode;
  button.setAttribute("aria-pressed", String(hiddenMode));
  button.textContent = hiddenMode
    ? `返回当前联系人（${visibleCount}）`
    : `查看已隐藏（${hiddenCount}）`;
  button.title = `满 ${AUTO_HIDE_AFTER_DAYS} 天未互动的联系人默认隐藏，但仍保存在本机数据库。`;
}

function makeUpcomingDateChip(contact, withinDays = 30) {
  const upcoming = collectUpcomingAnnualDates(contact, withinDays);
  if (!upcoming.length) return null;
  const item = upcoming[0];
  const label = item.kind === "birthday"
    ? (item.age !== undefined ? `${item.age} 岁生日` : "生日")
    : item.label;
  const when = item.daysUntil === 0 ? "今天" : item.daysUntil === 1 ? "明天" : `${item.daysUntil} 天后`;
  return element("span", {
    className: `date-chip ${item.daysUntil <= 7 ? "is-soon" : ""}`.trim(),
    text: `${label} · ${when}`,
    title: `${label}：${item.date}${item.age !== undefined ? `（到时满 ${item.age} 岁）` : ""}`,
  });
}

function renderTable(contacts, { hiddenMode = false } = {}) {
  const filtered = applyLedgerSortOrder(applyContactFilters(contacts, filters));
  const {
    totalPages,
    page: safePage,
    startIndex,
    endIndex,
    pageContacts,
  } = getLedgerPageWindow(filtered);
  currentPage = safePage;

  $("#contact-result-count").textContent = hiddenMode
    ? `${filtered.length} / ${contacts.length} 位已隐藏联系人`
    : `${filtered.length} / ${contacts.length} 位联系人`;
  const visibleContacts = pageContacts;
  const body = $("#contact-table-body");
  const fragment = document.createDocumentFragment();

  visibleContacts.forEach((contact) => {
    const status = contactStatus(contact);
    const contactName = visibleName(contact);
    const selectContact = element("input", {
      className: "contact-select-checkbox",
      type: "checkbox",
      dataset: { selectContact: contact.id },
      attributes: { "aria-label": `选择 ${visibleName(contact)}` },
    });
    selectContact.checked = selectedContactIds.has(contact.id);
    selectContact.disabled = !authority.ready || !bulkTagId;
    const selectionControl = element("label", {
      className: "contact-select-control",
      title: bulkTagId ? `选择 ${contactName}` : "请先选择关系标签",
    }, [selectContact, element("span", { className: "sr-only", text: `选择 ${contactName}` })]);
    const identity = element("div", { className: "contact-identity" }, [
      selectionControl,
      element("div", { className: "contact-person" }, [
        makeAvatar(contact, { sizeClass: "ledger-avatar" }),
        element("div", { className: "contact-meta" }, [
          element("button", {
            className: "contact-name-button private-name",
            type: "button",
            text: contactName,
            dataset: { contactId: contact.id },
            attributes: { "aria-label": `打开${contactName}的关系卡` },
          }),
          element("div", { className: "contact-meta-badges" }, [
            makeSourceBadge(contact),
            makeContactStatusBadge(contact),
            makeUpcomingDateChip(contact),
          ]),
        ]),
      ]),
    ]);

    const tagStack = element("div", { className: "tag-stack relationship-tags" }, makeSystemChips(contact));
    contact.customTagIds?.forEach((tagId) => {
      const tag = state.tags.find((item) => item.id === tagId);
      if (tag) tagStack.append(makeTagChip(tag.name, "custom-tag"));
    });
    if (contact.needsReview) tagStack.append(makeTagChip("待校验", "needs-review"));

    const dateClass = contact.isDue ? "is-due" : contact.reminderState === "upcoming" ? "is-upcoming" : "";
    const dateCell = element("div", { className: `date-cell ${dateClass}`.trim() }, [
      element("strong", { text: formatDaysAgo(contact.daysSince) }),
      element("span", { text: contact.sourceMessageAt ? formatDate(contact.sourceMessageAt) : "没有有效日期" }),
    ]);
    const reminder = formatReminder(contact);
    const reminderCell = element("div", { className: `reminder-cell is-${reminder.tone}`.replace("is- ", "") }, [
      element("strong", { text: reminder.main }),
      element("span", { text: reminder.sub }),
    ]);
    const actions = element("div", { className: "row-actions" }, [
      makeRecordGreetingButton(contact, "mini-action primary contact-action-record"),
      makeOpenContactButton(contact, "mini-action contact-action-open"),
    ]);
    const row = element("tr", {
      className: `contact-card-row ${selectContact.checked ? "is-selected" : ""}`.trim(),
      dataset: { reminderState: status.key },
      attributes: { "aria-selected": String(selectContact.checked) },
    }, [
      element("td", { className: "identity-cell", attributes: { "data-label": "联系人" } }, identity),
      element("td", { className: "relation-cell", attributes: { "data-label": "关系坐标" } }, tagStack),
      element("td", { className: "recent-cell", attributes: { "data-label": "最近回响" } }, dateCell),
      element("td", {
        className: "message-cell conversation-cell private-copy",
        text: visibleMessage(contact),
        title: visibleMessage(contact),
        attributes: { "data-label": "上次聊到" },
      }),
      element("td", { className: "next-cell", attributes: { "data-label": "下次想起" } }, reminderCell),
      element("td", { className: "action-cell", attributes: { "data-label": "关系操作" } }, actions),
    ]);
    fragment.append(row);
  });
  body.replaceChildren(fragment);
  renderBatchSelectionState(pageContacts);
  $("#contact-empty").hidden = filtered.length !== 0;
  $("#contact-empty-title").textContent = hiddenMode ? "没有符合筛选的已隐藏联系人" : "没有符合当前筛选的联系人";
  $("#contact-empty-copy").textContent = hiddenMode
    ? `只有满 ${AUTO_HIDE_AFTER_DAYS} 天且有可靠互动日期的联系人会进入这里。`
    : "可以重置筛选，或者导入一份新的联系人数据。";
  $("#ledger-pagination").hidden = filtered.length === 0;
  $("#pagination-summary").textContent = filtered.length
    ? `第 ${startIndex + 1}–${endIndex} 位，共 ${filtered.length} 位`
    : "第 0–0 位，共 0 位";
  $("#page-indicator").textContent = `第 ${currentPage} / ${totalPages} 页`;
  $("#page-previous").disabled = currentPage <= 1;
  $("#page-next").disabled = currentPage >= totalPages;
  $("#page-size").value = String(pageSize);
}

function renderLedger() {
  const { visible, hidden } = currentContactSets();
  renderVisibilityControl(visible.length, hidden.length);
  renderTable(filters.hiddenOnly ? hidden : visible, { hiddenMode: filters.hiddenOnly });
  renderTagFilter();
}

function relationshipScore(contacts) {
  if (!contacts.length) return 0;
  const maintain = contacts.filter((contact) => contact.maintenanceIntent === MAINTENANCE.MAINTAIN);
  if (!maintain.length) return 0;
  const onRhythm = maintain.filter((contact) => !contact.isDue && !contact.needsReview).length;
  return Math.round((onRhythm / maintain.length) * 100);
}

function renderStorageDetails() {
  const storage = authority.storage;
  const path = $("#storage-db-path");
  const backupTime = $("#storage-backup-time");
  const health = $("#storage-health");
  if (!path || !backupTime || !health) return;
  if (!authority.ready || !storage) {
    path.textContent = authority.error || "正在连接本机服务…";
    backupTime.textContent = "尚未确认";
    health.textContent = authority.error ? "不可用" : "正在检查";
    return;
  }
  path.textContent = storage.databasePath;
  path.title = storage.databasePath;
  backupTime.textContent = storage.lastBackupAt ? formatDate(storage.lastBackupAt) : "尚未创建";
  health.textContent = storage.health?.integrity === "ok" && storage.health?.foreignKeys === "ok"
    ? `上次校验正常（${formatDateTime(storage.health.checkedAt)}）· ${storage.historyCount} 个历史版本`
    : "需要检查";
}

function renderHeaderAndStatus(contacts) {
  $("#today-label").textContent = dayFormatter.format(new Date());
  const demo = state.dataMode === "demo";
  const hasWeFlowData = state.contacts.some((contact) => contact.source === "weflow-direct");
  $("#rail-data-mode").textContent = authority.ready ? (hasWeFlowData ? "本机 · WeFlow" : "本机 SQLite") : "正在连接本机数据";
  $("#data-state-badge").textContent = authority.ready ? "本机 SQLite 已连接" : "只读缓存";
  $("#data-state-copy").textContent = authority.ready
    ? demo
      ? "演示数据也已写入本机 SQLite；导入仍会先预览，确认后才会替换或合并。"
      : state.dataMode === "empty"
        ? "本机数据库当前没有联系人，可以连接数据源、恢复演示数据或导入文件。"
        : hasWeFlowData
          ? "联系人来自 WeFlow 本机提取；正式状态已写入本机 SQLite。"
          : "联系人来自本地导入；正式状态已写入本机 SQLite。"
    : authority.error || "正在连接本机 SQLite；连接完成前不会保存更改。";
  $("#rail-data-dot").style.background = demo ? "#7fbd91" : state.dataMode === "empty" ? "#d89a83" : "#e4c692";
  $("#privacy-toggle").setAttribute("aria-pressed", String(Boolean(state.settings.privacyMode)));
  document.body.classList.toggle("privacy-on", Boolean(state.settings.privacyMode));
  const score = relationshipScore(contacts);
  $("#relationship-index-score").textContent = String(score);
  $(".index-scale span").style.transform = `scaleX(${score / 100})`;
  const due = contacts.filter((contact) => contact.isDue).length;
  const dateCount = contacts.filter((contact) => collectUpcomingAnnualDates(contact, 7).length).length;
  let indexCopy = due ? `${due} 位联系人已到问候节律。` : "当前节律平稳，没有到期联系人。";
  if (dateCount) indexCopy += ` 本周还有 ${dateCount} 个生日或纪念日。`;
  $("#relationship-index-copy").textContent = indexCopy;
}

function renderSystemLabels(contacts) {
  const grid = $("#system-label-grid");
  const descriptions = {
    frequent: "由最近互动时间自动计算",
    infrequent: "超过不常联系阈值",
    maintain: "由你主动选择",
    ignore: "由你主动选择",
  };
  const cards = Object.values(SYSTEM_LABELS).map((label) => {
    const count = contacts.filter((contact) => label.axis === "frequency" ? contact.frequency === label.id : contact.maintenanceIntent === label.id).length;
    return element("div", { className: "system-label-card" }, [
      element("strong", {}, [label.label, element("span", { text: `${count} 位` })]),
      element("p", { text: descriptions[label.id] }),
    ]);
  });
  grid.replaceChildren(...cards);
}

function renderCustomTags(contacts) {
  const list = $("#custom-tag-list");
  const rows = state.tags.map((tag) => {
    const count = contacts.filter((contact) => contact.customTagIds?.includes(tag.id)).length;
    return element("div", { className: "custom-tag-row" }, [
      element("strong", { text: tag.name }),
      element("span", { text: `${count} 位联系人` }),
      element("button", { className: "tag-delete", type: "button", text: "删除", dataset: { deleteTag: tag.id } }),
    ]);
  });
  if (!rows.length) rows.push(element("p", { className: "quiet-line", text: "还没有自定义标签。" }));
  list.replaceChildren(...rows);
}

function renderAll() {
  const { visible, hidden } = currentContactSets();
  renderHeaderAndStatus(visible);
  renderChronometer(visible);
  renderQueue(visible);
  renderTagFilter();
  renderVisibilityControl(visible.length, hidden.length);
  renderTable(filters.hiddenOnly ? hidden : visible, { hiddenMode: filters.hiddenOnly });
  renderSystemLabels(visible);
  renderCustomTags(visible);
  renderStorageDetails();
  renderBatchUndo();
}

function openDialog(dialogId) {
  const dialog = document.getElementById(dialogId);
  if (!(dialog instanceof HTMLDialogElement)) return;
  if (dialogId === "settings-dialog") {
    $("#inactive-days-input").value = String(state.settings.inactiveAfterDays);
    $("#cadence-days-input").value = String(state.settings.defaultCadenceDays);
  }
  if (dialogId === "tags-dialog") {
    const { visible } = currentContactSets();
    renderSystemLabels(visible);
    renderCustomTags(visible);
  }
  if (dialogId === "import-dialog") resetImportSession();
  dialog.showModal();
  window.requestAnimationFrame(() => $(".dialog-close", dialog)?.focus());
}

function closeDialog(trigger) {
  const dialog = trigger.closest("dialog");
  if (dialog?.open) dialog.close();
}

function renderContactDialog() {
  const contact = currentDerivedContacts().find((item) => item.id === selectedContactId);
  if (!contact) return;
  const title = $("#contact-dialog-title");
  title.textContent = `${visibleName(contact)}的关系卡`;
  const content = $("#contact-dialog-content");

  const hero = element("div", { className: "contact-hero" }, [
    element("div", { className: "contact-hero-main" }, [
      makeAvatar(contact, { sizeClass: "contact-hero-avatar" }),
      element("div", { className: "contact-meta" }, [
        element("h3", { className: "private-name", text: visibleName(contact) }),
        element("div", { className: "contact-meta-badges" }, [makeSourceBadge(contact), makeContactStatusBadge(contact)]),
        element("p", { text: `${contact.cadenceDays} 天问候节律` }),
      ]),
    ]),
  ]);

  const reminder = formatReminder(contact);
  const facts = element("div", { className: "contact-facts" }, [
    element("div", { className: "contact-fact" }, [element("span", { text: "最近回响" }), element("strong", { text: formatDaysAgo(contact.daysSince) })]),
    element("div", { className: "contact-fact" }, [element("span", { text: "关系频率" }), element("strong", { text: contact.frequency === FREQUENCY.FREQUENT ? "常联系人" : contact.frequency === FREQUENCY.INFREQUENT ? "不常联系人" : "联系时间待校验" })]),
    element("div", { className: "contact-fact" }, [element("span", { text: "下次想起" }), element("strong", { text: reminder.main })]),
  ]);

  const intentButtons = [
    [MAINTENANCE.MAINTAIN, "需要维系"],
    [MAINTENANCE.IGNORE, "不需要维系"],
    [MAINTENANCE.UNSET, "维系意愿未设置"],
  ].map(([value, label]) => element("button", {
    className: `choice-button ${contact.maintenanceIntent === value ? "is-selected" : ""}`.trim(),
    type: "button",
    text: label,
    dataset: { intent: value, contactId: contact.id },
    attributes: { "aria-pressed": String(contact.maintenanceIntent === value) },
  }));

  const tagButtons = state.tags.map((tag) => {
    const selected = contact.customTagIds?.includes(tag.id);
    return element("button", {
      className: `choice-button ${selected ? "is-selected" : ""}`.trim(),
      type: "button",
      text: tag.name,
      dataset: { toggleTag: tag.id, contactId: contact.id },
      attributes: { "aria-pressed": String(Boolean(selected)) },
    });
  });
  if (!tagButtons.length) tagButtons.push(element("p", { className: "quiet-line", text: "还没有自定义标签，可以在标签管理中添加。" }));

  const cadenceSelect = element("select", { attributes: { "aria-label": "单独设置问候节律" }, dataset: { cadenceFor: contact.id } }, [14, 30, 45, 60, 90].map((days) => element("option", { text: `${days} 天`, attributes: { value: String(days) } })));
  cadenceSelect.value = String(contact.cadenceDays);

  const draft = makeGreetingDraft(contact);
  const savedNote = typeof contact.personalNote === "string" ? contact.personalNote : "";
  const makeDateRow = (item) => element("div", { className: "important-date-row", dataset: { dateRow: item.id } }, [
    element("input", {
      className: "date-input date-label-input",
      attributes: { value: item.label, maxlength: "40", placeholder: "名称，如 结婚纪念日", "aria-label": "日子名称" },
    }),
    element("input", {
      className: "date-input date-value-input",
      attributes: { value: item.date, maxlength: "10", placeholder: "如 10-01", "aria-label": `${item.label} 的日期` },
    }),
    element("button", {
      className: "date-remove",
      type: "button",
      text: "×",
      dataset: { removeDateRow: item.id },
      attributes: { "aria-label": `删除重要日子 ${item.label}` },
    }),
  ]);
  const datesSection = element("section", { className: "detail-section dates-section" }, [
    element("h4", { text: "生日与重要日子" }),
    element("p", { className: "section-hint", text: "只记月日也行（如 10-01）；临近时会出现问候面板和联系人旁边。" }),
    element("label", { className: "birthday-field" }, [
      element("span", { text: "生日" }),
      element("input", {
        className: "date-input",
        dataset: { birthdayInput: contact.id },
        attributes: {
          value: contact.birthday || "",
          maxlength: "10",
          placeholder: "如 08-15 或 1990-08-15",
          "aria-label": `${visibleName(contact)} 的生日`,
        },
      }),
    ]),
    element("div", { className: "important-date-list", dataset: { dateList: contact.id } },
      (contact.importantDates || []).map((item) => makeDateRow(item))),
    element("button", { className: "text-button add-date-button", type: "button", text: "＋ 添加重要日子", dataset: { addDateRow: contact.id } }),
    element("div", { className: "note-actions" }, [
      element("button", {
        className: "button button-secondary",
        type: "button",
        text: "保存日期",
        dataset: { saveDates: contact.id },
        disabled: true,
      }),
    ]),
  ]);
  const noteInput = state.settings.privacyMode ? null : element("textarea", {
    className: "contact-note-input",
    dataset: { noteFor: contact.id },
    attributes: {
      rows: "3",
      maxlength: "2000",
      placeholder: "记一点对方在意的事：家庭、喜好、约定…下次问候更容易开口。",
      "aria-label": `${visibleName(contact)} 的个人备注`,
    },
    text: savedNote,
  });
  const noteSection = element("section", { className: "detail-section note-section" }, [
    element("h4", { text: "我的备注" }),
    element("p", { className: "section-hint", text: "只保存在本机数据库，导入导出时会随联系人一起带走。" }),
    noteInput
      ?? element("p", { className: "contact-note-privacy", text: savedNote ? "备注已在隐私模式下隐藏；关闭隐私模式后可查看和编辑。" : "还没有备注。" }),
    element("div", { className: "note-actions" }, [
      element("button", {
        className: "button button-secondary note-save",
        type: "button",
        text: "保存备注",
        dataset: { saveNote: contact.id },
        disabled: true,
      }),
    ]),
  ]);
  const body = element("div", { className: "contact-detail-body" }, [
    facts,
    element("div", { className: "message-evidence" }, [
      element("span", { text: `上次真实消息 · ${contact.sourceMessageAt ? formatDate(contact.sourceMessageAt) : "日期待校验"}` }),
      element("p", { className: "private-copy", text: visibleMessage(contact) }),
    ]),
    datesSection,
    noteSection,
    element("section", { className: "detail-section" }, [
      element("h4", { text: "维系意愿" }),
      element("div", { className: "intent-controls" }, intentButtons),
    ]),
    element("section", { className: "detail-section" }, [
      element("h4", { text: "自定义标签" }),
      element("div", { className: "intent-controls" }, tagButtons),
    ]),
    element("section", { className: "detail-section" }, [
      element("h4", { text: "问候节律" }),
      cadenceSelect,
    ]),
    element("section", { className: "detail-section" }, [
      element("h4", { text: "问候参考（不会自动发送）" }),
      element("div", { className: "greeting-draft private-copy", text: state.settings.privacyMode ? "问候参考已隐藏" : draft }),
      element("button", { className: "text-button", type: "button", text: "复制问候参考 →", dataset: { copyGreeting: contact.id } }),
    ]),
    element("section", { className: "detail-section" }, [
      element("h4", { text: "稍后提醒" }),
      element("div", { className: "snooze-controls" }, [3, 7, 14].map((days) => element("button", { className: "choice-button", type: "button", text: `${days} 天后`, dataset: { action: "snooze", days: String(days), contactId: contact.id } }))),
    ]),
    element("div", { className: "detail-actions" }, [
      element("button", { className: "button button-secondary", type: "button", text: "管理全部标签", dataset: { switchDialog: "tags-dialog" } }),
      makeRecordGreetingButton(contact, "button button-primary contact-action-record"),
    ]),
  ]);
  content.replaceChildren(hero, body);
}

function showContact(contactId) {
  selectedContactId = contactId;
  renderContactDialog();
  const dialog = $("#contact-dialog");
  if (!dialog.open) dialog.showModal();
  window.requestAnimationFrame(() => $(".dialog-close", dialog)?.focus());
}

let suggestItems = [];
let suggestActiveIndex = -1;

function suggestSubline(contact, needle) {
  const note = typeof contact.personalNote === "string" ? contact.personalNote.trim() : "";
  if (note && needle && note.toLocaleLowerCase("zh-CN").includes(needle)) {
    return `备注：${note.replace(/\s+/g, " ").slice(0, 40)}`;
  }
  return visibleMessage(contact).replace(/\s+/g, " ").slice(0, 40);
}

function suggestMatches(query) {
  const needle = String(query || "").trim().toLocaleLowerCase("zh-CN");
  if (!needle) return [];
  return currentContactSets().visible.filter((contact) => {
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
    return haystack.includes(needle);
  }).slice(0, 6);
}

function closeSearchSuggest() {
  const panel = $("#search-suggest");
  const input = $("#search-input");
  panel.hidden = true;
  panel.replaceChildren();
  suggestItems = [];
  suggestActiveIndex = -1;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

function setSuggestActive(index) {
  const panel = $("#search-suggest");
  const input = $("#search-input");
  suggestActiveIndex = suggestItems.length ? Math.min(Math.max(0, index), suggestItems.length - 1) : -1;
  $$(".suggest-item", panel).forEach((row, rowIndex) => {
    const selected = rowIndex === suggestActiveIndex;
    row.classList.toggle("is-active", selected);
    row.setAttribute("aria-selected", String(selected));
    if (selected) row.scrollIntoView({ block: "nearest" });
  });
  if (suggestActiveIndex >= 0) {
    input.setAttribute("aria-activedescendant", `search-suggest-option-${suggestActiveIndex}`);
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}

function renderSearchSuggest() {
  const input = $("#search-input");
  const panel = $("#search-suggest");
  const matches = suggestMatches(input.value);
  if (!matches.length) {
    closeSearchSuggest();
    return;
  }
  const needle = input.value.trim().toLocaleLowerCase("zh-CN");
  suggestItems = matches;
  const fragment = document.createDocumentFragment();
  matches.forEach((contact, index) => {
    fragment.append(element("button", {
      className: "suggest-item",
      type: "button",
      dataset: { contactId: contact.id },
      attributes: {
        role: "option",
        id: `search-suggest-option-${index}`,
        "aria-selected": "false",
        "aria-label": `打开${visibleName(contact)}的关系卡`,
      },
    }, [
      makeAvatar(contact, { sizeClass: "suggest-avatar" }),
      element("span", { className: "suggest-main" }, [
        element("strong", { className: "private-name", text: visibleName(contact) }),
        element("small", { className: "private-copy suggest-subline", text: suggestSubline(contact, needle) }),
      ]),
      element("span", { className: "suggest-meta", text: formatDaysAgo(contact.daysSince) }),
    ]));
  });
  panel.replaceChildren(fragment);
  panel.hidden = false;
  input.setAttribute("aria-expanded", "true");
  setSuggestActive(-1);
}

function openSuggestSelection() {
  if (!suggestItems.length) return;
  const contact = suggestItems[suggestActiveIndex >= 0 ? suggestActiveIndex : 0];
  closeSearchSuggest();
  showContact(contact.id);
}

async function handleContactAction(action, contactId, days) {
  if (action === "maintained") {
    const contact = state.contacts.find((item) => item.id === contactId);
    const intervalDays = Math.max(
      Number(contact?.cadenceDays) || state.settings.defaultCadenceDays,
      state.settings.inactiveAfterDays,
    );
    const nextDate = addLocalDays(new Date(), intervalDays);
    await updateContact(contactId, (item) => markMaintained(item, new Date()),
      `已记录本次问候；下次想起：${nextDate ? formatDate(nextDate) : "已重新计算"}。`);
  } else if (action === "snooze") {
    await updateContact(contactId, (contact) => snoozeContact(contact, Number(days) || 7, new Date()), `已稍后 ${Number(days) || 7} 天提醒。`);
  }
}

function resetFilters() {
  window.clearTimeout(searchTimer);
  searchTimer = null;
  Object.assign(filters, { query: "", frequency: "all", maintenance: "all", tagId: "all", timeRange: "all", dueOnly: false, hiddenOnly: false });
  bulkTagId = "";
  clearContactSelection();
  currentPage = 1;
  $("#search-input").value = "";
  $("#due-only-filter").checked = false;
  $$(".filter-group").forEach((group) => {
    $$("button", group).forEach((button) => button.classList.toggle("is-selected", button.dataset.filterValue === "all"));
  });
  $("#time-range-filter").value = "all";
  $("#bulk-tag-select").value = "";
  renderAll();
}

function setDueFilter() {
  filters.dueOnly = true;
  filters.hiddenOnly = false;
  clearContactSelection();
  currentPage = 1;
  $("#due-only-filter").checked = true;
  $("#contacts-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  renderLedger();
}

function setImportControlsBusy(busy, label = "连接并生成预览") {
  $("#weflow-preview").disabled = busy || !weflowSupportedOnHost;
  $("#weflow-preview").textContent = busy ? label : "连接并生成预览";
  $("#weflow-port").disabled = busy || !weflowSupportedOnHost;
  $("#weflow-token").disabled = busy || !weflowSupportedOnHost;
  $("#import-file").disabled = busy;
  if (busy) $("#commit-import").disabled = true;
}

function beginImportPreview(message, label) {
  importOperationId += 1;
  weflowPreviewController?.abort();
  weflowPreviewController = null;
  pendingImport = { ok: false, loading: true, message };
  setImportControlsBusy(true, label);
  renderImportResult();
  return importOperationId;
}

function finishImportPreview(operationId) {
  if (operationId !== importOperationId) return false;
  setImportControlsBusy(false);
  return true;
}

function resetImportSession() {
  importOperationId += 1;
  weflowPreviewController?.abort();
  weflowPreviewController = null;
  pendingImport = null;
  setImportSourceTab("file");
  $("#weflow-token").value = "";
  $("#import-file").value = "";
  $("#weflow-status").textContent = "Access Token 只驻留本次连接内存；不会写进 SQLite 或浏览器缓存。";
  $("#weflow-status").classList.remove("is-error");
  setImportControlsBusy(false);
  renderImportResult();
}

$("#import-dialog").addEventListener("click", (event) => {
  const tab = event.target instanceof Element ? event.target.closest("[data-source-tab]") : null;
  if (tab) setImportSourceTab(tab.dataset.sourceTab);
});

const SOURCE_TAB_NOTES = {
  file: "JSON / CSV 都可以；解析结果先在右侧预览，确认后才写入。",
  weflow: "先在 WeFlow 设置 → API 服务 里启动，再回到这里连接。",
  bridge: "选定 Mac 微信读取软件后接入；输出与格式样例相同的 JSON 即可。",
};

function setImportSourceTab(tabId) {
  const safeTab = ["file", "weflow", "bridge"].includes(tabId) ? tabId : "file";
  $$("[data-source-tab]").forEach((tab) => {
    const active = tab.dataset.sourceTab === safeTab;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  ["file", "weflow", "bridge"].forEach((id) => {
    const panel = $(`#source-panel-${id}`);
    if (panel) panel.hidden = id !== safeTab;
  });
  const note = $("#source-tab-note");
  if (note) note.textContent = SOURCE_TAB_NOTES[safeTab];
}

function renderContactSourceCatalog() {
  const weflowSource = contactSourceCatalog.find((source) => source.id === "weflow-http-win32");
  weflowSupportedOnHost = Boolean(weflowSource?.supportedOnHost);
  const weflowTab = $('[data-source-tab="weflow"]');
  if (weflowTab) {
    const badge = weflowTab.querySelector("[data-tab-badge]");
    if (badge) badge.textContent = weflowSupportedOnHost ? "本机可用" : "仅 Windows";
    weflowTab.title = weflowSupportedOnHost
      ? "WeFlow 本机直连：本机可用"
      : "WeFlow 是 Windows 端提取器；在 Mac 上请用本机文件导入";
  }
  const bridgeTab = $('[data-source-tab="bridge"]');
  if (bridgeTab) {
    const bridgeSource = contactSourceCatalog.find((source) => source.availability === "adapter-required");
    const badge = bridgeTab.querySelector("[data-tab-badge]");
    if (badge) badge.textContent = bridgeSource ? "需适配器" : "即将支持";
  }
  const weflowSection = $("[data-provider-id=\"weflow-http-win32\"]");
  if (weflowSection) weflowSection.hidden = !weflowSupportedOnHost;
  const weflowUnavailableNote = $("[data-weflow-unavailable]");
  if (weflowUnavailableNote) weflowUnavailableNote.hidden = weflowSupportedOnHost;
  $("#file-drop")?.classList.toggle("is-recommended", !weflowSupportedOnHost);
  setImportControlsBusy(false);
}

async function hydrateContactSourceCatalog() {
  try {
    const payload = await listContactSources();
    contactSourceCatalog = payload.sources;
    renderContactSourceCatalog();
  } catch {
    // Static cards remain visible when the local API has not started yet.
  }
}

function renderImportResult() {
  const placeholder = $("#import-placeholder");
  const result = $("#import-result");
  const error = $("#import-error");
  const commit = $("#commit-import");
  error.hidden = true;
  if (!pendingImport?.ok) {
    placeholder.hidden = false;
    result.hidden = true;
    commit.disabled = true;
    commit.textContent = "确认导入";
    $("#import-placeholder-title").textContent = pendingImport?.loading ? "正在生成预览" : "等待选择联系人来源";
    $("#import-placeholder-copy").textContent = pendingImport?.loading
      ? pendingImport.message
      : "解析结果、警告和联系人预览会显示在这里。";
    if (pendingImport?.error) {
      error.textContent = pendingImport.error;
      error.hidden = false;
    }
    return;
  }

  placeholder.hidden = true;
  result.hidden = false;
  commit.disabled = false;
  const needsReviewCount = pendingImport.contacts.reduce((count, contact) => count + (contact.needsReview ? 1 : 0), 0);
  commit.textContent = needsReviewCount ? `确认导入 · ${needsReviewCount} 位待校验` : "确认导入";
  $("#import-contact-count").textContent = String(pendingImport.contacts.length);
  $("#import-warning-count").textContent = String(needsReviewCount);
  $("#import-warning-groups").textContent = String(pendingImport.warnings.length);
  $("#import-source").textContent = pendingImport.sourceKind === "portable-contact-source"
    ? `已读取关系回响通用数据源（${pendingImport.sourceMeta?.providerId || "未知读取器"}）；可在 Windows 与 Mac 之间迁移。尚未写入本机数据库。`
    : pendingImport.sourceKind === "weflow-message-compatible"
    ? "识别为 WeFlow 兼容消息列表；已按个人会话归纳最近一条有效消息。"
    : pendingImport.sourceKind === "weflow-direct"
      ? `${pendingImport.sourceMeta?.partial ? "这是部分消息预览；未取到正文的联系人已标记待校验。" : "已从 WeFlow 本机 API 生成完整预览。"} 共识别 ${pendingImport.contacts.length} 位个人联系人，尚未写入本机数据库。`
      : "识别为联系人摘要列表；尚未声明特定 WeFlow 版本。";
  const previewItems = pendingImport.contacts.slice(0, 6).map((contact, index) => element("div", { className: "preview-contact" }, [
    makeAvatar(contact, { sizeClass: "preview-avatar" }),
    element("div", { className: "contact-meta" }, [
      element("strong", { text: state.settings.privacyMode ? `导入联系人 ${String(index + 1).padStart(2, "0")}` : contact.name }),
      element("small", { text: state.settings.privacyMode ? "消息摘要已隐藏" : (contact.lastMessageText || "没有消息摘要") }),
      makeSourceBadge(contact),
    ]),
    element("time", { text: contact.lastMessageAt ? formatDate(contact.lastMessageAt) : "待校验" }),
  ]));
  $("#import-preview-list").replaceChildren(...previewItems);
  $("#import-warning-details").hidden = pendingImport.warnings.length === 0;
  const warnings = state.settings.privacyMode && pendingImport.warnings.length
    ? [`隐私模式下已隐藏 ${pendingImport.warnings.length} 条详细警告。关闭隐私模式后可重新选择文件查看。`]
    : pendingImport.warnings;
  $("#import-warning-list").replaceChildren(...warnings.map((warning) => element("li", { text: warning })));
}

async function handleImportFile(file) {
  if (!file) return;
  const operationId = beginImportPreview("正在本机读取并校验文件；完成前不能提交旧预览。", "正在读取文件…");
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    if (!finishImportPreview(operationId)) return;
    pendingImport = { ok: false, error: "文件超过 5 MB。请先在联系人读取工具中归纳，或拆分文件后再导入。" };
    renderImportResult();
    return;
  }
  try {
    const text = await file.text();
    if (operationId !== importOperationId) return;
    pendingImport = parseImportText(text, file.name, new Date());
  } catch (error) {
    if (operationId !== importOperationId) return;
    pendingImport = { ok: false, error: `无法读取文件：${error.message}` };
  }
  if (!finishImportPreview(operationId)) return;
  renderImportResult();
}

async function handleWeFlowPreview() {
  const status = $("#weflow-status");
  const tokenInput = $("#weflow-token");
  const port = Number($("#weflow-port").value);
  const token = tokenInput.value;
  tokenInput.value = "";
  if (!token.trim()) {
    status.textContent = "请先输入 WeFlow API 服务的 Access Token。";
    status.classList.add("is-error");
    tokenInput.focus();
    return;
  }
  const operationId = beginImportPreview("正在读取联系人、会话与最近消息，达到总预算后会返回可校验的部分预览。", "正在读取联系人与最近消息…");
  const controller = new AbortController();
  weflowPreviewController = controller;
  status.textContent = "正在连接 127.0.0.1；联系人较多时可能需要几十秒。";
  status.classList.remove("is-error");
  try {
    const result = await previewContactSource({
      sourceId: "weflow-http-win32",
      configuration: { port, token },
      signal: controller.signal,
    });
    if (operationId !== importOperationId) return;
    pendingImport = result;
    status.textContent = `连接成功：已生成 ${pendingImport.contacts.length} 位联系人的预览。确认导入前，本机数据不会改变。`;
    renderImportResult();
  } catch (error) {
    if (operationId !== importOperationId) return;
    pendingImport = { ok: false, error: error.message };
    status.textContent = error.message;
    status.classList.add("is-error");
    renderImportResult();
  } finally {
    if (operationId === importOperationId) {
      weflowPreviewController = null;
      finishImportPreview(operationId);
    }
  }
}

async function commitImport() {
  if (!pendingImport?.ok) return;
  const importSnapshot = pendingImport;
  importOperationId += 1;
  const commitOperationId = importOperationId;
  weflowPreviewController?.abort();
  weflowPreviewController = null;
  setImportControlsBusy(true, "正在写入本机数据库…");
  const candidate = cloneState();
  const nextTags = [...candidate.tags];
  const tagNameToId = new Map(nextTags.map((tag) => [tag.name.toLocaleLowerCase("zh-CN"), tag.id]));
  let tagLimitExceeded = false;
  const normalizedContacts = importSnapshot.contacts.map((contact, contactIndex) => {
    const customTagIds = [];
    contact.importedTagNames.forEach((name, tagIndex) => {
      const key = name.toLocaleLowerCase("zh-CN");
      let id = tagNameToId.get(key);
      if (!id) {
        const created = createCustomTag(name, nextTags, Date.now() + contactIndex * 100 + tagIndex);
        if (created.tag) {
          if (nextTags.length >= 500) {
            tagLimitExceeded = true;
            return;
          }
          nextTags.push(created.tag);
          id = created.tag.id;
          tagNameToId.set(key, id);
        }
      }
      if (id) customTagIds.push(id);
    });
    const normalized = {
      ...contact,
      cadenceDays: contact.importedCadenceProvided ? contact.cadenceDays : candidate.settings.defaultCadenceDays,
      customTagIds: [...new Set(customTagIds)],
    };
    delete normalized.importedTagNames;
    return normalized;
  });

  if (tagLimitExceeded) {
    showToast("导入后的自定义标签超过 500 个，已停止导入；当前数据没有改变。", "error");
    finishImportPreview(commitOperationId);
    renderImportResult();
    return;
  }

  const importMode = $("#import-mode").value;
  if (importMode === "replace") {
    candidate.contacts = normalizedContacts;
  } else {
    const merged = new Map(candidate.contacts.map((contact) => [contact.id, contact]));
    normalizedContacts.forEach((contact) => {
      const existing = merged.get(contact.id);
      merged.set(contact.id, existing ? {
        ...existing,
        ...contact,
        cadenceDays: contact.importedCadenceProvided ? contact.cadenceDays : existing.cadenceDays,
        maintenanceIntent: contact.maintenanceIntent === MAINTENANCE.UNSET ? existing.maintenanceIntent : contact.maintenanceIntent,
        customTagIds: [...new Set([...(existing.customTagIds || []), ...(contact.customTagIds || [])])],
      } : contact);
    });
    candidate.contacts = [...merged.values()];
  }
  if (candidate.contacts.length > MAX_CONTACTS) {
    showToast(`导入后将有 ${candidate.contacts.length} 位联系人，超过 ${MAX_CONTACTS} 人上限；当前数据没有改变。`, "error");
    finishImportPreview(commitOperationId);
    renderImportResult();
    return;
  }
  candidate.contacts.forEach((contact) => delete contact.importedCadenceProvided);
  candidate.tags = nextTags;
  candidate.dataMode = "imported";
  if (await commitCandidate(candidate, `已在本地导入 ${normalizedContacts.length} 位联系人。`)) {
    invalidateBatchUndoForStructuralChange();
    clearContactSelection();
    bulkTagId = "";
    currentPage = 1;
    pendingImport = null;
    $("#import-dialog").close();
    $("#import-file").value = "";
    renderAll();
  } else {
    finishImportPreview(commitOperationId);
    renderImportResult();
  }
}

function exportBackup() {
  try {
    const blob = new Blob([serializeBackup(state)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `relationship-care-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("本地备份已导出。文件可能包含私人内容，请妥善保管。" );
  } catch (error) {
    showToast(`备份导出失败：${error.message}`, "error");
  }
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function exportLedgerCsv() {
  try {
    const { visible } = currentContactSets();
    if (!visible.length) {
      showToast("当前没有可导出的联系人。", "error");
      return;
    }
    const intentLabel = { maintain: "需要维系", ignore: "不需要维系", unset: "未设置" };
    const frequencyLabel = { frequent: "常联系人", infrequent: "不常联系人", unknown: "待校验" };
    const stateLabel = {
      overdue: "已逾期",
      today: "今天到期",
      "first-greeting": "首次问候",
      upcoming: "将到期",
      snoozed: "已稍后提醒",
      scheduled: "节律内",
      none: "—",
    };
    const header = ["姓名", "维系意愿", "联系频率", "自定义标签", "最近互动", "距今天数", "上次消息摘要", "我的备注", "生日", "重要日子", "下次建议联系", "提醒状态"];
    const rows = visible.map((contact) => [
      visibleName(contact),
      intentLabel[contact.maintenanceIntent] || contact.maintenanceIntent,
      frequencyLabel[contact.frequency] || "",
      (contact.customTagIds || []).map((tagId) => getTagName(tagId)).join("、"),
      contact.interactionAt ? formatDate(contact.interactionAt) : "",
      contact.daysSince ?? "",
      visibleMessage(contact),
      contact.personalNote || "",
      contact.birthday || "",
      (contact.importantDates || []).map((item) => `${item.label}:${item.date}`).join("、"),
      contact.nextReminderAt ? formatDate(contact.nextReminderAt) : "",
      stateLabel[contact.reminderState] || contact.reminderState,
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `关系回响联系人-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${visible.length} 位联系人的 CSV（不含已自动隐藏的联系人）；文件含私人内容，请妥善保管。`);
  } catch (error) {
    showToast(`CSV 导出失败：${error.message}`, "error");
  }
}

function requestConfirmation({ title, copy, actionLabel = "确认", cancelLabel = "取消", tone = "danger", onConfirm, onCancel = null }) {
  pendingConfirmation = { onConfirm, onCancel, actionLabel, busy: false };
  $("#confirm-title").textContent = title;
  $("#confirm-copy").textContent = copy;
  $("#confirm-action").textContent = actionLabel;
  $("#confirm-action").className = `button ${tone === "primary" ? "button-primary" : "button-danger"}`;
  $("#confirm-action").disabled = false;
  $("#confirm-cancel").textContent = cancelLabel;
  $("#confirm-cancel").disabled = false;
  $("#confirm-dialog").showModal();
  $("#confirm-cancel").focus();
}

function setConfirmationBusy(busy, busyLabel = "正在处理…") {
  if (!pendingConfirmation) return;
  pendingConfirmation.busy = busy;
  $("#confirm-action").disabled = busy;
  $("#confirm-cancel").disabled = busy;
  $("#confirm-action").textContent = busy ? busyLabel : pendingConfirmation.actionLabel;
}

function cancelConfirmation() {
  if (pendingConfirmation?.busy) return;
  const onCancel = pendingConfirmation?.onCancel;
  closeConfirmation();
  onCancel?.();
}

function requestCacheMigrationChoice(contactCount) {
  return new Promise((resolveChoice) => {
    requestConfirmation({
      title: "发现浏览器恢复缓存",
      copy: `新的本机 SQLite 数据库还是空的，但浏览器里有 ${contactCount} 位旧联系人。选择“迁移到本机数据库”会把它们设为正式数据；选择“不使用缓存”会明确以演示数据新建数据库。`,
      actionLabel: "迁移到本机数据库",
      cancelLabel: "不使用缓存",
      tone: "primary",
      onConfirm: () => {
        closeConfirmation();
        resolveChoice(true);
      },
      onCancel: () => resolveChoice(false),
    });
  });
}

function closeConfirmation() {
  pendingConfirmation = null;
  if ($("#confirm-dialog").open) $("#confirm-dialog").close();
}

async function createAndPersistCustomTag({ input, error, form, selectForBatch = false }) {
  const validateTag = () => {
    if (state.tags.length >= 500) return { error: "自定义标签已达到 500 个上限。" };
    return createCustomTag(input.value, state.tags);
  };
  const initialResult = validateTag();
  if (initialResult.error) {
    error.textContent = initialResult.error;
    error.hidden = false;
    input.focus({ preventScroll: true });
    return false;
  }

  const persist = async () => {
    const result = validateTag();
    if (result.error) {
      error.textContent = result.error;
      error.hidden = false;
      input.focus({ preventScroll: true });
      return false;
    }
    error.hidden = true;
    input.disabled = true;
    form.setAttribute("aria-busy", "true");
    const submitButton = $('button[type="submit"]', form);
    if (submitButton) submitButton.disabled = true;
    try {
      const candidate = cloneState();
      candidate.tags.push(result.tag);
      if (!await commitCandidate(candidate, `已添加“${result.tag.name}”标签。`)) return false;
      input.value = "";
      if (selectForBatch) {
        bulkTagId = result.tag.id;
        clearContactSelection();
        form.hidden = true;
        $("#show-bulk-tag-form").setAttribute("aria-expanded", "false");
      }
      renderAll();
      if (selectForBatch) {
        $("#select-page-contacts").focus({ preventScroll: true });
        announce(`已创建并选中“${result.tag.name}”，现在请选择联系人。`);
      }
      return true;
    } finally {
      input.disabled = false;
      form.removeAttribute("aria-busy");
      if (submitButton) submitButton.disabled = false;
    }
  };

  if (lastBatchUndo) {
    requestConfirmation({
      title: "创建新标签并结束上一次撤销？",
      copy: `当前还有一笔批量整理可以撤销。创建“${initialResult.tag.name}”会写入新状态，并结束上一笔撤销窗口。`,
      actionLabel: "继续创建",
      cancelLabel: "保留撤销",
      tone: "primary",
      onConfirm: async () => {
        closeConfirmation();
        await persist();
      },
      onCancel: () => input.focus({ preventScroll: true }),
    });
    return false;
  }
  return persist();
}

function deleteTag(tagId) {
  const tag = state.tags.find((item) => item.id === tagId);
  if (!tag) return;
  const count = state.contacts.filter((contact) => contact.customTagIds?.includes(tagId)).length;
  requestConfirmation({
    title: `删除“${tag.name}”标签？`,
    copy: count ? `这个标签正在用于 ${count} 位联系人。删除只会移除标签关联，不会删除联系人。` : "这个标签尚未分配给联系人。",
    actionLabel: "删除标签",
    onConfirm: async () => {
      const candidate = cloneState();
      candidate.tags = candidate.tags.filter((item) => item.id !== tagId);
      candidate.contacts = candidate.contacts.map((contact) => ({
        ...contact,
        customTagIds: (contact.customTagIds || []).filter((id) => id !== tagId),
      }));
      if (await commitCandidate(candidate, `已删除“${tag.name}”标签。`)) {
        if (bulkTagId === tagId) {
          bulkTagId = "";
          clearContactSelection();
        }
        invalidateBatchUndoForStructuralChange(tagId);
        closeConfirmation();
        renderAll();
      }
    },
  });
}

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target.closest("button, label") : null;
  if (!target) return;

  if (target.matches("[data-open-dialog]")) {
    openDialog(target.dataset.openDialog);
    return;
  }
  if (target.matches(".dialog-close")) {
    closeDialog(target);
    return;
  }
  if (target.matches("[data-scroll-target]")) {
    document.getElementById(target.dataset.scrollTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
    $$(".rail-link").forEach((button) => button.classList.toggle("is-active", button === target));
    return;
  }
  if (target.matches("[data-undo-batch]")) {
    await undoLastBatchTagAction();
    return;
  }
  if (target.matches("[data-contact-id]") && !target.dataset.action && !target.dataset.intent && !target.dataset.toggleTag) {
    showContact(target.dataset.contactId);
    return;
  }
  if (target.matches("[data-action]")) {
    await handleContactAction(target.dataset.action, target.dataset.contactId, target.dataset.days);
    return;
  }
  if (target.matches("[data-set-due-filter]")) {
    setDueFilter();
    return;
  }
  if (target.matches("[data-reset-filters]")) {
    resetFilters();
    return;
  }
  if (target.matches("[data-intent]")) {
    await updateContact(target.dataset.contactId, (contact) => setMaintenanceIntent(contact, target.dataset.intent), "维系意愿已更新。" );
    return;
  }
  if (target.matches("[data-toggle-tag]")) {
    const tagId = target.dataset.toggleTag;
    await updateContact(target.dataset.contactId, (contact) => {
      const current = new Set(contact.customTagIds || []);
      if (current.has(tagId)) current.delete(tagId);
      else current.add(tagId);
      return { ...contact, customTagIds: [...current] };
    }, "联系人标签已更新。" );
    return;
  }
  if (target.matches("[data-copy-greeting]")) {
    const contact = state.contacts.find((item) => item.id === target.dataset.copyGreeting);
    if (!contact) return;
    if (state.settings.privacyMode) {
      showToast("请先关闭隐私模式，再复制问候参考。", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(makeGreetingDraft(contact));
      showToast("问候参考已复制；请根据真实关系再调整语气。" );
    } catch {
      showToast("浏览器没有允许剪贴板访问，请手动复制。", "error");
    }
    return;
  }
  if (target.matches("[data-save-note]")) {
    const contactId = target.dataset.saveNote;
    const textarea = $(`textarea[data-note-for="${CSS.escape(contactId)}"]`);
    if (!textarea) return;
    const note = textarea.value.replace(/\r\n/g, "\n").trim().slice(0, 2000);
    const saved = typeof state.contacts.find((item) => item.id === contactId)?.personalNote === "string"
      ? state.contacts.find((item) => item.id === contactId).personalNote.trim()
      : "";
    if (note === saved) return;
    target.disabled = true;
    target.textContent = "正在保存…";
    await updateContact(contactId, (contact) => ({ ...contact, personalNote: note ? note : undefined }),
      note ? "备注已保存到本机数据库。" : "已清空这条备注。");
    return;
  }
  if (target.matches("[data-quick-tag]")) {
    selectBulkTag(target.dataset.quickTag || "", { focus: true });
    return;
  }
  if (target.matches("#show-bulk-tag-form")) {
    $("#bulk-tag-form").hidden = false;
    target.setAttribute("aria-expanded", "true");
    $("#bulk-new-tag-name").focus({ preventScroll: true });
    return;
  }
  if (target.matches("#bulk-tag-form-cancel")) {
    $("#bulk-tag-form").reset();
    $("#bulk-tag-form").hidden = true;
    $("#bulk-tag-form-error").hidden = true;
    $("#show-bulk-tag-form").setAttribute("aria-expanded", "false");
    $("#show-bulk-tag-form").focus({ preventScroll: true });
    return;
  }
  if (target.matches("#select-page-contacts")) {
    const pageContacts = getCurrentLedgerPageContacts();
    const summary = summarizeContactSelection(selectedContactIds, pageContacts.map((contact) => contact.id));
    selectedContactIds = selectCurrentPage(pageContacts.map((contact) => contact.id), !summary.checked);
    renderBatchSelectionState(pageContacts);
    announce(summary.checked ? "已取消本页全部联系人选择。" : `已选择本页 ${selectedContactIds.size} 位联系人。`);
    return;
  }
  if (target.matches("#clear-contact-selection")) {
    clearContactSelection({ announceChange: true, reason: "已清空本页联系人选择。" });
    renderBatchSelectionState();
    return;
  }
  if (target.matches("#batch-add-tag")) {
    await applyBatchTag("add");
    return;
  }
  if (target.matches("#batch-remove-tag")) {
    await applyBatchTag("remove");
    return;
  }
  if (target.matches("[data-switch-dialog]")) {
    closeDialog(target);
    openDialog(target.dataset.switchDialog);
    return;
  }
  if (target.matches("[data-delete-tag]")) {
    deleteTag(target.dataset.deleteTag);
  }
});

$$('.filter-group').forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter-value]");
    if (!button) return;
    const groupName = group.dataset.filterGroup;
    filters[groupName] = button.dataset.filterValue;
    clearContactSelection({ announceChange: true, reason: "筛选条件已改变，联系人选择已清空。" });
    currentPage = 1;
    $$("button[data-filter-value]", group).forEach((item) => item.classList.toggle("is-selected", item === button));
    renderLedger();
  });
});

$("#search-input").addEventListener("input", (event) => {
  window.clearTimeout(searchTimer);
  const query = event.target.value;
  renderSearchSuggest();
  if (query !== filters.query) {
    clearContactSelection({ announceChange: true, reason: "搜索条件已改变，联系人选择已清空。" });
    renderBatchSelectionState();
  }
  searchTimer = window.setTimeout(() => {
    searchTimer = null;
    if ($("#search-input").value !== query) return;
    filters.query = query;
    currentPage = 1;
    renderLedger();
  }, 160);
});

$("#search-input").addEventListener("focus", () => {
  if ($("#search-input").value.trim()) renderSearchSuggest();
});

$("#search-input").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!suggestItems.length) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = suggestActiveIndex + delta;
    setSuggestActive(next < 0 ? suggestItems.length - 1 : next >= suggestItems.length ? 0 : next);
    return;
  }
  if (event.key === "Enter") {
    if (suggestItems.length) {
      event.preventDefault();
      openSuggestSelection();
      return;
    }
    if ($("#search-input").value.trim()) {
      $("#contacts-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }
  if (event.key === "Escape") {
    if (suggestItems.length) closeSearchSuggest();
  }
});

$("#search-suggest").addEventListener("click", () => {
  closeSearchSuggest();
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element) && event.target !== document) return;
  if (event.target instanceof Element && event.target.closest(".search-field")) return;
  closeSearchSuggest();
});

$("#tag-filter").addEventListener("change", (event) => {
  filters.tagId = event.target.value;
  clearContactSelection({ announceChange: true, reason: "筛选标签已改变，联系人选择已清空。" });
  currentPage = 1;
  renderLedger();
});

$("#time-range-filter").addEventListener("change", (event) => {
  filters.timeRange = event.target.value;
  clearContactSelection({ announceChange: true, reason: "联系时段已改变，联系人选择已清空。" });
  currentPage = 1;
  renderLedger();
});

$("#ledger-sort").addEventListener("change", (event) => {
  ledgerSortMode = ledgerSorters[event.target.value] ? event.target.value : "priority";
  clearContactSelection({ announceChange: true, reason: "排序方式已改变，联系人选择已清空。" });
  currentPage = 1;
  renderLedger();
  const sortLabel = { priority: "提醒优先", recent: "最近联系", name: "姓名" }[ledgerSortMode] || "提醒优先";
  announce(`联系人已按${sortLabel}排序。`);
});

$("#bulk-tag-select").addEventListener("change", (event) => {
  selectBulkTag(event.target.value);
});

$("#due-only-filter").addEventListener("change", (event) => {
  filters.dueOnly = event.target.checked;
  clearContactSelection({ announceChange: true, reason: "待问候筛选已改变，联系人选择已清空。" });
  currentPage = 1;
  renderLedger();
});

$("#hidden-contact-filter").addEventListener("click", () => {
  filters.hiddenOnly = !filters.hiddenOnly;
  clearContactSelection({ announceChange: true, reason: "联系人显示范围已改变，选择已清空。" });
  currentPage = 1;
  renderLedger();
});

$("#reset-filters").addEventListener("click", resetFilters);

$("#page-previous").addEventListener("click", () => {
  clearContactSelection({ announceChange: true, reason: "已翻到上一页，联系人选择已清空。" });
  currentPage = Math.max(1, currentPage - 1);
  renderLedger();
  $("#contacts-title").focus?.();
});

$("#page-next").addEventListener("click", () => {
  clearContactSelection({ announceChange: true, reason: "已翻到下一页，联系人选择已清空。" });
  currentPage += 1;
  renderLedger();
  $("#contacts-title").focus?.();
});

$("#page-size").addEventListener("change", (event) => {
  const requestedSize = Number(event.target.value);
  pageSize = ALLOWED_PAGE_SIZES.includes(requestedSize) ? requestedSize : DEFAULT_PAGE_SIZE;
  clearContactSelection({ announceChange: true, reason: "每页人数已改变，联系人选择已清空。" });
  currentPage = 1;
  renderLedger();
});

$("#contact-table-body").addEventListener("change", (event) => {
  const checkbox = event.target.closest('input[data-select-contact]');
  if (!checkbox || checkbox.disabled) return;
  const pageContacts = getCurrentLedgerPageContacts();
  selectedContactIds = toggleContactSelection(
    selectedContactIds,
    checkbox.dataset.selectContact,
    checkbox.checked,
    pageContacts.map((contact) => contact.id),
  );
  renderBatchSelectionState(pageContacts);
  announce(`当前页已选择 ${selectedContactIds.size} 位联系人。`);
});

$("#contact-table-body").addEventListener("click", (event) => {
  if (event.target.closest("button, input, label, select, a")) return;
  const openButton = event.target.closest("tr")?.querySelector("[data-contact-id]");
  if (openButton) showContact(openButton.dataset.contactId);
});

$$("dialog.app-dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && dialog.open) dialog.close();
  });
});

$("#select-page-checkbox").addEventListener("change", (event) => {
  const pageContacts = getCurrentLedgerPageContacts();
  selectedContactIds = selectCurrentPage(pageContacts.map((contact) => contact.id), event.target.checked);
  renderBatchSelectionState(pageContacts);
  announce(event.target.checked ? `已选择本页 ${selectedContactIds.size} 位联系人。` : "已取消本页全部联系人选择。");
});

$("#privacy-toggle").addEventListener("click", async () => {
  const candidate = cloneState();
  candidate.settings.privacyMode = !candidate.settings.privacyMode;
  if (await commitCandidate(candidate, candidate.settings.privacyMode ? "隐私模式已开启。" : "隐私模式已关闭。")) {
    if (candidate.settings.privacyMode) {
      window.clearTimeout(searchTimer);
      searchTimer = null;
      filters.query = "";
      currentPage = 1;
      $("#search-input").value = "";
    }
    renderAll();
    if ($("#contact-dialog").open) renderContactDialog();
    if ($("#import-dialog").open) renderImportResult();
  }
});

$("#contact-dialog-content").addEventListener("change", async (event) => {
  const select = event.target.closest("select[data-cadence-for]");
  if (!select) return;
  await updateContact(select.dataset.cadenceFor, (contact) => ({ ...contact, cadenceDays: Number(select.value) }), "问候节律已更新。" );
});

$("#contact-dialog-content").addEventListener("input", (event) => {
  const textarea = event.target.closest("textarea[data-note-for]");
  if (textarea) {
    const saveButton = $("#contact-dialog-content [data-save-note]");
    if (saveButton) {
      const contact = state.contacts.find((item) => item.id === textarea.dataset.noteFor);
      const saved = typeof contact?.personalNote === "string" ? contact.personalNote.trim() : "";
      const current = textarea.value.replace(/\r\n/g, "\n").trim();
      saveButton.disabled = current === saved;
      saveButton.textContent = "保存备注";
    }
  }
  if (event.target.closest(".dates-section .date-input")) {
    const saveButton = $("#contact-dialog-content [data-save-dates]");
    const contact = state.contacts.find((item) => item.id === saveButton?.dataset.saveDates);
    if (saveButton && contact) saveButton.disabled = !collectDatesEdits(contact.id).changed;
  }
});

function readAnnualInput(input) {
  const text = input.value.trim();
  if (!text) return { empty: true };
  const parsed = parseAnnualDate(text);
  if (!parsed) return { invalid: true };
  return { value: formatAnnualDate(parsed) };
}

function collectDatesEdits(contactId) {
  const content = $("#contact-dialog-content");
  const contact = state.contacts.find((item) => item.id === contactId);
  if (!content || !contact) return { changed: false };
  const birthday = readAnnualInput($("[data-birthday-input]", content));
  const birthdayText = $("[data-birthday-input]", content).value.trim();
  const savedBirthday = contact.birthday || "";
  const savedDates = (contact.importantDates || []).map((item) => ({ id: item.id, label: item.label, date: item.date }));
  const rows = $$("[data-date-row]", content).map((row) => ({
    id: row.dataset.dateRow,
    label: $("[data-date-label]", row).value.trim(),
    date: readAnnualInput($("[data-date-value]", row)),
  }));
  const nextDates = rows
    .filter((row) => row.label || !row.date.empty)
    .map((row) => ({ id: row.id, label: row.label, date: row.date.value || "" }));
  const datesChanged = nextDates.length !== savedDates.length
    || nextDates.some((item, index) => {
      const saved = savedDates[index];
      return !saved || saved.id !== item.id || saved.label !== item.label || saved.date !== item.date;
    });
  return { changed: birthdayText !== savedBirthday || datesChanged, birthday, rows };
}

async function saveContactDates(contactId) {
  const edits = collectDatesEdits(contactId);
  if (!edits.changed) return;
  if (edits.birthday.invalid) {
    showToast("生日格式看不懂；请用 08-15 或 1990-08-15。", "error");
    $("[data-birthday-input]").focus();
    return;
  }
  for (const row of edits.rows) {
    if (!row.label && row.date.empty) continue;
    if (!row.label) {
      showToast("有一条重要日子还没填名称；填好名称或点 × 删除这一行。", "error");
      return;
    }
    if (row.date.empty || row.date.invalid) {
      showToast(`“${row.label}”的日期请用 10-01 或 2020-10-01。`, "error");
      return;
    }
  }
  const birthday = edits.birthday.empty ? undefined : edits.birthday.value;
  const importantDates = edits.rows
    .filter((row) => row.label && row.date.value)
    .map((row) => ({ id: row.id, label: row.label.slice(0, 40), date: row.date.value }));
  await updateContact(contactId, (contact) => ({
    ...contact,
    birthday,
    importantDates: importantDates.length ? importantDates : undefined,
  }), "生日与重要日子已保存。");
}

$("#contact-dialog-content").addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.matches("[data-add-date-row]")) {
    const list = $("#contact-dialog-content [data-date-list]");
    if (!list) return;
    const rowId = `date-${crypto.randomUUID()}`;
    const row = element("div", { className: "important-date-row", dataset: { dateRow: rowId } }, [
      element("input", { className: "date-input date-label-input", dataset: { dateLabel: "" }, attributes: { maxlength: "40", placeholder: "名称，如 结婚纪念日", "aria-label": "日子名称" } }),
      element("input", { className: "date-input date-value-input", dataset: { dateValue: "" }, attributes: { maxlength: "10", placeholder: "如 10-01", "aria-label": "日期" } }),
      element("button", { className: "date-remove", type: "button", text: "×", dataset: { removeDateRow: rowId }, attributes: { "aria-label": "删除这一行" } }),
    ]);
    list.append(row);
    $("[data-date-label]", row).focus();
    const saveButton = $("#contact-dialog-content [data-save-dates]");
    if (saveButton) saveButton.disabled = false;
    return;
  }
  const removeButton = target.closest("[data-remove-date-row]");
  if (removeButton) {
    removeButton.closest("[data-date-row]")?.remove();
    const saveButton = $("#contact-dialog-content [data-save-dates]");
    const contact = state.contacts.find((item) => item.id === saveButton?.dataset.saveDates);
    if (saveButton && contact) saveButton.disabled = !collectDatesEdits(contact.id).changed;
    return;
  }
  if (target.matches("[data-save-dates]")) {
    await saveContactDates(target.dataset.saveDates);
  }
});

$("#import-file").addEventListener("change", (event) => handleImportFile(event.target.files?.[0]));
$("#commit-import").addEventListener("click", commitImport);
$("#weflow-preview").addEventListener("click", handleWeFlowPreview);
$("#import-dialog").addEventListener("close", resetImportSession);

const fileDrop = $("#file-drop");
["dragenter", "dragover"].forEach((type) => fileDrop.addEventListener(type, (event) => {
  event.preventDefault();
  fileDrop.classList.add("is-dragging");
}));
["dragleave", "drop"].forEach((type) => fileDrop.addEventListener(type, (event) => {
  event.preventDefault();
  fileDrop.classList.remove("is-dragging");
}));
fileDrop.addEventListener("drop", (event) => handleImportFile(event.dataTransfer?.files?.[0]));

$("#tag-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await createAndPersistCustomTag({
    input: $("#new-tag-name"),
    error: $("#tag-form-error"),
    form: event.currentTarget,
  });
});

$("#bulk-tag-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await createAndPersistCustomTag({
    input: $("#bulk-new-tag-name"),
    error: $("#bulk-tag-form-error"),
    form: event.currentTarget,
    selectForBatch: true,
  });
});

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const inactive = Number($("#inactive-days-input").value);
  const cadence = Number($("#cadence-days-input").value);
  if (!Number.isFinite(inactive) || inactive < 7 || inactive > 365 || !Number.isFinite(cadence) || cadence < 7 || cadence > 365) {
    showToast("节律天数必须在 7 到 365 之间。", "error");
    return;
  }
  const candidate = cloneState();
  candidate.settings.inactiveAfterDays = inactive;
  candidate.settings.defaultCadenceDays = cadence;
  candidate.contacts = candidate.contacts.map((contact) => contact.cadenceDays ? contact : { ...contact, cadenceDays: cadence });
  if (await commitCandidate(candidate, "节律设置已保存。")) {
    $("#settings-dialog").close();
    renderAll();
  }
});

$("#export-backup").addEventListener("click", exportBackup);
$("#export-csv").addEventListener("click", exportLedgerCsv);

$("#create-disk-backup").addEventListener("click", async () => {
  const button = $("#create-disk-backup");
  button.disabled = true;
  button.textContent = "正在校验并备份…";
  try {
    const result = await createDiskBackup();
    authority.storage = result.storage;
    renderStorageDetails();
    const cleanupNotice = result.warnings?.length ? `；${result.warnings.join("；")}` : "";
    showToast(`本机数据库快照已创建：${result.backup.filename}${cleanupNotice}`, result.warnings?.length ? "error" : "success");
  } catch (error) {
    showToast(`本机数据库快照创建失败：${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "立即创建本机快照";
  }
});

$("#backup-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = parseBackup(await file.text());
    if (parsed.error) {
      showToast(parsed.error, "error");
      return;
    }
    requestConfirmation({
      title: "恢复这份本地备份？",
      copy: `将用备份中的 ${parsed.state.contacts.length} 位联系人替换当前数据。这个操作不会上传文件。`,
      actionLabel: "恢复备份",
      onConfirm: async () => {
        if (await commitCandidate(parsed.state, "本地备份已恢复。", { destructive: true })) {
          invalidateBatchUndoForStructuralChange();
          clearContactSelection();
          bulkTagId = "";
          currentPage = 1;
          closeConfirmation();
          $("#data-dialog").close();
          renderAll();
        }
      },
    });
  } catch (error) {
    showToast(`无法读取备份：${error.message}`, "error");
  } finally {
    event.target.value = "";
  }
});

$("#restore-demo").addEventListener("click", () => {
  requestConfirmation({
    title: "恢复演示数据？",
    copy: "当前联系人和标签会被演示数据替换。需要保留时，请先导出本地备份。",
    actionLabel: "恢复演示数据",
    onConfirm: async () => {
      if (await commitCandidate(createDemoState(), "演示数据已恢复。", { destructive: true })) {
        invalidateBatchUndoForStructuralChange();
        clearContactSelection();
        bulkTagId = "";
        currentPage = 1;
        closeConfirmation();
        $("#data-dialog").close();
        renderAll();
      }
    },
  });
});

$("#clear-data").addEventListener("click", () => {
  requestConfirmation({
    title: "清空当前本机数据？",
    copy: "联系人、标签和提醒状态会从正式 SQLite 状态中清空；已有滚动快照和已导出的 JSON 不会被删除。",
    actionLabel: "清空数据",
    onConfirm: async () => {
      const blank = createDemoState();
      const candidate = { ...blank, dataMode: "empty", contacts: [], tags: [] };
      if (await commitCandidate(candidate, "当前本机数据已清空。", { destructive: true })) {
        invalidateBatchUndoForStructuralChange();
        clearContactSelection();
        bulkTagId = "";
        currentPage = 1;
        closeConfirmation();
        $("#data-dialog").close();
        renderAll();
      }
    },
  });
});

$("#confirm-cancel").addEventListener("click", cancelConfirmation);
$("#confirm-action").addEventListener("click", () => pendingConfirmation?.onConfirm?.());
$("#confirm-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelConfirmation();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("#search-input").focus();
    return;
  }
  if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  const alreadyTyping = target instanceof Element
    && (target.closest("input, textarea, select") || target.closest("dialog") || target.isContentEditable);
  if (alreadyTyping) return;
  event.preventDefault();
  $("#search-input").focus();
});

window.addEventListener("storage", async (event) => {
  if (event.key !== STORAGE_KEY) return;
  await hydrateAuthoritativeState({ announceChange: true });
});

window.addEventListener("focus", () => {
  if (!authority.ready) void hydrateAuthoritativeState();
});

window.addEventListener("online", () => {
  if (!authority.ready) void hydrateAuthoritativeState();
});

initVisualTheme({ documentRoot: document, storage: window.localStorage });
initTextScale({ documentRoot: document, storage: window.localStorage });
renderAll();
void hydrateContactSourceCatalog();
if (initialLoad.error) {
  window.setTimeout(() => showToast(`${initialLoad.error} 正在改从本机数据库恢复。`, "error"), 200);
}
hydrateAuthoritativeState();
