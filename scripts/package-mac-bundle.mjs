import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { exportTransfer, resolveTransferPassword } from "../server/migration-transfer.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP_FILES = Object.freeze([
  "DESIGN.md",
  "MAC-APP.md",
  "PRODUCT.md",
  "README.md",
  "build/entitlements.mac.plist",
  "build/icon.png",
  "build/icon.png.json",
  "docs/mac/开始使用.html",
  "electron-builder.yml",
  "favicon.svg",
  "index.html",
  "package-lock.json",
  "package.json",
  "server.mjs",
  "styles.css",
]);
const APP_DIRECTORIES = Object.freeze([
  "assets",
  "desktop",
  "samples",
  "scripts",
  "server",
  "src",
  "tests",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".impeccable",
  ".tmp",
  "artifacts",
  "backups",
  "dist",
  "logs",
  "node_modules",
]);
const SENSITIVE_FILE_PATTERN = /(?:^|[/._-])(password|secret|credential)(?:[/._-]|$)|\.sqlite(?:-(?:wal|shm))?$|\.log$|(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:authkey|token)[^/]*$|\.(?:p8|p12|pfx|pem|key|cer|crt|mobileprovision)$/i;

function bundleError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function sha256(bufferOrPath) {
  const value = Buffer.isBuffer(bufferOrPath) ? bufferOrPath : readFileSync(bufferOrPath);
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeArchiveEntryName(candidate) {
  if (typeof candidate !== "string" || candidate.includes("\0")) {
    throw bundleError("ARCHIVE_PATH_INVALID", "压缩包条目路径无效。");
  }
  const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
    || parts.some((part) => !part || part === "." || part === "..")) {
    throw bundleError("ARCHIVE_PATH_INVALID", `压缩包条目路径不安全：${candidate}`);
  }
  return normalized;
}

export function assertSafeBundleRelativePath(relativePath) {
  const normalizedPath = normalizeArchiveEntryName(relativePath);
  if (SENSITIVE_FILE_PATTERN.test(normalizedPath)) {
    throw bundleError("SENSITIVE_SOURCE_REJECTED", `构建源中发现不允许打包的敏感文件：${relativePath}`);
  }
  return normalizedPath;
}

function assertSafeSourceFile(sourcePath, relativePath) {
  const info = statSync(sourcePath, { throwIfNoEntry: false });
  if (!info?.isFile()) throw bundleError("SOURCE_FILE_MISSING", `构建源文件不存在：${relativePath}`);
  assertSafeBundleRelativePath(relativePath);
}

function copySafeFile(sourcePath, destinationPath, relativePath) {
  assertSafeSourceFile(sourcePath, relativePath);
  mkdirSync(dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
  if (destinationPath.endsWith(".command")) chmodSync(destinationPath, 0o755);
}

function copySafeTree(sourceDirectory, destinationDirectory, relativeDirectory) {
  const entries = readdirSync(sourceDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const sourcePath = join(sourceDirectory, entry.name);
    const destinationPath = join(destinationDirectory, entry.name);
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) {
      throw bundleError("SYMLINK_REJECTED", `构建源不允许符号链接：${relativePath}`);
    }
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      mkdirSync(destinationPath, { recursive: true });
      copySafeTree(sourcePath, destinationPath, relativePath);
      continue;
    }
    if (entry.isFile()) copySafeFile(sourcePath, destinationPath, relativePath);
  }
}

function copyApplicationSource(destination) {
  mkdirSync(destination, { recursive: true });
  for (const filename of APP_FILES) {
    copySafeFile(join(PROJECT_ROOT, filename), join(destination, filename), filename);
  }
  for (const directory of APP_DIRECTORIES) {
    const sourceDirectory = join(PROJECT_ROOT, directory);
    if (!existsSync(sourceDirectory)) throw bundleError("SOURCE_DIRECTORY_MISSING", `构建源目录不存在：${directory}`);
    const destinationDirectory = join(destination, directory);
    mkdirSync(destinationDirectory, { recursive: true });
    copySafeTree(sourceDirectory, destinationDirectory, directory);
  }
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      crcTable[index] = value >>> 0;
    }
  }
  let checksum = 0xffffffff;
  for (const byte of buffer) checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date) {
  const safeYear = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    date: ((safeYear - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function listFiles(directory) {
  const results = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const fullPath = join(current, entry.name);
      if (entry.isSymbolicLink()) throw bundleError("SYMLINK_REJECTED", `压缩目录不允许符号链接：${fullPath}`);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) results.push(fullPath);
    }
  }
  walk(directory);
  return results;
}

export function createZipArchive({ sourceDirectory, archivePath, rootName }) {
  const safeRootName = normalizeArchiveEntryName(rootName);
  const sourceRoot = resolve(sourceDirectory);
  const pendingArchive = `${resolve(archivePath)}.pending`;
  const chunks = [];
  const centralRecords = [];
  let offset = 0;

  try {
    for (const filePath of listFiles(sourceRoot)) {
      const relativePath = relative(sourceRoot, filePath).split(sep).join("/");
      const entryName = normalizeArchiveEntryName(`${safeRootName}/${relativePath}`);
      const nameBuffer = Buffer.from(entryName, "utf8");
      const plain = readFileSync(filePath);
      const deflated = deflateRawSync(plain, { level: 9 });
      const method = deflated.length < plain.length ? 8 : 0;
      const payload = method === 8 ? deflated : plain;
      if (plain.length > 0xffffffff || payload.length > 0xffffffff || offset > 0xffffffff) {
        throw bundleError("ARCHIVE_TOO_LARGE", "迁移包超过 ZIP32 安全上限。");
      }
      const { date, time } = dosTimestamp(statSync(filePath).mtime);
      const checksum = crc32(plain);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(plain.length, 22);
      local.writeUInt16LE(nameBuffer.length, 26);
      local.writeUInt16LE(0, 28);
      chunks.push(local, nameBuffer, payload);

      const mode = entryName.endsWith(".command") ? 0o100755 : 0o100644;
      centralRecords.push({
        checksum,
        compressedBytes: payload.length,
        date,
        method,
        mode,
        nameBuffer,
        offset,
        plainBytes: plain.length,
        time,
      });
      offset += local.length + nameBuffer.length + payload.length;
    }

    const centralOffset = offset;
    for (const record of centralRecords) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0x0314, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(record.method, 10);
      central.writeUInt16LE(record.time, 12);
      central.writeUInt16LE(record.date, 14);
      central.writeUInt32LE(record.checksum, 16);
      central.writeUInt32LE(record.compressedBytes, 20);
      central.writeUInt32LE(record.plainBytes, 24);
      central.writeUInt16LE(record.nameBuffer.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE((record.mode << 16) >>> 0, 38);
      central.writeUInt32LE(record.offset, 42);
      chunks.push(central, record.nameBuffer);
      offset += central.length + record.nameBuffer.length;
    }

    const centralBytes = offset - centralOffset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(centralRecords.length, 8);
    end.writeUInt16LE(centralRecords.length, 10);
    end.writeUInt32LE(centralBytes, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    chunks.push(end);

    mkdirSync(dirname(pendingArchive), { recursive: true });
    writeFileSync(pendingArchive, Buffer.concat(chunks));
    renameSync(pendingArchive, resolve(archivePath));
    return { entries: centralRecords.length, bytes: statSync(resolve(archivePath)).size };
  } catch (error) {
    rmSync(pendingArchive, { force: true });
    throw error;
  }
}

function writeChecksums(bundleDirectory) {
  const lines = listFiles(bundleDirectory)
    .filter((filePath) => basename(filePath) !== "SHA256SUMS.txt")
    .map((filePath) => `${sha256(filePath)}  ${relative(bundleDirectory, filePath).split(sep).join("/")}`)
    .sort((left, right) => left.localeCompare(right, "en"));
  writeFileSync(join(bundleDirectory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
}

function parseArguments(argv) {
  const args = {};
  const allowed = new Set(["--source-db", "--output-dir", "--password-file", "--expected-contacts"]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key) || index + 1 >= argv.length) throw bundleError("ARGUMENT_INVALID", `参数无效：${key}`);
    args[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!args["source-db"] || !args["output-dir"] || !args["expected-contacts"]) {
    throw bundleError("ARGUMENT_REQUIRED", "用法：node scripts/package-mac-bundle.mjs --source-db <SQLite> --output-dir <目录> --expected-contacts <数量> [--password-file <文件>]");
  }
  return args;
}

export async function packageMacBundle({ sourceDatabase, outputDirectory, password, expectedContacts, now = new Date() }) {
  if (!Number.isSafeInteger(expectedContacts) || expectedContacts < 1 || expectedContacts > 3_000) {
    throw bundleError("EXPECTED_CONTACTS_INVALID", "交付联系人期望数量必须是 1 到 3000 的整数。");
  }
  const outputRoot = resolve(outputDirectory);
  mkdirSync(outputRoot, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const bundleName = `关系回响-Mac迁移构建包-${stamp}`;
  const bundleDirectory = join(outputRoot, bundleName);
  const archivePath = join(outputRoot, `${bundleName}.zip`);
  if (existsSync(bundleDirectory) || existsSync(archivePath)) {
    throw bundleError("OUTPUT_EXISTS", "目标迁移包已存在；为避免覆盖，请稍后重试或选择新的输出目录。");
  }

  try {
    mkdirSync(join(bundleDirectory, "app"), { recursive: true });
    mkdirSync(join(bundleDirectory, "migration"), { recursive: true });
    copyApplicationSource(join(bundleDirectory, "app"));
    copySafeFile(
      join(PROJECT_ROOT, "scripts", "在Mac上构建关系回响.command"),
      join(bundleDirectory, "在Mac上构建关系回响.command"),
      "scripts/在Mac上构建关系回响.command",
    );
    copySafeFile(
      join(PROJECT_ROOT, "docs", "mac", "开始使用.html"),
      join(bundleDirectory, "开始使用.html"),
      "docs/mac/开始使用.html",
    );

    const transfer = await exportTransfer({
      sourcePath: sourceDatabase,
      outputPath: join(bundleDirectory, "migration", "contacts.relationship-echo-transfer"),
      password,
    });
    if (transfer.manifest.contactCount !== expectedContacts) {
      throw bundleError(
        "CONTACT_COUNT_MISMATCH",
        `交付门禁失败：源数据库有 ${transfer.manifest.contactCount} 位联系人，期望 ${expectedContacts} 位。没有生成 ZIP。`,
      );
    }
    const packageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
    const publicManifest = {
      schemaVersion: 1,
      productName: "关系回响",
      bundleName,
      createdAt: now.toISOString(),
      target: { platform: "macOS", architecture: "universal", minimumVersion: "12.0" },
      application: { version: packageJson.version, finalLocation: "~/Applications/关系回响.app" },
      data: {
        encrypted: true,
        format: "AES-256-GCM + scrypt",
        filename: "migration/contacts.relationship-echo-transfer",
        databaseUserVersion: transfer.manifest.databaseUserVersion,
        stateSchemaVersion: transfer.manifest.stateSchemaVersion,
        revision: transfer.manifest.revision,
        changeId: transfer.manifest.changeId,
        contactCount: transfer.manifest.contactCount,
        expectedContactCount: expectedContacts,
        tagCount: transfer.manifest.tagCount,
        plainBytes: transfer.manifest.bytes,
        plainSha256: transfer.manifest.plainSha256,
      },
      privacy: "迁移密码、联系人姓名、消息摘要和标签名称不在本清单中。",
    };
    writeFileSync(join(bundleDirectory, "迁移包清单.json"), `${JSON.stringify(publicManifest, null, 2)}\n`, "utf8");
    writeChecksums(bundleDirectory);
    const archive = createZipArchive({ sourceDirectory: bundleDirectory, archivePath, rootName: bundleName });
    const result = {
      archivePath,
      archiveBytes: archive.bytes,
      archiveEntries: archive.entries,
      archiveSha256: sha256(archivePath),
      manifest: publicManifest,
    };
    rmSync(bundleDirectory, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(bundleDirectory, { recursive: true, force: true });
    rmSync(archivePath, { force: true });
    throw error;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const expectedContacts = Number(args["expected-contacts"]);
    const result = await packageMacBundle({
      sourceDatabase: args["source-db"],
      outputDirectory: args["output-dir"],
      password: resolveTransferPassword({ passwordFile: args["password-file"] || null }),
      expectedContacts,
    });
    console.log(JSON.stringify({
      ok: true,
      archivePath: result.archivePath,
      archiveBytes: result.archiveBytes,
      archiveEntries: result.archiveEntries,
      archiveSha256: result.archiveSha256,
      contacts: result.manifest.data.contactCount,
      expectedContacts: result.manifest.data.expectedContactCount,
      contactCountVerified: result.manifest.data.contactCount === result.manifest.data.expectedContactCount,
      tags: result.manifest.data.tagCount,
      revision: result.manifest.data.revision,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || "PACKAGE_FAILED", error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
