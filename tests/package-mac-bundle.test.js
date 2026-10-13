import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";

import { createDemoState } from "../src/data.js";
import { createStateRepository } from "../server/state-repository.mjs";
import {
  assertSafeBundleRelativePath,
  createZipArchive,
  normalizeArchiveEntryName,
  packageMacBundle,
} from "../scripts/package-mac-bundle.mjs";

function readZipEntries(archivePath) {
  const archive = readFileSync(archivePath);
  const eocdOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocdOffset >= 0, "ZIP end-of-central-directory is required");
  const count = archive.readUInt16LE(eocdOffset + 10);
  let cursor = archive.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedBytes = archive.readUInt32LE(cursor + 20);
    const plainBytes = archive.readUInt32LE(cursor + 24);
    const nameBytes = archive.readUInt16LE(cursor + 28);
    const extraBytes = archive.readUInt16LE(cursor + 30);
    const commentBytes = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameBytes).toString("utf8");

    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50);
    const localNameBytes = archive.readUInt16LE(localOffset + 26);
    const localExtraBytes = archive.readUInt16LE(localOffset + 28);
    const payloadStart = localOffset + 30 + localNameBytes + localExtraBytes;
    const compressed = archive.subarray(payloadStart, payloadStart + compressedBytes);
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(content.length, plainBytes);
    entries.set(name, { content, externalAttributes, method });
    cursor += 46 + nameBytes + extraBytes + commentBytes;
  }
  return entries;
}

test("archive entry normalization rejects absolute paths and traversal", () => {
  for (const unsafe of ["", "../secret", "a/../secret", "/absolute", "C:/secret", "a//b", "a/./b", "bad\0name"]) {
    assert.throws(() => normalizeArchiveEntryName(unsafe), (error) => error.code === "ARCHIVE_PATH_INVALID");
  }
  assert.equal(normalizeArchiveEntryName("bundle/app/关系回响.txt"), "bundle/app/关系回响.txt");
  assert.equal(normalizeArchiveEntryName("bundle\\app\\file.txt"), "bundle/app/file.txt");
});

test("bundle source gate rejects common Apple signing credentials and database files", () => {
  for (const sensitive of [
    "build/AuthKey_ABC123.p8",
    "build/developer-id.p12",
    "build/private.pem",
    "build/signing.key",
    "build/profile.mobileprovision",
    "assets/token-production.txt",
    "samples/relationship-care.sqlite",
  ]) {
    assert.throws(
      () => assertSafeBundleRelativePath(sensitive),
      (error) => error.code === "SENSITIVE_SOURCE_REJECTED",
      sensitive,
    );
  }
  assert.equal(assertSafeBundleRelativePath("build/icon.png"), "build/icon.png");
});

test("ZIP writer preserves UTF-8 names, content and executable .command mode", () => {
  const work = mkdtempSync(join(tmpdir(), "re-zip-test-"));
  try {
    const source = join(work, "source");
    mkdirSync(join(source, "app"), { recursive: true });
    writeFileSync(join(source, "app", "说明.txt"), "联系人只在本机。\n", "utf8");
    const commandPath = join(source, "在Mac上运行.command");
    writeFileSync(commandPath, "#!/bin/bash\necho ok\n", "utf8");
    chmodSync(commandPath, 0o755);
    const archivePath = join(work, "bundle.zip");
    const result = createZipArchive({ sourceDirectory: source, archivePath, rootName: "关系回响-Mac" });
    assert.equal(result.entries, 2);

    const entries = readZipEntries(archivePath);
    assert.equal(entries.get("关系回响-Mac/app/说明.txt").content.toString("utf8"), "联系人只在本机。\n");
    assert.equal(entries.get("关系回响-Mac/在Mac上运行.command").content.toString("utf8"), "#!/bin/bash\necho ok\n");
    const unixMode = entries.get("关系回响-Mac/在Mac上运行.command").externalAttributes >>> 16;
    assert.equal(unixMode & 0o777, 0o755);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("formal bundle gate refuses a valid database when contact count is not the expected delivery count", async () => {
  const work = mkdtempSync(join(tmpdir(), "re-bundle-count-test-"));
  try {
    const repository = createStateRepository({ dataDir: join(work, "data") });
    const saved = repository.compareAndSwapState(createDemoState(new Date("2026-08-30T00:00:00.000Z")), {
      expectedChangeId: null,
      nowMs: Date.parse("2026-08-30T00:00:00.000Z"),
    });
    const sourceDatabase = repository.databasePath;
    repository.close();
    await assert.rejects(
      () => packageMacBundle({
        sourceDatabase,
        outputDirectory: join(work, "output"),
        password: "bundle-test-password-2026",
        expectedContacts: saved.state.contacts.length + 1,
        now: new Date("2026-08-30T00:00:00.000Z"),
      }),
      (error) => error.code === "CONTACT_COUNT_MISMATCH",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
