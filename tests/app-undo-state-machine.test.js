import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildBatchTagCandidate,
  buildInverseBatchTagCandidate,
  createBatchUndoRecord,
  isBatchUndoExpired,
} from "../src/batch-undo.js";
import { reconcileContactSelection } from "../src/contact-selection.js";
import { createDemoState } from "../src/data.js";
import { LocalApiError } from "../src/local-api.js";
import { saveState, validateState } from "../src/storage.js";

// 该夹具只执行 app.js 中原样提取的撤销状态机函数；不需要引入浏览器或 DOM 第三方依赖。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appSource = await readFile(resolve(projectRoot, "src", "app.js"), "utf8");

function functionBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `找不到 app.js 函数：${startMarker}`);
  assert.notEqual(end, -1, `找不到 app.js 函数边界：${endMarker}`);
  return source.slice(start, end);
}

const appFunctions = [
  functionBlock(appSource, "function showToast(", "\nfunction renderBatchUndo("),
  functionBlock(appSource, "function renderBatchUndo(", "\nfunction clearBatchUndo("),
  functionBlock(appSource, "function clearBatchUndo(", "\nfunction scheduleBatchUndoExpiry("),
  functionBlock(appSource, "function scheduleBatchUndoExpiry(", "\nfunction setBatchUndo("),
  functionBlock(appSource, "function setBatchUndo(", "\nfunction invalidateBatchUndoForStructuralChange("),
  functionBlock(appSource, "function stateIdentity(", "\nasync function commitCandidate("),
  functionBlock(appSource, "async function hydrateAuthoritativeState(", "\nfunction currentDerivedContacts("),
  functionBlock(appSource, "async function undoLastBatchTagAction(", "\nfunction makeSystemChips("),
].join("\n");

const confirmationFunctions = [
  functionBlock(appSource, "function renderBatchUndo(", "\nfunction clearBatchUndo("),
  functionBlock(appSource, "function clearBatchUndo(", "\nfunction scheduleBatchUndoExpiry("),
  functionBlock(appSource, "function scheduleBatchUndoExpiry(", "\nfunction setBatchUndo("),
  functionBlock(appSource, "function setBatchUndo(", "\nfunction invalidateBatchUndoForStructuralChange("),
  functionBlock(appSource, "async function applyBatchTag(", "\nasync function undoLastBatchTagAction("),
  functionBlock(appSource, "function stateIdentity(", "\nasync function commitCandidate("),
  functionBlock(appSource, "function requestConfirmation(", "\nfunction setConfirmationBusy("),
  functionBlock(appSource, "function setConfirmationBusy(", "\nfunction cancelConfirmation("),
  functionBlock(appSource, "function cancelConfirmation(", "\nfunction requestCacheMigrationChoice("),
  functionBlock(appSource, "function closeConfirmation(", "\nfunction deleteTag("),
].join("\n");

const authorityFunctions = [
  functionBlock(appSource, "function showToast(", "\nfunction renderBatchUndo("),
  functionBlock(appSource, "function renderBatchUndo(", "\nfunction clearBatchUndo("),
  functionBlock(appSource, "function clearBatchUndo(", "\nfunction scheduleBatchUndoExpiry("),
  functionBlock(appSource, "function scheduleBatchUndoExpiry(", "\nfunction setBatchUndo("),
  functionBlock(appSource, "function setBatchUndo(", "\nfunction invalidateBatchUndoForStructuralChange("),
  functionBlock(appSource, "function stateIdentity(", "\nfunction currentDerivedContacts("),
].join("\n");

const renderTagFilterFunction = functionBlock(
  appSource,
  "function renderTagFilter(",
  "\nasync function applyBatchTag(",
);

const hydrationRestoreFunctions = [
  functionBlock(appSource, "function renderBatchUndo(", "\nfunction clearBatchUndo("),
  functionBlock(appSource, "function clearBatchUndo(", "\nfunction scheduleBatchUndoExpiry("),
  functionBlock(appSource, "function scheduleBatchUndoExpiry(", "\nfunction setBatchUndo("),
  functionBlock(appSource, "function setBatchUndo(", "\nfunction invalidateBatchUndoForStructuralChange("),
  functionBlock(appSource, "function stateIdentity(", "\nasync function commitCandidate("),
  functionBlock(appSource, "async function hydrateAuthoritativeState(", "\nfunction currentDerivedContacts("),
  functionBlock(appSource, "function renderAll(", "\nfunction openDialog("),
].join("\n");

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.fail(message);
}

function makeNode({ open = false } = {}) {
  const classes = new Set();
  return {
    open,
    hidden: true,
    textContent: "",
    disabled: false,
    checked: false,
    indeterminate: false,
    value: "",
    dataset: {},
    children: [],
    attributes: new Map(),
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    replaceChildren(...children) {
      this.children = children;
    },
    append(...children) {
      this.children.push(...children);
    },
    toggleAttribute(name, force) {
      if (force) this.attributes.set(name, "");
      else this.attributes.delete(name);
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    focus() {
      this.focused = true;
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  };
}

function createDomFixture() {
  const nodes = new Map([
    ["#toast", makeNode()],
    ["#app-status", makeNode()],
    ["#batch-undo-panel", makeNode()],
    ["#batch-undo-message", makeNode()],
    ["#batch-undo-action", makeNode()],
    ["#batch-write-status", makeNode()],
    ["#batch-page-count", makeNode()],
    ["#batch-selected-count", makeNode()],
    ["#select-page-contacts", makeNode()],
    ["#clear-contact-selection", makeNode()],
    ["#select-page-checkbox", makeNode()],
    ["#batch-step-tag", makeNode()],
    ["#batch-step-contacts", makeNode()],
    ["#batch-step-apply", makeNode()],
    ["#bulk-tag-select", makeNode()],
    ["#tag-filter", makeNode()],
    ["#quick-bulk-tag-list", makeNode()],
    ["#batch-add-tag", makeNode()],
    ["#batch-remove-tag", makeNode()],
    ["#contact-dialog", makeNode()],
    ["#import-dialog", makeNode()],
    ["#confirm-title", makeNode()],
    ["#confirm-copy", makeNode()],
    ["#confirm-action", makeNode()],
    ["#confirm-cancel", makeNode()],
    ["#confirm-dialog", makeNode()],
  ]);
  const document = { activeElement: null, body: makeNode() };
  nodes.forEach((node) => {
    const focus = node.focus.bind(node);
    node.focus = (...args) => {
      focus(...args);
      document.activeElement = node;
    };
  });
  nodes.get("#batch-undo-panel").contains = (node) => node === nodes.get("#batch-undo-panel")
    || node === nodes.get("#batch-undo-action")
    || node === nodes.get("#batch-undo-message");
  let nextTimerId = 1;
  const timers = new Map();
  return {
    nodes,
    document,
    runTimer(id) {
      const timer = timers.get(id);
      assert.ok(timer, `夹具缺少定时器 ${id}`);
      timers.delete(id);
      timer.callback();
    },
    timerCount() {
      return timers.size;
    },
    window: {
      localStorage: {},
      setTimeout(callback, delay) {
        const id = nextTimerId;
        nextTimerId += 1;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    $(selector) {
      const node = nodes.get(selector);
      assert.ok(node, `夹具缺少选择器 ${selector}`);
      return node;
    },
  };
}

function makeState(changeId = "change-local", customTagIds = ["tag-focus"]) {
  const state = createDemoState(new Date("2026-08-23T12:00:00+08:00"));
  state.changeId = changeId;
  state.revision = changeId === "change-local" ? 1 : 2;
  state.tags = [{ id: "tag-focus", name: "重点维系", color: "#765" }];
  state.contacts = [{
    id: "contact-1",
    name: "联系人 1",
    maintenanceIntent: "maintain",
    cadenceDays: 30,
    lastMessageAt: null,
    lastMaintainedAt: null,
    snoozedUntil: null,
    lastMessageText: "",
    customTagIds,
  }];
  return state;
}

function makeUndoRecord(overrides = {}) {
  return {
    id: "undo-1",
    action: "add",
    tagId: "tag-focus",
    tagName: "重点维系",
    contactIds: ["contact-1"],
    scopeLabel: "全部筛选结果",
    changedCount: 1,
    expiresAt: Date.now() + 45_000,
    status: "available",
    timerId: 99,
    lastError: null,
    expiredWhileInFlight: false,
    ...overrides,
  };
}

function makePendingUndo(stateChangeId = "change-local", overrides = {}) {
  const now = Date.now();
  return {
    id: "undo-server",
    action: "add",
    tagId: "tag-focus",
    tagName: "重点维系",
    scopeLabel: "全部筛选结果",
    changedCount: 1,
    createdAt: now,
    expiresAt: now + 45_000,
    stateChangeId,
    ...overrides,
  };
}

function authoritativeEnvelope(state, pendingUndo = null, overrides = {}) {
  return {
    state,
    pendingUndo,
    serverNow: Date.now(),
    storage: { available: true },
    ...overrides,
  };
}

function createAppUndoHarness({
  state = makeState(),
  record = null,
  loadAuthoritativeState = async () => authoritativeEnvelope(state),
  commitCandidate = async () => true,
  consumeAuthoritativeBatchUndo = null,
  saveState: saveBrowserState = () => ({ ok: true, error: null }),
} = {}) {
  const fixture = createDomFixture();
  const consumeUndo = consumeAuthoritativeBatchUndo || (async ({ expectedChangeId }) => {
    const inverse = buildInverseBatchTagCandidate(state, record || makeUndoRecord());
    const saved = inverse.ok && await commitCandidate(inverse.candidate, "", { expectedIdentity: expectedChangeId });
    if (!saved) throw new LocalApiError("模拟撤销保存失败", { status: 422, code: "INVALID_STATE" });
    return authoritativeEnvelope(inverse.candidate, null, {
      undone: { id: record?.id || "undo-1", changedCount: inverse.changedCount },
    });
  });
  const execute = new Function("dependencies", `
    let state = dependencies.state;
    let lastBatchUndo = dependencies.record;
    let toastTimer = null;
    let authorityRequestSequence = 0;
    let authorityHydrationFlight = null;
    let authority = { ready: true, storage: null, error: null };
    const $ = dependencies.$;
    const document = dependencies.document;
    const window = dependencies.window;
    const element = dependencies.element;
    const announce = dependencies.announce;
    const initialLoad = { state: null };
    const createDemoState = dependencies.createDemoState;
    const requestCacheMigrationChoice = async () => false;
    const saveAuthoritativeState = dependencies.saveAuthoritativeState;
    const loadAuthoritativeState = dependencies.loadAuthoritativeState;
    const saveState = dependencies.saveState;
    const validateState = dependencies.validateState;
    const LocalApiError = dependencies.LocalApiError;
    const MAX_CONTACTS = dependencies.MAX_CONTACTS;
    const consumeAuthoritativeBatchUndo = dependencies.consumeAuthoritativeBatchUndo;
    const clearContactSelection = dependencies.clearContactSelection;
    const renderAll = dependencies.renderAll;
    const renderContactDialog = dependencies.renderContactDialog;
    const renderImportResult = dependencies.renderImportResult;
    const isBatchUndoExpired = dependencies.isBatchUndoExpired;
    const buildInverseBatchTagCandidate = dependencies.buildInverseBatchTagCandidate;
    const commitCandidate = dependencies.commitCandidate;
    ${appFunctions}
    return {
      showToast,
      setBatchUndo,
      renderBatchUndo,
      hydrateAuthoritativeState,
      undoLastBatchTagAction,
      getRecord: () => lastBatchUndo,
      setRecord: (value) => { lastBatchUndo = value; },
      getState: () => state,
      setState: (value) => { state = value; },
      getAuthority: () => authority,
    };
  `);

  const app = execute({
    state,
    record,
    $: fixture.$,
    document: fixture.document,
    window: fixture.window,
    element: (tagName, options = {}) => ({ tagName, ...options }),
    announce: (message) => { fixture.$("#app-status").textContent = message; },
    createDemoState,
    saveAuthoritativeState: async () => { throw new Error("本测试不应初始化远端状态"); },
    loadAuthoritativeState,
    saveState: saveBrowserState,
    renderAll: () => {},
    renderContactDialog: () => {},
    renderImportResult: () => {},
    isBatchUndoExpired,
    commitCandidate,
    consumeAuthoritativeBatchUndo: consumeUndo,
    clearContactSelection: () => {},
    validateState,
    LocalApiError,
    MAX_CONTACTS: 3000,
  });
  return { app, fixture };
}

function createBatchConfirmationHarness({
  state = makeState("change-local", []),
  pageContacts = null,
  selectedContactIds = null,
  commitCandidate = async () => true,
  applyAuthoritativeBatchTag = null,
  hydrateAuthoritativeState = async () => true,
  authority = { ready: true, storage: null, error: null },
  showToast = () => {},
  onAnnounce = null,
  saveState: saveBrowserState = () => ({ ok: true, error: null }),
} = {}) {
  const fixture = createDomFixture();
  const applyBatchCommand = applyAuthoritativeBatchTag || (async (request) => {
    const preview = buildBatchTagCandidate(state, request);
    const saved = preview.ok && await commitCandidate(preview.candidate, "", { expectedIdentity: request.expectedChangeId });
    if (!saved) throw new LocalApiError("模拟批量保存失败", { status: 422, code: "INVALID_STATE" });
    const nextState = { ...preview.candidate, changeId: "change-batch" };
    return authoritativeEnvelope(nextState, makePendingUndo(nextState.changeId, {
      action: request.action,
      tagId: request.tagId,
      changedCount: preview.changedCount,
    }), {
      batch: { targetCount: request.contactIds.length, changedCount: preview.changedCount },
    });
  });
  const execute = new Function("dependencies", `
    let state = dependencies.state;
    let bulkTagId = "tag-focus";
    let selectedContactIds = new Set(dependencies.selectedContactIds);
    let pendingConfirmation = null;
    let lastBatchUndo = null;
    let authorityRequestSequence = 0;
    let authority = dependencies.authority;
    const $ = dependencies.$;
    const document = dependencies.document;
    const window = dependencies.window;
    const getCurrentLedgerPageContacts = dependencies.getCurrentLedgerPageContacts;
    const reconcileContactSelection = dependencies.reconcileContactSelection;
    const selectedContactsOnCurrentPage = (pageContacts = getCurrentLedgerPageContacts()) => {
      selectedContactIds = reconcileContactSelection(selectedContactIds, pageContacts.map((contact) => contact.id));
      return pageContacts.filter((contact) => selectedContactIds.has(contact.id));
    };
    const clearContactSelection = () => {
      const changed = selectedContactIds.size > 0;
      selectedContactIds = new Set();
      dependencies.onSelectionCleared?.();
      return changed;
    };
    const renderBatchSelectionState = dependencies.renderBatchSelectionState;
    const renderLedger = dependencies.renderLedger;
    const visibleName = dependencies.visibleName;
    const getCurrentFilterSummary = dependencies.getCurrentFilterSummary;
    const showToast = dependencies.showToast;
    const announce = dependencies.announce;
    const commitCandidate = dependencies.commitCandidate;
    const buildBatchTagCandidate = dependencies.buildBatchTagCandidate;
    const applyAuthoritativeBatchTag = dependencies.applyAuthoritativeBatchTag;
    const saveState = dependencies.saveState;
    const validateState = dependencies.validateState;
    const LocalApiError = dependencies.LocalApiError;
    const MAX_CONTACTS = dependencies.MAX_CONTACTS;
    const MAX_BATCH_SELECTION = dependencies.MAX_BATCH_SELECTION;
    const hydrateAuthoritativeState = async (options) => {
      const result = await dependencies.hydrateAuthoritativeState(options);
      if (result && typeof result === "object") {
        if (result.state) state = result.state;
        if (Object.hasOwn(result, "pendingUndo")) syncBatchUndoFromAuthority(result.pendingUndo, result.serverNow);
        return result.ok !== false;
      }
      return result;
    };
    const renderAll = dependencies.renderAll;
    ${confirmationFunctions}
    return {
      applyBatchTag,
      cancelConfirmation,
      getPendingConfirmation: () => pendingConfirmation,
      getLastBatchUndo: () => lastBatchUndo,
      getState: () => state,
      setState: (value) => { state = value; },
      getSelectedContactIds: () => [...selectedContactIds],
      setSelectedContactIds: (value) => { selectedContactIds = new Set(value); },
    };
  `);
  const currentPageContacts = pageContacts || state.contacts;
  const initialSelection = selectedContactIds || currentPageContacts.map((contact) => contact.id);
  const app = execute({
    state,
    $: fixture.$,
    document: fixture.document,
    getCurrentLedgerPageContacts: () => currentPageContacts,
    selectedContactIds: initialSelection,
    reconcileContactSelection,
    onSelectionCleared: () => {},
    renderBatchSelectionState: () => {},
    renderLedger: () => {},
    visibleName: (contact) => contact.name,
    getCurrentFilterSummary: () => "全部联系人",
    authority,
    showToast,
    announce: (message) => {
      onAnnounce?.(message, fixture.document.activeElement);
      fixture.$("#app-status").textContent = message;
    },
    window: fixture.window,
    commitCandidate,
    buildBatchTagCandidate,
    applyAuthoritativeBatchTag: applyBatchCommand,
    hydrateAuthoritativeState,
    saveState: saveBrowserState,
    validateState,
    LocalApiError,
    MAX_CONTACTS: 3000,
    MAX_BATCH_SELECTION: 50,
    renderAll: () => {},
  });
  return { app, fixture };
}

function createTagFilterHarness({ authorityReady = false } = {}) {
  const fixture = createDomFixture();
  const state = makeState("change-c1", ["tag-focus"]);
  const execute = new Function("dependencies", `
    const state = dependencies.state;
    const filters = { tagId: "all" };
    let bulkTagId = "tag-focus";
    const authority = { ready: dependencies.authorityReady };
    const $ = dependencies.$;
    const element = dependencies.element;
    let selectedContactIds = new Set(["contact-1"]);
    const getCurrentLedgerPageContacts = dependencies.getCurrentLedgerPageContacts;
    const selectedContactsOnCurrentPage = (pageContacts = getCurrentLedgerPageContacts()) => pageContacts
      .filter((contact) => selectedContactIds.has(contact.id));
    const clearContactSelection = () => { selectedContactIds = new Set(); };
    const MAX_BATCH_SELECTION = dependencies.MAX_BATCH_SELECTION;
    const renderBatchSelectionState = () => dependencies.renderBatchSelectionState({ state, authority, bulkTagId, selectedContactIds });
    ${renderTagFilterFunction}
    return {
      renderTagFilter,
      setAuthorityReady: (ready) => { authority.ready = ready; },
    };
  `);
  const app = execute({
    state,
    authorityReady,
    $: fixture.$,
    element: (tagName, options = {}) => ({ tagName, ...options }),
    getCurrentLedgerPageContacts: () => state.contacts,
    MAX_BATCH_SELECTION: 50,
    renderBatchSelectionState: ({ state: currentState, authority, bulkTagId, selectedContactIds }) => {
      const tag = currentState.tags.find((item) => item.id === bulkTagId);
      const selected = currentState.contacts.filter((contact) => selectedContactIds.has(contact.id));
      const canSubmit = authority.ready && Boolean(tag) && selected.length > 0;
      fixture.$("#batch-add-tag").disabled = !canSubmit
        || !selected.some((contact) => !contact.customTagIds.includes(tag.id));
      fixture.$("#batch-remove-tag").disabled = !canSubmit
        || !selected.some((contact) => contact.customTagIds.includes(tag.id));
    },
  });
  return { app, fixture };
}

function createAuthorityHarness({
  state = makeState(),
  record = null,
  authorityReady = true,
  loadAuthoritativeState = async () => authoritativeEnvelope(state),
  saveAuthoritativeState = async (candidate) => authoritativeEnvelope(candidate),
  saveState: saveBrowserState = () => ({ ok: true, error: null }),
  onAnnounce = null,
} = {}) {
  const fixture = createDomFixture();
  const announcements = [];
  const execute = new Function("dependencies", `
    let state = dependencies.state;
    let lastBatchUndo = dependencies.record;
    let toastTimer = null;
    let authorityRequestSequence = 0;
    let authorityHydrationFlight = null;
    let authority = { ready: dependencies.authorityReady, storage: null, error: null };
    const $ = dependencies.$;
    const document = dependencies.document;
    const window = dependencies.window;
    const element = dependencies.element;
    const announce = dependencies.announce;
    const initialLoad = { state: null };
    const createDemoState = dependencies.createDemoState;
    const requestCacheMigrationChoice = async () => false;
    const saveAuthoritativeState = dependencies.saveAuthoritativeState;
    const loadAuthoritativeState = dependencies.loadAuthoritativeState;
    const saveState = dependencies.saveState;
    const validateState = dependencies.validateState;
    const LocalApiError = dependencies.LocalApiError;
    const MAX_CONTACTS = dependencies.MAX_CONTACTS;
    const clearContactSelection = dependencies.clearContactSelection;
    const renderAll = dependencies.renderAll;
    const renderStorageDetails = dependencies.renderStorageDetails;
    const renderContactDialog = dependencies.renderContactDialog;
    const renderImportResult = dependencies.renderImportResult;
    ${authorityFunctions}
    return {
      commitCandidate,
      hydrateAuthoritativeState,
      clearBatchUndo,
      renderBatchUndo,
      setBatchUndo,
      getRecord: () => lastBatchUndo,
      setRecord: (value) => { lastBatchUndo = value; },
      getState: () => state,
      setState: (value) => { state = value; },
      getAuthority: () => authority,
    };
  `);

  const app = execute({
    state,
    record,
    authorityReady,
    $: fixture.$,
    document: fixture.document,
    window: fixture.window,
    element: (tagName, options = {}) => ({ tagName, ...options }),
    announce: (message) => {
      onAnnounce?.(message, fixture.document.activeElement);
      announcements.push(message);
      fixture.$("#app-status").textContent = message;
    },
    createDemoState,
    saveAuthoritativeState,
    loadAuthoritativeState,
    saveState: saveBrowserState,
    validateState,
    LocalApiError,
    MAX_CONTACTS: 3000,
    clearContactSelection: () => {},
    renderAll: () => {},
    renderStorageDetails: () => {},
    renderContactDialog: () => {},
    renderImportResult: () => {},
  });
  return { app, fixture, announcements };
}

function createHydrationRestoreHarness({ state, payload, authorityReady = false }) {
  const fixture = createDomFixture();
  const renderPasses = [];
  const execute = new Function("dependencies", `
    let state = dependencies.state;
    let lastBatchUndo = null;
    let toastTimer = null;
    let authorityRequestSequence = 0;
    let authorityHydrationFlight = null;
    let authority = { ready: dependencies.authorityReady, storage: null, error: "初始离线" };
    const filters = { hiddenOnly: false };
    const $ = dependencies.$;
    const document = dependencies.document;
    const window = dependencies.window;
    const announce = dependencies.announce;
    const initialLoad = { state: null };
    const createDemoState = dependencies.createDemoState;
    const requestCacheMigrationChoice = async () => false;
    const saveAuthoritativeState = dependencies.saveAuthoritativeState;
    const loadAuthoritativeState = dependencies.loadAuthoritativeState;
    const saveState = dependencies.saveState;
    const MAX_CONTACTS = dependencies.MAX_CONTACTS;
    const clearContactSelection = dependencies.clearContactSelection;
    const currentContactSets = dependencies.currentContactSets;
    const renderHeaderAndStatus = dependencies.renderHeaderAndStatus;
    const renderChronometer = dependencies.noop;
    const renderQueue = dependencies.noop;
    const renderTagFilter = dependencies.noop;
    const renderVisibilityControl = dependencies.noop;
    const renderTable = dependencies.noop;
    const renderSystemLabels = dependencies.noop;
    const renderCustomTags = dependencies.noop;
    const renderStorageDetails = dependencies.noop;
    const renderContactDialog = dependencies.noop;
    const renderImportResult = dependencies.noop;
    const showToast = dependencies.noop;
    ${hydrationRestoreFunctions}
    return {
      hydrateAuthoritativeState,
      getAuthority: () => authority,
      getRecord: () => lastBatchUndo,
    };
  `);

  const app = execute({
    state,
    authorityReady,
    $: fixture.$,
    document: fixture.document,
    window: fixture.window,
    announce: () => {},
    createDemoState,
    saveAuthoritativeState: async () => { throw new Error("恢复测试不应初始化状态"); },
    loadAuthoritativeState: async () => payload,
    saveState: () => ({ ok: true, error: null }),
    MAX_CONTACTS: 3000,
    clearContactSelection: () => {},
    currentContactSets: () => ({ visible: state.contacts, hidden: [] }),
    renderHeaderAndStatus: () => renderPasses.push("renderAll"),
    noop: () => {},
  });
  return { app, fixture, renderPasses };
}

test("跨页权威状态变化时，即使浏览器缓存保存失败也会清除旧撤销面板", async () => {
  const remoteState = makeState("change-remote");
  const record = makeUndoRecord();
  const { app, fixture } = createAppUndoHarness({
    state: makeState("change-local"),
    record,
    loadAuthoritativeState: async () => ({ state: remoteState, storage: { available: true } }),
    // 使用真实 saveState，模拟 localStorage.setItem 拒绝写入而不是只检查源码顺序。
    saveState: (storage, state) => saveState({
      ...storage,
      setItem() { throw new Error("quota denied"); },
    }, state),
  });

  const hydrated = await app.hydrateAuthoritativeState({ announceChange: true });

  assert.equal(hydrated, true);
  assert.equal(app.getState().changeId, "change-remote");
  assert.equal(app.getRecord(), null, "缓存失败不能保留基于旧权威状态的撤销记录");
  assert.equal(fixture.$("#batch-undo-panel").hidden, true);
  assert.match(fixture.$("#toast").children[0].text, /缓存更新失败.*最近一次批量撤销已失效/);
});

test("普通 showToast 不会替换或移除独立的批量撤销面板", () => {
  const { app, fixture } = createAppUndoHarness({ state: makeState() });
  app.setBatchUndo(makeUndoRecord());
  const panel = fixture.$("#batch-undo-panel");
  const originalRecord = app.getRecord();

  app.showToast("普通保存提示");

  assert.equal(app.getRecord(), originalRecord);
  assert.equal(panel.hidden, false);
  assert.equal(fixture.$("#toast").hidden, false);
  assert.equal(fixture.$("#toast").children[0].text, "普通保存提示");
});

test("双击撤销会在第一个 await 前同步进入 in-flight，且只提交一次", async () => {
  let resolveCommit;
  const submitted = [];
  const { app, fixture } = createAppUndoHarness({
    state: makeState(),
    record: makeUndoRecord(),
    commitCandidate: (candidate, message, options) => {
      submitted.push({ candidate, message, options });
      return new Promise((resolve) => { resolveCommit = resolve; });
    },
  });

  const firstClick = app.undoLastBatchTagAction();
  const secondClick = app.undoLastBatchTagAction();

  assert.equal(app.getRecord().status, "in-flight");
  assert.equal(fixture.$("#batch-undo-action").disabled, true);
  assert.equal(submitted.length, 1, "第二次点击必须在第一次网络提交完成前被同步拒绝");
  assert.equal(submitted[0].options.expectedIdentity, "change-local");

  resolveCommit(true);
  await Promise.all([firstClick, secondClick]);
  assert.equal(app.getRecord(), null);
});

test("撤销保存失败后的重试会使用当前 expectedChangeId 与同一服务器撤销 ID", async () => {
  const submitted = [];
  const { app } = createAppUndoHarness({
    state: makeState("change-one", ["tag-focus"]),
    record: makeUndoRecord(),
    consumeAuthoritativeBatchUndo: async (request) => {
      submitted.push(request);
      if (submitted.length === 1) {
        throw new LocalApiError("模拟撤销保存失败", { status: 422, code: "INVALID_STATE" });
      }
      return authoritativeEnvelope(makeState("change-undone", ["tag-other"]), null, {
        undone: { id: request.undoId, changedCount: 1 },
      });
    },
  });

  await app.undoLastBatchTagAction();
  assert.equal(app.getRecord().status, "available", "失败后应恢复为可重试状态");

  // 模拟失败期间另一个页面写入并同步了新的权威状态；重试必须重新读取当前身份。
  app.setState(makeState("change-two", ["tag-focus", "tag-other"]));
  await app.undoLastBatchTagAction();

  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[0], {
    undoId: "undo-1",
    expectedChangeId: "change-one",
    expectedAction: "add",
    expectedTagId: "tag-focus",
  });
  assert.deepEqual(submitted[1], {
    undoId: "undo-1",
    expectedChangeId: "change-two",
    expectedAction: "add",
    expectedTagId: "tag-focus",
  });
  assert.deepEqual(app.getState().contacts[0].customTagIds, ["tag-other"]);
  assert.equal(app.getRecord(), null, "重试成功后撤销记录应清除");
});

test("批量确认普通保存失败后原地保留确认，并可用同一操作重试", async () => {
  const submitted = [];
  const toasts = [];
  const originalState = makeState("change-local", []);
  const { app, fixture } = createBatchConfirmationHarness({
    state: originalState,
    showToast: (message, type) => toasts.push({ message, type }),
    applyAuthoritativeBatchTag: async (request) => {
      submitted.push(request);
      if (submitted.length === 1) {
        throw new LocalApiError("模拟批量保存失败", { status: 422, code: "INVALID_STATE" });
      }
      const nextState = makeState("change-batch", ["tag-focus"]);
      return authoritativeEnvelope(nextState, makePendingUndo(nextState.changeId), {
        batch: { targetCount: 1, changedCount: 1 },
      });
    },
  });

  await app.applyBatchTag("add");
  const originalConfirmation = app.getPendingConfirmation();
  assert.ok(originalConfirmation);
  assert.equal(fixture.$("#confirm-dialog").open, true);

  await originalConfirmation.onConfirm();

  assert.equal(app.getPendingConfirmation(), originalConfirmation, "普通失败必须保留原确认，而不是关闭后丢失重试入口");
  assert.equal(originalConfirmation.busy, false);
  assert.equal(fixture.$("#confirm-dialog").open, true);
  assert.equal(fixture.$("#confirm-action").disabled, false);
  assert.equal(fixture.$("#confirm-cancel").disabled, false);
  assert.equal(fixture.$("#confirm-action").textContent, "确认执行");
  assert.equal(fixture.$("#confirm-action").focused, true);
  assert.deepEqual(app.getState().contacts[0].customTagIds, [], "失败不得直接修改当前权威状态");
  assert.deepEqual(app.getSelectedContactIds(), ["contact-1"], "普通失败必须保留用户勾选，便于原地重试");

  await app.getPendingConfirmation().onConfirm();

  assert.equal(submitted.length, 2);
  assert.equal(app.getPendingConfirmation(), null, "重试成功后才关闭确认框");
  assert.equal(fixture.$("#confirm-dialog").open, false);
  assert.equal(app.getLastBatchUndo().changedCount, 1);
  assert.deepEqual(app.getSelectedContactIds(), [], "保存成功后必须清空已完成的选择");
  assert.equal(fixture.document.activeElement, fixture.$("#batch-undo-action"));
  assert.match(toasts.at(-1).message, /45 秒内撤销.*焦点已移到撤销按钮/);
});

test("批量确认冻结打开瞬间显式勾选的 ID，之后改选或换页也不扩大目标", async () => {
  const state = makeState("change-local", []);
  const template = state.contacts[0];
  state.contacts = ["selected-a", "selected-b", "not-selected"].map((id) => ({
    ...structuredClone(template),
    id,
    name: id,
    customTagIds: [],
  }));
  const pageContacts = [...state.contacts];
  const submitted = [];
  const { app, fixture } = createBatchConfirmationHarness({
    state,
    pageContacts,
    selectedContactIds: ["selected-a", "selected-b"],
    applyAuthoritativeBatchTag: async (request) => {
      submitted.push(request);
      const preview = buildBatchTagCandidate(state, request);
      assert.equal(preview.ok, true);
      const nextState = { ...preview.candidate, changeId: "change-frozen-targets", revision: 2 };
      return authoritativeEnvelope(nextState, makePendingUndo(nextState.changeId, {
        changedCount: preview.changedCount,
      }), { batch: { changedCount: preview.changedCount } });
    },
  });

  await app.applyBatchTag("add");
  assert.match(fixture.$("#confirm-copy").textContent, /已手动勾选 2 人/);
  app.setSelectedContactIds(["not-selected"]);
  pageContacts.splice(0, pageContacts.length, state.contacts[2]);
  await app.getPendingConfirmation().onConfirm();

  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].contactIds, ["selected-a", "selected-b"]);
  assert.equal(submitted[0].scopeLabel, "本页手动勾选 2 人");
  assert.deepEqual(app.getSelectedContactIds(), [], "成功后清空后来改选的集合，避免误操作下一批");
});

test("取消批量确认保留显式联系人选择", async () => {
  const { app, fixture } = createBatchConfirmationHarness({ selectedContactIds: ["contact-1"] });

  await app.applyBatchTag("add");
  assert.equal(fixture.$("#confirm-dialog").open, true);
  app.cancelConfirmation();

  assert.equal(app.getPendingConfirmation(), null);
  assert.equal(fixture.$("#confirm-dialog").open, false);
  assert.deepEqual(app.getSelectedContactIds(), ["contact-1"]);
});

test("批量成功的普通、缓存警告、快照警告最终 Toast 都保留撤销焦点事实", async (t) => {
  const scenarios = [
    {
      name: "普通成功",
      responseOverrides: {},
      saveResult: { ok: true, error: null },
      expectedToast: /加入“重点维系”标签 1 位联系人.*45 秒内撤销.*焦点已移到撤销按钮/,
      expectedType: undefined,
    },
    {
      name: "浏览器缓存警告",
      responseOverrides: {},
      saveResult: { ok: false, error: "quota denied" },
      expectedToast: /浏览器恢复缓存更新失败：quota denied.*45 秒内撤销.*焦点已移到撤销按钮/,
      expectedType: "error",
    },
    {
      name: "自动快照警告",
      responseOverrides: { backupWarning: "快照磁盘忙", backupWarnings: ["旧快照清理失败"] },
      saveResult: { ok: true, error: null },
      expectedToast: /45 秒内撤销.*焦点已移到撤销按钮.*快照提示：快照磁盘忙；旧快照清理失败/,
      expectedType: "error",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const events = [];
      const nextState = makeState(`change-${scenario.name}`, ["tag-focus"]);
      const { app, fixture } = createBatchConfirmationHarness({
        applyAuthoritativeBatchTag: async () => authoritativeEnvelope(
          nextState,
          makePendingUndo(nextState.changeId),
          {
            batch: { targetCount: 1, changedCount: 1 },
            ...scenario.responseOverrides,
          },
        ),
        saveState: () => scenario.saveResult,
        onAnnounce: (message, activeElement) => events.push({ kind: "announce", message, activeElement }),
        showToast: (message, type) => events.push({ kind: "toast", message, type, activeElement: fixture?.document.activeElement }),
      });

      await app.applyBatchTag("add");
      await app.getPendingConfirmation().onConfirm();

      const availabilityAnnouncement = events.find((event) => event.kind === "announce" && /已整理 1 位联系人/.test(event.message));
      const finalToast = events.findLast((event) => event.kind === "toast");
      assert.ok(availabilityAnnouncement, "批量成功必须播报撤销入口可用");
      assert.equal(availabilityAnnouncement.activeElement, fixture.$("#batch-undo-action"), "实际焦点必须先移动，随后才能播报");
      assert.ok(events.indexOf(availabilityAnnouncement) < events.indexOf(finalToast), "撤销可用播报必须先于最终 Toast");
      assert.equal(fixture.document.activeElement, fixture.$("#batch-undo-action"));
      assert.deepEqual(app.getSelectedContactIds(), [], "成功场景都必须清空本次选择");
      assert.match(finalToast.message, scenario.expectedToast);
      assert.equal(finalToast.type, scenario.expectedType);
    });
  }
});

test("批量确认双击在第一个 await 前同步 busy，只提交一次", async () => {
  let resolveCommit;
  const submitted = [];
  const { app, fixture } = createBatchConfirmationHarness({
    commitCandidate: (...args) => {
      submitted.push(args);
      return new Promise((resolve) => { resolveCommit = resolve; });
    },
  });

  await app.applyBatchTag("add");
  const confirmation = app.getPendingConfirmation();
  const firstClick = confirmation.onConfirm();
  const secondClick = confirmation.onConfirm();

  assert.equal(confirmation.busy, true);
  assert.equal(fixture.$("#confirm-action").disabled, true);
  assert.equal(fixture.$("#confirm-cancel").disabled, true);
  assert.equal(fixture.$("#confirm-action").textContent, "正在保存…");
  assert.equal(submitted.length, 1, "第二次确认不得在第一次保存结束前重复提交");

  resolveCommit(false);
  await Promise.all([firstClick, secondClick]);
  assert.equal(confirmation.busy, false);
  assert.equal(fixture.$("#confirm-dialog").open, true, "普通失败仍允许用户重试");
  assert.deepEqual(app.getSelectedContactIds(), ["contact-1"]);
});

test("批量确认提交失败但权威身份已变化时关闭旧确认", async () => {
  const remoteState = makeState("change-from-another-page", []);
  const { app, fixture } = createBatchConfirmationHarness({
    applyAuthoritativeBatchTag: async () => {
      throw new LocalApiError("CAS 冲突", {
        status: 409,
        code: "STATE_CONFLICT",
        details: {
          currentState: remoteState,
          pendingUndo: null,
          serverNow: Date.now(),
        },
      });
    },
  });

  await app.applyBatchTag("add");
  const confirmation = app.getPendingConfirmation();
  await confirmation.onConfirm();

  assert.equal(app.getPendingConfirmation(), null, "CAS 冲突同步了新身份后，旧候选确认必须关闭");
  assert.equal(fixture.$("#confirm-dialog").open, false);
  assert.equal(app.getState().changeId, "change-from-another-page");
});

test("离线时快速整理不会打开确认、提交或创建撤销，并显示权威错误", async (t) => {
  const scenarios = [
    { name: "显示 authority 原始错误", authorityError: "本机数据连接已断开", expected: "本机数据连接已断开" },
    { name: "空错误使用不可写兜底", authorityError: null, expected: "本机数据服务当前不可写，快速整理已停用。" },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const commits = [];
      const toasts = [];
      const { app, fixture } = createBatchConfirmationHarness({
        authority: { ready: false, storage: null, error: scenario.authorityError },
        commitCandidate: async (...args) => {
          commits.push(args);
          return true;
        },
        showToast: (message, type) => toasts.push({ message, type }),
      });

      await app.applyBatchTag("add");

      assert.equal(app.getPendingConfirmation(), null);
      assert.equal(fixture.$("#confirm-dialog").open, false);
      assert.equal(commits.length, 0);
      assert.equal(app.getLastBatchUndo(), null);
      assert.deepEqual(toasts, [{ message: scenario.expected, type: "error" }]);
    });
  }
});

test("renderTagFilter 在 authority 离线时禁用批量按钮，恢复在线后重新启用", () => {
  const { app, fixture } = createTagFilterHarness({ authorityReady: false });

  app.renderTagFilter();
  assert.equal(fixture.$("#batch-add-tag").disabled, true);
  assert.equal(fixture.$("#batch-remove-tag").disabled, true);

  app.setAuthorityReady(true);
  app.renderTagFilter();
  assert.equal(fixture.$("#batch-add-tag").disabled, true, "已含标签的选中联系人无需重复加入");
  assert.equal(fixture.$("#batch-remove-tag").disabled, false);
});

test("并发 H1 与 PUT 都网络失败时，两种完成顺序最终都会关闭写权限", async (t) => {
  for (const completionOrder of ["H1-first", "PUT-first"]) {
    await t.test(completionOrder, async () => {
      const getRequest = deferred();
      const putRequest = deferred();
      const { app } = createAuthorityHarness({
        state: makeState("change-c1"),
        loadAuthoritativeState: () => getRequest.promise,
        saveAuthoritativeState: () => putRequest.promise,
      });

      const hydration = app.hydrateAuthoritativeState();
      const saving = app.commitCandidate(makeState("change-candidate"));
      const getFailure = new LocalApiError("GET 断网", { code: "LOCAL_SERVICE_UNAVAILABLE" });
      const putFailure = new LocalApiError("PUT 断网", { code: "LOCAL_SERVICE_UNAVAILABLE" });

      if (completionOrder === "H1-first") {
        getRequest.reject(getFailure);
        assert.equal(await hydration, false);
        assert.equal(app.getAuthority().ready, true, "旧 GET 失败不应先覆盖仍在途的 PUT");
        putRequest.reject(putFailure);
        assert.equal(await saving, false);
      } else {
        putRequest.reject(putFailure);
        assert.equal(await saving, false);
        assert.equal(app.getAuthority().ready, false, "最新 PUT 网络失败应立即关闭写权限");
        getRequest.reject(getFailure);
        assert.equal(await hydration, false);
      }

      assert.equal(app.getAuthority().ready, false);
      assert.match(app.getAuthority().error, /PUT 断网/);
    });
  }
});

test("旧 GET、旧 PUT 成功和旧 PUT 冲突晚到都不回退新状态或清除新撤销", async (t) => {
  await t.test("旧 GET 成功", async () => {
    const request = deferred();
    const { app } = createAuthorityHarness({
      state: makeState("change-c1"),
      record: makeUndoRecord({ id: "undo-old" }),
      loadAuthoritativeState: () => request.promise,
    });
    const hydration = app.hydrateAuthoritativeState();
    app.setState(makeState("change-c3"));
    app.setBatchUndo(makeUndoRecord({ id: "undo-new" }));

    request.resolve({ state: makeState("change-c2"), storage: { available: true } });
    assert.equal(await hydration, true);
    assert.equal(app.getState().changeId, "change-c3");
    assert.equal(app.getRecord().id, "undo-new");
  });

  await t.test("旧 PUT 成功", async () => {
    const request = deferred();
    const { app } = createAuthorityHarness({
      state: makeState("change-c1"),
      record: makeUndoRecord({ id: "undo-old" }),
      saveAuthoritativeState: () => request.promise,
    });
    const saving = app.commitCandidate(makeState("change-candidate"));
    app.setState(makeState("change-c3"));
    app.setBatchUndo(makeUndoRecord({ id: "undo-new" }));

    request.resolve({ state: makeState("change-c2"), storage: { available: true } });
    assert.equal(await saving, false);
    assert.equal(app.getState().changeId, "change-c3");
    assert.equal(app.getRecord().id, "undo-new");
  });

  await t.test("旧 PUT 冲突", async () => {
    const request = deferred();
    const { app } = createAuthorityHarness({
      state: makeState("change-c1"),
      record: makeUndoRecord({ id: "undo-old" }),
      saveAuthoritativeState: () => request.promise,
    });
    const saving = app.commitCandidate(makeState("change-candidate"));
    app.setState(makeState("change-c3"));
    app.setBatchUndo(makeUndoRecord({ id: "undo-new" }));

    request.reject(new LocalApiError("CAS 冲突", {
      status: 409,
      code: "STATE_CONFLICT",
      details: { currentState: makeState("change-c2") },
    }));
    assert.equal(await saving, false);
    assert.equal(app.getState().changeId, "change-c3");
    assert.equal(app.getRecord().id, "undo-new");
    assert.equal(app.getAuthority().ready, true, "冲突不是服务不可用");
  });
});

test("PUT 错误按 authority 分类：400、422、409 保持 ready，其余传输类错误关闭写权限", async (t) => {
  const cases = [
    { name: "400", error: new LocalApiError("请求错误", { status: 400, code: "LOCAL_API_HTTP_ERROR" }), ready: true },
    { name: "422", error: new LocalApiError("校验错误", { status: 422, code: "VALIDATION_ERROR" }), ready: true },
    {
      name: "409",
      error: new LocalApiError("状态冲突", {
        status: 409,
        code: "STATE_CONFLICT",
        details: { currentState: makeState("change-c1") },
      }),
      ready: true,
    },
    { name: "网络失败", error: new LocalApiError("无法连接", { code: "LOCAL_SERVICE_UNAVAILABLE" }), ready: false },
    { name: "协议失败", error: new LocalApiError("协议错误", { status: 200, code: "LOCAL_API_PROTOCOL_ERROR" }), ready: false },
    { name: "响应读取失败", error: new LocalApiError("读取失败", { status: 200, code: "LOCAL_API_RESPONSE_READ_FAILED" }), ready: false },
    { name: "500", error: new LocalApiError("服务错误", { status: 500, code: "LOCAL_API_HTTP_ERROR" }), ready: false },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { app } = createAuthorityHarness({
        state: makeState("change-c1"),
        saveAuthoritativeState: async () => { throw scenario.error; },
      });
      assert.equal(await app.commitCandidate(makeState("change-candidate")), false);
      assert.equal(app.getAuthority().ready, scenario.ready);
    });
  }
});

test("focus、online 等价的并发 hydrate 调用只产生一个物理 GET", async () => {
  const request = deferred();
  let physicalGetCount = 0;
  const { app } = createAuthorityHarness({
    state: makeState("change-c1"),
    loadAuthoritativeState: () => {
      physicalGetCount += 1;
      return request.promise;
    },
  });

  const focusHydration = app.hydrateAuthoritativeState();
  const onlineHydration = app.hydrateAuthoritativeState();
  const visibilityHydration = app.hydrateAuthoritativeState();
  assert.equal(physicalGetCount, 1);

  request.resolve({ state: makeState("change-c1"), storage: { available: true } });
  assert.deepEqual(await Promise.all([focusHydration, onlineHydration, visibilityHydration]), [true, true, true]);
  assert.equal(physicalGetCount, 1);
});

test("hydration 在途收到多次 storage announce 时只合并一个 follow-up GET", async () => {
  const requests = [];
  const { app } = createAuthorityHarness({
    state: makeState("change-c1"),
    loadAuthoritativeState: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  });

  const initial = app.hydrateAuthoritativeState();
  const storageOne = app.hydrateAuthoritativeState({ announceChange: true });
  const storageTwo = app.hydrateAuthoritativeState({ announceChange: true });
  assert.equal(requests.length, 1);

  requests[0].resolve({ state: makeState("change-c1"), storage: { available: true } });
  await waitFor(() => requests.length === 2, "storage 事件应在首轮 hydration 后补一次 GET");
  requests[1].resolve({ state: makeState("change-c2"), storage: { available: true } });

  assert.deepEqual(await Promise.all([initial, storageOne, storageTwo]), [true, true, true]);
  assert.equal(requests.length, 2, "多次 storage 通知必须合并，不能形成 GET 风暴");
});

test("两轮 hydration 的 C1/C2/C3 组合每个 flight 最多公告一次", async (t) => {
  const scenarios = [
    { name: "H1 吸收 C2，H2 仍是 C2", first: "change-c2", second: "change-c2" },
    { name: "H1 是 C1，H2 吸收 C2", first: "change-c1", second: "change-c2" },
    { name: "H1 吸收 C2，H2 吸收 C3", first: "change-c2", second: "change-c3" },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const requests = [];
      const { app, announcements } = createAuthorityHarness({
        state: makeState("change-c1"),
        loadAuthoritativeState: () => {
          const request = deferred();
          requests.push(request);
          return request.promise;
        },
      });
      const initial = app.hydrateAuthoritativeState();
      const storage = app.hydrateAuthoritativeState({ announceChange: true });
      requests[0].resolve({ state: makeState(scenario.first), storage: { available: true } });
      await waitFor(() => requests.length === 2, "应开始 flight 内合并的第二轮 hydration");
      requests[1].resolve({ state: makeState(scenario.second), storage: { available: true } });
      await Promise.all([initial, storage]);

      const syncNotices = announcements.filter((message) => /本页已同步/.test(message));
      assert.equal(syncNotices.length, 1);
      assert.equal(app.getState().changeId, scenario.second);
    });
  }
});

test("默认 hydrate 的新 changeId 清旧撤销，但不清请求期间替换的新撤销", async (t) => {
  await t.test("清除请求开始时的旧撤销", async () => {
    const { app } = createAuthorityHarness({
      state: makeState("change-c1"),
      record: makeUndoRecord({ id: "undo-old" }),
      loadAuthoritativeState: async () => ({ state: makeState("change-c2"), storage: { available: true } }),
    });

    assert.equal(await app.hydrateAuthoritativeState(), true);
    assert.equal(app.getRecord(), null);
  });

  await t.test("较旧 GET 不覆盖请求期间同步的更新状态与新撤销", async () => {
    const request = deferred();
    const { app } = createAuthorityHarness({
      state: makeState("change-c1"),
      record: makeUndoRecord({ id: "undo-old" }),
      loadAuthoritativeState: () => request.promise,
    });
    const hydration = app.hydrateAuthoritativeState();
    app.setState(makeState("change-c3"));
    app.setBatchUndo(makeUndoRecord({ id: "undo-new", stateChangeId: "change-c3" }));
    request.resolve(authoritativeEnvelope(makeState("change-c2")));

    assert.equal(await hydration, true);
    assert.equal(app.getState().changeId, "change-c3");
    assert.equal(app.getRecord().id, "undo-new");
  });
});

test("hydration 失败后会清理 flight，下一次调用可重新发起并恢复 ready", async () => {
  let callCount = 0;
  const { app } = createAuthorityHarness({
    state: makeState("change-c1"),
    loadAuthoritativeState: async () => {
      callCount += 1;
      if (callCount === 1) throw new LocalApiError("暂时断网", { code: "LOCAL_SERVICE_UNAVAILABLE" });
      return { state: makeState("change-c2"), storage: { available: true } };
    },
  });

  assert.equal(await app.hydrateAuthoritativeState(), false);
  assert.equal(app.getAuthority().ready, false);
  assert.equal(await app.hydrateAuthoritativeState(), true);
  assert.equal(callCount, 2);
  assert.equal(app.getAuthority().ready, true);
  assert.equal(app.getState().changeId, "change-c2");
});

test("离线启动恢复未到期 pending 后，renderAll 以在线状态重新启用撤销入口且不递归", async () => {
  const serverNow = Date.now();
  const recoveredState = makeState("change-recovered-pending", ["tag-focus"]);
  const pendingUndo = makePendingUndo(recoveredState.changeId, {
    id: "40000000-0000-4000-8000-000000000001",
    createdAt: serverNow - 1_000,
    expiresAt: serverNow + 44_000,
  });
  const { app, fixture, renderPasses } = createHydrationRestoreHarness({
    state: recoveredState,
    authorityReady: false,
    payload: authoritativeEnvelope(recoveredState, pendingUndo, { serverNow }),
  });

  assert.equal(await app.hydrateAuthoritativeState(), true);

  assert.equal(app.getAuthority().ready, true);
  assert.equal(app.getRecord().id, pendingUndo.id);
  assert.equal(fixture.$("#batch-undo-panel").hidden, false);
  assert.equal(fixture.$("#batch-undo-action").disabled, false, "authority 恢复后不得保留首次离线渲染的 disabled 状态");
  assert.match(fixture.$("#batch-undo-message").textContent, /刚刚整理了 1 位联系人；还可撤销约 \d+ 秒/);
  assert.doesNotMatch(fixture.$("#batch-undo-message").textContent, /服务暂不可写/);
  assert.deepEqual(renderPasses, ["renderAll"], "一次 hydrate 只应完成一次全量渲染，不能由撤销面板反向递归 renderAll");
  assert.equal(fixture.timerCount(), 1, "恢复 pending 只注册一个到期定时器");
});

test("setBatchUndo 聚焦撤销按钮、播报 45 秒，并在提交中设置 aria-busy", () => {
  const observedAtAnnouncement = [];
  const { app, fixture, announcements } = createAuthorityHarness({
    state: makeState("change-c1"),
    onAnnounce: (message, activeElement) => observedAtAnnouncement.push({ message, activeElement }),
  });
  app.setBatchUndo(makeUndoRecord());

  assert.equal(fixture.document.activeElement, fixture.$("#batch-undo-action"));
  assert.match(announcements.at(-1), /45 秒内撤销.*焦点已移到撤销按钮/);
  assert.equal(observedAtAnnouncement.at(-1).activeElement, fixture.$("#batch-undo-action"), "播报回调观察到的焦点必须已经位于撤销按钮");
  assert.equal(fixture.$("#batch-undo-panel").attributes.has("aria-busy"), false);

  app.getRecord().status = "in-flight";
  app.renderBatchUndo();
  assert.equal(fixture.$("#batch-undo-panel").attributes.get("aria-busy"), "true");
  assert.equal(fixture.$("#batch-undo-action").disabled, true);
});

test("批量撤销自动到期时将面板内焦点返回快速整理标签并播报关闭", () => {
  const { app, fixture, announcements } = createAuthorityHarness({ state: makeState("change-c1") });
  app.setBatchUndo(makeUndoRecord());
  const expiryTimerId = app.getRecord().timerId;
  assert.equal(fixture.document.activeElement, fixture.$("#batch-undo-action"));

  fixture.runTimer(expiryTimerId);

  assert.equal(app.getRecord(), null);
  assert.equal(fixture.$("#batch-undo-panel").hidden, true);
  assert.equal(fixture.document.activeElement, fixture.$("#bulk-tag-select"));
  assert.equal(announcements.at(-1), "最近一次批量操作的撤销入口已关闭。焦点已返回快速整理标签。");
});

test("清除撤销时若焦点位于其他控件，不抢焦点也不播报通用关闭消息", () => {
  const { app, fixture, announcements } = createAuthorityHarness({ state: makeState("change-c1") });
  app.setBatchUndo(makeUndoRecord());
  fixture.$("#confirm-action").focus();
  const announcementCountBeforeClear = announcements.length;

  assert.equal(app.clearBatchUndo(app.getRecord().id), true);

  assert.equal(app.getRecord(), null);
  assert.equal(fixture.document.activeElement, fixture.$("#confirm-action"));
  assert.equal(announcements.length, announcementCountBeforeClear);
  assert.doesNotMatch(announcements.at(-1), /撤销入口已关闭/);
});

test("撤销成功后的最终播报是具体已撤销结果，而不是焦点恢复通用消息", async () => {
  const { app, fixture } = createAppUndoHarness({
    state: makeState("change-c1", ["tag-focus"]),
    commitCandidate: async () => true,
  });
  app.setBatchUndo(makeUndoRecord());
  assert.equal(fixture.document.activeElement, fixture.$("#batch-undo-action"));

  await app.undoLastBatchTagAction();

  assert.equal(app.getRecord(), null);
  assert.equal(fixture.document.activeElement, fixture.$("#bulk-tag-select"));
  assert.match(fixture.$("#app-status").textContent, /^已撤销（全部筛选结果）：为 1 位联系人移除“重点维系”标签。$/);
  assert.doesNotMatch(fixture.$("#app-status").textContent, /撤销入口已关闭/);
});

test("模拟浏览器将禁用按钮焦点回退到 BODY 后，撤销成功会聚焦快速整理标签", async () => {
  const request = deferred();
  const { app, fixture } = createAppUndoHarness({
    state: makeState("change-c1", ["tag-focus"]),
    commitCandidate: () => request.promise,
  });
  app.setBatchUndo(makeUndoRecord());
  const undoing = app.undoLastBatchTagAction();
  assert.equal(app.getRecord().restoreFocusAfterDisable, true);
  fixture.document.activeElement = fixture.document.body;

  request.resolve(true);
  await undoing;

  assert.equal(app.getRecord(), null);
  assert.equal(fixture.document.activeElement, fixture.$("#bulk-tag-select"));
});

test("模拟浏览器 BODY 回退后撤销失败未过期，会把焦点恢复到可重试的撤销按钮", async () => {
  const request = deferred();
  const { app, fixture } = createAppUndoHarness({
    state: makeState("change-c1", ["tag-focus"]),
    commitCandidate: () => request.promise,
  });
  app.setBatchUndo(makeUndoRecord());
  const undoing = app.undoLastBatchTagAction();
  fixture.document.activeElement = fixture.document.body;

  request.resolve(false);
  await undoing;

  assert.equal(app.getRecord().status, "available");
  assert.equal(app.getRecord().restoreFocusAfterDisable, false);
  assert.equal(fixture.document.activeElement, fixture.$("#batch-undo-action"));
});

test("撤销在途时用户主动聚焦其他控件，成功响应不会抢回焦点", async () => {
  const request = deferred();
  const { app, fixture } = createAppUndoHarness({
    state: makeState("change-c1", ["tag-focus"]),
    commitCandidate: () => request.promise,
  });
  app.setBatchUndo(makeUndoRecord());
  const undoing = app.undoLastBatchTagAction();
  fixture.$("#confirm-action").focus();

  request.resolve(true);
  await undoing;

  assert.equal(app.getRecord(), null);
  assert.equal(fixture.document.activeElement, fixture.$("#confirm-action"));
});

test("旧撤销响应晚到不会清除新撤销或移动新撤销按钮焦点", async () => {
  const request = deferred();
  const { app, fixture } = createAppUndoHarness({
    state: makeState("change-c1", ["tag-focus"]),
    consumeAuthoritativeBatchUndo: () => request.promise,
  });
  app.setBatchUndo(makeUndoRecord({ id: "undo-old" }));
  const oldUndoing = app.undoLastBatchTagAction();
  fixture.document.activeElement = fixture.document.body;
  app.setState(makeState("change-c3", ["tag-focus"]));
  app.setBatchUndo(makeUndoRecord({ id: "undo-new", stateChangeId: "change-c3" }));
  assert.equal(fixture.document.activeElement, fixture.$("#batch-undo-action"));

  request.resolve(authoritativeEnvelope(makeState("change-c2", []), null, {
    undone: { id: "undo-old", changedCount: 1 },
  }));
  await oldUndoing;

  assert.equal(app.getState().changeId, "change-c3");
  assert.equal(app.getRecord().id, "undo-new");
  assert.equal(fixture.document.activeElement, fixture.$("#batch-undo-action"));
});

test("批量写入超时后只有 GET 返回同一 operationId 才归因本页并聚焦撤销", async () => {
  let submittedOperationId = null;
  const toasts = [];
  const events = [];
  const confirmedState = makeState("change-confirmed-batch", ["tag-focus"]);
  const { app, fixture } = createBatchConfirmationHarness({
    applyAuthoritativeBatchTag: async (request) => {
      submittedOperationId = request.operationId;
      throw new LocalApiError("批量响应超时", {
        code: "LOCAL_API_TIMEOUT",
        details: { outcomeUnknown: true },
      });
    },
    hydrateAuthoritativeState: async () => authoritativeEnvelope(
      confirmedState,
      makePendingUndo(confirmedState.changeId, {
        id: submittedOperationId,
        action: "add",
        tagId: "tag-focus",
      }),
    ),
    onAnnounce: (message, activeElement) => events.push({ kind: "announce", message, activeElement }),
    showToast: (message, type) => {
      toasts.push({ message, type });
      events.push({ kind: "toast", message, type });
    },
  });

  await app.applyBatchTag("add");
  await app.getPendingConfirmation().onConfirm();

  assert.match(submittedOperationId, /^[0-9a-f-]{36}$/i);
  assert.equal(app.getPendingConfirmation(), null);
  assert.equal(app.getLastBatchUndo().id, submittedOperationId);
  assert.deepEqual(app.getSelectedContactIds(), [], "核对确认本次 operationId 成功后必须清空选择");
  assert.equal(fixture.document.activeElement, fixture.$("#batch-undo-action"));
  const reconciliationAnnouncement = events.find((event) => event.kind === "announce" && /本机数据库核对完成/.test(event.message));
  const finalToastEvent = events.findLast((event) => event.kind === "toast");
  assert.equal(reconciliationAnnouncement.activeElement, fixture.$("#batch-undo-action"), "结果未知但核对成功时也必须先聚焦再播报");
  assert.ok(events.indexOf(reconciliationAnnouncement) < events.indexOf(finalToastEvent));
  assert.match(toasts.at(-1).message, /确认本次快速整理成功.*焦点已移到撤销按钮/);
  assert.equal(toasts.at(-1).type, "success");
});

test("批量写入超时后 GET 若返回另一页面的 operationId，不误报本页成功也不抢焦点", async () => {
  let submittedOperationId = null;
  const otherPageOperationId = "20000000-0000-4000-8000-000000000001";
  const toasts = [];
  const otherPageState = makeState("change-from-other-page", ["tag-focus"]);
  const { app, fixture } = createBatchConfirmationHarness({
    applyAuthoritativeBatchTag: async (request) => {
      submittedOperationId = request.operationId;
      throw new LocalApiError("批量响应中断", {
        code: "LOCAL_API_RESPONSE_READ_FAILED",
        details: { outcomeUnknown: true },
      });
    },
    hydrateAuthoritativeState: async () => authoritativeEnvelope(
      otherPageState,
      makePendingUndo(otherPageState.changeId, {
        id: otherPageOperationId,
        action: "add",
        tagId: "tag-focus",
      }),
    ),
    showToast: (message, type) => toasts.push({ message, type }),
  });

  await app.applyBatchTag("add");
  const focusBeforeSubmit = fixture.document.activeElement;
  await app.getPendingConfirmation().onConfirm();

  assert.notEqual(submittedOperationId, otherPageOperationId);
  assert.equal(app.getPendingConfirmation(), null);
  assert.equal(app.getLastBatchUndo().id, otherPageOperationId, "必须保留 GET 返回的另一页面权威批次");
  assert.equal(fixture.document.activeElement, focusBeforeSubmit, "不能把焦点移到另一页面批次的撤销按钮");
  assert.match(toasts.at(-1).message, /无法把当前变化归因于本页/);
  assert.equal(toasts.at(-1).type, "error");
});

test("撤销进入 reconciling 后重入零请求，到期只等待 GET 权威结果再关闭", async () => {
  const hydration = deferred();
  let undoRequestCount = 0;
  const { app, fixture } = createAppUndoHarness({
    state: makeState("change-before-unknown-undo", ["tag-focus"]),
    loadAuthoritativeState: () => hydration.promise,
    consumeAuthoritativeBatchUndo: async () => {
      undoRequestCount += 1;
      throw new LocalApiError("撤销响应超时", {
        code: "LOCAL_API_TIMEOUT",
        details: { outcomeUnknown: true },
      });
    },
  });
  app.setBatchUndo(makeUndoRecord({ id: "undo-reconciling" }));
  const expiryTimerId = app.getRecord().timerId;

  const firstAttempt = app.undoLastBatchTagAction();
  await waitFor(() => app.getRecord()?.status === "reconciling", "未知写入结果应进入 reconciling");
  assert.equal(undoRequestCount, 1);
  assert.equal(fixture.$("#batch-undo-action").disabled, true);
  assert.equal(fixture.$("#batch-undo-panel").attributes.get("aria-busy"), "true");

  await app.undoLastBatchTagAction();
  assert.equal(undoRequestCount, 1, "reconciling 重入不得再发送撤销请求");

  fixture.runTimer(expiryTimerId);
  assert.equal(app.getRecord().id, "undo-reconciling", "核对中到期不能在 GET 返回前擅自判定结果");
  assert.equal(app.getRecord().expiredWhileInFlight, true);

  hydration.resolve(authoritativeEnvelope(makeState("change-after-unknown-undo", []), null));
  await firstAttempt;
  assert.equal(app.getRecord(), null, "GET 确认 pending 已消费后才关闭撤销入口");
  assert.equal(fixture.$("#batch-undo-panel").hidden, true);
});
