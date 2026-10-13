import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { backupFailureDetails, createStateRepository } from "../server/state-repository.mjs";
import { createDemoState } from "../src/data.js";

const NOW = new Date("2026-08-23T12:00:00+08:00");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function withRepository(run, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "relationship-care-repository-test-"));
  const repository = createStateRepository({ dataDir, ...options });
  try {
    return await run(repository, dataDir);
  } finally {
    repository.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test("SQLite 仓库以 changeId 做 CAS，陈旧写入不能覆盖新状态", async () => {
  await withRepository(async (repository) => {
    const first = repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    assert.equal(first.state.revision, 2);
    assert.ok(first.state.changeId);

    const winnerCandidate = clone(first.state);
    winnerCandidate.dataMode = "winner";
    const winner = repository.compareAndSwapState(winnerCandidate, {
      expectedChangeId: first.state.changeId,
    });
    assert.equal(winner.state.dataMode, "winner");

    const staleCandidate = clone(first.state);
    staleCandidate.dataMode = "stale-loser";
    assert.throws(
      () => repository.compareAndSwapState(staleCandidate, { expectedChangeId: first.state.changeId }),
      (error) => error.code === "STATE_CONFLICT"
        && error.currentState.changeId === winner.state.changeId
        && error.currentState.dataMode === "winner",
    );
    assert.equal(repository.loadState().state.dataMode, "winner");
    assert.equal(repository.storageStatus().historyCount, 1);
  });
});

test("独立 SQLite 快照同时通过 integrity_check 与 foreign_key_check", async () => {
  await withRepository(async (repository) => {
    repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    const result = await repository.createBackup("unit-test");
    assert.match(result.filename, /^relationship-care-.*-unit-test\.sqlite$/);
    assert.deepEqual(result.cleanupWarnings, []);

    const snapshot = new DatabaseSync(result.backupPath, { readOnly: true });
    try {
      const integrity = snapshot.prepare("PRAGMA integrity_check").all();
      const foreignKeys = snapshot.prepare("PRAGMA foreign_key_check").all();
      assert.equal(integrity.length, 1);
      assert.equal(integrity[0].integrity_check, "ok");
      assert.deepEqual(foreignKeys, []);
    } finally {
      snapshot.close();
    }
  });
});

test("备份发布 EXDEV 会标记脱敏阶段、清理 pending 且不降级为非原子复制", async () => {
  const sensitiveSource = "C:\\Users\\private-person\\secret-source.sqlite";
  const sensitiveDestination = "D:\\private-volume\\secret-destination.sqlite";
  await withRepository(async (repository, dataDir) => {
    repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    await assert.rejects(
      () => repository.createBackup("exdev-test"),
      (error) => {
        const details = backupFailureDetails(error);
        assert.equal(error.code, "BACKUP_STAGE_FAILED");
        assert.deepEqual(details, {
          phase: "publish-link",
          code: "EXDEV",
          syscall: "link",
          path: "backupDir/.pending.sqlite",
          dest: details.dest,
        });
        assert.match(details.dest, /^backupDir\/relationship-care-.*-exdev-test\.sqlite$/);
        assert.doesNotMatch(`${error.message}${JSON.stringify(details)}`, /private-person|private-volume|secret-source|secret-destination/);
        return true;
      },
    );
    const backupEntries = readdirSync(join(dataDir, "backups"));
    assert.deepEqual(backupEntries, []);
  }, {
    publishBackup() {
      const error = new Error("cross-device link not permitted");
      error.code = "EXDEV";
      error.syscall = "link";
      error.path = sensitiveSource;
      error.dest = sensitiveDestination;
      throw error;
    },
  });
});

test("备份发布失败不会删除无法证明属于本轮的既有目标", async () => {
  let preservedDestination = null;
  await withRepository(async (repository, dataDir) => {
    repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    await assert.rejects(
      () => repository.createBackup("ownership-test"),
      (error) => backupFailureDetails(error).phase === "publish-link",
    );
    assert.ok(preservedDestination);
    assert.equal(existsSync(preservedDestination), true, "publish 未提交时不能删除无所有权证明的目标");
    const entries = readdirSync(join(dataDir, "backups"));
    assert.equal(entries.filter((name) => name.startsWith(".pending-")).length, 0);
    assert.deepEqual(entries, [preservedDestination.split(/[\\/]/).at(-1)]);

    const preserved = new DatabaseSync(preservedDestination, { readOnly: true });
    try {
      assert.equal(preserved.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(preserved.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      preserved.close();
    }
  }, {
    publishBackup(source, destination) {
      preservedDestination = destination;
      copyFileSync(source, destination);
      const error = new Error("publish callback failed after an external owner created the destination");
      error.code = "EXDEV";
      error.syscall = "link";
      throw error;
    },
  });
});

test("仓库构造阶段完整性失败会立即关闭 SQLite 句柄", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "relationship-care-construction-close-test-"));
  const databasePath = join(dataDir, "relationship-care.sqlite");
  const movedPath = join(dataDir, "relationship-care-corrupt.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA user_version = 2;
      CREATE TABLE integrity_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE integrity_child(
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES integrity_parent(id)
      );
      INSERT INTO integrity_child(id, parent_id) VALUES(1, 999);
    `);
  } finally {
    database.close();
  }

  try {
    assert.throws(
      () => createStateRepository({ dataDir }),
      /integrity=ok, foreignKeys=1/,
    );
    renameSync(databasePath, movedPath);
    assert.equal(existsSync(movedPath), true, "构造失败后数据库文件必须可立即移动");
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("备份轮换只删除清单内且摘要匹配的程序快照", async () => {
  await withRepository(async (repository, dataDir) => {
    repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    const backupDir = join(dataDir, "backups");
    const manualName = "relationship-care-2026-08-30T12-00-00-000Z-00000000-0000-4000-8000-000000000000-user-copy.sqlite";
    const manualPath = join(backupDir, manualName);
    writeFileSync(manualPath, "这是用户自行保留、但文件名看似程序生成的备份。", { encoding: "utf8" });

    const created = [];
    created.push(await repository.createBackup("retention-test"));
    created.push(await repository.createBackup("retention-test"));
    created.push(await repository.createBackup("retention-test"));

    assert.equal(existsSync(manualPath), true, "没有持久所有权记录的文件绝不能进入自动删除范围");
    assert.equal(created.filter((entry) => existsSync(entry.backupPath)).length, 2);
    const entries = readdirSync(backupDir);
    assert.equal(entries.includes(manualName), true);
    assert.equal(entries.filter((name) => name.endsWith("-retention-test.sqlite")).length, 2);
  }, { backupRetention: 2 });
});

test("已登记快照被同长度篡改后永久退出轮换清单且不会重复警告", async () => {
  await withRepository(async (repository) => {
    repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });

    const expiring = await repository.createBackup("tamper-retention");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    await repository.createBackup("tamper-retention");

    const originalBytes = readFileSync(expiring.backupPath);
    assert.ok(originalBytes.length > 32, "测试快照必须足够大，才能安全构造同长度篡改反例");
    const tamperedBytes = Buffer.from(originalBytes);
    tamperedBytes[Math.floor(tamperedBytes.length / 2)] ^= 0xff;
    writeFileSync(expiring.backupPath, tamperedBytes);
    assert.equal(readFileSync(expiring.backupPath).length, originalBytes.length, "篡改前后 bytes 必须相同，以单独验证 SHA-256 门禁");

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    const rotation = await repository.createBackup("tamper-retention");
    assert.equal(existsSync(expiring.backupPath), true, "摘要不匹配的已登记快照绝不能被自动删除");
    assert.ok(
      rotation.cleanupWarnings.some((warning) => warning.includes(expiring.filename)
        && warning.includes("摘要已经变化")
        && warning.includes("不再自动删除")),
      "首次发现篡改必须返回包含文件名和退出管理语义的 warning",
    );

    const readManagedManifest = () => {
      const inspector = new DatabaseSync(repository.databasePath, { readOnly: true });
      try {
        const row = inspector.prepare("SELECT value FROM storage_meta WHERE key = ?")
          .get("managed_backup_manifest_v1");
        return JSON.parse(row.value);
      } finally {
        inspector.close();
      }
    };
    const afterTamper = readManagedManifest();
    assert.equal(afterTamper.length, 2);
    assert.equal(afterTamper.some((entry) => entry.filename === expiring.filename), false, "被篡改项必须从持久管理清单退出");

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    const nextRotation = await repository.createBackup("tamper-retention");
    assert.equal(existsSync(expiring.backupPath), true, "退出管理清单后，后续轮换仍不得重新认领或删除该文件");
    assert.equal(
      nextRotation.cleanupWarnings.some((warning) => warning.includes(expiring.filename)),
      false,
      "退出管理清单后不应对同一篡改文件重复产生轮换 warning",
    );
    const finalManifest = readManagedManifest();
    assert.equal(finalManifest.length, 2);
    assert.equal(finalManifest.some((entry) => entry.filename === expiring.filename), false);
    assert.ok(finalManifest.every((entry) => existsSync(join(repository.dataDir, "backups", entry.filename))));
  }, { backupRetention: 2 });
});

test("integrity_check 仍为 ok 时，仓库也会因孤儿外键拒绝数据库", async () => {
  await withRepository(async (repository) => {
    const injector = new DatabaseSync(repository.databasePath);
    try {
      injector.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE integrity_parent(id INTEGER PRIMARY KEY);
        CREATE TABLE integrity_child(
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES integrity_parent(id)
        );
        INSERT INTO integrity_child(id, parent_id) VALUES(1, 999);
      `);
      const integrity = injector.prepare("PRAGMA integrity_check").all();
      assert.equal(integrity.length, 1);
      assert.equal(integrity[0].integrity_check, "ok");
      assert.equal(injector.prepare("PRAGMA foreign_key_check").all().length, 1);
    } finally {
      injector.close();
    }

    assert.throws(
      () => repository.assertIntegrity(),
      /integrity=ok, foreignKeys=1/,
      "不能只依据 integrity_check=ok 接受存在孤儿外键的数据库",
    );
  });
});

test("历史保留上限独立生效，不影响当前状态", async () => {
  await withRepository(async (repository) => {
    let saved = repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    for (let index = 0; index < 5; index += 1) {
      const candidate = clone(saved.state);
      candidate.dataMode = `revision-${index}`;
      saved = repository.compareAndSwapState(candidate, { expectedChangeId: saved.state.changeId });
    }
    assert.equal(repository.storageStatus().historyCount, 2);
    assert.equal(repository.loadState().state.dataMode, "revision-4");
  }, { historyRetention: 2 });
});

function firstTagBatch(state, overrides = {}) {
  return {
    expectedChangeId: state.changeId,
    action: "add",
    tagId: state.tags[0].id,
    tagName: state.tags[0].name,
    contactIds: [state.contacts.find((contact) => !contact.customTagIds.includes(state.tags[0].id))?.id || state.contacts[0].id],
    scopeLabel: "全部筛选结果",
    operationId: randomUUID(),
    ...overrides,
  };
}

test("批量写入与唯一撤销记录同事务提交，公共快照不泄露 contactIds", async () => {
  await withRepository(async (repository) => {
    const initial = repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    const nowMs = 1_000_000;
    const operationId = "30000000-0000-4000-8000-000000000001";
    const saved = repository.applyBatchTagWithUndo(firstTagBatch(initial.state, { operationId }), { nowMs });
    assert.equal(saved.batch.changedCount, 1);
    assert.equal(saved.pendingUndo.id, operationId, "pending id 必须使用客户端提交的幂等操作标识");
    assert.equal(saved.pendingUndo.stateChangeId, saved.state.changeId);
    assert.equal(saved.pendingUndo.createdAt, nowMs);
    assert.equal(saved.pendingUndo.expiresAt, nowMs + 45_000);
    assert.equal(Object.hasOwn(saved.pendingUndo, "contactIds"), false);

    const snapshot = repository.loadAuthoritativeSnapshot({ nowMs: nowMs + 1 });
    assert.equal(snapshot.state.changeId, saved.state.changeId);
    assert.deepEqual(snapshot.pendingUndo, saved.pendingUndo);
    assert.equal(snapshot.serverNow, nowMs + 1);
    assert.equal(Object.hasOwn(snapshot.pendingUndo, "contactIds"), false);

    const inspector = new DatabaseSync(repository.databasePath, { readOnly: true });
    try {
      assert.equal(
        inspector.prepare("SELECT undo_id FROM pending_batch_undo WHERE id = 1").get().undo_id,
        operationId,
        "同一事务落盘的 pending_batch_undo.undo_id 必须保持 operationId",
      );
    } finally {
      inspector.close();
    }
  });
});

test("批量事务拒绝无效 UUID operationId，且不改变 state 或 pending", async () => {
  await withRepository(async (repository) => {
    const initial = repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null, nowMs: 10_000 });
    const before = repository.loadAuthoritativeSnapshot({ nowMs: 10_001 });
    for (const invalidOperationId of [null, "", "not-a-uuid", "30000000-0000-3000-8000-000000000001", "30000000-0000-4000-7000-000000000001"]) {
      assert.throws(
        () => repository.applyBatchTagWithUndo(firstTagBatch(initial.state, { operationId: invalidOperationId }), { nowMs: 20_000 }),
        (error) => error.code === "INVALID_BATCH_TAG" && /请求标识/.test(error.message),
        String(invalidOperationId),
      );
      const after = repository.loadAuthoritativeSnapshot({ nowMs: 20_001 });
      assert.equal(after.state.changeId, before.state.changeId);
      assert.equal(after.pendingUndo, null);
    }
  });
});

test("第二次批量操作覆盖第一条撤销，旧 ID 不能消费新记录", async () => {
  await withRepository(async (repository) => {
    const initial = repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    const first = repository.applyBatchTagWithUndo(firstTagBatch(initial.state), { nowMs: 1000 });
    const secondTarget = first.state.contacts.find((contact) => !contact.customTagIds.includes(first.state.tags[1].id));
    const second = repository.applyBatchTagWithUndo(firstTagBatch(first.state, {
      tagId: first.state.tags[1].id,
      tagName: first.state.tags[1].name,
      contactIds: [secondTarget.id],
    }), { nowMs: 2000 });
    assert.notEqual(second.pendingUndo.id, first.pendingUndo.id);
    assert.throws(
      () => repository.consumePendingBatchUndo({ expectedChangeId: second.state.changeId, undoId: first.pendingUndo.id }, { nowMs: 2001 }),
      (error) => error.code === "UNDO_NOT_FOUND" && error.currentPendingUndo.id === second.pendingUndo.id,
    );
    assert.equal(repository.loadAuthoritativeSnapshot({ nowMs: 2001 }).pendingUndo.id, second.pendingUndo.id);
  });
});

test("撤销在 44,999ms 成功、45,000ms 拒绝且到期记录不再公开", async () => {
  await withRepository(async (repository) => {
    const initial = repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    const batch = repository.applyBatchTagWithUndo(firstTagBatch(initial.state), { nowMs: 10_000 });
    const undone = repository.consumePendingBatchUndo({ expectedChangeId: batch.state.changeId, undoId: batch.pendingUndo.id }, { nowMs: 54_999 });
    assert.equal(undone.pendingUndo, null);
    assert.equal(undone.undone.changedCount, 1);

    const second = repository.applyBatchTagWithUndo(firstTagBatch(undone.state), { nowMs: 100_000 });
    assert.throws(
      () => repository.consumePendingBatchUndo({ expectedChangeId: second.state.changeId, undoId: second.pendingUndo.id }, { nowMs: 145_000 }),
      (error) => error.code === "UNDO_EXPIRED" && error.currentPendingUndo === null,
    );
    assert.equal(repository.loadAuthoritativeSnapshot({ nowMs: 145_000 }).pendingUndo, null);
  });
});

test("普通 PUT 成功原子清除撤销，CAS 冲突不清除", async () => {
  await withRepository(async (repository) => {
    const initial = repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    const batch = repository.applyBatchTagWithUndo(firstTagBatch(initial.state), { nowMs: 1000 });
    const stale = clone(batch.state);
    stale.dataMode = "stale";
    assert.throws(() => repository.compareAndSwapState(stale, { expectedChangeId: "wrong" }), /另一个页面/);
    assert.equal(repository.loadAuthoritativeSnapshot({ nowMs: 1001 }).pendingUndo.id, batch.pendingUndo.id);

    const candidate = clone(batch.state);
    candidate.dataMode = "ordinary-write";
    const saved = repository.compareAndSwapState(candidate, { expectedChangeId: batch.state.changeId });
    assert.equal(saved.clearedUndoId, batch.pendingUndo.id);
    assert.equal(saved.pendingUndo, null);
  });
});

test("仓库关闭重开后仍恢复未到期撤销", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "relationship-care-reopen-test-"));
  let repository = createStateRepository({ dataDir });
  try {
    const initial = repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    const batch = repository.applyBatchTagWithUndo(firstTagBatch(initial.state), { nowMs: 1000 });
    repository.close();
    repository = createStateRepository({ dataDir });
    assert.equal(repository.loadAuthoritativeSnapshot({ nowMs: 2000 }).pendingUndo.id, batch.pendingUndo.id);
  } finally {
    repository.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("pending 写入失败会回滚同事务中的 state 变化", async () => {
  await withRepository(async (repository) => {
    const initial = repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    const injector = new DatabaseSync(repository.databasePath);
    injector.exec("CREATE TRIGGER reject_pending_insert BEFORE INSERT ON pending_batch_undo BEGIN SELECT RAISE(ABORT, 'reject pending'); END;");
    injector.close();
    assert.throws(() => repository.applyBatchTagWithUndo(firstTagBatch(initial.state), { nowMs: 1000 }), /reject pending/);
    const current = repository.loadAuthoritativeSnapshot({ nowMs: 1001 });
    assert.equal(current.state.changeId, initial.state.changeId);
    assert.equal(current.pendingUndo, null);
  });
});

test("快照移除 pending undo，但主库仍保留并通过双完整性检查", async () => {
  await withRepository(async (repository) => {
    const initial = repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    const batch = repository.applyBatchTagWithUndo(firstTagBatch(initial.state), { nowMs: Date.now() });
    const result = await repository.createBackup("pending-privacy");
    const snapshot = new DatabaseSync(result.backupPath, { readOnly: true });
    try {
      assert.equal(snapshot.prepare("SELECT COUNT(*) AS count FROM pending_batch_undo").get().count, 0);
      assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(snapshot.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      snapshot.close();
    }
    assert.equal(repository.loadAuthoritativeSnapshot({ nowMs: Date.now() }).pendingUndo.id, batch.pendingUndo.id);
  });
});

test("v1 数据库事务迁移到 v2 并保留原状态", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "relationship-care-v1-migration-"));
  const databasePath = join(dataDir, "relationship-care.sqlite");
  const state = createDemoState(NOW);
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL, change_id TEXT NOT NULL UNIQUE,
      state_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL,
      change_id TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX idx_state_history_created_at ON state_history(created_at DESC);
    CREATE TABLE storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 1;
  `);
  legacy.prepare("INSERT INTO app_state VALUES(1, ?, ?, ?, ?, ?)")
    .run(state.schemaVersion, state.revision, "legacy-change", JSON.stringify({ ...state, changeId: "legacy-change" }), NOW.toISOString());
  legacy.close();

  const repository = createStateRepository({ dataDir });
  try {
    assert.equal(repository.loadState().state.changeId, "legacy-change");
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 2);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM pending_batch_undo").get().count, 0);
    } finally {
      migrated.close();
    }
  } finally {
    repository.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("user_version 高于 2 时拒绝启动且不降级版本", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "relationship-care-future-version-"));
  const databasePath = join(dataDir, "relationship-care.sqlite");
  const future = new DatabaseSync(databasePath);
  future.exec("PRAGMA user_version = 3;");
  future.close();
  assert.throws(
    () => createStateRepository({ dataDir }),
    (error) => error.code === "UNSUPPORTED_DATABASE_VERSION" && /版本 3/.test(error.message),
  );
  const unchanged = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(unchanged.prepare("PRAGMA user_version").get().user_version, 3);
  unchanged.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test("撤销消费阶段 DELETE 失败时状态和 pending 均原子回滚", async () => {
  await withRepository(async (repository) => {
    const initial = repository.compareAndSwapState(createDemoState(NOW), { expectedChangeId: null });
    const batch = repository.applyBatchTagWithUndo(firstTagBatch(initial.state), { nowMs: 1000 });
    const injector = new DatabaseSync(repository.databasePath);
    injector.exec("CREATE TRIGGER reject_pending_delete BEFORE DELETE ON pending_batch_undo BEGIN SELECT RAISE(ABORT, 'reject delete'); END;");
    injector.close();
    assert.throws(
      () => repository.consumePendingBatchUndo({ expectedChangeId: batch.state.changeId, undoId: batch.pendingUndo.id }, { nowMs: 2000 }),
      /reject delete/,
    );
    const current = repository.loadAuthoritativeSnapshot({ nowMs: 2001 });
    assert.equal(current.state.changeId, batch.state.changeId);
    assert.equal(current.pendingUndo.id, batch.pendingUndo.id);
  });
});

test("SQLite 批量事务正向支持恰好 50 人并可撤销", async () => {
  await withRepository(async (repository) => {
    const seed = createDemoState(NOW);
    const template = seed.contacts[0];
    seed.contacts = Array.from({ length: 50 }, (_, index) => ({
      ...clone(template),
      id: `bulk-${index}`,
      name: `联系人${index}`,
      customTagIds: [],
    }));
    const initial = repository.compareAndSwapState(seed, { expectedChangeId: null, nowMs: 10_000 });
    const batch = repository.applyBatchTagWithUndo({
      expectedChangeId: initial.state.changeId,
      action: "add",
      tagId: initial.state.tags[0].id,
      contactIds: initial.state.contacts.map((contact) => contact.id),
      scopeLabel: "本页手动勾选 50 人",
      operationId: randomUUID(),
    }, { nowMs: 20_000 });
    assert.equal(batch.batch.changedCount, 50);
    assert.equal(batch.pendingUndo.changedCount, 50);
    assert.equal(batch.state.contacts.every((contact) => contact.customTagIds.includes(initial.state.tags[0].id)), true);

    const undone = repository.consumePendingBatchUndo({
      expectedChangeId: batch.state.changeId,
      undoId: batch.pendingUndo.id,
    }, { nowMs: 64_999 });
    assert.equal(undone.undone.changedCount, 50);
    assert.equal(undone.state.contacts.every((contact) => contact.customTagIds.length === 0), true);
  });
});

test("SQLite 批量事务拒绝 51 人且 state 与 pending 均保持不变", async () => {
  await withRepository(async (repository) => {
    const seed = createDemoState(NOW);
    const template = seed.contacts[0];
    seed.contacts = Array.from({ length: 51 }, (_, index) => ({
      ...clone(template),
      id: `too-many-${index}`,
      name: `联系人${index}`,
      customTagIds: [],
    }));
    const initial = repository.compareAndSwapState(seed, { expectedChangeId: null, nowMs: 10_000 });
    const before = repository.loadAuthoritativeSnapshot({ nowMs: 10_001 });

    assert.throws(
      () => repository.applyBatchTagWithUndo({
        expectedChangeId: initial.state.changeId,
        action: "add",
        tagId: initial.state.tags[0].id,
        contactIds: initial.state.contacts.map((contact) => contact.id),
        scopeLabel: "非法 51 人",
        operationId: randomUUID(),
      }, { nowMs: 20_000 }),
      (error) => error.code === "INVALID_BATCH_TAG" && /最多包含 50/.test(error.message),
    );

    const after = repository.loadAuthoritativeSnapshot({ nowMs: 20_001 });
    assert.deepEqual(after.state, before.state);
    assert.equal(after.pendingUndo, null);
  });
});

test("SQLite 中旧版 51 人 pending 撤销记录仍可消费", async () => {
  await withRepository(async (repository) => {
    const seed = createDemoState(NOW);
    const template = seed.contacts[0];
    seed.contacts = Array.from({ length: 51 }, (_, index) => ({
      ...clone(template),
      id: `legacy-${index}`,
      name: `旧联系人${index}`,
      customTagIds: [seed.tags[0].id],
    }));
    const initial = repository.compareAndSwapState(seed, { expectedChangeId: null, nowMs: 10_000 });
    const legacyUndoId = "legacy-undo-51";
    const injector = new DatabaseSync(repository.databasePath);
    try {
      injector.prepare(`
        INSERT INTO pending_batch_undo(
          id, undo_id, state_change_id, action, tag_id, tag_name, contact_ids_json,
          scope_label, changed_count, created_at_ms, expires_at_ms
        ) VALUES(1, ?, ?, 'add', ?, ?, ?, ?, 51, 10000, 55000)
      `).run(
        legacyUndoId,
        initial.state.changeId,
        initial.state.tags[0].id,
        initial.state.tags[0].name,
        JSON.stringify(initial.state.contacts.map((contact) => contact.id)),
        "旧版 51 人批次",
      );
    } finally {
      injector.close();
    }

    const undone = repository.consumePendingBatchUndo({
      expectedChangeId: initial.state.changeId,
      undoId: legacyUndoId,
    }, { nowMs: 20_000 });
    assert.equal(undone.undone.changedCount, 51);
    assert.equal(undone.pendingUndo, null);
    assert.equal(undone.state.contacts.every((contact) => !contact.customTagIds.includes(initial.state.tags[0].id)), true);
  });
});
