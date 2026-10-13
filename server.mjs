import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_API_BODY_BYTES } from "./src/limits.js";
import { backupFailureDetails, createStateRepository } from "./server/state-repository.mjs";
import { ContactSourceError, createDefaultContactSourceRegistry } from "./server/contact-source-registry.mjs";
import { WeFlowAdapterError } from "./server/weflow-adapter.mjs";

const defaultRootDir = fileURLToPath(new URL(".", import.meta.url));
const DESKTOP_COOKIE_NAME = "relationship_echo_session";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const publicFiles = new Set([
  "index.html",
  "share.html",
  "share.css",
  "styles.css",
  "favicon.svg",
  "src/app.js",
  "src/batch-undo.js",
  "src/contact-selection.js",
  "src/data.js",
  "src/domain.js",
  "src/importer.js",
  "src/limits.js",
  "src/local-api.js",
  "src/storage.js",
  "src/background-prompt.js",
  "src/visual-theme.js",
  "assets/appearance/theme-manifest.json",
  "assets/appearance/backgrounds/echo-glass-light-wide.webp",
  "assets/appearance/backgrounds/echo-glass-dark-wide.webp",
  "assets/appearance/backgrounds/echo-glass-light-portrait.webp",
  "assets/appearance/backgrounds/echo-glass-dark-portrait.webp",
  "assets/appearance/skins/control-primary.webp",
  "assets/appearance/skins/control-neutral.webp",
  "assets/appearance/illustrations/contact-source.webp",
  "assets/appearance/contact/contact-card-surface-v2.webp",
  "assets/appearance/contact/avatar-echo-medallion-v2.webp",
  "assets/appearance/contact/contact-action-primary-v2.webp",
  "assets/appearance/contact/contact-action-secondary-v2.webp",
  "assets/appearance/contact/brand-echo-flourish-v2.webp",
  "samples/contacts.sample.json",
  "samples/contact-source.sample.json",
]);

const baseHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

class HttpError extends Error {
  constructor(status, message, code = "REQUEST_ERROR", details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text, headers = {}) {
  response.writeHead(status, { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8", ...headers });
  response.end(text);
}

function parseUrl(requestUrl, port) {
  try {
    return new URL(requestUrl, `http://127.0.0.1:${port}`);
  } catch {
    throw new HttpError(400, "Bad request", "MALFORMED_URL");
  }
}

function normalizedPublicPath(url) {
  try {
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const normalizedPath = normalize(relative).replaceAll("\\", "/");
    if (normalizedPath.startsWith("..") || normalizedPath.includes("\0") || normalizedPath.startsWith(".")) return null;
    return publicFiles.has(normalizedPath) ? normalizedPath : null;
  } catch (error) {
    if (error instanceof URIError) throw new HttpError(400, "Bad request", "MALFORMED_URL");
    return null;
  }
}

function assertLocalRequest(request, port, { write = false } = {}) {
  const host = String(request.headers.host || "").toLowerCase();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(host)) throw new HttpError(403, "本机服务拒绝了异常 Host。", "INVALID_HOST");
  if (!write) return;
  const origin = request.headers.origin;
  if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) {
    throw new HttpError(403, "本机服务拒绝了跨来源写入。", "INVALID_ORIGIN");
  }
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "请求必须使用 application/json。", "UNSUPPORTED_MEDIA_TYPE");
  }
}

function constantTimeMatches(candidate, expected) {
  const candidateDigest = createHash("sha256").update(String(candidate ?? ""), "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function desktopCookieValue(sessionSecret) {
  return createHmac("sha256", sessionSecret)
    .update("relationship-echo-desktop-session-v1", "utf8")
    .digest("base64url");
}

function readDesktopCookie(request) {
  const cookieHeader = String(request.headers.cookie || "");
  const values = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${DESKTOP_COOKIE_NAME}=`))
    .map((part) => part.slice(DESKTOP_COOKIE_NAME.length + 1));
  return values.length === 1 ? values[0] : null;
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      rejectBody(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      byteLength += chunk.length;
      if (byteLength > MAX_API_BODY_BYTES) {
        rejectOnce(new HttpError(413, "请求内容超过 8 MB。", "REQUEST_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolveBody(text ? JSON.parse(text) : {});
      } catch {
        rejectBody(new HttpError(400, "请求 JSON 无法解析。", "INVALID_JSON"));
      }
    });
    request.on("aborted", () => rejectOnce(new HttpError(400, "请求已中止。", "REQUEST_ABORTED")));
    request.on("error", (error) => rejectOnce(new HttpError(400, `请求读取失败：${error.message}`, "REQUEST_READ_FAILED")));
  });
}

export async function createLocalServer({
  dataDir,
  host = "127.0.0.1",
  port = 4173,
  sessionSecret = null,
  rootDir = defaultRootDir,
  shutdownGraceMs = 5_000,
  onLifecycleEvent = null,
} = {}) {
  if (!dataDir) throw new Error("缺少本地数据目录。");
  if (!["127.0.0.1", "localhost"].includes(host)) {
    throw new Error("本机服务只能监听 127.0.0.1 或 localhost。");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("端口必须在 0 到 65535 之间。");
  }
  if (sessionSecret !== null
    && (typeof sessionSecret !== "string" || sessionSecret.length < 16 || sessionSecret.length > 4_096)) {
    throw new Error("桌面会话密钥必须是 16 到 4096 个字符的字符串。");
  }
  if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 10 || shutdownGraceMs > 30_000) {
    throw new Error("关闭等待时间必须是 10 到 30000 毫秒之间的整数。");
  }
  if (onLifecycleEvent !== null && typeof onLifecycleEvent !== "function") {
    throw new Error("生命周期观察器必须是函数。");
  }

  const root = resolve(rootDir);
  const repository = createStateRepository({ dataDir: resolve(dataDir) });
  const contactSources = createDefaultContactSourceRegistry();
  const activeDestructiveWrites = new Set();
  const backgroundTasks = new Set();
  const activeRequests = new Set();
  const shutdownController = new AbortController();
  const expectedDesktopCookie = sessionSecret === null ? null : desktopCookieValue(sessionSecret);
  let listeningPort = null;

  function emitLifecycle(phase) {
    if (!onLifecycleEvent) return;
    try {
      onLifecycleEvent(Object.freeze({
        phase,
        activeRequests: activeRequests.size,
        destructiveWrites: activeDestructiveWrites.size,
        backgroundTasks: backgroundTasks.size,
      }));
    } catch {}
  }

function authorityErrorDetails(error) {
  const snapshot = repository.loadAuthoritativeSnapshot();
  return {
    currentState: error.currentState ?? snapshot.state,
    pendingUndo: error.currentPendingUndo ?? snapshot.pendingUndo,
    serverNow: error.serverNow ?? snapshot.serverNow,
    ...(error.batch ? { batch: error.batch } : {}),
  };
}

async function maybeBackupAfterWrite(saved, reason = "automatic") {
  let backupResult = null;
  let backupWarning = null;
  const backupWarnings = [];
  try {
    backupResult = await repository.maybeCreateBackup({
      force: !saved.hadPreviousState,
      reason: saved.hadPreviousState ? reason : "initial-state",
    });
    backupWarnings.push(...(backupResult?.cleanupWarnings || []));
  } catch (error) {
    backupWarning = `数据已经写入 SQLite，但自动快照失败：${error.message}`;
  }
  return {
    backupCreated: Boolean(backupResult),
    backupWarning,
    backupWarnings,
  };
}

async function waitForDestructiveWrites() {
  while (activeDestructiveWrites.size) {
    await Promise.all([...activeDestructiveWrites]);
  }
}

function scheduleBackupAfterWrite(saved, reason = "automatic") {
  const task = maybeBackupAfterWrite(saved, reason).then((result) => {
    const warnings = [result.backupWarning, ...(result.backupWarnings || [])].filter(Boolean);
    if (warnings.length) console.warn(`[relationship-care] ${warnings.join("；")}`);
  });
  backgroundTasks.add(task);
  void task.finally(() => backgroundTasks.delete(task));
}

async function previewContactSourceForRequest(request, response, sourceId) {
  const body = await readJsonBody(request);
  const controller = new AbortController();
  const cancelForShutdown = () => controller.abort();
  const cancelIfClientLeaves = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", cancelIfClientLeaves);
  response.once("close", cancelIfClientLeaves);
  shutdownController.signal.addEventListener("abort", cancelForShutdown, { once: true });
  try {
    return await contactSources.preview(sourceId, body, { signal: controller.signal });
  } finally {
    request.off("aborted", cancelIfClientLeaves);
    response.off("close", cancelIfClientLeaves);
    shutdownController.signal.removeEventListener("abort", cancelForShutdown);
  }
}

async function handleApi(request, response, url) {
  const method = request.method || "GET";
  const sourcePreviewMatch = /^\/api\/contact-sources\/([a-z0-9][a-z0-9-]{1,63})\/preview$/.exec(url.pathname);
  assertLocalRequest(request, listeningPort);
  let knownMethods = null;
  if (["/api/health", "/api/contact-sources"].includes(url.pathname)) knownMethods = ["GET"];
  else if (url.pathname === "/api/state") knownMethods = ["GET", "PUT"];
  else if ([
    "/api/state/batch-tag",
    "/api/state/batch-tag/undo",
    "/api/storage/backup",
    "/api/weflow/preview",
  ].includes(url.pathname) || sourcePreviewMatch) knownMethods = ["POST"];
  if (knownMethods && !knownMethods.includes(method)) {
    throw new HttpError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
  }
  assertLocalRequest(request, listeningPort, { write: ["PUT", "POST", "PATCH", "DELETE"].includes(method) });

  if (url.pathname === "/api/health" && method === "GET") {
    sendJson(response, 200, { ok: true, storage: repository.storageStatus() });
    return;
  }

  if (url.pathname === "/api/contact-sources" && method === "GET") {
    sendJson(response, 200, {
      ok: true,
      contractVersion: 1,
      sources: contactSources.list(),
    });
    return;
  }

  if (url.pathname === "/api/state" && method === "GET") {
    await waitForDestructiveWrites();
    const snapshot = repository.loadAuthoritativeSnapshot();
    sendJson(response, 200, { ok: true, ...snapshot, storage: repository.storageStatus() });
    return;
  }

  if (url.pathname === "/api/state" && method === "PUT") {
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || !body.state) {
      throw new HttpError(400, "请求缺少 state。", "MISSING_STATE");
    }
    let releaseDestructiveBarrier = null;
    let destructiveBarrier = null;
    if (body.destructive === true) {
      destructiveBarrier = new Promise((resolveBarrier) => { releaseDestructiveBarrier = resolveBarrier; });
      activeDestructiveWrites.add(destructiveBarrier);
    }
    try {
      const backupWarnings = [];
      let preChangeBackup = null;
      if (body.destructive === true && repository.loadState()) {
        preChangeBackup = await repository.createBackup("before-destructive-change");
        backupWarnings.push(...(preChangeBackup.cleanupWarnings || []));
      }
      let saved;
      try {
        saved = repository.compareAndSwapState(body.state, {
          expectedChangeId: body.expectedChangeId || null,
        });
      } catch (error) {
        if (error.code === "STATE_CONFLICT") {
          throw new HttpError(409, "本机数据刚刚被另一个页面更新；本次更改未保存。", "STATE_CONFLICT", {
            ...authorityErrorDetails(error),
          });
        }
        if (error.code === "INVALID_STATE") throw new HttpError(422, error.message, "INVALID_STATE");
        throw error;
      }
      let backupResult = preChangeBackup;
      let backupWarning = null;
      if (!body.destructive) {
        try {
          backupResult = await repository.maybeCreateBackup({
            force: !saved.hadPreviousState,
            reason: saved.hadPreviousState ? "automatic" : "initial-state",
          });
          backupWarnings.push(...(backupResult?.cleanupWarnings || []));
        } catch (error) {
          backupWarning = `数据已经写入 SQLite，但自动快照失败：${error.message}`;
        }
      }
      sendJson(response, 200, {
        ok: true,
        state: saved.state,
        pendingUndo: saved.pendingUndo,
        clearedUndoId: saved.clearedUndoId,
        serverNow: saved.serverNow,
        storage: repository.storageStatus(),
        backupCreated: Boolean(backupResult),
        backupWarning,
        backupWarnings,
      });
    } finally {
      if (destructiveBarrier) {
        activeDestructiveWrites.delete(destructiveBarrier);
        releaseDestructiveBarrier();
      }
    }
    return;
  }

  if (url.pathname === "/api/state/batch-tag" && method === "POST") {
    const body = await readJsonBody(request);
    let saved;
    try {
      saved = repository.applyBatchTagWithUndo(body);
    } catch (error) {
      if (error.code === "STATE_CONFLICT") throw new HttpError(409, error.message, error.code, authorityErrorDetails(error));
      if (error.code === "STATE_NOT_FOUND") throw new HttpError(404, error.message, error.code, authorityErrorDetails(error));
      if (error.code === "BATCH_NO_CHANGES") throw new HttpError(409, error.message, error.code, authorityErrorDetails(error));
      if (error.code === "INVALID_BATCH_TAG" || error.code === "INVALID_STATE") {
        throw new HttpError(422, error.message, error.code, authorityErrorDetails(error));
      }
      throw error;
    }
    scheduleBackupAfterWrite(saved, "automatic");
    sendJson(response, 200, {
      ok: true,
      state: saved.state,
      pendingUndo: saved.pendingUndo,
      serverNow: saved.serverNow,
      batch: saved.batch,
      storage: repository.storageStatus(),
      backupScheduled: true,
    });
    return;
  }

  if (url.pathname === "/api/state/batch-tag/undo" && method === "POST") {
    const body = await readJsonBody(request);
    let saved;
    try {
      saved = repository.consumePendingBatchUndo(body);
    } catch (error) {
      if (["STATE_CONFLICT", "UNDO_NOT_FOUND", "UNDO_STATE_MISMATCH"].includes(error.code)) {
        throw new HttpError(409, error.message, error.code, authorityErrorDetails(error));
      }
      if (error.code === "UNDO_EXPIRED") throw new HttpError(410, error.message, error.code, authorityErrorDetails(error));
      if (error.code === "UNDO_INVALID" || error.code === "INVALID_STATE") {
        throw new HttpError(422, error.message, error.code, authorityErrorDetails(error));
      }
      throw error;
    }
    scheduleBackupAfterWrite(saved, "automatic");
    sendJson(response, 200, {
      ok: true,
      state: saved.state,
      pendingUndo: saved.pendingUndo,
      clearedUndoId: saved.clearedUndoId,
      serverNow: saved.serverNow,
      undone: saved.undone,
      storage: repository.storageStatus(),
      backupScheduled: true,
    });
    return;
  }

  if (url.pathname === "/api/storage/backup" && method === "POST") {
    await readJsonBody(request);
    const result = await repository.createBackup("manual");
    sendJson(response, 201, {
      ok: true,
      backup: { createdAt: result.createdAt, filename: result.filename },
      warnings: result.cleanupWarnings || [],
      storage: repository.storageStatus(),
    });
    return;
  }

  if (sourcePreviewMatch && method === "POST") {
    const result = await previewContactSourceForRequest(request, response, sourcePreviewMatch[1]);
    sendJson(response, 200, result);
    return;
  }


  // Backward-compatible alias for older local clients. New UI uses the provider route above.
  if (url.pathname === "/api/weflow/preview" && method === "POST") {
    const result = await previewContactSourceForRequest(request, response, "weflow-http-win32");
    sendJson(response, 200, result);
    return;
  }

  if (["/api/state", "/api/state/batch-tag", "/api/state/batch-tag/undo", "/api/contact-sources", "/api/weflow/preview"].includes(url.pathname)
    || sourcePreviewMatch) {
    throw new HttpError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
  }
  throw new HttpError(404, "Not found", "NOT_FOUND");
}

function handleStatic(request, response, url) {
  if (!["GET", "HEAD"].includes(request.method || "")) {
    sendText(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
    return;
  }
  const relativePath = normalizedPublicPath(url);
  if (!relativePath) {
    sendText(response, 404, "Not found");
    return;
  }
  const filePath = join(root, relativePath);
  try {
    if (!statSync(filePath).isFile()) throw new Error("not found");
    response.writeHead(200, { ...baseHeaders, "Content-Type": contentTypes[extname(filePath).toLowerCase()] || "application/octet-stream" });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    sendText(response, 404, "Not found");
  }
}

function authorizeDesktopRequest(request, response, url) {
  if (expectedDesktopCookie === null) return false;

  const bootstrapTokens = url.searchParams.getAll("desktopToken");
  if (bootstrapTokens.length) {
    const onlyBootstrapParameter = [...url.searchParams.keys()].every((name) => name === "desktopToken");
    const validBootstrapRequest = request.method === "GET"
      && url.pathname === "/"
      && bootstrapTokens.length === 1
      && onlyBootstrapParameter
      && constantTimeMatches(bootstrapTokens[0], sessionSecret);
    if (!validBootstrapRequest) {
      throw new HttpError(403, "桌面会话验证失败。", "DESKTOP_SESSION_FORBIDDEN");
    }
    response.writeHead(302, {
      ...baseHeaders,
      Location: "/",
      "Set-Cookie": `${DESKTOP_COOKIE_NAME}=${expectedDesktopCookie}; HttpOnly; SameSite=Strict; Path=/`,
    });
    response.end();
    return true;
  }

  const cookie = readDesktopCookie(request);
  if (cookie === null || !constantTimeMatches(cookie, expectedDesktopCookie)) {
    throw new HttpError(403, "桌面会话验证失败。", "DESKTOP_SESSION_FORBIDDEN");
  }
  return false;
}

const server = createServer((request, response) => {
  const requestTask = (async () => {
  if (!request.url) {
    sendText(response, 400, "Bad request");
    return;
  }
  try {
    const url = parseUrl(request.url, listeningPort);
    assertLocalRequest(request, listeningPort);
    if (authorizeDesktopRequest(request, response, url)) return;
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else handleStatic(request, response, url);
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof ContactSourceError || error instanceof WeFlowAdapterError) {
      sendJson(response, error.status, { ok: false, error: error.message, code: error.code, details: error.details || null });
      return;
    }
    if (error instanceof HttpError) {
      const requestPath = String(request.url || "").split("?", 1)[0];
      const isStateApi = ["/api/state", "/api/state/batch-tag", "/api/state/batch-tag/undo"].includes(requestPath);
      let allowedMethods = "POST";
      if (requestPath === "/api/state") allowedMethods = "GET, PUT";
      else if (["/api/health", "/api/contact-sources"].includes(requestPath)) allowedMethods = "GET";
      const headers = error.status === 405 ? { Allow: allowedMethods } : {};
      let details = error.details;
      if (isStateApi) {
        try {
          details = { ...authorityErrorDetails(error), ...(error.details || {}) };
        } catch {}
      }
      response.writeHead(error.status, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8", ...headers });
      response.end(JSON.stringify({ ok: false, error: error.message, code: error.code, details }));
      return;
    }
    let details = null;
    if (String(request.url || "").split("?", 1)[0].startsWith("/api/state")) {
      try { details = authorityErrorDetails(error); } catch {}
    }
    sendJson(response, 500, { ok: false, error: "本机数据服务发生内部错误。", code: "INTERNAL_ERROR", details });
    process.stderr.write(`[relationship-care] ${error.stack || error.message}\n`);
  }
  })();
  activeRequests.add(requestTask);
  void requestTask.finally(() => activeRequests.delete(requestTask));
});

try {
  await new Promise((resolveListening, rejectListening) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListening(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListening(new Error("无法确定本机服务的监听端口。"));
        return;
      }
      listeningPort = address.port;
      resolveListening();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
} catch (error) {
  try { repository.close(); } catch {}
  throw error;
}

try {
  if (repository.loadState()) await repository.maybeCreateBackup({ reason: "startup" });
} catch (error) {
  process.stderr.write(`[relationship-care] 启动备份失败 ${JSON.stringify(backupFailureDetails(error))}\n`);
}

let closePromise = null;
function close() {
  if (closePromise) return closePromise;
  closePromise = (async () => {
    emitLifecycle("close-started");
    shutdownController.abort();
    let forceCloseTimer = null;
    let listenerClosePromise = Promise.resolve();
    if (server.listening) {
      listenerClosePromise = new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
        server.closeIdleConnections?.();
      });
      forceCloseTimer = setTimeout(() => {
        emitLifecycle("force-closing-connections");
        server.closeAllConnections?.();
      }, shutdownGraceMs);
      forceCloseTimer.unref?.();
    }
    try {
      await listenerClosePromise;
      emitLifecycle("listener-closed");
      if (activeRequests.size) await Promise.allSettled([...activeRequests]);
      emitLifecycle("requests-drained");
      await waitForDestructiveWrites();
      emitLifecycle("writes-drained");
      if (backgroundTasks.size) await Promise.allSettled([...backgroundTasks]);
      emitLifecycle("background-tasks-drained");
      repository.close();
      emitLifecycle("repository-closed");
    } finally {
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
    }
  })();
  return closePromise;
}

return {
  server,
  repository,
  host,
  port: listeningPort,
  origin: `http://${host}:${listeningPort}`,
  close,
};
}

function parseCliPort(argv = process.argv, environment = process.env) {
  const requestedPortIndex = argv.indexOf("--port");
  const requestedPort = requestedPortIndex >= 0 ? argv[requestedPortIndex + 1] : environment.RELATIONSHIP_CARE_PORT;
  const port = Number.parseInt(requestedPort || "4173", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("端口必须在 1 到 65535 之间。");
  return port;
}

function defaultCliDataDir(rootDir = defaultRootDir) {
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "Relationship Echo");
  }
  return resolve(rootDir, "..", "relationship-care-data");
}

async function runCli() {
  const port = parseCliPort();
  const dataDir = resolve(process.env.RELATIONSHIP_CARE_DATA_DIR || defaultCliDataDir());
  const diagnosticsEnabled = process.env.RELATIONSHIP_CARE_DIAGNOSTICS === "1";
  const localServer = await createLocalServer({
    dataDir,
    port,
    rootDir: defaultRootDir,
    onLifecycleEvent: diagnosticsEnabled
      ? (event) => process.stdout.write(`[relationship-care-lifecycle] ${JSON.stringify(event)}\n`)
      : null,
  });
  process.stdout.write(`关系回响已启动：${localServer.origin}\n`);
  process.stdout.write(`本机数据目录：${localServer.repository.dataDir}\n`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (diagnosticsEnabled) {
      process.stdout.write(`[relationship-care-lifecycle] ${JSON.stringify({ phase: "signal-received", signal })}\n`);
    }
    try {
      await localServer.close();
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
      if (diagnosticsEnabled) {
        process.stdout.write(`[relationship-care-lifecycle] ${JSON.stringify({ phase: "shutdown-complete" })}\n`);
      }
    } catch (error) {
      process.stderr.write(`[relationship-care] 关闭失败：${error.message}\n`);
      process.exitCode = 1;
    }
  };

  const handleSigint = () => { void shutdown("SIGINT"); };
  const handleSigterm = () => { void shutdown("SIGTERM"); };
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
}

const invokedAsScript = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`[relationship-care] 启动失败：${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
