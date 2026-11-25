#!/usr/bin/env node
// @feature TST001 @scenario S-001 S-003
// @feature TST002 @scenario S-002 S-003
// skill-family-test 命令行可执行入口（sft）。

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.mjs";

const BIN_PATH = fileURLToPath(import.meta.url);

function resolveEntryRealPath(targetPath) {
  try {
    return realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

if (process.argv[1] && resolveEntryRealPath(process.argv[1]) === resolveEntryRealPath(BIN_PATH)) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
