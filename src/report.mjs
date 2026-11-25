// @feature TST002 @scenario S-002 S-003
// 第 4 层：人类可读 Markdown 测试核收摘要渲染函数与标准模板。
// 结论前置，严格区分“实测通过”“有效复用”“可选显式跳过”“环境未执行”与“产品失败”，绝不将跳过或未执行渲染为通过。

import { createSftError, SFT_ERROR_CODES } from "./errors.mjs";

export const ACCEPTANCE_REPORT_TEMPLATE = `# 测试核收摘要

- **核收结论**：{{headlineVerdict}}
- **候选对象摘要**：\`{{subjectDigest}}\`
- **测试计划摘要**：\`{{planDigest}}\`
- **收据摘要**：\`{{receiptDigest}}\`

## 一、分类统计

| 状态类别 | 数量 | 含义说明 |
| --- | ---: | --- |
| 本次实测通过（\`executed / passed\`） | {{passedCount}} | 本轮真实运行且经原领域验收人判读达标 |
| 有效复用（\`reused\`） | {{reusedCount}} | 依赖文件、环境与判据版本核验未变，沿用既有通过证据 |
| 原权威确认不适用（\`not-applicable\`） | {{notApplicableCount}} | 原要求持有方确认不在本轮范围内 |
| 可选测试显式跳过（\`explicitly_skipped\`） | {{explicitlySkippedCount}} | 经维护者批准本轮跳过可选检查（未评估，**不计入通过**） |
| 编排/环境未执行（\`not_executed\`） | {{notExecutedCount}} | 因 PATH、运行时或调用参数问题未跑入被测产品，需修环境重跑 |
| 产品失败（\`failed\`） | {{failedCount}} | 被测产品违反合同或判据，交回产品职责方修复 |
| 未完成 / 未覆盖（\`incomplete / uncovered\`） | {{openCount}} | 证据缺失或业务目标尚未跑完，阻断正式接受 |

{{detailSections}}
## 权责与后续边界

- 本摘要仅反映测试组织与证据核收事实，不替代原领域职责方的独立业务判断，也不自动构成 Git 提交、打标签或公开发布授权。
`;

const STATUS_LABELS = Object.freeze({
  all_required_passed: "全部必测项已核收通过",
  passed_with_explicit_skips: "必测项已通过（含经维护者批准的可选测试显式跳过，跳过项未评估且不等同于通过）",
  blocked: "未通过核收（存在失败、环境未执行、缺证或契约违规阻断项）",
});

export function renderAcceptanceReport(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw createSftError(SFT_ERROR_CODES.INVALID_ARGS, "renderAcceptanceReport 需要传入结构化结果 JSON 对象（record-run、validate-plan、invalidate-changed 或 eval-smoke 的输出）。");
  }

  if (payload.kind === "skill-family-test.invalidation-report") {
    if (
      typeof payload.allReusable !== "boolean" ||
      !Array.isArray(payload.changedFiles) ||
      !Array.isArray(payload.reusableIds) ||
      !Array.isArray(payload.invalidatedIds) ||
      !Array.isArray(payload.items)
    ) {
      throw createSftError(SFT_ERROR_CODES.INVALID_ARGS, "renderAcceptanceReport 收到的 invalidation-report 对象缺少必需数组或布尔字段。");
    }
    const lines = [
      "# 增量复测与失效重算摘要",
      "",
      `- **重算结论**：${payload.allReusable ? "全部既有通过证据仍有效，无需重跑" : `共 ${payload.invalidatedIds.length} 项测试证据已失效，必须定向重跑`}`,
      `- **变更文件数**：${payload.changedFiles.length}（${payload.changedFiles.length > 0 ? payload.changedFiles.map((f) => `\`${f}\``).join("、") : "无变更"}）`,
      `- **可安全复用项（${payload.reusableIds.length}）**：${payload.reusableIds.length > 0 ? payload.reusableIds.map((id) => `\`${id}\``).join("、") : "无"}`,
      `- **必须重跑项（${payload.invalidatedIds.length}）**：${payload.invalidatedIds.length > 0 ? payload.invalidatedIds.map((id) => `\`${id}\``).join("、") : "无"}`,
      "",
      "## 逐项判定依据",
      "",
      ...payload.items.map((item) => `- **\`${item.id}\`**（\`${item.status}\` / \`${item.reasonCode}\`）：${item.reason}`),
      "",
    ];
    return lines.join("\n");
  }

  if (payload.kind === "skill-family-test.eval-smoke-report") {
    if (
      typeof payload.skillId !== "string" ||
      payload.skillId.trim() === "" ||
      typeof payload.passed !== "boolean" ||
      typeof payload.sampleCount !== "number" ||
      typeof payload.heterogeneous !== "boolean" ||
      !Array.isArray(payload.samples) ||
      !Array.isArray(payload.findings)
    ) {
      throw createSftError(SFT_ERROR_CODES.INVALID_ARGS, "renderAcceptanceReport 收到的 eval-smoke-report 对象缺少必需字段。");
    }
    const cs = payload.comparisonSummary ?? {};
    const lines = [
      `# 最小样本探针与防过拟合评估摘要（${payload.skillId}）`,
      "",
      `- **探针结论**：${payload.passed ? "通过（满足 ≥2 份异构样本且无回归退化）" : "未通过（存在过拟合风险、异构性不足或样本断言失败）"}`,
      `- **样本数量与异构性**：共 ${payload.sampleCount} 份样本，异构核验 ${payload.heterogeneous ? "通过" : "未通过"}`,
      `- **修改前后对比**：修复转绿 ${cs.improved ?? 0} 项，保持通过 ${cs.preservedPass ?? 0} 项，回归退化 ${cs.regressed ?? 0} 项，持续失败 ${cs.stillFailing ?? 0} 项`,
      "",
      "## 样本明细",
      "",
      ...payload.samples.map((s) => `- **\`${s.id}\`**（变化：\`${s.transition}\`，当前结论：\`${s.afterVerdict}\`）${s.failedAssertions.length > 0 ? ` —— 失败项：${s.failedAssertions.join("；")}` : ""}`),
      ...(payload.findings.length > 0 ? ["", "## 风险与修复提示", "", ...payload.findings.map((f) => `- [${f.code}] ${f.message}`)] : []),
      "",
    ];
    return lines.join("\n");
  }

  if (Object.hasOwn(payload, "readyToRun") && Object.hasOwn(payload, "planDigest")) {
    if (
      typeof payload.valid !== "boolean" ||
      typeof payload.planDigest !== "string" ||
      !Array.isArray(payload.coveredCriteria) ||
      !Array.isArray(payload.uncoveredIds) ||
      !Array.isArray(payload.findings)
    ) {
      throw createSftError(SFT_ERROR_CODES.INVALID_ARGS, "renderAcceptanceReport 收到的测试计划核验结果缺少必需字段。");
    }
    const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    const lines = [
      "# 测试计划核验摘要",
      "",
      `- **计划结论**：${payload.valid ? "结构、分层与输入绑定核验通过，可进入授权执行" : "测试计划存在缺口，请修正后再启动执行"}`,
      `- **交付阶段**：\`${payload.stage ?? "未声明"}\`（方法修订：\`${payload.methodRevision ?? "未声明"}\`）`,
      `- **计划摘要**：\`${payload.planDigest}\``,
      `- **已覆盖验收条件**：${payload.coveredCriteria.length > 0 ? payload.coveredCriteria.join("、") : "无"}`,
      `- **未覆盖条目**：${payload.uncoveredIds.length > 0 ? payload.uncoveredIds.join("、") : "无"}`,
      ...(warnings.length > 0 ? ["", "## 验收条件直接行为覆盖告警", "", ...warnings.map((w) => `- [${w.code}]${w.criterionId ? `（\`${w.criterionId}\`）` : ""} ${w.message}`)] : []),
      ...(payload.findings.length > 0 ? ["", "## 待修正问题", "", ...payload.findings.map((f) => `- [${f.code}]${f.itemId ? `（\`${f.itemId}\`）` : ""} ${f.message}`)] : []),
      "",
    ];
    return lines.join("\n");
  }

  if (
    payload.kind === "skill-family-test.run-receipt" &&
    payload.summary &&
    typeof payload.summary === "object" &&
    !Array.isArray(payload.summary) &&
    Object.hasOwn(STATUS_LABELS, payload.overallStatus) &&
    typeof payload.receiptDigest === "string" &&
    Array.isArray(payload.items) &&
    Array.isArray(payload.findings)
  ) {
    const s = payload.summary;
    const sections = [];
    const items = payload.items;
    const failedItems = items.filter((i) => i.disposition === "failed" || i.disposition === "not_executed" || i.disposition === "incomplete" || i.disposition === "uncovered");
    if (failedItems.length > 0 || payload.findings.length > 0) {
      sections.push("## 二、阻断与待处理事项\n");
      for (const item of failedItems) {
        const tag = item.disposition === "not_executed" ? "环境/编排未执行（修环境后原地重跑）" : item.disposition === "failed" ? "产品缺陷（交回开发修复）" : "未完成/缺证";
        sections.push(`- **\`${item.id}\`** [${tag}]：${item.reason ?? "需补充说明与复测记录"}`);
      }
      for (const f of payload.findings) {
        sections.push(`- **[${f.code}]**${f.itemId ? `（\`${f.itemId}\`）` : ""}：${f.message}`);
      }
      sections.push("");
    }

    const skippedItems = items.filter((i) => i.disposition === "explicitly_skipped");
    if (skippedItems.length > 0) {
      sections.push("## 可选测试显式跳过记录（未评估，不等同于通过）\n");
      for (const item of skippedItems) {
        sections.push(
          `- **\`${item.id}\`**（批准人：\`${item.approvedBy}\`）\n` +
          `  - **跳过原因**：${item.reason}\n` +
          `  - **适用边界**：${item.applicabilityBoundary}\n` +
          `  - **残余风险**：${(item.residualRisks ?? []).join("；")}\n` +
          `  - **兜底必检门禁**：${(item.fallbackGates ?? []).join("、")}`,
        );
      }
      sections.push("");
    }

    return ACCEPTANCE_REPORT_TEMPLATE
      .replace("{{headlineVerdict}}", STATUS_LABELS[payload.overallStatus])
      .replace("{{subjectDigest}}", payload.subjectDigest ?? "未绑定")
      .replace("{{planDigest}}", payload.planDigest ?? "未绑定")
      .replace("{{receiptDigest}}", payload.receiptDigest ?? "未生成")
      .replace("{{passedCount}}", String(s.passed ?? 0))
      .replace("{{reusedCount}}", String(s.reused ?? 0))
      .replace("{{notApplicableCount}}", String(s.notApplicable ?? 0))
      .replace("{{explicitlySkippedCount}}", String(s.explicitlySkipped ?? 0))
      .replace("{{notExecutedCount}}", String(s.notExecuted ?? 0))
      .replace("{{failedCount}}", String(s.failed ?? 0))
      .replace("{{openCount}}", String(s.incompleteOrUncovered ?? 0))
      .replace("{{detailSections}}", sections.length > 0 ? `${sections.join("\n")}\n` : "");
  }

  throw createSftError(
    SFT_ERROR_CODES.INVALID_ARGS,
    "无法识别输入结果的报告类型或缺少必需字段；请传入 validate-plan、record-run、invalidate-changed 或 eval-smoke 生成的结构化 JSON 结果。",
    { kind: payload.kind ?? null },
  );
}
