// @feature TST001 @scenario S-001 S-003
// @feature TST002 @scenario S-002 S-003
// skill-family-test 公共入口模块（手写源事实，保留 PROJECT_ID 导出兼容，提供测试规划校验、运行收据核收、增量失效计算、多样本探针与报告渲染 API）。

export const PROJECT_ID = "skill-family-test";

export { SFT_ERROR_CODES, SFT_EXIT_CODES, SftError, createSftError } from "./errors.mjs";
export { sha256Hex, normalizeRelativePath, matchDependencyPattern } from "./fs-utils.mjs";
export { validateTestPlan } from "./validate-plan.mjs";
export { recordTestRun } from "./record-run.mjs";
export { invalidateChangedTests } from "./invalidate-changed.mjs";
export { evaluateSmokeSamples } from "./eval-smoke.mjs";
export { ACCEPTANCE_REPORT_TEMPLATE, renderAcceptanceReport } from "./report.mjs";
export { CLI_HELP_TEXT, runCli } from "./cli.mjs";
