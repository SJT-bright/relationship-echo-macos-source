import assert from "node:assert/strict";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { createDemoState } from "../src/data.js";
import { createStateRepository } from "../server/state-repository.mjs";
import {
  createConsistentSnapshot,
  exportTransfer,
  inspectDatabase,
  installTransfer,
  MAX_DATABASE_BYTES,
  MAX_TRANSFER_FILE_BYTES,
  readTransferPasswordFromStream,
  readTransferEnvelope,
  resolveTransferPassword,
  verifyInstalledTransfer,
  verifyTransfer,
} from "../server/migration-transfer.mjs";

const PASSWORD = "correct-horse-battery-staple-2026";
const WRONG_PASSWORD = "this-is-not-the-correct-password";

function availableBash() {
  if (process.platform !== "win32") return "/bin/bash";
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  return existsSync(gitBash) ? gitBash : null;
}

function bashPath(value) {
  if (process.platform !== "win32") return value;
  return value.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
}

async function waitForPath(path, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function createWorkspace(prefix = "relationship-echo-transfer-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createSourceDatabase(root, now = new Date("2026-08-30T00:00:00.000Z")) {
  const dataDir = join(root, "source");
  const repository = createStateRepository({ dataDir });
  const saved = repository.compareAndSwapState(createDemoState(now), { expectedChangeId: null, nowMs: now.getTime() });
  const databasePath = repository.databasePath;
  repository.close();
  return { databasePath, state: saved.state };
}

async function createTransfer(root) {
  const source = createSourceDatabase(root);
  const outputPath = join(root, "contacts.relationship-echo-transfer");
  const exported = await exportTransfer({ sourcePath: source.databasePath, outputPath, password: PASSWORD });
  return { ...source, outputPath, exported };
}

test("加密迁移包使用一致 SQLite 快照往返，公开外壳不泄露联系人正文", async (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { state, outputPath, exported } = await createTransfer(root);
  const verified = await verifyTransfer({ inputPath: outputPath, password: PASSWORD });

  assert.equal(verified.inspection.contactCount, state.contacts.length);
  assert.equal(verified.inspection.tagCount, state.tags.length);
  assert.equal(verified.inspection.revision, state.revision);
  assert.equal(verified.inspection.changeId, state.changeId);
  assert.equal(exported.manifest.plainSha256.length, 64);

  const serialized = readFileSync(outputPath, "utf8");
  assert.doesNotMatch(serialized, new RegExp(state.contacts[0].name));
  assert.doesNotMatch(serialized, new RegExp(state.contacts[0].lastMessageText));
  assert.doesNotMatch(serialized, new RegExp(state.tags[0].name));
  assert.equal(serialized.includes(PASSWORD), false);
});

test("源数据库保持打开且最新状态仍在活动 WAL 时也能导出一致快照", async (t) => {
  const root = createWorkspace();
  const repository = createStateRepository({ dataDir: join(root, "live-source") });
  t.after(() => {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  });
  const saved = repository.compareAndSwapState(createDemoState(new Date("2026-08-30T00:00:00.000Z")), {
    expectedChangeId: null,
    nowMs: Date.parse("2026-08-30T00:00:00.000Z"),
  });
  assert.ok(existsSync(`${repository.databasePath}-wal`));
  assert.ok(statSync(`${repository.databasePath}-wal`).size > 0, "test requires uncheckpointed WAL bytes");

  const outputPath = join(root, "live-wal.relationship-echo-transfer");
  await exportTransfer({ sourcePath: repository.databasePath, outputPath, password: PASSWORD });
  const verified = await verifyTransfer({ inputPath: outputPath, password: PASSWORD });
  assert.equal(verified.inspection.changeId, saved.state.changeId);
  assert.equal(verified.inspection.revision, saved.state.revision);
  assert.equal(verified.inspection.contactCount, saved.state.contacts.length);
});

test("超大源数据库在 backup 与 integrity_check 前即被页预算拒绝", async (t) => {
  const root = createWorkspace("relationship-echo-oversized-source-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oversizedPath = join(root, "oversized.sqlite");
  const database = new DatabaseSync(oversizedPath);
  database.exec(`
    PRAGMA page_size = 4096;
    CREATE TABLE oversized(payload BLOB NOT NULL);
    INSERT INTO oversized(payload) VALUES(zeroblob(${MAX_DATABASE_BYTES}));
  `);
  database.close();
  assert.ok(statSync(oversizedPath).size > MAX_DATABASE_BYTES);

  const destinationPath = join(root, "snapshot.sqlite");
  await assert.rejects(
    () => createConsistentSnapshot(oversizedPath, destinationPath),
    (error) => error.code === "TRANSFER_TOO_LARGE",
  );
  assert.equal(existsSync(destinationPath), false);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith("snapshot.sqlite.pending-")),
    [],
  );
});

test("错误密码、密文篡改和公开清单篡改都失败关闭", async (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { outputPath } = await createTransfer(root);

  await assert.rejects(
    () => verifyTransfer({ inputPath: outputPath, password: WRONG_PASSWORD }),
    (error) => error.code === "TRANSFER_AUTH_FAILED",
  );

  const original = readTransferEnvelope(outputPath);
  const ciphertext = Buffer.from(original.ciphertext, "base64");
  ciphertext[Math.floor(ciphertext.length / 2)] ^= 0x01;
  const tamperedCiphertextPath = join(root, "tampered-ciphertext.relationship-echo-transfer");
  writeFileSync(tamperedCiphertextPath, JSON.stringify({ ...original, ciphertext: ciphertext.toString("base64") }));
  await assert.rejects(
    () => verifyTransfer({ inputPath: tamperedCiphertextPath, password: PASSWORD }),
    (error) => error.code === "TRANSFER_AUTH_FAILED",
  );

  const tamperedManifestPath = join(root, "tampered-manifest.relationship-echo-transfer");
  writeFileSync(tamperedManifestPath, JSON.stringify({
    ...original,
    manifest: { ...original.manifest, contactCount: original.manifest.contactCount + 1 },
  }));
  await assert.rejects(
    () => verifyTransfer({ inputPath: tamperedManifestPath, password: PASSWORD }),
    (error) => error.code === "TRANSFER_AUTH_FAILED",
  );
});

test("截断或格式错误的迁移包不会产生明文数据库", async (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invalidPath = join(root, "truncated.relationship-echo-transfer");
  writeFileSync(invalidPath, '{"format":"relationship-echo-transfer"');
  await assert.rejects(
    () => verifyTransfer({ inputPath: invalidPath, password: PASSWORD }),
    (error) => error.code === "TRANSFER_INVALID",
  );
  assert.deepEqual(existsSync(join(root, "relationship-care.sqlite")), false);
});

test("超过迁移文件硬上限时在解析和密钥派生前受控拒绝", (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oversizedPath = join(root, "oversized.relationship-echo-transfer");
  writeFileSync(oversizedPath, "{}");
  truncateSync(oversizedPath, MAX_TRANSFER_FILE_BYTES + 1);
  assert.throws(
    () => readTransferEnvelope(oversizedPath),
    (error) => error.code === "TRANSFER_TOO_LARGE",
  );
});

test("密文 Base64 解码长度必须与受限 manifest.bytes 完全一致", async (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { outputPath } = await createTransfer(root);
  const envelope = readTransferEnvelope(outputPath);
  const invalidPath = join(root, "length-mismatch.relationship-echo-transfer");
  writeFileSync(invalidPath, JSON.stringify({
    ...envelope,
    manifest: { ...envelope.manifest, bytes: envelope.manifest.bytes + 1 },
  }));
  assert.throws(
    () => readTransferEnvelope(invalidPath),
    (error) => error.code === "TRANSFER_INVALID",
  );
});

test("数据库迁移门禁同时拒绝 foreign_key_check 孤儿记录", (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { databasePath } = createSourceDatabase(root);
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE migration_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE migration_child(parent_id INTEGER REFERENCES migration_parent(id));
    INSERT INTO migration_child(parent_id) VALUES(999);
  `);
  database.close();
  assert.throws(
    () => inspectDatabase(databasePath),
    (error) => error.code === "DATABASE_INTEGRITY_FAILED" && /foreignKeys=1/.test(error.message),
  );
});

test("Mac 安装使用原子发布且始终拒绝覆盖已有数据库", async (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { outputPath, state } = await createTransfer(root);
  const targetDataDir = join(root, "Library", "Application Support", "Relationship Echo");

  const first = await installTransfer({
    inputPath: outputPath,
    password: PASSWORD,
    targetDataDir,
    platform: "darwin",
  });
  assert.equal(first.inspection.contactCount, state.contacts.length);
  assert.equal(first.backupPath, null);
  const receipt = verifyInstalledTransfer({ inputPath: outputPath, databasePath: first.targetPath });
  assert.equal(receipt.inspection.changeId, state.changeId);

  await assert.rejects(
    () => installTransfer({ inputPath: outputPath, password: PASSWORD, targetDataDir, platform: "darwin" }),
    (error) => error.code === "TARGET_EXISTS",
  );

  await assert.rejects(
    () => installTransfer({
      inputPath: outputPath,
      password: PASSWORD,
      targetDataDir,
      platform: "darwin",
      replace: true,
    }),
    (error) => error.code === "TARGET_EXISTS",
  );
  assert.equal(inspectDatabase(first.targetPath).changeId, state.changeId);
});

test("无密码恢复复核拒绝不是本次迁移的目标数据库", async (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { outputPath } = await createTransfer(root);
  const unrelated = createSourceDatabase(join(root, "unrelated"), new Date("2026-08-31T00:00:00.000Z"));
  assert.throws(
    () => verifyInstalledTransfer({ inputPath: outputPath, databasePath: unrelated.databasePath }),
    (error) => error.code === "TRANSFER_HASH_MISMATCH",
  );
});

test("无密码恢复复核拒绝尾部被追加字节的已安装数据库", async (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { outputPath } = await createTransfer(root);
  const installed = await installTransfer({
    inputPath: outputPath,
    password: PASSWORD,
    targetDataDir: join(root, "target"),
    platform: "darwin",
  });
  const originalBytes = statSync(installed.targetPath).size;

  verifyInstalledTransfer({ inputPath: outputPath, databasePath: installed.targetPath });
  writeFileSync(installed.targetPath, Buffer.from([0x52, 0x45]), { flag: "a" });
  assert.equal(statSync(installed.targetPath).size, originalBytes + 2);
  assert.throws(
    () => verifyInstalledTransfer({ inputPath: outputPath, databasePath: installed.targetPath }),
    (error) => error.code === "TRANSFER_HASH_MISMATCH",
  );
});

test("检测到目标 WAL/SHM 时拒绝替换并保持现有数据库不变", async (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { outputPath } = await createTransfer(root);
  const targetDataDir = join(root, "target");
  const first = await installTransfer({ inputPath: outputPath, password: PASSWORD, targetDataDir, platform: "darwin" });
  const before = readFileSync(first.targetPath);
  writeFileSync(`${first.targetPath}-wal`, "active");

  await assert.rejects(
    () => installTransfer({
      inputPath: outputPath,
      password: PASSWORD,
      targetDataDir,
      platform: "darwin",
    }),
    (error) => error.code === "DATABASE_IN_USE",
  );
  assert.deepEqual(readFileSync(first.targetPath), before);
});

test("匿名输入只接受一行强密码并拒绝超限内容", async () => {
  assert.equal(await readTransferPasswordFromStream(Readable.from([`${PASSWORD}\n`])), PASSWORD);
  await assert.rejects(
    () => readTransferPasswordFromStream(Readable.from([`${PASSWORD}\nsecond-line\n`])),
    (error) => error.code === "TRANSFER_PASSWORD_INVALID",
  );
  await assert.rejects(
    () => readTransferPasswordFromStream(Readable.from(["x".repeat(8_193)])),
    (error) => error.code === "TRANSFER_PASSWORD_TOO_LARGE",
  );
  for (const invalidPassword of [
    ` ${PASSWORD}\n`,
    `${PASSWORD} \n`,
    `${PASSWORD}\0\n`,
  ]) {
    await assert.rejects(
      () => readTransferPasswordFromStream(Readable.from([invalidPassword])),
      (error) => error.code === "TRANSFER_PASSWORD_INVALID",
    );
  }
  assert.throws(
    () => resolveTransferPassword({ environment: { RELATIONSHIP_ECHO_TRANSFER_PASSWORD: `${PASSWORD}\nsecond` } }),
    (error) => error.code === "TRANSFER_PASSWORD_INVALID",
  );
  assert.equal(
    resolveTransferPassword({ environment: { RELATIONSHIP_ECHO_TRANSFER_PASSWORD: "迁移密码足够长" } }),
    "迁移密码足够长",
  );
});

test("密码文件只接受单行密码并严格拒绝多行或边缘空白", (t) => {
  const root = createWorkspace("relationship-echo-password-file-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [name, content] of [
    ["without-newline", PASSWORD],
    ["with-lf", `${PASSWORD}\n`],
    ["with-crlf", `${PASSWORD}\r\n`],
  ]) {
    const passwordPath = join(root, `${name}.txt`);
    writeFileSync(passwordPath, content);
    assert.equal(resolveTransferPassword({ passwordFile: passwordPath, environment: {} }), PASSWORD);
  }

  for (const [name, content] of [
    ["two-lines", `${PASSWORD}\nsecond-line\n`],
    ["extra-empty-line", `${PASSWORD}\n\n`],
    ["leading-space", ` ${PASSWORD}\n`],
    ["trailing-space", `${PASSWORD} \n`],
    ["trailing-tab", `${PASSWORD}\t\r\n`],
  ]) {
    const passwordPath = join(root, `${name}.txt`);
    writeFileSync(passwordPath, content);
    assert.throws(
      () => resolveTransferPassword({ passwordFile: passwordPath, environment: {} }),
      (error) => error.code === "TRANSFER_PASSWORD_INVALID",
      name,
    );
  }
});

test("Mac 安装锁真实拒绝第二个活动进程且不改写首个 owner", { skip: !availableBash() }, async (t) => {
  const root = createWorkspace("relationship-echo-lock-");
  const bash = availableBash();
  const lockLibrary = fileURLToPath(new URL("../scripts/mac-install-lock.sh", import.meta.url));
  const readyPath = join(root, "ready");
  const releasePath = join(root, "release");
  const lockOwnerPath = join(root, "install.lock", "owner");
  const holderScript = `
    set -euo pipefail
    LOCK_DIR="$1/install.lock"
    LOCK_OWNER_FILE="$LOCK_DIR/owner"
    LOCK_OWNER_TOKEN="holder-$$"
    LOCK_HELD=0
    . "$2"
    acquire_install_lock
    printf ready > "$1/ready"
    while [[ ! -f "$1/release" ]]; do sleep 0.05; done
    release_install_lock
  `;
  const holder = spawn(bash, ["-c", holderScript, "lock-holder", bashPath(root), bashPath(lockLibrary)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let holderStderr = "";
  holder.stderr.setEncoding("utf8");
  holder.stderr.on("data", (chunk) => { holderStderr += chunk; });
  t.after(() => {
    try { writeFileSync(releasePath, "release"); } catch {}
    if (holder.exitCode === null) holder.kill();
    rmSync(root, { recursive: true, force: true });
  });
  await waitForPath(readyPath);
  const ownerBefore = readFileSync(lockOwnerPath, "utf8");

  const contenderScript = `
    set -euo pipefail
    LOCK_DIR="$1/install.lock"
    LOCK_OWNER_FILE="$LOCK_DIR/owner"
    LOCK_OWNER_TOKEN="contender-$$"
    LOCK_HELD=0
    . "$2"
    acquire_install_lock
    release_install_lock
  `;
  const contender = spawnSync(
    bash,
    ["-c", contenderScript, "lock-contender", bashPath(root), bashPath(lockLibrary)],
    { encoding: "utf8" },
  );
  assert.notEqual(contender.status, 0);
  assert.match(contender.stderr, /本次未执行任何恢复或清理/);
  assert.equal(readFileSync(lockOwnerPath, "utf8"), ownerBefore);

  writeFileSync(releasePath, "release");
  const [holderCode] = await once(holder, "exit");
  assert.equal(holderCode, 0, holderStderr);
  assert.equal(existsSync(join(root, "install.lock")), false);
});

test("Mac 安装锁仅回收死 PID 的空 stale 锁并拒绝含未知内容的锁", { skip: !availableBash() }, (t) => {
  const root = createWorkspace("relationship-echo-stale-lock-");
  const bash = availableBash();
  const lockLibrary = fileURLToPath(new URL("../scripts/mac-install-lock.sh", import.meta.url));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const staleLock = join(root, "reclaimable", "install.lock");
  mkdirSync(staleLock, { recursive: true });
  writeFileSync(join(staleLock, "owner"), "pid=99999999\nowner=dead-owner\n");
  const reclaimScript = `
    set -euo pipefail
    LOCK_DIR="$1/reclaimable/install.lock"
    LOCK_OWNER_FILE="$LOCK_DIR/owner"
    LOCK_OWNER_TOKEN="rescuer-$$"
    LOCK_HELD=0
    . "$2"
    acquire_install_lock
    grep -q "owner=$LOCK_OWNER_TOKEN" "$LOCK_OWNER_FILE"
    release_install_lock
  `;
  const reclaimed = spawnSync(
    bash,
    ["-c", reclaimScript, "stale-reclaimer", bashPath(root), bashPath(lockLibrary)],
    { encoding: "utf8" },
  );
  assert.equal(reclaimed.status, 0, reclaimed.stderr);
  assert.equal(existsSync(staleLock), false);

  const guardedLock = join(root, "guarded", "install.lock");
  mkdirSync(guardedLock, { recursive: true });
  writeFileSync(join(guardedLock, "owner"), "pid=99999999\nowner=dead-owner\n");
  writeFileSync(join(guardedLock, "unexpected"), "must-not-delete");
  const guardedScript = reclaimScript.replaceAll("reclaimable", "guarded");
  const guarded = spawnSync(
    bash,
    ["-c", guardedScript, "stale-guard", bashPath(root), bashPath(lockLibrary)],
    { encoding: "utf8" },
  );
  assert.notEqual(guarded.status, 0);
  assert.match(guarded.stderr, /陈旧安装锁中含未知内容，未自动删除/);
  assert.equal(readFileSync(join(guardedLock, "unexpected"), "utf8"), "must-not-delete");
});

test("两个进程并发回收同一 stale 锁时只有一个能成为活动 owner", { skip: !availableBash() }, async (t) => {
  const root = createWorkspace("relationship-echo-stale-race-");
  const bash = availableBash();
  const lockLibrary = fileURLToPath(new URL("../scripts/mac-install-lock.sh", import.meta.url));
  const staleLock = join(root, "install.lock");
  mkdirSync(staleLock, { recursive: true });
  writeFileSync(join(staleLock, "owner"), "pid=99999999\nowner=dead-owner\n");

  const workerScript = `
    set -euo pipefail
    LOCK_DIR="$1/install.lock"
    LOCK_OWNER_FILE="$LOCK_DIR/owner"
    LOCK_OWNER_TOKEN="winner-$3-$$"
    LOCK_HELD=0
    . "$2"
    while [[ ! -f "$1/start" ]]; do sleep 0.02; done
    acquire_install_lock
    printf ready > "$1/ready-$3"
    while [[ ! -f "$1/release" ]]; do sleep 0.02; done
    release_install_lock
  `;
  const children = ["A", "B"].map((id) => spawn(
    bash,
    ["-c", workerScript, `stale-race-${id}`, bashPath(root), bashPath(lockLibrary), id],
    { stdio: ["ignore", "pipe", "pipe"] },
  ));
  const exitPromises = children.map((child) => new Promise((resolvePromise) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => resolvePromise({ code, stderr }));
  }));
  t.after(() => {
    try { writeFileSync(join(root, "release"), "release"); } catch {}
    for (const child of children) if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  });

  writeFileSync(join(root, "start"), "start");
  const readyA = join(root, "ready-A");
  const readyB = join(root, "ready-B");
  const deadline = Date.now() + 3_000;
  while (!existsSync(readyA) && !existsSync(readyB) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.notEqual(existsSync(readyA), existsSync(readyB), "exactly one stale reclaimer must hold the lock");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  assert.notEqual(existsSync(readyA), existsSync(readyB), "loser must not acquire after winner is active");
  const winner = existsSync(readyA) ? "A" : "B";
  assert.match(readFileSync(join(staleLock, "owner"), "utf8"), new RegExp(`owner=winner-${winner}-`));

  writeFileSync(join(root, "release"), "release");
  const results = await Promise.all(exitPromises);
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
  assert.match(results.find((result) => result.code !== 0).stderr, /本次未执行任何恢复或清理/);
  assert.equal(existsSync(staleLock), false);
});

test("Mac 数据事务在调用安装器前连续开启恢复保留并在日志清理后才解除", () => {
  const script = readFileSync(new URL("../scripts/在Mac上构建关系回响.command", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n");
  assert.match(
    script,
    /write_install_journal data-installing\nPRESERVE_RECOVERY_STATE=1\nprintf '%s\\n' "\$TRANSFER_PASSWORD" \| node scripts\/install-mac-data\.mjs[^\n]+--password-stdin/,
  );

  const dataInstallingAt = script.indexOf("write_install_journal data-installing");
  const installAt = script.indexOf("install-mac-data.mjs", dataInstallingAt);
  const identityAt = script.indexOf("verify-installed-mac-data.mjs", installAt);
  const committedAt = script.indexOf("write_install_journal data-committed", identityAt);
  const journalRemovedAt = script.indexOf('rm -f -- "$INSTALL_JOURNAL" "$JOURNAL_PENDING"', committedAt);
  const preserveReleasedAt = script.indexOf("PRESERVE_RECOVERY_STATE=0", journalRemovedAt);
  assert.ok(dataInstallingAt >= 0
    && dataInstallingAt < installAt
    && installAt < identityAt
    && identityAt < committedAt
    && committedAt < journalRemovedAt
    && journalRemovedAt < preserveReleasedAt);
  assert.doesNotMatch(script.slice(dataInstallingAt, journalRemovedAt), /PRESERVE_RECOVERY_STATE=0/);
});

test("Mac 构建脚本用匿名管道传密码并以持久日志恢复 App 安装", () => {
  const script = readFileSync(new URL("../scripts/在Mac上构建关系回响.command", import.meta.url), "utf8");
  const lockLibrary = readFileSync(new URL("../scripts/mac-install-lock.sh", import.meta.url), "utf8");
  assert.match(script, /^#!\/bin\/bash\nset -euo pipefail/m);
  assert.match(script, /IFS= read -r -s -p/);
  assert.doesNotMatch(script, /RELATIONSHIP_ECHO_TRANSFER_PASSWORD/);
  assert.match(script, /trap cleanup EXIT/);
  assert.doesNotMatch(script, /--password(?:\s|=)/);
  assert.match(script, /printf '%s\\n' "\$TRANSFER_PASSWORD" \| node scripts\/verify-mac-transfer\.mjs[^\n]+--password-stdin/);
  assert.match(script, /printf '%s\\n' "\$TRANSFER_PASSWORD" \| node scripts\/install-mac-data\.mjs[^\n]+--password-stdin/);
  assert.match(script, /shasum -a 256 -c SHA256SUMS\.txt/);
  assert.match(script, /确认完全一致后输入 YES/);
  assert.match(script, /CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac:dir/);
  assert.match(script, /codesign --force --deep --sign -/);
  assert.match(script, /npm run test:electron-smoke -- --packaged-app "\$BUILT_APP"/);
  assert.match(script, /FINAL_APP="\$FINAL_APP_DIR\/关系回响\.app"/);
  assert.match(script, /STAGING_APP="\$FINAL_APP_DIR\/\.relationship-echo-incoming-\$\{transaction_id\}\.app"/);
  assert.match(script, /ROLLBACK_APP="\$FINAL_APP_DIR\/\.relationship-echo-rollback-\$\{transaction_id\}\.app"/);
  assert.match(script, /INSTALL_JOURNAL=.*\.relationship-echo-install\.journal/);
  assert.match(script, /LOCK_DIR=.*\.relationship-echo-install\.lock/);
  assert.match(script, /\. "\$APP_DIR\/scripts\/mac-install-lock\.sh"/);
  assert.match(lockLibrary, /if mkdir -- "\$LOCK_DIR"/);
  assert.match(lockLibrary, /kill -0 "\$existing_pid"/);
  assert.match(lockLibrary, /本次未执行任何恢复或清理/);
  assert.match(script, /release_install_lock/);
  assert.match(script, /write_install_journal prepared/);
  assert.match(script, /write_install_journal old-moved/);
  assert.match(script, /write_install_journal app-published/);
  assert.match(script, /write_install_journal data-installing/);
  assert.match(script, /write_install_journal data-committed/);
  assert.match(script, /write_install_journal complete/);
  assert.match(script, /version=2\\ntransaction_id=%s\\nphase=%s/);
  assert.match(script, /set_transaction_paths "\$RECOVERY_TRANSACTION_ID"/);
  assert.match(script, /发现没有事务日志可以证明归属的旧暂存\/回滚文件/);
  assert.doesNotMatch(script, /rm -rf -- "\$LEGACY_STAGING_APP"|rm -rf -- "\$LEGACY_ROLLBACK_APP"/);
  assert.match(script, /verify-installed-mac-data\.mjs/);
  assert.match(script, /RECOVERY_PHASE/);
  assert.match(script, /sync/);
  assert.match(script, /ditto "\$BUILT_APP" "\$STAGING_APP"/);
  assert.match(script, /mv -- "\$STAGING_APP" "\$FINAL_APP"/);
  assert.doesNotMatch(script, /ditto "\$BUILT_APP" "\$FINAL_APP"/);
  const installAt = script.indexOf("npm ci");
  const verifyAt = script.indexOf("verify-mac-transfer.mjs");
  const testAt = script.indexOf("npm test");
  const buildAt = script.indexOf("npm run dist:mac:dir");
  const codeSignAt = script.indexOf("codesign --force --deep --sign -");
  const packagedSmokeAt = script.indexOf('npm run test:electron-smoke -- --packaged-app "$BUILT_APP"');
  const appPublishAt = script.indexOf('mv -- "$STAGING_APP" "$FINAL_APP"');
  const readPasswordAt = script.indexOf("read -r -s -p");
  const migrateAt = script.indexOf("install-mac-data.mjs");
  const journalPrepareAt = script.indexOf("write_install_journal prepared");
  const journalDataAt = script.indexOf("write_install_journal data-installing");
  const preserveAfterDataAt = script.indexOf("PRESERVE_RECOVERY_STATE=1", journalDataAt);
  const installedIdentityAt = script.lastIndexOf("verify-installed-mac-data.mjs");
  const journalCommittedAt = script.indexOf("write_install_journal data-committed");
  const journalCompleteAt = script.indexOf("write_install_journal complete");
  const lockAt = script.lastIndexOf("acquire_install_lock");
  const recoveryAt = script.indexOf('if [[ -f "$INSTALL_JOURNAL" ]]');
  assert.ok(installAt >= 0 && installAt < testAt && testAt < buildAt
    && buildAt < codeSignAt && codeSignAt < packagedSmokeAt && packagedSmokeAt < appPublishAt
    && appPublishAt < readPasswordAt
    && journalPrepareAt < appPublishAt
    && readPasswordAt < verifyAt && verifyAt < journalDataAt
    && journalDataAt < preserveAfterDataAt && preserveAfterDataAt < migrateAt
    && migrateAt < installedIdentityAt
    && installedIdentityAt < journalCommittedAt && journalCommittedAt < journalCompleteAt
    && lockAt < recoveryAt && recoveryAt < installAt);
});

test("Mac 前向安装以 v2 事务绑定唯一暂存路径且发行版 smoke 前不删除 App", () => {
  const script = readFileSync(new URL("../scripts/在Mac上构建关系回响.command", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n");

  assert.match(
    script,
    /printf 'version=2\\ntransaction_id=%s\\nphase=%s\\n' "\$ACTIVE_TRANSACTION_ID" "\$phase" > "\$JOURNAL_PENDING"/,
    "事务日志必须同时持久化 v2、事务身份和阶段",
  );
  assert.match(script, /if \[\[ "\$RECOVERY_VERSION" != "2" \]\] \|\| ! set_transaction_paths "\$RECOVERY_TRANSACTION_ID"; then/);
  assert.match(script, /STAGING_APP="\$FINAL_APP_DIR\/\.relationship-echo-incoming-\$\{transaction_id\}\.app"/);
  assert.match(script, /ROLLBACK_APP="\$FINAL_APP_DIR\/\.relationship-echo-rollback-\$\{transaction_id\}\.app"/);

  const uniquePathsAt = script.indexOf('set_transaction_paths "$LOCK_OWNER_TOKEN"');
  const packagedSmokeAt = script.indexOf('npm run test:electron-smoke -- --packaged-app "$BUILT_APP"');
  const preparedAt = script.indexOf("write_install_journal prepared", packagedSmokeAt);
  const stagedCopyAt = script.indexOf('ditto "$BUILT_APP" "$STAGING_APP"', preparedAt);
  const previousAppMoveAt = script.indexOf('mv -- "$FINAL_APP" "$ROLLBACK_APP"', stagedCopyAt);
  const finalPublishAt = script.indexOf('mv -- "$STAGING_APP" "$FINAL_APP"', stagedCopyAt);

  assert.ok(uniquePathsAt >= 0
    && uniquePathsAt < packagedSmokeAt
    && packagedSmokeAt < preparedAt
    && preparedAt < stagedCopyAt
    && stagedCopyAt < previousAppMoveAt
    && previousAppMoveAt < finalPublishAt,
  "发行版 smoke 必须先通过，之后才能写 prepared 日志、创建唯一暂存并替换 App");

  const freshFlowBeforePackagedSmoke = script.slice(uniquePathsAt, packagedSmokeAt);
  assert.doesNotMatch(
    freshFlowBeforePackagedSmoke,
    /rm\s+-[^\n]*\s+--\s+"\$(?:FINAL_APP|STAGING_APP|ROLLBACK_APP|INSTALL_JOURNAL|JOURNAL_PENDING)"/,
    "本轮唯一路径建立后，发行版 smoke 通过前不能删除任何 App 或事务日志",
  );
  assert.doesNotMatch(
    freshFlowBeforePackagedSmoke,
    /(?:mv|ditto)\s+[^\n]*"\$(?:FINAL_APP|STAGING_APP|ROLLBACK_APP)"/,
    "发行版 smoke 通过前不能移动、复制或发布 App",
  );
});
