#!/usr/bin/env node
import { resolve } from "node:path";

import {
  readTransferPasswordFromStream,
  resolveTransferPassword,
  verifyTransfer,
} from "../server/migration-transfer.mjs";

function parseArguments(argv) {
  const values = { passwordStdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--password-stdin") {
      values.passwordStdin = true;
      continue;
    }
    if (!["--input", "--password-file"].includes(argument)) throw new Error(`未知参数：${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少路径。`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  if (!values.input) throw new Error("用法：node scripts/verify-mac-transfer.mjs --input <transfer> [--password-file <file> | --password-stdin]");
  if (values.passwordStdin && values["password-file"]) throw new Error("--password-stdin 与 --password-file 不能同时使用。");
  return values;
}

try {
  const args = parseArguments(process.argv.slice(2));
  const password = args.passwordStdin
    ? await readTransferPasswordFromStream(process.stdin)
    : resolveTransferPassword({ passwordFile: args["password-file"] || null });
  const result = await verifyTransfer({ inputPath: resolve(args.input), password });
  process.stdout.write([
    "Mac 迁移包验证通过。",
    "SQLite integrity_check：ok",
    "SQLite foreign_key_check：0 行",
    `联系人：${result.inspection.contactCount}`,
    `标签：${result.inspection.tagCount}`,
    `修订：${result.inspection.revision}`,
  ].join("\n") + "\n");
} catch (error) {
  process.stderr.write(`验证 Mac 迁移包失败：${error.message}\n`);
  process.exitCode = 1;
}
