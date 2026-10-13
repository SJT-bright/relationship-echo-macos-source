#!/usr/bin/env node
import { resolve } from "node:path";

import { exportTransfer, resolveTransferPassword } from "../server/migration-transfer.mjs";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--source", "--output", "--password-file"].includes(argument)) {
      throw new Error(`未知参数：${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少路径。`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  if (!values.source || !values.output) {
    throw new Error("用法：node scripts/export-mac-transfer.mjs --source <sqlite> --output <transfer> [--password-file <file>]");
  }
  return values;
}

try {
  const args = parseArguments(process.argv.slice(2));
  const password = resolveTransferPassword({ passwordFile: args["password-file"] || null });
  const result = await exportTransfer({
    sourcePath: resolve(args.source),
    outputPath: resolve(args.output),
    password,
  });
  process.stdout.write([
    "Mac 加密迁移包已生成。",
    `联系人：${result.manifest.contactCount}`,
    `标签：${result.manifest.tagCount}`,
    `修订：${result.manifest.revision}`,
    `输出：${result.outputPath}`,
  ].join("\n") + "\n");
} catch (error) {
  process.stderr.write(`生成 Mac 迁移包失败：${error.message}\n`);
  process.exitCode = 1;
}
