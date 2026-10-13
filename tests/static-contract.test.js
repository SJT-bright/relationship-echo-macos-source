import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// 静态合同：防止危险 DOM API、远程依赖、产品边界文案和并发哨兵发生回退。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [path];
  }));
  return nested.flat();
}

test("客户端源码禁用危险 DOM/执行 API，且只有 local-api 可发 same-origin 请求", async () => {
  const files = (await sourceFiles(join(projectRoot, "src"))).filter((path) => extname(path) === ".js");
  for (const path of files) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(/, path);
    assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\s*\(/, path);
    if (basename(path) !== "local-api.js") assert.doesNotMatch(source, /\bfetch\s*\(/, path);
  }
  const localApi = await readFile(join(projectRoot, "src", "local-api.js"), "utf8");
  assert.match(localApi, /fetch\(path,/);
  assert.doesNotMatch(localApi, /fetch\(\s*["'`]https?:\/\//i);
  for (const endpoint of ["/api/state", "/api/storage/backup", "/api/weflow/preview"]) assert.match(localApi, new RegExp(endpoint));
});

test("HTML 与 CSS 不引用任何远程资源", async () => {
  const html = await readFile(join(projectRoot, "index.html"), "utf8");
  const css = await readFile(join(projectRoot, "styles.css"), "utf8");
  const resourceValues = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(resourceValues.length >= 3);
  for (const value of resourceValues) {
    assert.doesNotMatch(value, /^(?:https?:)?\/\//i);
  }
  assert.doesNotMatch(css, /@import\s+url\(\s*["']?(?:https?:)?\/\//i);
  assert.doesNotMatch(css, /url\(\s*["']?(?:https?:)?\/\//i);
});

test("首页存在四个系统分类和不可删除边界文案", async () => {
  const html = await readFile(join(projectRoot, "index.html"), "utf8");
  for (const label of ["不常联系人", "常联系人", "需要维系", "不需要维系"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /系统标签不能删除/);
  assert.match(html, /自定义标签可以增减/);
});

test("首页明确站内提醒边界和不会自动发送微信消息", async () => {
  const html = await readFile(join(projectRoot, "index.html"), "utf8");
  assert.match(html, /站内节律提醒，不是后台自动发信/);
  assert.match(html, /只在打开网站时计算到期状态/);
  assert.match(html, /关闭应用后不保证通知/);
});

test("多标签页写入以服务器 SQLite CAS 为权威而非浏览器锁", async () => {
  const app = await readFile(join(projectRoot, "src", "app.js"), "utf8");
  const server = await readFile(join(projectRoot, "server.mjs"), "utf8");
  const repository = await readFile(join(projectRoot, "server", "state-repository.mjs"), "utf8");
  assert.match(app, /function stateIdentity\(/);
  assert.match(app, /expectedIdentity = stateIdentity\(state\)/);
  assert.match(app, /saveAuthoritativeState\(candidate, expectedIdentity, \{ destructive \}\)/);
  assert.match(app, /error\.code === "STATE_CONFLICT"/);
  assert.match(server, /repository\.compareAndSwapState\(body\.state/);
  assert.match(server, /expectedChangeId: body\.expectedChangeId \|\| null/);
  assert.match(repository, /current\?\.change_id \|\| null.*expectedChangeId \|\| null/s);
  assert.doesNotMatch(app, /navigator\.locks|withIndexedDbWriteLock/);
});

test("destructive PUT 在预备份前建立写屏障，GET 必须等待到提交或失败后再读取", async () => {
  const server = await readFile(join(projectRoot, "server.mjs"), "utf8");
  const getStart = server.indexOf('if (url.pathname === "/api/state" && method === "GET")');
  const putStart = server.indexOf('if (url.pathname === "/api/state" && method === "PUT")');
  const batchStart = server.indexOf('if (url.pathname === "/api/state/batch-tag"', putStart);
  assert.ok(getStart >= 0 && putStart > getStart && batchStart > putStart);

  const getBlock = server.slice(getStart, putStart);
  const putBlock = server.slice(putStart, batchStart);
  assert.ok(
    getBlock.indexOf("await waitForDestructiveWrites()") < getBlock.indexOf("repository.loadAuthoritativeSnapshot()"),
    "GET 在读权威快照前必须等待所有 destructive 写屏障",
  );

  const addBarrier = putBlock.indexOf("activeDestructiveWrites.add(destructiveBarrier)");
  const preBackup = putBlock.indexOf('await repository.createBackup("before-destructive-change")');
  const commit = putBlock.indexOf("repository.compareAndSwapState(body.state");
  const response = putBlock.indexOf("sendJson(response, 200");
  const release = putBlock.indexOf("activeDestructiveWrites.delete(destructiveBarrier)");
  assert.ok(addBarrier >= 0 && addBarrier < preBackup, "屏障必须在预备份 await 之前发布，避免 GET 读到稳定旧状态");
  assert.ok(preBackup < commit, "destructive 写入必须先完成可恢复快照再提交");
  assert.ok(commit < response && response < release, "屏障只能在写响应形成后由 finally 释放");
  assert.match(putBlock, /finally\s*\{[\s\S]*activeDestructiveWrites\.delete\(destructiveBarrier\);[\s\S]*releaseDestructiveBarrier\(\);/);
});

test("批量撤销使用独立面板和字段级逆操作，不恢复整份旧状态", async () => {
  const html = await readFile(join(projectRoot, "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "src", "app.js"), "utf8");
  const css = await readFile(join(projectRoot, "styles.css"), "utf8");
  const localApi = await readFile(join(projectRoot, "src", "local-api.js"), "utf8");
  const repository = await readFile(join(projectRoot, "server", "state-repository.mjs"), "utf8");

  assert.match(html, /id="feedback-stack"[\s\S]*id="batch-undo-panel"[\s\S]*data-undo-batch="1"[\s\S]*id="toast"/);
  assert.match(css, /\.feedback-stack\s*\{[\s\S]*pointer-events:\s*none;[\s\S]*\}/);
  assert.match(css, /\.feedback-stack\s*>\s*\*\s*\{\s*pointer-events:\s*auto;/);

  const toastStart = app.indexOf("function showToast(");
  const toastEnd = app.indexOf("\nfunction renderBatchUndo(", toastStart);
  const toastBody = app.slice(toastStart, toastEnd);
  assert.doesNotMatch(toastBody, /lastBatchUndo|data-undo-batch|undoBatch/);
  assert.doesNotMatch(app, /lastBatchUndo\?*\.previousState|const previousState = cloneState\(\)/);
  assert.doesNotMatch(app, /buildInverseBatchTagCandidate/);
  assert.match(app, /consumeAuthoritativeBatchUndo\(\{[\s\S]*undoId: record\.id,[\s\S]*expectedChangeId: expectedIdentity/);
  assert.match(localApi, /request\("\/api\/state\/batch-tag\/undo"/);
  assert.match(repository, /CREATE TABLE IF NOT EXISTS pending_batch_undo/);
  assert.match(repository, /buildInverseBatchTagCandidate\(parseStateJson\(current\.state_json\), record\)/);
  assert.match(repository, /writeStateWithinTransaction\(inverse\.candidate, current, nowMs\);[\s\S]*deletePendingUndo\.run\(\);[\s\S]*database\.exec\("COMMIT"\)/);
  assert.match(html, /id="confirm-dialog"[\s\S]*aria-describedby="confirm-copy"/);
  assert.match(html, /id="batch-add-tag"[\s\S]*aria-describedby="batch-write-status"/);

  const hydrateStart = app.indexOf("async function hydrateAuthoritativeState(");
  const hydrateEnd = app.indexOf("\nfunction currentDerivedContacts()", hydrateStart);
  const hydrate = app.slice(hydrateStart, hydrateEnd);
  assert.match(hydrate, /baselineIdentity: stateIdentity\(state\)[\s\S]*undoIdAtStart: lastBatchUndo\?\.id \?\? null/);
  assert.match(hydrate, /responseCanApply[\s\S]*if \(!responseCanApply\) return true/);
  assert.match(hydrate, /syncBatchUndoFromAuthority\(payload\.pendingUndo, payload\.serverNow\)/);

  const commitStart = app.indexOf("async function commitCandidate(");
  const commitEnd = app.indexOf("\nasync function hydrateAuthoritativeState(", commitStart);
  const commit = app.slice(commitStart, commitEnd);
  assert.match(commit, /baselineIdentity: stateIdentity\(state\)[\s\S]*undoIdAtStart: lastBatchUndo\?\.id \?\? null/);
  assert.match(commit, /error\.code === "STATE_CONFLICT"[\s\S]*syncBatchUndoFromAuthority\(latestPendingUndo, latestServerNow\)/);

  const routerStart = app.indexOf('document.addEventListener("click", async (event) => {');
  const routerEnd = app.indexOf("\n});\n\n$$('.filter-group')", routerStart);
  const router = app.slice(routerStart, routerEnd);
  assert.ok(router.indexOf('[data-undo-batch]') < router.indexOf('[data-contact-id]'));
});

test("快速整理固定为三步手动选择流程，并只提交当前页显式勾选 ID", async () => {
  const html = await readFile(join(projectRoot, "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "src", "app.js"), "utf8");
  const server = await readFile(join(projectRoot, "server.mjs"), "utf8");

  for (const id of [
    "batch-organizer",
    "batch-step-tag",
    "bulk-tag-select",
    "show-bulk-tag-form",
    "bulk-new-tag-name",
    "batch-step-contacts",
    "batch-page-count",
    "batch-selected-count",
    "select-page-contacts",
    "clear-contact-selection",
    "batch-step-apply",
    "batch-add-tag",
    "batch-remove-tag",
    "select-page-checkbox",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少三步整理控件 ${id}`);
  }
  assert.doesNotMatch(html, /id="batch-scope-select"/);
  assert.doesNotMatch(html, /<option[^>]*>\s*全部筛选结果\s*<\/option>/);
  assert.doesNotMatch(app, /\bbatchScope\b|currentFilteredLedgerContacts|getBatchScopeLabel/);
  assert.match(html, /id="select-page-checkbox"[^>]*aria-label="全选当前页联系人"/);
  assert.match(app, /const targets = selectedContactsOnCurrentPage\(pageContacts\)/);
  assert.match(app, /const targetContactIds = targets\.slice\(0, MAX_BATCH_SELECTION\)\.map\(\(contact\) => contact\.id\)/);
  assert.match(app, /applyAuthoritativeBatchTag\(\{[\s\S]*contactIds: targetContactIds/);
  assert.match(server, /"src\/contact-selection\.js"/);
});

test("renderAll 末尾恰好重渲染一次撤销面板，renderBatchUndo 不反向递归", async () => {
  const app = await readFile(join(projectRoot, "src", "app.js"), "utf8");
  const renderAllStart = app.indexOf("function renderAll() {");
  const renderAllEnd = app.indexOf("\nfunction openDialog(", renderAllStart);
  const renderBatchStart = app.indexOf("function renderBatchUndo() {");
  const renderBatchEnd = app.indexOf("\nfunction clearBatchUndo(", renderBatchStart);
  assert.ok(renderAllStart >= 0 && renderAllEnd > renderAllStart);
  assert.ok(renderBatchStart >= 0 && renderBatchEnd > renderBatchStart);

  const renderAllBody = app.slice(renderAllStart, renderAllEnd);
  const renderBatchBody = app.slice(renderBatchStart, renderBatchEnd);
  assert.equal((renderAllBody.match(/renderBatchUndo\(\);/g) || []).length, 1, "全量渲染必须且只能刷新一次撤销面板");
  assert.match(renderAllBody, /renderStorageDetails\(\);\s*renderBatchUndo\(\);\s*\}\s*$/);
  assert.doesNotMatch(renderBatchBody, /renderAll\(\)/, "撤销面板渲染不得反向调用全量渲染形成递归");
});

test("联系人分页后可把键盘焦点稳定移到台账标题", async () => {
  const html = await readFile(join(projectRoot, "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "src", "app.js"), "utf8");
  assert.match(html, /<h2 id="contacts-title" tabindex="-1">联系人台账<\/h2>/);
  assert.match(app, /\$\("#contacts-title"\)\.focus\?\.\(\);/);
});

test("3000 人总量、50 人批量、导入记录、文件大小与分页边界固定在共享常量", async () => {
  const limits = await readFile(join(projectRoot, "src", "limits.js"), "utf8");
  const html = await readFile(join(projectRoot, "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "src", "app.js"), "utf8");
  assert.match(limits, /MAX_CONTACTS = 3_000/);
  assert.match(limits, /MAX_BATCH_SELECTION = 50/);
  assert.match(limits, /MAX_IMPORT_RECORDS = 20_000/);
  assert.match(limits, /MAX_IMPORT_FILE_BYTES = 5 \* 1024 \* 1024/);
  assert.match(limits, /DEFAULT_PAGE_SIZE = 50/);
  assert.match(limits, /ALLOWED_PAGE_SIZES = Object\.freeze\(\[25, 50\]\)/);
  assert.match(html, /<option value="25">25<\/option>[\s\S]*<option value="50" selected>50<\/option>/);
  assert.doesNotMatch(html, /<option value="100">100<\/option>/);
  assert.match(app, /ALLOWED_PAGE_SIZES\.includes\(requestedSize\) \? requestedSize : DEFAULT_PAGE_SIZE/);
});

test("满 600 天联系人只在派生视图隐藏，仍可从台账临时查看", async () => {
  const html = await readFile(join(projectRoot, "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "src", "app.js"), "utf8");
  const domain = await readFile(join(projectRoot, "src", "domain.js"), "utf8");

  assert.match(domain, /AUTO_HIDE_AFTER_DAYS = 600/);
  assert.match(domain, /typeof contact\?\.daysSince === "number"[\s\S]*contact\.daysSince >= thresholdDays/);
  assert.match(domain, /return \{ visible, hidden \};/);
  assert.match(html, /id="auto-hidden-rule">满 600 天未互动自动隐藏，数据仍保留/);
  assert.match(html, /id="hidden-contact-filter"[^>]*aria-pressed="false"/);
  assert.match(app, /const \{ visible, hidden \} = currentContactSets\(\);[\s\S]*renderHeaderAndStatus\(visible\);[\s\S]*renderChronometer\(visible\);[\s\S]*renderQueue\(visible\);/);
  assert.match(app, /renderTable\(filters\.hiddenOnly \? hidden : visible, \{ hiddenMode: filters\.hiddenOnly \}\)/);
  assert.match(app, /filters\.hiddenOnly = !filters\.hiddenOnly/);
  assert.doesNotMatch(app, /candidate\.contacts\s*=\s*candidate\.contacts\.filter\([^)]*600/);
});

test("数据弹窗宽度在 dialog 本体，桌面为 900px 的 2×2 无横向滚动布局", async () => {
  const html = await readFile(join(projectRoot, "index.html"), "utf8");
  const css = await readFile(join(projectRoot, "styles.css"), "utf8");
  assert.match(html, /<dialog class="app-dialog dialog-wide" id="data-dialog"/);
  assert.match(css, /#data-dialog\s*\{[^}]*width:\s*min\(900px, calc\(100vw - 32px\)\);[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.data-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[^}]*overflow:\s*hidden;/s);
  assert.match(css, /#data-dialog \.data-grid\s*\{[^}]*grid-template-columns:\s*1fr;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s);
});

test("联系人详情弹窗固定可用高度，并只让详情正文纵向滚动", async () => {
  const [html, css, app] = await Promise.all([
    readFile(join(projectRoot, "index.html"), "utf8"),
    readFile(join(projectRoot, "styles.css"), "utf8"),
    readFile(join(projectRoot, "src", "app.js"), "utf8"),
  ]);

  assert.match(html, /<div class="dialog-frame dialog-contact-frame">[\s\S]*?<div id="contact-dialog-content"><\/div>[\s\S]*?<\/dialog>/);
  assert.match(app, /content\.replaceChildren\(hero, body\);/, "联系人头部与可滚动正文必须是内容容器的直接 flex 子项");

  const frameRule = css.match(/\.dialog-contact-frame\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(frameRule, /\bheight:\s*min\(90dvh,\s*900px\);/, "桌面联系人弹窗必须有明确高度，不能只依赖 max-height");

  const contentRule = css.match(/#contact-dialog-content\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(contentRule, /min-height:\s*0;/);
  assert.match(contentRule, /flex:\s*1 1 auto;/);
  assert.match(contentRule, /display:\s*flex;/);
  assert.match(contentRule, /flex-direction:\s*column;/);
  assert.match(contentRule, /overflow:\s*hidden;/, "中间容器必须裁住外溢，将滚动职责留给正文");

  const heroRule = css.match(/#contact-dialog-content \.contact-hero\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(heroRule, /flex:\s*0 0 auto;/, "联系人头部不能被长正文压缩");

  const bodyRule = css.match(/\.contact-detail-body\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(bodyRule, /min-height:\s*0;/);
  assert.match(bodyRule, /flex:\s*1 1 auto;/);
  assert.match(bodyRule, /overflow-y:\s*auto;/, "联系人详情正文必须是纵向滚动区");
  assert.match(bodyRule, /scroll-padding-block:\s*10px;/, "滚动区必须为 3px outline 与 3px offset 预留焦点安全空间");

  const focusedDescendantRule = css.match(/(?:^|\n)\s*\.contact-detail-body\s+:focus-visible\s*\{([^}]*)\}/m)?.[1] || "";
  assert.match(
    focusedDescendantRule,
    /scroll-margin-block:\s*10px;/,
    "焦点滚动安全必须覆盖任意 :focus-visible 后代，不能退回元素类型清单",
  );

  const mobileStart = css.indexOf("@media (max-width: 520px) {");
  const mobileEnd = css.indexOf("\n@media", mobileStart + 1);
  assert.ok(mobileStart >= 0 && mobileEnd > mobileStart, "应能定位 520px 联系人弹窗移动覆盖");
  const mobileCss = css.slice(mobileStart, mobileEnd);
  assert.match(mobileCss, /\.app-dialog\s*\{[^}]*width:\s*calc\(100vw - 16px\);[^}]*max-height:\s*calc\(100dvh - 16px\);/s);
  assert.match(mobileCss, /\.dialog-contact-frame\s*\{[^}]*width:\s*100%;[^}]*height:\s*calc\(100dvh - 16px\);/s);
});

test("品牌艺术字、标题、正文与数据采用分层字体而非全局楷体合成粗体", async () => {
  const [html, css] = await Promise.all([
    readFile(join(projectRoot, "index.html"), "utf8"),
    readFile(join(projectRoot, "styles.css"), "utf8"),
  ]);
  assert.match(css, /--font-brand:[^;]*"STXingkai"[^;]*"HanziPen SC"/);
  assert.match(css, /--font-display:[^;]*"Songti SC"[^;]*"STSong"/);
  assert.match(css, /--font-body:[^;]*"PingFang SC"[^;]*"Microsoft YaHei UI"/);
  assert.match(css, /--font-data:[^;]*"SF Pro Text"/);
  assert.match(css, /:root\s*\{[^}]*font-family:\s*var\(--font-body\);/s);
  assert.match(css, /body\s*\{[^}]*font-weight:\s*400;[^}]*line-height:\s*1\.55;/s);
  assert.match(css, /h1, h2, h3, h4, legend\s*\{[^}]*font-family:\s*var\(--font-display\);/s);
  assert.match(css, /\.image-theme \.brand-lockup strong[^}]*\{[^}]*font-family:\s*var\(--font-brand\);/s);
  assert.match(css, /\.image-theme \.contact-name-button,[\s\S]*?font-family:\s*var\(--font-display\);/);
  assert.match(html, /<strong class="brand-title-art">关系回响<\/strong>/);
  assert.doesNotMatch(css, /\.image-theme\s*\{[^}]*font-family:\s*var\(--font-kai\);/s);
});

test("导入预览分别统计待校验联系人和警告组，并防止旧异步结果回写", async () => {
  const source = await readFile(join(projectRoot, "src", "app.js"), "utf8");
  assert.match(source, /pendingImport\.contacts\.reduce\(\(count, contact\) => count \+ \(contact\.needsReview \? 1 : 0\), 0\)/);
  assert.match(source, /import-warning-count"\)\.textContent = String\(needsReviewCount\)/);
  assert.match(source, /import-warning-groups"\)\.textContent = String\(pendingImport\.warnings\.length\)/);
  assert.match(source, /if \(operationId !== importOperationId\) return/);
  assert.match(source, /tokenInput\.value = ""/);
  assert.match(source, /window\.clearTimeout\(searchTimer\)[\s\S]*searchTimer = null/);
});

test("WeFlow 固定回环地址，并保留单请求超时、总预算和取消哨兵", async () => {
  const source = await readFile(join(projectRoot, "server", "weflow-adapter.mjs"), "utf8");
  assert.match(source, /const baseUrl = `http:\/\/127\.0\.0\.1:\$\{parsedPort\}`/);
  assert.match(source, /REQUEST_TIMEOUT_MS = 5_000/);
  assert.match(source, /MESSAGE_PREVIEW_BUDGET_MS = 45_000/);
  assert.match(source, /AbortSignal\.any\(\[signal, deadlineController\.signal\]\)/);
  assert.match(source, /WEFLOW_CANCELLED/);
});

test("隐私模式隐藏导入预览名称、消息和警告详情", async () => {
  const source = await readFile(join(projectRoot, "src", "app.js"), "utf8");
  assert.match(source, /导入联系人/);
  assert.match(source, /消息摘要已隐藏/);
  assert.match(source, /隐私模式下已隐藏/);
});

test("关系圆盘固定为四个时间桶且多人桶只跳转台账", async () => {
  const source = await readFile(join(projectRoot, "src", "app.js"), "utf8");
  const css = await readFile(join(projectRoot, "styles.css"), "utf8");
  const functionStart = source.indexOf("function renderChronometer(contacts) {");
  const functionEnd = source.indexOf("\nfunction renderQueue(contacts) {", functionStart);

  assert.notEqual(functionStart, -1, "应存在关系圆盘渲染函数");
  assert.notEqual(functionEnd, -1, "应能定位关系圆盘渲染函数边界");
  const chronometer = source.slice(functionStart, functionEnd);

  // 四桶必须稳定占据上、右、下、左四个方向，并保持 30% 的统一半径。
  assert.match(
    chronometer,
    /const buckets = \[\s*\{ label: "0–6天", angle: -90, contacts: \[\] \},\s*\{ label: "7–14天", angle: 0, contacts: \[\] \},\s*\{ label: "15–29天", angle: 90, contacts: \[\] \},\s*\{ label: "30天\+", angle: 180, contacts: \[\] \},\s*\];/,
  );
  assert.match(
    chronometer,
    /const bucketIndex = contact\.daysSince < 7 \? 0 : contact\.daysSince < 15 \? 1 : contact\.daysSince < 30 \? 2 : 3;/,
    "边界应为 0–6、7–14、15–29、30+",
  );
  assert.match(chronometer, /const radius = 30;/);
  assert.match(chronometer, /const left = 50 \+ Math\.cos\(angle\) \* radius;/);
  assert.match(chronometer, /const top = 50 \+ Math\.sin\(angle\) \* radius;/);

  // 多人桶不能冒充首位联系人；只有单人桶才携带 contactId 打开详情。
  assert.match(
    chronometer,
    /const dataset = isGroup \? \{ scrollTarget: "contacts-panel" \} : \{ contactId: contact\.id \};/,
  );
  assert.doesNotMatch(
    chronometer,
    /isGroup\s*\?\s*\{[^}]*contactId/s,
    "多人桶分支不得携带首位联系人的 contactId",
  );

  // 520px 以下仍保留足够的节点触控尺寸。
  const mobileStart = css.indexOf("@media (max-width: 520px) {");
  const mobileEnd = css.indexOf("\n@media (prefers-reduced-motion: reduce)", mobileStart);
  assert.notEqual(mobileStart, -1, "应存在 520px 移动端断点");
  assert.notEqual(mobileEnd, -1, "应能定位移动端断点边界");
  const mobileCss = css.slice(mobileStart, mobileEnd);
  assert.match(mobileCss, /\.dial-contact\s*\{\s*width: 44px;\s*min-height: 48px;\s*\}/);

  // 旧碰撞偏移算法和 39% 半径会让节点重叠或溢出，不得回归。
  assert.doesNotMatch(source, /crowdOffset|placedAngles/);
  assert.doesNotMatch(css, /39%/);
});

test("圆盘节点层允许中心操作穿透且联系人按钮仍可点击", async () => {
  const css = await readFile(join(projectRoot, "styles.css"), "utf8");

  // 覆盖整张圆盘的节点容器不能遮挡中心按钮，但实际联系人节点必须恢复点击命中。
  assert.match(
    css,
    /\.contact-nodes\s*\{[^}]*pointer-events:\s*none;[^}]*\}/s,
    ".contact-nodes 必须让空白区域的点击穿透到圆盘中心",
  );
  assert.match(
    css,
    /\.dial-contact\s*\{[^}]*pointer-events:\s*auto;[^}]*\}/s,
    ".dial-contact 必须恢复点击命中，避免联系人节点随容器一起失效",
  );
});

test("联系人点击路由不会让通用详情入口截获操作、维系意愿或标签切换", async () => {
  const source = await readFile(join(projectRoot, "src", "app.js"), "utf8");
  const routerStart = source.indexOf('document.addEventListener("click", async (event) => {');
  const routerEnd = source.indexOf("\n});\n\n$$('.filter-group')", routerStart);

  assert.notEqual(routerStart, -1, "应存在统一点击路由");
  assert.notEqual(routerEnd, -1, "应能定位统一点击路由的边界");
  const router = source.slice(routerStart, routerEnd);

  // 所有详情按钮仍由通用入口处理，但携带特殊意图的数据节点必须让行给后续分支。
  assert.match(
    router,
    /if\s*\(\s*target\.matches\("\[data-contact-id\]"\)\s*&&\s*!target\.dataset\.action\s*&&\s*!target\.dataset\.intent\s*&&\s*!target\.dataset\.toggleTag\s*\)\s*\{\s*showContact\(target\.dataset\.contactId\);\s*return;\s*\}/,
  );

  // 锁定三个特殊路由各自的分派目标，避免以后只保留选择器却误接到通用详情逻辑。
  assert.match(
    router,
    /if\s*\(target\.matches\("\[data-action\]"\)\)\s*\{\s*await handleContactAction\(target\.dataset\.action, target\.dataset\.contactId, target\.dataset\.days\);\s*return;\s*\}/,
  );
  assert.match(
    router,
    /if\s*\(target\.matches\("\[data-intent\]"\)\)\s*\{\s*await updateContact\(target\.dataset\.contactId, \(contact\) => setMaintenanceIntent\(contact, target\.dataset\.intent\),[^}]+return;\s*\}/,
  );
  assert.match(
    router,
    /if\s*\(target\.matches\("\[data-toggle-tag\]"\)\)\s*\{[\s\S]*?const tagId = target\.dataset\.toggleTag;[\s\S]*?await updateContact\(target\.dataset\.contactId,[\s\S]*?customTagIds: \[\.\.\.current\][\s\S]*?return;\s*\}/,
  );
});

test("图片按钮视觉皮肤完全位于 44px 真实命中盒内且不截获指针", async () => {
  const css = await readFile(join(projectRoot, "styles.css"), "utf8");
  assert.match(
    css,
    /\.image-theme \.button\s*\{[^}]*min-height:\s*44px;[^}]*\}/s,
    "图片按钮的真实语义按钮至少应有 44px 高",
  );
  assert.match(
    css,
    /\.image-theme \.button::before\s*\{[^}]*inset:\s*0;[^}]*pointer-events:\s*none;[^}]*\}/s,
    "皮肤必须位于真实按钮盒内，并让真实 button 成为唯一 hit target",
  );
  assert.doesNotMatch(
    css,
    /\.image-theme \.button::before\s*\{[^}]*inset:\s*-[^;}]+;/s,
    "实体图片皮肤不能用负 inset 外扩到不可点击区域",
  );
  const pseudoRule = css.match(/\.image-theme \.button::before\s*\{([^}]*)\}/s)?.[1] || "";
  assert.doesNotMatch(pseudoRule, /\btransform\s*:/, "图片伪元素自身不能缩放或位移出真实命中盒");
  assert.doesNotMatch(pseudoRule, /transition:[^;]*\btransform\b/, "图片伪元素不能通过动画越过命中盒");
  for (const selector of ["hover", "active", "disabled"]) {
    const stateRule = css.match(new RegExp(`\\.image-theme \\.button:${selector}::before\\s*\\{([^}]*)\\}`, "s"))?.[1] || "";
    assert.doesNotMatch(stateRule, /\btransform\s*:/, `${selector} 状态不能移动图片伪元素`);
  }
});

test("联系人回声信笺复用共享素材，真实按钮和头像内容保持语义 DOM", async () => {
  const [html, css, app] = await Promise.all([
    readFile(join(projectRoot, "index.html"), "utf8"),
    readFile(join(projectRoot, "styles.css"), "utf8"),
    readFile(join(projectRoot, "src", "app.js"), "utf8"),
  ]);
  assert.match(html, /brand-title-ornament" aria-hidden="true"/);
  assert.match(html, /<strong class="brand-title-art">关系回响<\/strong>/);
  assert.match(css, /\.contact-table tbody tr\.contact-card-row[\s\S]*contact-card-surface-v2\.webp/);
  assert.match(css, /\.image-theme :is\(\.queue-item, \.contact-hero, \.preview-contact\)[\s\S]*contact-card-surface-v2\.webp/);
  assert.match(css, /\.image-theme \.echo-avatar::before\s*\{[^}]*inset:\s*0;[^}]*pointer-events:\s*none;[^}]*avatar-echo-medallion-v2\.webp/s);
  assert.match(css, /\.image-theme \.mini-action\s*\{[^}]*min-height:\s*44px;[^}]*font-family:\s*var\(--font-body\);/s);
  assert.match(css, /\.image-theme \.mini-action::before\s*\{[^}]*inset:\s*0;[^}]*pointer-events:\s*none;[^}]*contact-action-secondary-v2\.webp/s);
  assert.doesNotMatch(css, /\.image-theme \.mini-action::before\s*\{[^}]*inset:\s*-[^;}]+;/s);
  assert.match(app, /className:\s*`avatar-token echo-avatar/);
  assert.match(app, /className:\s*"echo-avatar-glyph", text:\s*glyph/);
  assert.match(app, /className:\s*`contact-card-row/);
  for (const label of ["关系坐标", "最近回响", "上次聊到", "下次想起", "关系操作"]) {
    assert.match(app, new RegExp(`"data-label": "${label}"`));
  }
  assert.match(app, /text:\s*"记录问候"/);
  assert.match(app, /text:\s*"打开关系卡"/);
  assert.match(app, /className:\s*`source-badge source-\$\{sourceKind\}`/);
  assert.match(app, /className:\s*`contact-status-badge is-\$\{status\.key\}`/);
});

test("HTML 首帧固定浅色，系统深色媒体查询不能在主题初始化前翻转背景", async () => {
  const [html, css] = await Promise.all([
    readFile(join(projectRoot, "index.html"), "utf8"),
    readFile(join(projectRoot, "styles.css"), "utf8"),
  ]);
  assert.match(html, /<html\s+lang="zh-CN"\s+data-theme="light">/);
  assert.match(css, /\.ambient-backdrop-image\s*\{[^}]*echo-glass-light-wide\.webp/s);
  assert.match(css, /html\[data-theme="dark"\] \.ambient-backdrop-image\s*\{[^}]*echo-glass-dark-wide\.webp/s);
  const systemDarkStart = css.indexOf("@media (prefers-color-scheme: dark)");
  if (systemDarkStart !== -1) {
    const nextMedia = css.indexOf("\n@media", systemDarkStart + 1);
    const systemDark = css.slice(systemDarkStart, nextMedia === -1 ? undefined : nextMedia);
    assert.match(systemDark, /html:not\(\[data-theme\]\)/, "系统深色只能作用于没有显式主题的兜底页面");
    assert.doesNotMatch(systemDark, /html\[data-theme="light"\]/);
  }
});

test("forced-colors 为筛选、按下和当前导航提供系统选中态", async () => {
  const css = await readFile(join(projectRoot, "styles.css"), "utf8");
  const start = css.indexOf("@media (forced-colors: active)");
  assert.notEqual(start, -1);
  const block = css.slice(start, css.indexOf("\n@supports", start));
  assert.match(block, /button\.is-selected/);
  assert.match(block, /\[aria-pressed="true"\]/);
  assert.match(block, /\[aria-current="page"\]/);
  assert.match(block, /background:\s*Highlight;/);
  assert.match(block, /color:\s*HighlightText;/);
  assert.match(block, /forced-color-adjust:\s*none;/);
  assert.match(block, /input:checked[\s\S]*accent-color:\s*Highlight;/);
});

test("深色移动端使用独立竖版 WebP，并同步到提示词、manifest、CSS 与静态白名单", async () => {
  const css = await readFile(join(projectRoot, "styles.css"), "utf8");
  const prompts = await readFile(join(projectRoot, "src", "background-prompt.js"), "utf8");
  const server = await readFile(join(projectRoot, "server.mjs"), "utf8");
  const manifest = JSON.parse(await readFile(join(projectRoot, "assets", "appearance", "theme-manifest.json"), "utf8"));
  const assetPath = join(projectRoot, "assets", "appearance", "backgrounds", "echo-glass-dark-portrait.webp");
  const image = await readFile(assetPath);

  assert.equal(manifest.assets.darkPortrait.path, "assets/appearance/backgrounds/echo-glass-dark-portrait.webp");
  assert.ok(manifest.assets.darkPortrait.height > manifest.assets.darkPortrait.width, "深色移动资产必须是真正竖版");
  assert.equal(image.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(image.subarray(8, 12).toString("ascii"), "WEBP");
  assert.match(prompts, /darkPortrait:\s*"\.\/assets\/appearance\/backgrounds\/echo-glass-dark-portrait\.webp"/);
  assert.match(server, /"assets\/appearance\/backgrounds\/echo-glass-dark-portrait\.webp"/);
  const imageThemeStart = css.indexOf(".image-theme");
  const mobileStart = css.indexOf("@media (max-width: 820px)", imageThemeStart);
  const mobileEnd = css.indexOf("@media (max-width: 640px)", mobileStart);
  const mobileCss = css.slice(mobileStart, mobileEnd);
  assert.match(mobileCss, /html\[data-theme="dark"\][^{]*\.ambient-backdrop-image\s*\{[^}]*echo-glass-dark-portrait\.webp/s);
});

test("联系人来源目录未知或未明确支持时 WeFlow 入口静态 fail-closed", async () => {
  const [html, app] = await Promise.all([
    readFile(join(projectRoot, "index.html"), "utf8"),
    readFile(join(projectRoot, "src", "app.js"), "utf8"),
  ]);
  assert.match(html, /data-provider-id="weflow-http-win32"\s+hidden/);
  for (const id of ["weflow-port", "weflow-token", "weflow-preview"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*\\sdisabled(?:\\s|>)`));
  }
  assert.match(app, /let contactSourceCatalog\s*=\s*\[\];/);
  assert.match(app, /let weflowSupportedOnHost\s*=\s*false;/);
  assert.match(app, /weflowSupportedOnHost\s*=\s*Boolean\(weflowSource\?\.supportedOnHost\);/);
  assert.match(app, /weflowSection\.hidden\s*=\s*!weflowSupportedOnHost;/);
  assert.match(app, /disabled\s*=\s*busy\s*\|\|\s*!weflowSupportedOnHost/g);
});

test("reduced-transparency 关闭玻璃模糊、颗粒与装饰图并提高实体表面", async () => {
  const css = await readFile(join(projectRoot, "styles.css"), "utf8");
  const start = css.indexOf("@media (prefers-reduced-transparency: reduce)");
  assert.notEqual(start, -1);
  const block = css.slice(start, css.indexOf("\n@supports", start));
  assert.match(block, /ambient-backdrop-image\s*\{\s*opacity:\s*0\.12;/);
  assert.match(block, /ambient-backdrop-grain,[\s\S]*import-explainer::after\s*\{\s*display:\s*none;/);
  assert.match(block, /background:\s*var\(--echo-surface-strong\);/);
  assert.match(block, /-webkit-backdrop-filter:\s*none;/);
  assert.match(block, /(?<!-webkit-)backdrop-filter:\s*none;/);
});
