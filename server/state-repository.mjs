import { createReadStream, linkSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";

import { validateState } from "../src/storage.js";
import {
  buildBatchTagCandidate,
  buildInverseBatchTagCandidate,
  createBatchUndoRecord,
  isBatchUndoExpired,
} from "../src/batch-undo.js";

const DATABASE_FILENAME = "relationship-care.sqlite";
const BACKUP_RETENTION = 12;
const HISTORY_RETENTION = 50;
const AUTOMATIC_BACKUP_INTERVAL_MS = 60 * 60 * 1_000;
const BATCH_UNDO_TIMEOUT_MS = 45_000;
const DATABASE_SCHEMA_VERSION = 2;
const MANAGED_BACKUPS_META_KEY = "managed_backup_manifest_v1";
const MANAGED_BACKUP_NAME_PATTERN = /^relationship-care-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[a-z0-9-]{1,24}\.sqlite$/;
const BACKUP_PHASES = new Set([
  "verify-source",
  "snapshot-copy",
  "snapshot-open",
  "snapshot-integrity-before-redaction",
  "snapshot-redact-pending-undo",
  "snapshot-integrity-after-redaction",
  "snapshot-close",
  "publish-link",
  "publish-source-cleanup",
  "published-open",
  "published-integrity",
  "published-identity",
  "metadata-update",
  "retention-cleanup",
]);

function safeDiagnosticToken(value, fallback) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : fallback;
}

function backupStageError(error, phase, { path = null, dest = null } = {}) {
  if (error?.name === "BackupStageError" && BACKUP_PHASES.has(error.backupPhase)) return error;
  const wrapped = new Error(`SQLite 备份阶段 ${phase} 失败。`, { cause: error });
  wrapped.name = "BackupStageError";
  wrapped.code = "BACKUP_STAGE_FAILED";
  wrapped.backupPhase = phase;
  wrapped.causeCode = safeDiagnosticToken(error?.code, "BACKUP_FAILED");
  wrapped.syscall = safeDiagnosticToken(error?.syscall, "unknown");
  wrapped.logicalPath = path;
  wrapped.logicalDest = dest;
  return wrapped;
}

async function runBackupStage(phase, operation, locations = {}) {
  try {
    return await operation();
  } catch (error) {
    throw backupStageError(error, phase, locations);
  }
}

export function backupFailureDetails(error) {
  const phase = BACKUP_PHASES.has(error?.backupPhase) ? error.backupPhase : "unknown";
  return Object.freeze({
    phase,
    code: safeDiagnosticToken(error?.causeCode || error?.code, "BACKUP_FAILED"),
    syscall: safeDiagnosticToken(error?.syscall, "unknown"),
    path: typeof error?.logicalPath === "string" ? error.logicalPath : null,
    dest: typeof error?.logicalDest === "string" ? error.logicalDest : null,
  });
}

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function safeReason(value) {
  const cleaned = String(value || "automatic").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  return cleaned.slice(0, 24) || "automatic";
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function parseStateJson(value) {
  const parsed = JSON.parse(value);
  const validation = validateState(parsed);
  if (!validation.ok) throw new Error(`SQLite 中的状态无效：${validation.error}`);
  return parsed;
}

function assertDatabaseIntegrity(database) {
  const integrityRows = database.prepare("PRAGMA integrity_check").all();
  const integrityOk = integrityRows.length === 1 && String(integrityRows[0].integrity_check).toLowerCase() === "ok";
  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
  if (!integrityOk || foreignKeyRows.length) {
    throw new Error(`数据库完整性检查失败（integrity=${integrityOk ? "ok" : "failed"}, foreignKeys=${foreignKeyRows.length}）。`);
  }
  return { integrity: "ok", foreignKeys: "ok" };
}

function initializeDatabase(database) {
  const version = Number(database.prepare("PRAGMA user_version").get().user_version || 0);
  if (version > DATABASE_SCHEMA_VERSION) {
    const error = new Error(`数据库版本 ${version} 高于本程序支持的版本 ${DATABASE_SCHEMA_VERSION}，已拒绝启动以避免损坏数据。`);
    error.code = "UNSUPPORTED_DATABASE_VERSION";
    throw error;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        change_id TEXT NOT NULL UNIQUE,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision INTEGER NOT NULL,
        change_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_state_history_created_at ON state_history(created_at DESC);
      CREATE TABLE IF NOT EXISTS storage_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_batch_undo (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        undo_id TEXT NOT NULL UNIQUE,
        state_change_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
        tag_id TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        contact_ids_json TEXT NOT NULL,
        scope_label TEXT NOT NULL,
        changed_count INTEGER NOT NULL CHECK (changed_count >= 0),
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function createStateRepository({
  dataDir,
  historyRetention = HISTORY_RETENTION,
  backupRetention = BACKUP_RETENTION,
  backupDatabase = backup,
  publishBackup = linkSync,
} = {}) {
  if (!dataDir) throw new Error("缺少本地数据目录。");
  if (typeof backupDatabase !== "function" || typeof publishBackup !== "function") {
    throw new Error("SQLite 备份依赖无效。");
  }
  const resolvedDataDir = resolve(dataDir);
  const backupDir = join(resolvedDataDir, "backups");
  const databasePath = join(resolvedDataDir, DATABASE_FILENAME);
  mkdirSync(backupDir, { recursive: true });

  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  let initialHealth;
  let selectCurrent;
  let selectPendingUndo;
  let deletePendingUndo;
  let upsertPendingUndo;
  let selectMeta;
  let upsertMeta;
  try {
    initializeDatabase(database);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    initialHealth = assertDatabaseIntegrity(database);
    selectCurrent = database.prepare("SELECT revision, change_id, state_json, updated_at FROM app_state WHERE id = 1");
    selectPendingUndo = database.prepare("SELECT * FROM pending_batch_undo WHERE id = 1");
    deletePendingUndo = database.prepare("DELETE FROM pending_batch_undo WHERE id = 1");
    upsertPendingUndo = database.prepare(`
      INSERT INTO pending_batch_undo(
        id, undo_id, state_change_id, action, tag_id, tag_name, contact_ids_json,
        scope_label, changed_count, created_at_ms, expires_at_ms
      ) VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        undo_id = excluded.undo_id,
        state_change_id = excluded.state_change_id,
        action = excluded.action,
        tag_id = excluded.tag_id,
        tag_name = excluded.tag_name,
        contact_ids_json = excluded.contact_ids_json,
        scope_label = excluded.scope_label,
        changed_count = excluded.changed_count,
        created_at_ms = excluded.created_at_ms,
        expires_at_ms = excluded.expires_at_ms
    `);
    selectMeta = database.prepare("SELECT value FROM storage_meta WHERE key = ?");
    upsertMeta = database.prepare("INSERT INTO storage_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  } catch (error) {
    try { database.close(); } catch {}
    throw error;
  }
  let backupPromise = null;
  let lastHealth = { ...initialHealth, checkedAt: nowIso() };

  function verifyPrimaryDatabase() {
    lastHealth = { ...assertDatabaseIntegrity(database), checkedAt: nowIso() };
    return lastHealth;
  }

  function publicPendingUndo(row) {
    if (!row) return null;
    return {
      id: row.undo_id,
      action: row.action,
      tagId: row.tag_id,
      tagName: row.tag_name,
      scopeLabel: row.scope_label,
      changedCount: Number(row.changed_count),
      createdAt: Number(row.created_at_ms),
      expiresAt: Number(row.expires_at_ms),
      stateChangeId: row.state_change_id,
    };
  }

  function internalPendingUndo(row) {
    if (!row) return null;
    let contactIds;
    try {
      contactIds = JSON.parse(row.contact_ids_json);
    } catch {
      const error = new Error("SQLite 中的批量撤销联系人列表无效。");
      error.code = "INVALID_PENDING_UNDO";
      throw error;
    }
    return { ...publicPendingUndo(row), contactIds };
  }

  function currentDetails(nowMs = Date.now()) {
    const current = selectCurrent.get();
    const pendingRow = selectPendingUndo.get();
    const pendingUndo = pendingRow && !isBatchUndoExpired({ expiresAt: Number(pendingRow.expires_at_ms) }, nowMs)
      ? publicPendingUndo(pendingRow)
      : null;
    return {
      currentState: current ? parseStateJson(current.state_json) : null,
      currentPendingUndo: pendingUndo,
      serverNow: nowMs,
    };
  }

  function repositoryError(code, message, nowMs = Date.now(), extras = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, currentDetails(nowMs), extras);
    return error;
  }

  function writeStateWithinTransaction(candidate, current, nowMs) {
    const nextState = JSON.parse(JSON.stringify(candidate));
    nextState.revision = Number(current?.revision || candidate?.revision || 0) + 1;
    nextState.changeId = `${nowMs}-${randomUUID()}`;
    const validation = validateState(nextState);
    if (!validation.ok) {
      const invalid = new Error(validation.error);
      invalid.code = "INVALID_STATE";
      throw invalid;
    }

    const changedAt = nowIso(nowMs);
    if (current) {
      database.prepare("INSERT INTO state_history(revision, change_id, state_json, created_at) VALUES(?, ?, ?, ?)")
        .run(current.revision, current.change_id, current.state_json, changedAt);
    }
    database.prepare(`
      INSERT INTO app_state(id, schema_version, revision, change_id, state_json, updated_at)
      VALUES(1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        schema_version = excluded.schema_version,
        revision = excluded.revision,
        change_id = excluded.change_id,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(nextState.schemaVersion, nextState.revision, nextState.changeId, JSON.stringify(nextState), changedAt);
    database.prepare(`
      DELETE FROM state_history
      WHERE id NOT IN (SELECT id FROM state_history ORDER BY id DESC LIMIT ?)
    `).run(historyRetention);
    return { state: nextState, updatedAt: changedAt, hadPreviousState: Boolean(current) };
  }

  function loadState() {
    const row = selectCurrent.get();
    if (!row) return null;
    return {
      state: parseStateJson(row.state_json),
      updatedAt: row.updated_at,
    };
  }

  function loadAuthoritativeSnapshot({ nowMs = Date.now() } = {}) {
    if (!Number.isSafeInteger(nowMs)) throw new TypeError("nowMs 必须是安全整数毫秒时间戳。");
    const pendingRow = selectPendingUndo.get();
    if (pendingRow && nowMs >= Number(pendingRow.expires_at_ms)) deletePendingUndo.run();
    const current = loadState();
    return {
      state: current?.state || null,
      pendingUndo: publicPendingUndo(selectPendingUndo.get()),
      serverNow: nowMs,
    };
  }

  function storageStatus() {
    const current = selectCurrent.get();
    const lastBackupAt = selectMeta.get("last_backup_at")?.value || null;
    const historyCount = Number(database.prepare("SELECT COUNT(*) AS count FROM state_history").get().count || 0);
    return {
      authority: "sqlite",
      databasePath,
      dataDirectory: resolvedDataDir,
      updatedAt: current?.updated_at || null,
      lastBackupAt,
      historyCount,
      backupRetention,
      health: lastHealth,
    };
  }

  function compareAndSwapState(candidate, { expectedChangeId = null, nowMs = Date.now() } = {}) {
    if (!Number.isSafeInteger(nowMs)) throw new TypeError("nowMs 必须是安全整数毫秒时间戳。");
    database.exec("BEGIN IMMEDIATE");
    try {
      const current = selectCurrent.get();
      if ((current?.change_id || null) !== (expectedChangeId || null)) {
        throw repositoryError("STATE_CONFLICT", "本机数据已被另一个页面更新。", nowMs);
      }
      const pendingRow = selectPendingUndo.get();
      const saved = writeStateWithinTransaction(candidate, current, nowMs);
      const clearedUndoId = pendingRow?.undo_id || null;
      if (pendingRow) deletePendingUndo.run();
      database.exec("COMMIT");
      return { ...saved, pendingUndo: null, clearedUndoId, serverNow: nowMs };
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function applyBatchTagWithUndo(request, { nowMs = Date.now() } = {}) {
    if (!Number.isSafeInteger(nowMs)) throw new TypeError("nowMs 必须是安全整数毫秒时间戳。");
    database.exec("BEGIN IMMEDIATE");
    try {
      const current = selectCurrent.get();
      if (!current) throw repositoryError("STATE_NOT_FOUND", "还没有可整理的联系人数据。", nowMs);
      if (current.change_id !== (request?.expectedChangeId || null)) {
        throw repositoryError("STATE_CONFLICT", "本机数据已被另一个页面更新。", nowMs);
      }
      if (typeof request?.operationId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.operationId)) {
        throw repositoryError("INVALID_BATCH_TAG", "批量操作缺少有效的请求标识。", nowMs);
      }
      const currentState = parseStateJson(current.state_json);
      const batch = buildBatchTagCandidate(currentState, request);
      if (!batch.ok) throw repositoryError("INVALID_BATCH_TAG", batch.error, nowMs);
      if (batch.changedCount === 0) {
        throw repositoryError("BATCH_NO_CHANGES", "当前权威数据中没有需要修改的联系人。", nowMs, {
          batch: {
            action: request.action,
            tagId: request.tagId,
            changedCount: 0,
            skippedCount: batch.skippedCount,
            missingCount: batch.missingCount,
          },
        });
      }

      const saved = writeStateWithinTransaction(batch.candidate, current, nowMs);
      const authoritativeTag = saved.state.tags.find((tag) => tag.id === request.tagId);
      const record = createBatchUndoRecord({
        action: request.action,
        tagId: request.tagId,
        tagName: authoritativeTag.name,
        contactIds: batch.changedContactIds,
        scopeLabel: typeof request.scopeLabel === "string" ? request.scopeLabel.slice(0, 120) : "批量整理",
        now: nowMs,
        timeoutMs: BATCH_UNDO_TIMEOUT_MS,
        id: request.operationId,
      });
      upsertPendingUndo.run(
        record.id,
        saved.state.changeId,
        record.action,
        record.tagId,
        record.tagName,
        JSON.stringify(record.contactIds),
        record.scopeLabel,
        record.changedCount,
        record.createdAt,
        record.expiresAt,
      );
      database.exec("COMMIT");
      return {
        ...saved,
        pendingUndo: publicPendingUndo(selectPendingUndo.get()),
        serverNow: nowMs,
        batch: {
          action: request.action,
          tagId: request.tagId,
          changedCount: batch.changedCount,
          skippedCount: batch.skippedCount,
          missingCount: batch.missingCount,
        },
      };
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function consumePendingBatchUndo(request, { nowMs = Date.now() } = {}) {
    if (!Number.isSafeInteger(nowMs)) throw new TypeError("nowMs 必须是安全整数毫秒时间戳。");
    database.exec("BEGIN IMMEDIATE");
    let expiredError = null;
    try {
      const current = selectCurrent.get();
      if (!current || current.change_id !== (request?.expectedChangeId || null)) {
        throw repositoryError("STATE_CONFLICT", "本机数据已被另一个页面更新。", nowMs);
      }
      const pendingRow = selectPendingUndo.get();
      if (!pendingRow || pendingRow.undo_id !== request?.undoId) {
        throw repositoryError("UNDO_NOT_FOUND", "这条撤销记录已不存在或已被更新的操作替换。", nowMs);
      }
      if (nowMs >= Number(pendingRow.expires_at_ms)) {
        deletePendingUndo.run();
        database.exec("COMMIT");
        expiredError = repositoryError("UNDO_EXPIRED", "撤销窗口已经结束。", nowMs);
      } else {
        if (pendingRow.state_change_id !== current.change_id) {
          throw repositoryError("UNDO_STATE_MISMATCH", "联系人数据已经变化，不能再撤销旧批次。", nowMs);
        }
        const record = internalPendingUndo(pendingRow);
        const inverse = buildInverseBatchTagCandidate(parseStateJson(current.state_json), record);
        if (!inverse.ok) throw repositoryError("UNDO_INVALID", inverse.error, nowMs);
        const saved = writeStateWithinTransaction(inverse.candidate, current, nowMs);
        deletePendingUndo.run();
        database.exec("COMMIT");
        return {
          ...saved,
          pendingUndo: null,
          clearedUndoId: record.id,
          serverNow: nowMs,
          undone: {
            action: record.action,
            tagId: record.tagId,
            changedCount: inverse.changedCount,
            skippedCount: inverse.skippedCount,
            missingCount: inverse.missingCount,
          },
        };
      }
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
    throw expiredError;
  }

  function loadManagedBackupManifest() {
    const cleanupWarnings = [];
    const stored = selectMeta.get(MANAGED_BACKUPS_META_KEY)?.value;
    if (!stored) return { entries: [], cleanupWarnings };
    try {
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) throw new Error("manifest-not-array");
      const seen = new Set();
      const entries = parsed.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)
          || typeof entry.filename !== "string" || !MANAGED_BACKUP_NAME_PATTERN.test(entry.filename)
          || basename(entry.filename) !== entry.filename
          || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)
          || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
          || seen.has(entry.filename)) {
          throw new Error("manifest-entry-invalid");
        }
        seen.add(entry.filename);
        return { filename: entry.filename, sha256: entry.sha256, bytes: entry.bytes };
      });
      return { entries, cleanupWarnings };
    } catch {
      cleanupWarnings.push("备份所有权清单无法验证；已保留全部旧快照，并从本次新快照重新建立清单。");
      return { entries: [], cleanupWarnings };
    }
  }

  async function rotateBackups(managedBackups) {
    const ordered = [...managedBackups].sort((left, right) => right.filename.localeCompare(left.filename));
    const retainedEntries = ordered.slice(0, backupRetention);
    const cleanupWarnings = [];
    for (const entry of ordered.slice(backupRetention)) {
      const managedPath = join(backupDir, entry.filename);
      try {
        const info = lstatSync(managedPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) {
          cleanupWarnings.push(`旧快照 ${entry.filename} 的身份已经变化，已保留且不再自动删除。`);
          continue;
        }
        const digest = await sha256File(managedPath);
        if (digest !== entry.sha256) {
          cleanupWarnings.push(`旧快照 ${entry.filename} 的摘要已经变化，已保留且不再自动删除。`);
          continue;
        }
        unlinkSync(managedPath);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        retainedEntries.push(entry);
        cleanupWarnings.push(`旧快照 ${entry.filename} 暂时无法安全删除（${error.code || "DELETE_FAILED"}），下次备份会重试。`);
      }
    }
    upsertMeta.run(MANAGED_BACKUPS_META_KEY, JSON.stringify(retainedEntries));
    return cleanupWarnings;
  }

  async function createBackup(reason = "automatic") {
    if (backupPromise) return backupPromise;
    backupPromise = (async () => {
      const createdAt = nowIso();
      const filename = `relationship-care-${timestampForFilename(new Date(createdAt))}-${randomUUID()}-${safeReason(reason)}.sqlite`;
      const backupPath = join(backupDir, filename);
      const temporaryPath = join(backupDir, `.pending-${randomUUID()}.sqlite`);
      let temporaryDatabase = null;
      let publishedByThisAttempt = false;
      let publishedIdentity = null;
      try {
        await runBackupStage("verify-source", () => verifyPrimaryDatabase());
        await runBackupStage(
          "snapshot-copy",
          () => backupDatabase(database, temporaryPath, { rate: 64 }),
          { path: "database/relationship-care.sqlite", dest: "backupDir/.pending.sqlite" },
        );
        temporaryDatabase = await runBackupStage(
          "snapshot-open",
          () => new DatabaseSync(temporaryPath),
          { path: "backupDir/.pending.sqlite" },
        );
        await runBackupStage(
          "snapshot-integrity-before-redaction",
          () => assertDatabaseIntegrity(temporaryDatabase),
          { path: "backupDir/.pending.sqlite" },
        );
        await runBackupStage(
          "snapshot-redact-pending-undo",
          () => temporaryDatabase.exec("BEGIN IMMEDIATE; DELETE FROM pending_batch_undo; COMMIT;"),
          { path: "backupDir/.pending.sqlite" },
        );
        await runBackupStage(
          "snapshot-integrity-after-redaction",
          () => assertDatabaseIntegrity(temporaryDatabase),
          { path: "backupDir/.pending.sqlite" },
        );
        await runBackupStage("snapshot-close", () => temporaryDatabase.close(), { path: "backupDir/.pending.sqlite" });
        temporaryDatabase = null;
        await runBackupStage(
          "publish-link",
          () => publishBackup(temporaryPath, backupPath),
          { path: "backupDir/.pending.sqlite", dest: `backupDir/${basename(backupPath)}` },
        );
        publishedByThisAttempt = true;
        await runBackupStage(
          "publish-source-cleanup",
          () => unlinkSync(temporaryPath),
          { path: "backupDir/.pending.sqlite", dest: `backupDir/${basename(backupPath)}` },
        );
        const publishedDatabase = await runBackupStage(
          "published-open",
          () => new DatabaseSync(backupPath, { readOnly: true }),
          { path: `backupDir/${basename(backupPath)}` },
        );
        try {
          await runBackupStage(
            "published-integrity",
            () => assertDatabaseIntegrity(publishedDatabase),
            { path: `backupDir/${basename(backupPath)}` },
          );
        } finally {
          publishedDatabase.close();
        }
        publishedIdentity = await runBackupStage(
          "published-identity",
          async () => {
            const info = lstatSync(backupPath);
            if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) {
              const error = new Error("published backup identity is invalid");
              error.code = "BACKUP_IDENTITY_INVALID";
              throw error;
            }
            return {
              filename,
              sha256: await sha256File(backupPath),
              bytes: info.size,
            };
          },
          { path: `backupDir/${basename(backupPath)}` },
        );
      } catch (error) {
        try { temporaryDatabase?.close(); } catch {}
        try { unlinkSync(temporaryPath); } catch {}
        if (publishedByThisAttempt) {
          try { unlinkSync(backupPath); } catch {}
        }
        throw error;
      }
      const manifest = loadManagedBackupManifest();
      const managedBackups = await runBackupStage("metadata-update", () => {
        const nextEntries = manifest.entries.filter((entry) => entry.filename !== publishedIdentity.filename);
        nextEntries.push(publishedIdentity);
        upsertMeta.run("last_backup_at", createdAt);
        upsertMeta.run("last_backup_file", basename(backupPath));
        upsertMeta.run(MANAGED_BACKUPS_META_KEY, JSON.stringify(nextEntries));
        return nextEntries;
      });
      const cleanupWarnings = [
        ...manifest.cleanupWarnings,
        ...await runBackupStage("retention-cleanup", () => rotateBackups(managedBackups)),
      ];
      return { createdAt, filename, backupPath, cleanupWarnings };
    })().finally(() => { backupPromise = null; });
    return backupPromise;
  }

  async function maybeCreateBackup({ force = false, reason = "automatic" } = {}) {
    const lastBackup = selectMeta.get("last_backup_at")?.value;
    const age = lastBackup ? Date.now() - new Date(lastBackup).getTime() : Number.POSITIVE_INFINITY;
    if (!force && age < AUTOMATIC_BACKUP_INTERVAL_MS) return null;
    return createBackup(reason);
  }

  return {
    databasePath,
    dataDir: resolvedDataDir,
    loadState,
    loadAuthoritativeSnapshot,
    compareAndSwapState,
    applyBatchTagWithUndo,
    consumePendingBatchUndo,
    createBackup,
    maybeCreateBackup,
    storageStatus,
    assertIntegrity: verifyPrimaryDatabase,
    close: () => database.close(),
  };
}
