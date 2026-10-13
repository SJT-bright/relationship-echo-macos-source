#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  installTransfer,
  readTransferPasswordFromStream,
  resolveTransferPassword,
} from "../server/migration-transfer.mjs";

function parseArguments(argv) {
  const values = { passwordStdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--password-stdin") {
      values.passwordStdin = true;
      continue;
    }
    if (!["--input", "--password-file", "--target-data-dir"].includes(argument)) {
      throw new Error(`未知参数：${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少路径。`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  if (!values.input) throw new Error("用法：node scripts/install-mac-data.mjs --input <transfer> [--password-stdin]");
  if (values.passwordStdin && values["password-file"]) throw new Error("--password-stdin 与 --password-file 不能同时使用。");
  return values;
}

try {
  const args = parseArguments(process.argv.slice(2));
  const password = args.passwordStdin
    ? await readTransferPasswordFromStream(process.stdin)
    : resolveTransferPassword({ passwordFile: args["password-file"] || null });
  const targetDataDir = args["target-data-dir"]
    ? resolve(args["target-data-dir"])
    : join(homedir(), "Library", "Application Support", "Relationship Echo");
  const result = await installTransfer({
    inputPath: resolve(args.input),
    password,
    targetDataDir,
  });
  process.stdout.write([
    "联系人数据已安全安装到 Mac 本机。",
    `联系人：${result.inspection.contactCount}`,
    `标签：${result.inspection.tagCount}`,
    `修订：${result.inspection.revision}`,
    `数据库：${result.targetPath}`,
    ...(result.backupPath ? [`原数据库备份：${result.backupPath}`] : []),
  ].join("\n") + "\n");
} catch (error) {
  process.stderr.write(`安装 Mac 联系人数据失败：${error.message}\n`);
  process.exitCode = 1;
}
