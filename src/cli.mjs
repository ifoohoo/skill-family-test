// @feature TST001 @scenario S-001 S-003
// @feature TST002 @scenario S-002 S-003
// skill-family-test 命令行解析与调度器（sft）。
// 所有报错信息均直接指出缺失参数或违规字段，并给出下一步修复命令示例。

import { readFileSync } from "node:fs";
import path from "node:path";
import { createSftError, SFT_ERROR_CODES, SFT_EXIT_CODES, SftError } from "./errors.mjs";
import { evaluateSmokeSamples } from "./eval-smoke.mjs";
import { readContainedJson, readExternalTextStrict, writeContainedJsonAtomic, writeContainedTextAtomic } from "./fs-utils.mjs";
import { invalidateChangedTests } from "./invalidate-changed.mjs";
import { recordTestRun } from "./record-run.mjs";
import { renderAcceptanceReport } from "./report.mjs";
import { validateTestPlan } from "./validate-plan.mjs";

const SFT_PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const SUPPORTED_SUBCOMMANDS = new Set([
  "validate-plan",
  "record-run",
  "invalidate-changed",
  "eval-smoke",
  "render-report",
]);

export const CLI_HELP_TEXT = `sft —— 技能族测试规划校验、运行收据核收、增量失效计算与多样本防过拟合 CLI

用法：
  sft <subcommand> --input <相对或绝对 JSON 路径> [--root <项目根目录>] [--out <收据或报告输出相对路径>] [--format <json|markdown> | --json]

可用子命令：
  validate-plan       校验测试计划的分层覆盖、阶段边界、验收条件映射与输入原件摘要绑定
  record-run          核收真实测试运行结果，生成含 explicitly_skipped 与编排/产品失败隔离的结构化收据
  invalidate-changed  对比变更前后的文件 SHA-256 摘要，精确计算可安全复用的测试与必须重跑的失效项
  eval-smoke          运行工程化前最小代表性样本集探针（强制 ≥2 份异构样本并对比修改前后跨样本回归）
  render-report       将结构化核收结果渲染为结论前置的 Markdown 报告（支持 --out 落盘）

选项：
  --input, -i <path>     输入 JSON 文件路径（必填）
  --root, -r <dir>       项目根目录（核验文件引用摘要或写出 --out 时必填）
  --out, -o <relPath>    将结构化结果（或 Markdown 报告）写入项目根目录内的相对路径
  --format, -f <fmt>     输出格式：json（默认）或 markdown
  --json                 --format json 的便捷兼容开关（不能与 --format markdown 同时使用）
  --strict-ac-behavior   在 validate-plan 中将验收条件仅靠 unit-mock 或无直接行为层覆盖的告警升级为硬阻断
  --version, -v          查看当前版本号
  --help, -h             查看本帮助说明
`;

function consumeOptionValue(argv, index, flag) {
  const next = argv[index + 1];
  if (next === undefined || next === "" || next.startsWith("-")) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `选项 ${flag} 缺少参数值；请紧随其后传入合法参数（例如 ${flag} <路径或值>）。`,
      { flag },
    );
  }
  return { value: next, nextIndex: index + 1 };
}

function parseCliArgs(argv) {
  const args = { subcommand: null, input: null, root: null, out: null, format: "json", strictAcBehavior: false, version: false, help: false };
  let explicitFormat = null;
  let hasJsonFlag = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--version" || token === "-v") {
      args.version = true;
    } else if (token === "--strict-ac-behavior") {
      args.strictAcBehavior = true;
    } else if (token === "--json") {
      hasJsonFlag = true;
    } else if (token === "--input" || token === "-i") {
      const consumed = consumeOptionValue(argv, i, token);
      args.input = consumed.value;
      i = consumed.nextIndex;
    } else if (token === "--root" || token === "-r") {
      const consumed = consumeOptionValue(argv, i, token);
      args.root = consumed.value;
      i = consumed.nextIndex;
    } else if (token === "--out" || token === "-o") {
      const consumed = consumeOptionValue(argv, i, token);
      args.out = consumed.value;
      i = consumed.nextIndex;
    } else if (token === "--format" || token === "-f") {
      const consumed = consumeOptionValue(argv, i, token);
      explicitFormat = consumed.value;
      i = consumed.nextIndex;
    } else if (!token.startsWith("-") && !args.subcommand) {
      args.subcommand = token;
    } else {
      throw createSftError(
        SFT_ERROR_CODES.INVALID_ARGS,
        `无法识别的命令行参数 "${token}"；请运行 "sft --help" 查看支持的子命令与选项。`,
      );
    }
  }
  if (explicitFormat !== null && explicitFormat !== "json" && explicitFormat !== "markdown") {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `不支持的 --format "${String(explicitFormat)}"；仅允许 "json" 或 "markdown"。`,
    );
  }
  if (hasJsonFlag && explicitFormat === "markdown") {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      "参数冲突：--json 与 --format markdown 不能同时传入；请仅保留其中一种输出格式选项。",
      { flags: ["--json", "--format"] },
    );
  }
  args.format = explicitFormat ?? (hasJsonFlag ? "json" : "json");
  return args;
}

async function loadInputJson(inputPath, rootDir) {
  if (!inputPath) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      "缺少必填参数 --input <文件路径>；请传入待核验的 JSON 文件（例如：sft validate-plan --root . --input plan.json）。",
    );
  }
  if (!path.isAbsolute(inputPath) && rootDir) {
    const loaded = await readContainedJson(rootDir, inputPath, "--input");
    return loaded.data;
  }
  const rawText = await readExternalTextStrict(inputPath, "--input");
  try {
    return JSON.parse(rawText);
  } catch (err) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_JSON,
      `输入文件 "${inputPath}" 不是合法的 JSON（${err.message}）；请修正语法后重试。`,
    );
  }
}

function requireOutRoot(args, effectiveRoot) {
  if (args.out && !effectiveRoot) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `指定 --out "${args.out}" 输出路径时，必须同时指定 --root <项目根目录> 以校验写入边界。`,
      { out: args.out },
    );
  }
}

export async function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const args = parseCliArgs(argv);
    if (args.help || argv.length === 0) {
      io.stdout.write(CLI_HELP_TEXT);
      return SFT_EXIT_CODES.OK;
    }
    if (args.version) {
      io.stdout.write(`${SFT_PACKAGE_VERSION}\n`);
      return SFT_EXIT_CODES.OK;
    }
    if (!args.subcommand || !SUPPORTED_SUBCOMMANDS.has(args.subcommand)) {
      throw createSftError(
        SFT_ERROR_CODES.INVALID_ARGS,
        `未知的子命令 "${String(args.subcommand ?? "")}"；可用子命令为 validate-plan、record-run、invalidate-changed、eval-smoke、render-report。`,
      );
    }

    const effectiveRoot = args.root ? path.resolve(args.root) : null;
    requireOutRoot(args, effectiveRoot);
    const inputData = await loadInputJson(args.input, effectiveRoot);

    let result;
    let passed = true;
    if (args.subcommand === "validate-plan") {
      result = await validateTestPlan(inputData, { root: effectiveRoot, strictAcBehavior: args.strictAcBehavior });
      passed = result.valid;
      if (args.out) {
        await writeContainedJsonAtomic(effectiveRoot, args.out, result);
      }
    } else if (args.subcommand === "record-run") {
      result = await recordTestRun(inputData, { root: effectiveRoot, outPath: args.out });
      passed = result.ok;
    } else if (args.subcommand === "invalidate-changed") {
      result = await invalidateChangedTests(inputData, { root: effectiveRoot });
      passed = true;
      if (args.out) {
        await writeContainedJsonAtomic(effectiveRoot, args.out, result);
      }
    } else if (args.subcommand === "eval-smoke") {
      result = await evaluateSmokeSamples(inputData, { root: effectiveRoot });
      passed = result.passed;
      if (args.out) {
        await writeContainedJsonAtomic(effectiveRoot, args.out, result);
      }
    } else if (args.subcommand === "render-report") {
      const md = renderAcceptanceReport(inputData);
      const finalMd = md.endsWith("\n") ? md : `${md}\n`;
      if (args.out) {
        await writeContainedTextAtomic(effectiveRoot, args.out, finalMd);
      }
      io.stdout.write(finalMd);
      return SFT_EXIT_CODES.OK;
    }

    if (args.format === "markdown") {
      const md = renderAcceptanceReport(result);
      io.stdout.write(md.endsWith("\n") ? md : `${md}\n`);
    } else {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return passed ? SFT_EXIT_CODES.OK : SFT_EXIT_CODES.BLOCKED;
  } catch (err) {
    if (err instanceof SftError) {
      io.stderr.write(`[${err.code}] ${err.message}\n`);
      return err.exitCode;
    }
    io.stderr.write(`[SFT_INTERNAL_ERROR] 执行异常：${err?.message ?? String(err)}\n`);
    return SFT_EXIT_CODES.USAGE_OR_SECURITY;
  }
}
