#!/usr/bin/env node
import { resolve } from "node:path";

import { verifyInstalledTransfer } from "../server/migration-transfer.mjs";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--input", "--database"].includes(argument)) throw new Error(`未知参数：${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少路径。`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  if (!values.input || !values.database) {
    throw new Error("用法：node scripts/verify-installed-mac-data.mjs --input <transfer> --database <sqlite>");
  }
  return values;
}

try {
  const args = parseArguments(process.argv.slice(2));
  const result = verifyInstalledTransfer({
    inputPath: resolve(args.input),
    databasePath: resolve(args.database),
  });
  process.stdout.write([
    "Mac 已安装联系人数据库与本次迁移身份一致。",
    "SQLite integrity_check：ok",
    "SQLite foreign_key_check：0 行",
    `联系人：${result.inspection.contactCount}`,
    `标签：${result.inspection.tagCount}`,
    `修订：${result.inspection.revision}`,
  ].join("\n") + "\n");
} catch (error) {
  process.stderr.write(`复核 Mac 已安装联系人数据库失败：${error.message}\n`);
  process.exitCode = 1;
}
