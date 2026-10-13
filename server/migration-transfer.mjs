import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { MAX_CONTACTS } from "../src/limits.js";
import { validateState } from "../src/storage.js";

export const TRANSFER_FORMAT = "relationship-echo-transfer";
export const TRANSFER_VERSION = 1;
export const DATABASE_SCHEMA_VERSION = 2;
export const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
export const MAX_TRANSFER_FILE_BYTES = 96 * 1024 * 1024;
export const MAX_TRANSFER_PASSWORD_BYTES = 4_096;
export const MAX_SOURCE_PHYSICAL_BYTES = 256 * 1024 * 1024;

const scryptAsync = promisify(scryptCallback);
const SCRYPT_OPTIONS = Object.freeze({ N: 32_768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
const KEY_BYTES = 32;
const MINIMUM_PASSWORD_BYTES = 16;

function transferError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertDatabaseByteLimit(bytes, label = "迁移数据库") {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_DATABASE_BYTES) {
    throw transferError("TRANSFER_TOO_LARGE", `${label}必须小于或等于 ${MAX_DATABASE_BYTES} 字节。`);
  }
  return bytes;
}

function assertLogicalPageLimit(pageCount, pageSize) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw transferError("DATABASE_STATE_INVALID", "无法读取 SQLite 页大小信息。");
  }
  const logicalBytes = BigInt(pageCount) * BigInt(pageSize);
  if (logicalBytes > BigInt(MAX_DATABASE_BYTES)) {
    throw transferError("TRANSFER_TOO_LARGE", `SQLite 逻辑数据库必须小于或等于 ${MAX_DATABASE_BYTES} 字节。`);
  }
  return Number(logicalBytes);
}

function assertSourcePhysicalLimit(sourcePath) {
  let physicalBytes = statSync(sourcePath).size;
  const walPath = `${sourcePath}-wal`;
  const walStat = statSync(walPath, { throwIfNoEntry: false });
  if (walStat) physicalBytes += walStat.size;
  if (!Number.isSafeInteger(physicalBytes) || physicalBytes > MAX_SOURCE_PHYSICAL_BYTES) {
    throw transferError(
      "TRANSFER_TOO_LARGE",
      `SQLite 主库与活动 WAL 合计必须小于或等于 ${MAX_SOURCE_PHYSICAL_BYTES} 字节。`,
    );
  }
  return physicalBytes;
}

function fsyncFile(filePath) {
  const descriptor = openSync(filePath, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(directoryPath) {
  // Windows cannot open a directory as a regular fs descriptor. Production
  // installation is macOS-only; skipping this branch keeps cross-platform
  // contract tests able to exercise the otherwise identical transaction.
  if (process.platform === "win32") return;
  const descriptor = openSync(directoryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function requirePassword(password) {
  if (typeof password !== "string") {
    throw transferError("TRANSFER_PASSWORD_WEAK", `迁移密码至少需要 ${MINIMUM_PASSWORD_BYTES} 个 UTF-8 字节。`);
  }
  if (/[\0\r\n]/.test(password) || password.trim() !== password) {
    throw transferError("TRANSFER_PASSWORD_INVALID", "迁移密码不能包含换行、NUL 或首尾空白。");
  }
  const passwordBytes = Buffer.byteLength(password, "utf8");
  if (passwordBytes < MINIMUM_PASSWORD_BYTES) {
    throw transferError("TRANSFER_PASSWORD_WEAK", `迁移密码至少需要 ${MINIMUM_PASSWORD_BYTES} 个 UTF-8 字节。`);
  }
  if (passwordBytes > MAX_TRANSFER_PASSWORD_BYTES) {
    throw transferError("TRANSFER_PASSWORD_TOO_LARGE", "迁移密码超过安全上限。");
  }
  return password;
}

function assertBase64Shape(value, field, expectedBytes = null) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw transferError("TRANSFER_INVALID", `迁移包字段 ${field} 不是有效 Base64。`);
  }
  const paddingBytes = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - paddingBytes;
  if (expectedBytes !== null && decodedBytes !== expectedBytes) {
    throw transferError("TRANSFER_INVALID", `迁移包字段 ${field} 长度无效。`);
  }
  return decodedBytes;
}

function decodeBase64(value, field, expectedBytes = null) {
  assertBase64Shape(value, field, expectedBytes);
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value || (expectedBytes !== null && buffer.length !== expectedBytes)) {
    throw transferError("TRANSFER_INVALID", `迁移包字段 ${field} 长度无效。`);
  }
  return buffer;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw transferError("TRANSFER_INVALID", `${label} 不是有效对象。`);
  }
  return value;
}

function assertManifest(manifest) {
  assertPlainObject(manifest, "迁移清单");
  const integerFields = ["databaseUserVersion", "stateSchemaVersion", "revision", "contactCount", "tagCount", "bytes"];
  for (const field of integerFields) {
    if (!Number.isSafeInteger(manifest[field]) || manifest[field] < 0) {
      throw transferError("TRANSFER_INVALID", `迁移清单字段 ${field} 无效。`);
    }
  }
  assertDatabaseByteLimit(manifest.bytes);
  if (manifest.contactCount > MAX_CONTACTS || manifest.tagCount > 500) {
    throw transferError("TRANSFER_INVALID", "迁移清单中的联系人或标签数量超过应用上限。");
  }
  if (manifest.databaseUserVersion !== DATABASE_SCHEMA_VERSION) {
    throw transferError("TRANSFER_VERSION_UNSUPPORTED", `迁移数据库版本 ${manifest.databaseUserVersion} 不受支持。`);
  }
  if (manifest.stateSchemaVersion !== 1) {
    throw transferError("TRANSFER_VERSION_UNSUPPORTED", `迁移状态版本 ${manifest.stateSchemaVersion} 不受支持。`);
  }
  if (typeof manifest.changeId !== "string" || manifest.changeId.length < 1 || manifest.changeId.length > 160) {
    throw transferError("TRANSFER_INVALID", "迁移清单 changeId 无效。");
  }
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw transferError("TRANSFER_INVALID", "迁移清单 createdAt 无效。");
  }
  if (typeof manifest.plainSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.plainSha256)) {
    throw transferError("TRANSFER_INVALID", "迁移清单 SHA-256 无效。");
  }
  return manifest;
}

function envelopeAad(envelope) {
  return Buffer.from(canonicalJson({
    format: envelope.format,
    version: envelope.version,
    manifest: envelope.manifest,
    kdf: envelope.kdf,
    cipher: { name: envelope.cipher.name, iv: envelope.cipher.iv },
  }), "utf8");
}

function assertEnvelope(candidate) {
  const envelope = assertPlainObject(candidate, "迁移包");
  if (envelope.format !== TRANSFER_FORMAT || envelope.version !== TRANSFER_VERSION) {
    throw transferError("TRANSFER_VERSION_UNSUPPORTED", "迁移包格式或版本不受支持。");
  }
  assertManifest(envelope.manifest);
  assertPlainObject(envelope.kdf, "迁移包 KDF");
  assertPlainObject(envelope.cipher, "迁移包 cipher");
  if (envelope.kdf.name !== "scrypt"
    || envelope.kdf.N !== SCRYPT_OPTIONS.N
    || envelope.kdf.r !== SCRYPT_OPTIONS.r
    || envelope.kdf.p !== SCRYPT_OPTIONS.p
    || envelope.kdf.keyBytes !== KEY_BYTES) {
    throw transferError("TRANSFER_INVALID", "迁移包密钥派生参数无效。");
  }
  if (envelope.cipher.name !== "aes-256-gcm") {
    throw transferError("TRANSFER_INVALID", "迁移包加密算法无效。");
  }
  decodeBase64(envelope.kdf.salt, "kdf.salt", 16);
  decodeBase64(envelope.cipher.iv, "cipher.iv", 12);
  decodeBase64(envelope.cipher.tag, "cipher.tag", 16);
  // The ciphertext can be tens of megabytes. Validate its exact encoded shape
  // here without allocating a duplicate decoded Buffer; authenticated decryption
  // performs the single full decode later.
  assertBase64Shape(envelope.ciphertext, "ciphertext", envelope.manifest.bytes);
  return envelope;
}

async function deriveKey(password, salt) {
  return Buffer.from(await scryptAsync(requirePassword(password), salt, KEY_BYTES, SCRYPT_OPTIONS));
}

export function inspectDatabase(databasePath) {
  const resolvedPath = resolve(databasePath);
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    throw transferError("DATABASE_NOT_FOUND", "没有找到可迁移的 SQLite 数据库。");
  }
  const database = new DatabaseSync(resolvedPath, { readOnly: true, timeout: 5_000 });
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    const integrityOk = integrityRows.length === 1
      && String(integrityRows[0].integrity_check).toLowerCase() === "ok";
    const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
    if (!integrityOk || foreignKeyRows.length) {
      throw transferError(
        "DATABASE_INTEGRITY_FAILED",
        `数据库完整性检查失败（integrity=${integrityOk ? "ok" : "failed"}, foreignKeys=${foreignKeyRows.length}）。`,
      );
    }
    const databaseUserVersion = Number(database.prepare("PRAGMA user_version").get().user_version || 0);
    if (databaseUserVersion !== DATABASE_SCHEMA_VERSION) {
      throw transferError("TRANSFER_VERSION_UNSUPPORTED", `数据库版本 ${databaseUserVersion} 不受迁移器支持。`);
    }
    const row = database.prepare(
      "SELECT schema_version, revision, change_id, state_json, updated_at FROM app_state WHERE id = 1",
    ).get();
    if (!row) throw transferError("DATABASE_STATE_MISSING", "SQLite 中没有可迁移的联系人状态。");
    let state;
    try {
      state = JSON.parse(row.state_json);
    } catch (error) {
      throw transferError("DATABASE_STATE_INVALID", "SQLite 中的联系人状态 JSON 无法解析。", error);
    }
    const validation = validateState(state);
    if (!validation.ok) throw transferError("DATABASE_STATE_INVALID", validation.error);
    if (Number(row.schema_version) !== state.schemaVersion
      || Number(row.revision) !== Number(state.revision)
      || String(row.change_id) !== String(state.changeId)) {
      throw transferError("DATABASE_STATE_MISMATCH", "SQLite 索引字段与联系人状态不一致。");
    }
    return {
      databaseUserVersion,
      stateSchemaVersion: state.schemaVersion,
      revision: Number(state.revision),
      changeId: String(state.changeId),
      contactCount: state.contacts.length,
      tagCount: state.tags.length,
      updatedAt: String(row.updated_at),
      integrity: "ok",
      foreignKeys: 0,
    };
  } finally {
    database.close();
  }
}

export async function createConsistentSnapshot(sourcePath, destinationPath) {
  const resolvedSource = resolve(sourcePath);
  const resolvedDestination = resolve(destinationPath);
  if (resolvedSource === resolvedDestination) {
    throw transferError("SNAPSHOT_PATH_INVALID", "迁移快照不能覆盖源数据库。");
  }
  mkdirSync(dirname(resolvedDestination), { recursive: true });
  const pendingPath = `${resolvedDestination}.pending-${randomUUID()}`;
  const source = new DatabaseSync(resolvedSource, { readOnly: true, timeout: 5_000 });
  try {
    const pageCount = Number(source.prepare("PRAGMA page_count").get().page_count);
    const pageSize = Number(source.prepare("PRAGMA page_size").get().page_size);
    assertLogicalPageLimit(pageCount, pageSize);
    assertSourcePhysicalLimit(resolvedSource);
    try {
      await backup(source, pendingPath, {
        rate: 64,
        progress: ({ totalPages }) => {
          // Another connection can grow the database and make backup restart.
          // Recheck both the logical snapshot and the physical WAL budget on
          // every batch so an initially small source cannot grow without bound.
          assertLogicalPageLimit(Number(totalPages), pageSize);
          assertSourcePhysicalLimit(resolvedSource);
        },
      });
    } catch (error) {
      try { unlinkSync(pendingPath); } catch {}
      throw error;
    }
  } finally {
    source.close();
  }
  try {
    assertDatabaseByteLimit(statSync(pendingPath).size, "迁移快照");
    const inspection = inspectDatabase(pendingPath);
    renameSync(pendingPath, resolvedDestination);
    return inspection;
  } catch (error) {
    try { unlinkSync(pendingPath); } catch {}
    throw error;
  }
}

export async function encryptDatabaseBuffer(databaseBuffer, password, inspection, createdAt = new Date().toISOString()) {
  if (!Buffer.isBuffer(databaseBuffer) || databaseBuffer.length < 1) {
    throw transferError("TRANSFER_INVALID", "没有可加密的数据库内容。");
  }
  assertDatabaseByteLimit(databaseBuffer.length);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const manifest = {
    createdAt,
    databaseUserVersion: inspection.databaseUserVersion,
    stateSchemaVersion: inspection.stateSchemaVersion,
    revision: inspection.revision,
    changeId: inspection.changeId,
    contactCount: inspection.contactCount,
    tagCount: inspection.tagCount,
    bytes: databaseBuffer.length,
    plainSha256: sha256(databaseBuffer),
  };
  const envelope = {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    manifest,
    kdf: {
      name: "scrypt",
      N: SCRYPT_OPTIONS.N,
      r: SCRYPT_OPTIONS.r,
      p: SCRYPT_OPTIONS.p,
      keyBytes: KEY_BYTES,
      salt: salt.toString("base64"),
    },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: "" },
    ciphertext: "",
  };
  const key = await deriveKey(password, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(envelopeAad(envelope));
    const ciphertext = Buffer.concat([cipher.update(databaseBuffer), cipher.final()]);
    envelope.cipher.tag = cipher.getAuthTag().toString("base64");
    envelope.ciphertext = ciphertext.toString("base64");
    return envelope;
  } finally {
    key.fill(0);
  }
}

async function decryptValidatedEnvelope(envelope, password) {
  const salt = decodeBase64(envelope.kdf.salt, "kdf.salt", 16);
  const iv = decodeBase64(envelope.cipher.iv, "cipher.iv", 12);
  const tag = decodeBase64(envelope.cipher.tag, "cipher.tag", 16);
  // assertEnvelope already checked the Base64 alphabet, padding and exact byte
  // length. Decode the full ciphertext exactly once and avoid re-encoding it.
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const key = await deriveKey(password, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(envelopeAad(envelope));
    decipher.setAuthTag(tag);
    let plaintext;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      throw transferError("TRANSFER_AUTH_FAILED", "迁移密码错误，或迁移包已经损坏。", error);
    }
    if (plaintext.length !== envelope.manifest.bytes || sha256(plaintext) !== envelope.manifest.plainSha256) {
      throw transferError("TRANSFER_HASH_MISMATCH", "迁移数据库哈希或字节数不一致。");
    }
    return { plaintext, manifest: envelope.manifest };
  } finally {
    key.fill(0);
    ciphertext.fill(0);
  }
}

export async function decryptTransferEnvelope(candidate, password) {
  return decryptValidatedEnvelope(assertEnvelope(candidate), password);
}

export async function exportTransfer({ sourcePath, outputPath, password }) {
  const resolvedOutput = resolve(outputPath);
  if (existsSync(resolvedOutput)) {
    throw transferError("TRANSFER_OUTPUT_EXISTS", "输出迁移包已经存在；为防止覆盖，请使用新的输出路径。");
  }
  mkdirSync(dirname(resolvedOutput), { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "re-export-"));
  const snapshotPath = join(workDir, "relationship-care.sqlite");
  const pendingOutput = `${resolvedOutput}.pending-${randomUUID()}`;
  try {
    const inspection = await createConsistentSnapshot(sourcePath, snapshotPath);
    if (statSync(snapshotPath).size > MAX_DATABASE_BYTES) {
      throw transferError("TRANSFER_TOO_LARGE", `迁移数据库必须小于或等于 ${MAX_DATABASE_BYTES} 字节。`);
    }
    const snapshot = readFileSync(snapshotPath);
    const envelope = await encryptDatabaseBuffer(snapshot, password, inspection);
    writeFileSync(pendingOutput, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(pendingOutput, resolvedOutput);
    return { outputPath: resolvedOutput, manifest: envelope.manifest, encryptedBytes: statSync(resolvedOutput).size };
  } finally {
    try { unlinkSync(pendingOutput); } catch {}
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function readTransferEnvelope(inputPath) {
  const resolvedInput = resolve(inputPath);
  let parsed;
  try {
    const inputStat = statSync(resolvedInput);
    if (!inputStat.isFile()) {
      throw transferError("TRANSFER_INVALID", "迁移包不是普通文件。");
    }
    if (inputStat.size < 1 || inputStat.size > MAX_TRANSFER_FILE_BYTES) {
      throw transferError("TRANSFER_TOO_LARGE", `迁移包必须小于或等于 ${MAX_TRANSFER_FILE_BYTES} 字节。`);
    }
    parsed = JSON.parse(readFileSync(resolvedInput, "utf8"));
  } catch (error) {
    if (error?.code === "TRANSFER_TOO_LARGE" || error?.code === "TRANSFER_INVALID") throw error;
    throw transferError("TRANSFER_INVALID", "迁移包无法读取或 JSON 已损坏。", error);
  }
  return assertEnvelope(parsed);
}

function assertInspectionMatchesManifest(inspection, manifest) {
  for (const [manifestKey, inspectionKey] of [
    ["databaseUserVersion", "databaseUserVersion"],
    ["stateSchemaVersion", "stateSchemaVersion"],
    ["revision", "revision"],
    ["changeId", "changeId"],
    ["contactCount", "contactCount"],
    ["tagCount", "tagCount"],
  ]) {
    if (manifest[manifestKey] !== inspection[inspectionKey]) {
      throw transferError("TRANSFER_MANIFEST_MISMATCH", `迁移清单与数据库字段 ${manifestKey} 不一致。`);
    }
  }
  return inspection;
}

function verifyDatabaseFileAgainstManifest(databasePath, manifest) {
  const databaseStat = statSync(databasePath);
  assertDatabaseByteLimit(databaseStat.size);
  if (databaseStat.size !== manifest.bytes || sha256(readFileSync(databasePath)) !== manifest.plainSha256) {
    throw transferError("TRANSFER_HASH_MISMATCH", "迁移数据库哈希或字节数不一致。");
  }
  return assertInspectionMatchesManifest(inspectDatabase(databasePath), manifest);
}

async function materializeTransfer({ inputPath, password }) {
  const envelope = readTransferEnvelope(inputPath);
  const decrypted = await decryptValidatedEnvelope(envelope, password);
  const workDir = mkdtempSync(join(tmpdir(), "re-verify-"));
  const databasePath = join(workDir, "relationship-care.sqlite");
  try {
    writeFileSync(databasePath, decrypted.plaintext, { mode: 0o600 });
    decrypted.plaintext.fill(0);
    const inspection = verifyDatabaseFileAgainstManifest(databasePath, decrypted.manifest);
    return {
      databasePath,
      workDir,
      manifest: decrypted.manifest,
      inspection,
      cleanup: () => rmSync(workDir, { recursive: true, force: true }),
    };
  } catch (error) {
    decrypted.plaintext.fill(0);
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyTransfer({ inputPath, password }) {
  const materialized = await materializeTransfer({ inputPath, password });
  try {
    return { manifest: materialized.manifest, inspection: materialized.inspection };
  } finally {
    materialized.cleanup();
  }
}

export function verifyInstalledTransfer({ inputPath, databasePath }) {
  const envelope = readTransferEnvelope(inputPath);
  const resolvedDatabase = resolve(databasePath);
  const databaseEntry = lstatSync(resolvedDatabase, { throwIfNoEntry: false });
  if (!databaseEntry?.isFile() || databaseEntry.isSymbolicLink()) {
    throw transferError("DATABASE_NOT_FOUND", "没有找到待复核的 Mac 联系人数据库。");
  }
  const inspection = verifyDatabaseFileAgainstManifest(resolvedDatabase, envelope.manifest);
  removeReadOnlySidecars(resolvedDatabase);
  return { manifest: envelope.manifest, inspection, databasePath: resolvedDatabase };
}

function removeReadOnlySidecars(databasePath) {
  const walPath = `${databasePath}-wal`;
  const shmPath = `${databasePath}-shm`;
  const walIsEmpty = !existsSync(walPath) || statSync(walPath).size === 0;
  if (!walIsEmpty) return;
  try { unlinkSync(walPath); } catch {}
  try { unlinkSync(shmPath); } catch {}
}

export async function installTransfer({
  inputPath,
  password,
  targetDataDir,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") {
    throw transferError("MACOS_REQUIRED", "联系人迁移安装只能在 macOS 上执行。");
  }
  if (!targetDataDir) throw transferError("TARGET_REQUIRED", "缺少 Mac Application Support 数据目录。");
  const materialized = await materializeTransfer({ inputPath, password });
  const resolvedDataDir = resolve(targetDataDir);
  const targetPath = join(resolvedDataDir, "relationship-care.sqlite");
  const incomingPath = join(resolvedDataDir, `.incoming-${randomUUID()}.sqlite`);
  let published = false;
  try {
    mkdirSync(resolvedDataDir, { recursive: true });
    if (existsSync(`${targetPath}-wal`) || existsSync(`${targetPath}-shm`)) {
      throw transferError("DATABASE_IN_USE", "检测到 SQLite WAL/SHM；请先完全退出关系回响 App 再迁移。");
    }
    if (existsSync(targetPath)) {
      throw transferError("TARGET_EXISTS", "Mac 上已经存在联系人数据库；安全迁移不会覆盖它。请先在 App 内导出并确认旧数据，再另行合并。");
    }
    copyFileSync(materialized.databasePath, incomingPath);
    chmodSync(incomingPath, 0o600);
    verifyDatabaseFileAgainstManifest(incomingPath, materialized.manifest);
    removeReadOnlySidecars(incomingPath);
    fsyncFile(incomingPath);
    try {
      // A same-directory hard link publishes the fully verified database atomically and,
      // unlike rename(), fails if another process created the target in the meantime.
      linkSync(incomingPath, targetPath);
      published = true;
      fsyncDirectory(resolvedDataDir);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw transferError("TARGET_EXISTS", "Mac 上已经存在联系人数据库；本次迁移没有覆盖任何数据。", error);
      }
      throw error;
    }
    unlinkSync(incomingPath);
    fsyncDirectory(resolvedDataDir);
    chmodSync(targetPath, 0o600);
    const installed = verifyDatabaseFileAgainstManifest(targetPath, materialized.manifest);
    fsyncFile(targetPath);
    removeReadOnlySidecars(targetPath);
    fsyncDirectory(resolvedDataDir);
    return { targetPath, backupPath: null, manifest: materialized.manifest, inspection: installed };
  } catch (error) {
    try { unlinkSync(incomingPath); } catch {}
    removeReadOnlySidecars(incomingPath);
    if (published) {
      try { unlinkSync(targetPath); } catch {}
      try { fsyncDirectory(resolvedDataDir); } catch {}
    }
    throw error;
  } finally {
    try { unlinkSync(incomingPath); } catch {}
    removeReadOnlySidecars(incomingPath);
    materialized.cleanup();
  }
}

export async function readTransferPasswordFromStream(
  stream = process.stdin,
  { maxBytes = MAX_TRANSFER_PASSWORD_BYTES + 2 } = {},
) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      for (const stored of chunks) stored.fill(0);
      buffer.fill(0);
      throw transferError("TRANSFER_PASSWORD_TOO_LARGE", "密码输入超过安全上限。");
    }
    chunks.push(buffer);
  }
  const combined = Buffer.concat(chunks);
  try {
    const value = combined.toString("utf8").replace(/(?:\r\n|\n)$/, "");
    return requirePassword(value);
  } finally {
    combined.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function resolveTransferPassword({ passwordFile = null, environment = process.env } = {}) {
  const fromEnvironment = String(environment.RELATIONSHIP_ECHO_TRANSFER_PASSWORD || "");
  if (fromEnvironment) return requirePassword(fromEnvironment);
  if (passwordFile) {
    const resolvedPasswordFile = resolve(passwordFile);
    if (statSync(resolvedPasswordFile).size > MAX_TRANSFER_PASSWORD_BYTES + 2) {
      throw transferError("TRANSFER_PASSWORD_TOO_LARGE", "密码文件超过安全上限。");
    }
    const fromFile = readFileSync(resolvedPasswordFile, "utf8").replace(/(?:\r\n|\n)$/, "");
    return requirePassword(fromFile);
  }
  throw transferError(
    "TRANSFER_PASSWORD_MISSING",
    "请设置 RELATIONSHIP_ECHO_TRANSFER_PASSWORD，或使用 --password-file 指向未上传网盘的密码文件。",
  );
}
