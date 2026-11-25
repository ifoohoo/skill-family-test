// @feature TST002 @scenario S-001 S-002 S-003
// 测试运行收据记录与核收校验器（覆盖 US-022 可选测试显式跳过、US-031 编排故障与产品失败隔离）。

import { createSftError, SFT_ERROR_CODES } from "./errors.mjs";
import {
  normalizeRelativePath,
  readContainedBytesAndDigest,
  SHA256_HEX_REGEX,
  sha256Hex,
  writeContainedJsonAtomic,
} from "./fs-utils.mjs";
import { hasMatchingReuseFactors, REUSE_KEYS, validateContractByDefinition } from "./schema-validator.mjs";

const ALLOWED_DISPOSITIONS = new Set([
  "executed",
  "reused",
  "not-applicable",
  "explicitly_skipped",
  "not_executed",
  "failed",
  "incomplete",
  "uncovered",
]);

const ALLOWED_VERDICTS = new Set(["passed", "failed", "not-evaluated"]);
const ALLOWED_FAILURE_KINDS = new Set(["orchestration_error", "product_failure"]);

async function checkEvidenceRef(ref, label, root, findings, itemId) {
  if (!ref || typeof ref !== "object") {
    findings.push({ code: SFT_ERROR_CODES.RECEIPT_INVALID, itemId, message: `${label} 必须是包含 path 与 sha256 的文件引用对象。` });
    return null;
  }
  const relPath = normalizeRelativePath(ref.path, `${label}.path`);
  if (typeof ref.sha256 !== "string" || !SHA256_HEX_REGEX.test(ref.sha256)) {
    findings.push({ code: SFT_ERROR_CODES.RECEIPT_INVALID, itemId, message: `${label}（"${relPath}"）必须携带 64 位小写 sha256 摘要。` });
    return { path: relPath, sha256: ref.sha256 ?? null };
  }
  if (!root) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `${label} 引用了磁盘证据文件 "${relPath}"，必须同时传入 --root <项目根目录> 以核验实际 SHA-256 摘要。`,
      { field: label, path: relPath },
    );
  }
  try {
    const actual = await readContainedBytesAndDigest(root, relPath, label);
    if (actual.sha256 !== ref.sha256) {
      findings.push({
        code: SFT_ERROR_CODES.DIGEST_TAMPERED,
        itemId,
        message: `证据文件 "${relPath}" 的实际摘要与收据声明不一致；禁止使用篡改或过期的证据文件。`,
        path: relPath,
        expectedSha256: ref.sha256,
        actualSha256: actual.sha256,
      });
    }
  } catch (err) {
    findings.push({ code: err.code ?? SFT_ERROR_CODES.IO_CONTAINMENT, itemId, message: err.message, ...(err.details ?? {}) });
  }
  return { path: relPath, sha256: ref.sha256, ...(ref.anchor ? { anchor: ref.anchor } : {}) };
}

export async function recordTestRun(runInput, { root = null, outPath = null } = {}) {
  if (!runInput || typeof runInput !== "object" || Array.isArray(runInput)) {
    throw createSftError(SFT_ERROR_CODES.RECEIPT_INVALID, "运行收据输入必须是 JSON 对象；请核对输入格式。");
  }
  if (runInput.schemaVersion !== 1) {
    throw createSftError(SFT_ERROR_CODES.RECEIPT_INVALID, "运行收据输入必须声明 schemaVersion: 1。");
  }
  if (runInput.subjectDigest !== undefined && !SHA256_HEX_REGEX.test(String(runInput.subjectDigest))) {
    throw createSftError(SFT_ERROR_CODES.RECEIPT_INVALID, "subjectDigest 必须是 64 位小写十六进制 SHA-256 摘要。");
  }
  const rawItems = Array.isArray(runInput.items) ? runInput.items : [];
  if (rawItems.length === 0) {
    throw createSftError(SFT_ERROR_CODES.RECEIPT_INVALID, "运行收据 items 不能为空；请至少传入一条测试记录。");
  }

  const schemaCheck = validateContractByDefinition("runReceiptInput", runInput);
  const itemSchemaErrors = [];
  if (!schemaCheck.valid) {
    for (const err of schemaCheck.errors) {
      const itemMatch = /^\/items\/(\d+)(?:\/(.*))?$/.exec(err.instancePath);
      if (!itemMatch) {
        throw createSftError(
          SFT_ERROR_CODES.RECEIPT_INVALID,
          `运行收据顶层契约校验失败：${err.message}。`,
          { schemaKeyword: err.keyword, instancePath: err.instancePath },
        );
      }
      const idx = Number(itemMatch[1]);
      const sub = itemMatch[2] ?? "";
      // 保留下面逐条分支对 disposition/verdict/failureKind 的专门中文提示，避免重复输出同一字段错误
      if (sub === "disposition" || sub === "verdict" || sub === "failureKind") continue;
      itemSchemaErrors.push({ idx, err });
    }
  }

  const findings = [];
  for (const { idx, err } of itemSchemaErrors) {
    const raw = rawItems[idx];
    const id = typeof raw?.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : `items[${idx}]`;
    findings.push({
      code: SFT_ERROR_CODES.RECEIPT_INVALID,
      itemId: id,
      message: `测试项 "${id}" 契约校验失败：${err.message}。`,
      schemaKeyword: err.keyword,
      instancePath: err.instancePath,
    });
  }

  const normalizedItems = [];
  const seenIds = new Set();
  const passedIds = [];
  const reusedIds = [];
  const notApplicableIds = [];
  const explicitlySkippedIds = [];
  const notExecutedIds = [];
  const failedIds = [];
  const openIds = [];

  for (const [idx, raw] of rawItems.entries()) {
    const id = typeof raw?.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : `items[${idx}]`;
    if (seenIds.has(id)) {
      findings.push({ code: SFT_ERROR_CODES.RECEIPT_INVALID, itemId: id, message: `运行收据中存在重复的测试项 id "${id}"。` });
    }
    seenIds.add(id);

    if (raw?.verdict !== undefined && !ALLOWED_VERDICTS.has(raw.verdict)) {
      findings.push({
        code: SFT_ERROR_CODES.RECEIPT_INVALID,
        itemId: id,
        message: `测试项 "${id}" 的 verdict "${String(raw.verdict)}" 无效；允许值为 passed、failed、not-evaluated。`,
      });
    }
    if (raw?.failureKind !== undefined && !ALLOWED_FAILURE_KINDS.has(raw.failureKind)) {
      findings.push({
        code: SFT_ERROR_CODES.RECEIPT_INVALID,
        itemId: id,
        message: `测试项 "${id}" 的 failureKind "${String(raw.failureKind)}" 无效；允许值为 orchestration_error、product_failure。`,
      });
    }

    const disposition = raw?.disposition;
    if (!ALLOWED_DISPOSITIONS.has(disposition)) {
      findings.push({
        code: SFT_ERROR_CODES.RECEIPT_INVALID,
        itemId: id,
        message: `测试项 "${id}" 的 disposition "${String(disposition)}" 无效；允许值为 executed、reused、not-applicable、explicitly_skipped、not_executed、failed、incomplete、uncovered。`,
      });
      continue;
    }

    const evidence = [];
    for (const [eIdx, ref] of (Array.isArray(raw?.evidence) ? raw.evidence : []).entries()) {
      const checked = await checkEvidenceRef(ref, `items[${idx}].evidence[${eIdx}]`, root, findings, id);
      if (checked) evidence.push(checked);
    }

    if (disposition === "explicitly_skipped") {
      // 可选测试显式跳过收据（US-022）：严禁跳过必选门禁，严禁把跳过伪装成 passed！
      if (raw.optional !== true) {
        findings.push({
          code: SFT_ERROR_CODES.RECEIPT_INVALID,
          itemId: id,
          message: `测试项 "${id}" 属于必选检查（optional 不为 true），严禁标记为 explicitly_skipped；请完成真实执行或如实记为 uncovered/incomplete。`,
        });
      }
      if (raw.verdict === "passed" || raw.passed === true) {
        findings.push({
          code: SFT_ERROR_CODES.RECEIPT_INVALID,
          itemId: id,
          message: `测试项 "${id}" 的状态为 explicitly_skipped（经确认本轮未执行），严禁将 verdict 标为 passed；跳过不等于测试通过，verdict 必须保持为 not-evaluated。`,
        });
      }
      const residualRisks = Array.isArray(raw.residualRisks) ? raw.residualRisks.filter((s) => typeof s === "string" && s.trim() !== "") : [];
      const fallbackGates = Array.isArray(raw.fallbackGates) ? raw.fallbackGates.filter((s) => typeof s === "string" && s.trim() !== "") : [];
      if (!raw.approvedBy || !raw.reason || !raw.applicabilityBoundary || residualRisks.length === 0 || fallbackGates.length === 0) {
        findings.push({
          code: SFT_ERROR_CODES.RECEIPT_INVALID,
          itemId: id,
          message: `显式跳过项 "${id}" 必须完整填写 approvedBy（批准人）、reason（跳过原因）、applicabilityBoundary（适用边界）、residualRisks（残余风险列表）与 fallbackGates（兜底必检门禁列表）。`,
        });
      }
      explicitlySkippedIds.push(id);
      normalizedItems.push({
        id,
        requirementId: raw.requirementId ?? id,
        optional: Boolean(raw.optional),
        disposition: "explicitly_skipped",
        verdict: "not-evaluated",
        passed: false,
        approvedBy: raw.approvedBy ?? null,
        reason: raw.reason ?? null,
        applicabilityBoundary: raw.applicabilityBoundary ?? null,
        residualRisks,
        fallbackGates,
        evidence,
      });
      continue;
    }

    if (disposition === "not_executed") {
      // 编排/环境故障隔离（US-031）：因 PATH、Node 版本或参数错误未真正执行产品逻辑时，单独归类，不冒充通过，也不混入产品逻辑缺陷。
      if (raw.verdict === "passed" || raw.passed === true) {
        findings.push({ code: SFT_ERROR_CODES.RECEIPT_INVALID, itemId: id, message: `未执行项 "${id}"（not_executed）不能标为 passed。` });
      }
      notExecutedIds.push(id);
      normalizedItems.push({
        id,
        requirementId: raw.requirementId ?? id,
        disposition: "not_executed",
        failureKind: ALLOWED_FAILURE_KINDS.has(raw.failureKind) ? raw.failureKind : "orchestration_error",
        verdict: "not-evaluated",
        passed: false,
        reason: raw.reason ?? "验证命令因环境、PATH 或调用参数问题未能执行，需修正环境后重跑",
        command: raw.command ?? null,
        exitCode: raw.exitCode ?? null,
        evidence,
      });
      continue;
    }

    if (disposition === "executed") {
      if (raw.exitCode !== undefined && raw.exitCode !== null && raw.exitCode !== 0 && (raw.verdict === "passed" || raw.passed === true)) {
        findings.push({
          code: SFT_ERROR_CODES.RECEIPT_INVALID,
          itemId: id,
          message: `测试项 "${id}" 进程退出码 exitCode=${raw.exitCode}（非 0），严禁将 verdict 标为 passed。`,
        });
      }
      if (raw.businessComplete === false && (raw.verdict === "passed" || raw.passed === true)) {
        findings.push({
          code: SFT_ERROR_CODES.RECEIPT_INVALID,
          itemId: id,
          message: `测试项 "${id}" 虽然进程退出码可能为 0，但 businessComplete 为 false（业务目标未完成），严禁标为 passed；请改为 incomplete。`,
        });
      }
      if ((raw.passed === false && raw.verdict === "passed") || (raw.passed === true && raw.verdict === "failed")) {
        findings.push({
          code: SFT_ERROR_CODES.RECEIPT_INVALID,
          itemId: id,
          message: `测试项 "${id}" 的 passed 与 verdict 字段自相矛盾。`,
        });
      }
      const rawVerdict = ALLOWED_VERDICTS.has(raw.verdict) ? raw.verdict : undefined;
      const verdict = rawVerdict ?? (raw.businessComplete === true && raw.exitCode === 0 ? "passed" : "failed");
      if (verdict === "passed") {
        if (!raw.acceptedBy || evidence.length === 0) {
          findings.push({ code: SFT_ERROR_CODES.RECEIPT_INVALID, itemId: id, message: `已执行通过项 "${id}" 必须提供原领域验收人 acceptedBy 及至少一份可核验的 evidence 文件引用。` });
        }
        passedIds.push(id);
      } else if (verdict === "failed") {
        failedIds.push(id);
      } else {
        openIds.push(id);
      }
      normalizedItems.push({
        id,
        requirementId: raw.requirementId ?? id,
        disposition: verdict === "failed" ? "failed" : "executed",
        failureKind: verdict === "failed" ? (ALLOWED_FAILURE_KINDS.has(raw.failureKind) ? raw.failureKind : "product_failure") : null,
        verdict,
        passed: verdict === "passed",
        acceptedBy: raw.acceptedBy ?? null,
        exitCode: raw.exitCode ?? null,
        businessComplete: raw.businessComplete ?? (verdict === "passed"),
        reason: raw.reason ?? null,
        evidence,
      });
      continue;
    }

    if (disposition === "reused" || disposition === "not-applicable") {
      if (raw.verdict === "failed" || raw.passed === false) {
        findings.push({
          code: SFT_ERROR_CODES.RECEIPT_INVALID,
          itemId: id,
          message: `测试项 "${id}"（${disposition}）不能同时携带失败结论。`,
        });
      }
      if (!raw.acceptedBy || (disposition === "reused" && evidence.length === 0)) {
        findings.push({ code: SFT_ERROR_CODES.RECEIPT_INVALID, itemId: id, message: `测试项 "${id}"（${disposition}）必须声明确认人 acceptedBy${disposition === "reused" ? " 并附原通过证据 evidence" : ""}。` });
      }
      if (disposition === "reused" && !hasMatchingReuseFactors(raw.prior, raw.current)) {
        findings.push({
          code: SFT_ERROR_CODES.RECEIPT_INVALID,
          itemId: id,
          message: `复用项 "${id}" 不满足有效复用六要素前提：要求 prior.verdict 为 passed、非纯历史读取，且 ${REUSE_KEYS.join("/")}（对象身份/形态/工具版本/判据版本/环境/范围）与 current 完全一致。`,
        });
      }
      if (disposition === "reused") reusedIds.push(id);
      else notApplicableIds.push(id);
      normalizedItems.push({
        id,
        requirementId: raw.requirementId ?? id,
        disposition,
        verdict: "passed",
        passed: true,
        acceptedBy: raw.acceptedBy ?? null,
        reason: raw.reason ?? null,
        evidence,
      });
      continue;
    }

    if (disposition === "failed") failedIds.push(id);
    else openIds.push(id);
    normalizedItems.push({
      id,
      requirementId: raw.requirementId ?? id,
      disposition,
      failureKind: disposition === "failed" ? (ALLOWED_FAILURE_KINDS.has(raw.failureKind) ? raw.failureKind : "product_failure") : null,
      verdict: disposition === "failed" ? "failed" : "not-evaluated",
      passed: false,
      acceptedBy: raw.acceptedBy ?? null,
      reason: raw.reason ?? null,
      evidence,
    });
  }

  const hasBlockers = findings.length > 0 || failedIds.length > 0 || notExecutedIds.length > 0 || openIds.length > 0;
  const overallStatus = hasBlockers
    ? "blocked"
    : explicitlySkippedIds.length > 0
      ? "passed_with_explicit_skips"
      : "all_required_passed";

  const receiptBody = {
    schemaVersion: 1,
    kind: "skill-family-test.run-receipt",
    ok: !hasBlockers,
    overallStatus,
    subjectDigest: runInput.subjectDigest ?? null,
    planDigest: runInput.planDigest ?? null,
    summary: {
      total: normalizedItems.length,
      passed: passedIds.length,
      reused: reusedIds.length,
      notApplicable: notApplicableIds.length,
      explicitlySkipped: explicitlySkippedIds.length,
      notExecuted: notExecutedIds.length,
      failed: failedIds.length,
      incompleteOrUncovered: openIds.length,
    },
    passedIds,
    reusedIds,
    notApplicableIds,
    explicitlySkippedIds,
    notExecutedIds,
    failedIds,
    openIds,
    items: normalizedItems,
    findings,
  };
  const receipt = { ...receiptBody, receiptDigest: sha256Hex(JSON.stringify(receiptBody)) };
  if (outPath) {
    if (!root) {
      throw createSftError(SFT_ERROR_CODES.INVALID_ARGS, "指定 --out 输出收据路径时，必须同时指定 --root 项目根目录以校验写入边界。");
    }
    const written = await writeContainedJsonAtomic(root, outPath, receipt);
    return { ...receipt, writtenTo: written.relPath };
  }
  return receipt;
}
