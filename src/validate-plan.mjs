// @feature TST001 @scenario S-001 S-003
// 测试计划结构、分层覆盖、验收条件直接行为映射、候选/设计输入绑定与复用前提校验器（覆盖 US-018、US-028、US-033）。

import { createSftError, SFT_ERROR_CODES } from "./errors.mjs";
import { normalizeRelativePath, readContainedBytesAndDigest, SHA256_HEX_REGEX, sha256Hex } from "./fs-utils.mjs";
import { hasMatchingReuseFactors, REUSE_KEYS, validateContractByDefinition } from "./schema-validator.mjs";

const STAGE_MAP = Object.freeze({
  "development-baseline": "development-baseline",
  "开发基线": "development-baseline",
  "candidate-delivery": "candidate-delivery",
  "候选交付": "candidate-delivery",
  "stable-acceptance": "stable-acceptance",
  "稳定业务验收": "stable-acceptance",
});

const DISPOSITION_MAP = Object.freeze({
  execute: "execute",
  "本次执行": "execute",
  reuse: "reuse",
  "有效复用": "reuse",
  "policy-accept": "policy-accept",
  "按版本政策接受": "policy-accept",
  "historical-read": "historical-read",
  "历史记录读取": "historical-read",
  uncovered: "uncovered",
  "未覆盖": "uncovered",
  "not-applicable": "not-applicable",
  "不适用": "not-applicable",
  explicitly_skipped: "explicitly_skipped",
});

const DIRECT_BEHAVIOR_LAYERS = new Set([
  "integration",
  "e2e",
  "cli-smoke",
  "direct-behavior",
  "host",
  "payload",
  "scenario",
  "acceptance",
]);
const MOCK_ONLY_LAYERS = new Set(["unit-mock", "mock", "stub"]);
const VALID_VERIFICATION_DEPTHS = new Set(["direct", "indirect", "mock"]);

function normalizeDeclaredCriteria(rawCriteria, findings) {
  if (rawCriteria === undefined || rawCriteria === null) return [];
  if (!Array.isArray(rawCriteria)) {
    pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, "acceptanceCriteria 必须是数组（支持验收编号字符串或含 id 的结构化声明）。");
    return [];
  }
  const normalized = [];
  const seenAcIds = new Set();
  for (const [idx, entry] of rawCriteria.entries()) {
    let record = null;
    if (typeof entry === "string") {
      const id = entry.trim();
      if (!id) {
        pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, `acceptanceCriteria[${idx}] 不能为空字符串。`);
        continue;
      }
      record = { id, description: null, requireDirectBehavior: null, structured: false };
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!id) {
        pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, `acceptanceCriteria[${idx}] 缺少非空字符串字段 id（如 "AC-1"）。`);
        continue;
      }
      if (entry.requireDirectBehavior !== undefined && typeof entry.requireDirectBehavior !== "boolean") {
        pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, `acceptanceCriteria[${idx}]（"${id}"）的 requireDirectBehavior 必须是布尔值。`);
      }
      record = {
        id,
        description: typeof entry.description === "string" ? entry.description : null,
        requireDirectBehavior: typeof entry.requireDirectBehavior === "boolean" ? entry.requireDirectBehavior : null,
        structured: true,
      };
    } else {
      pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, `acceptanceCriteria[${idx}] 必须是验收条件编号字符串或包含 id 的对象。`);
      continue;
    }
    if (seenAcIds.has(record.id)) {
      pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, `acceptanceCriteria 存在重复的验收条件编号 "${record.id}"。`);
      continue;
    }
    seenAcIds.add(record.id);
    normalized.push(record);
  }
  return normalized;
}

function classifyItemBehaviorDepth(item, layer, disposition) {
  if (disposition === "not-applicable") return "not-applicable";
  const lowerLayer = layer ? layer.toLowerCase() : "";
  if (item?.mockOnly === true || item?.verificationDepth === "mock" || MOCK_ONLY_LAYERS.has(lowerLayer)) {
    return "mock";
  }
  if (item?.verificationDepth === "direct" || (DIRECT_BEHAVIOR_LAYERS.has(lowerLayer) && item?.verificationDepth !== "indirect")) {
    return "direct";
  }
  return "indirect";
}

function pushFinding(findings, code, itemId, message, extra = {}) {
  findings.push({ code, itemId: itemId ?? null, message, ...extra });
}

function isHandledSemanticSchemaError(err, items) {
  if (err.instancePath === "" && err.keyword === "required") {
    return ["schemaVersion", "stage", "methodRevision", "stopCondition", "bindings", "items"].includes(err.params?.missingProperty);
  }
  if (err.instancePath === "/schemaVersion" && err.keyword === "const") return true;
  if (err.instancePath === "/stage" && (err.keyword === "enum" || err.keyword === "type")) return true;
  if ((err.instancePath === "/methodRevision" || err.instancePath === "/stopCondition") && (err.keyword === "minLength" || err.keyword === "type")) return true;
  if (err.instancePath === "/items" && (err.keyword === "minItems" || err.keyword === "type")) return true;
  const itemMatch = /^\/items\/(\d+)(?:\/(.*))?$/.exec(err.instancePath);
  if (itemMatch) {
    const idx = Number(itemMatch[1]);
    const sub = itemMatch[2] ?? "";
    const rawItem = Array.isArray(items) ? items[idx] : null;
    if (sub === "" && err.keyword === "additionalProperties") {
      const prop = err.params?.additionalProperty;
      if ((prop === "verdict" && rawItem?.verdict === "passed") || (prop === "passed" && rawItem?.passed === true)) {
        return true;
      }
    }
    if (sub === "disposition" && err.keyword === "enum") return true;
    if (sub === "verificationDepth" && err.keyword === "enum") return true;
    if ((sub === "layer" || sub === "reason") && (err.keyword === "minLength" || err.keyword === "type")) return true;
  }
  return false;
}

async function verifyBindingRef(ref, label, root, findings) {
  if (!ref || typeof ref !== "object") {
    pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, `${label} 缺少绑定对象；请提供包含 path 与 sha256 的文件引用。`);
    return;
  }
  const relPath = normalizeRelativePath(ref.path, `${label}.path`);
  if (typeof ref.sha256 !== "string" || !SHA256_HEX_REGEX.test(ref.sha256)) {
    pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, `${label}（"${relPath}"）缺少 64 位小写十六进制 sha256 摘要。`);
    return;
  }
  if (!root) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `${label} 引用了磁盘文件 "${relPath}"，必须同时传入 --root <项目根目录> 以实算核验磁盘 SHA-256 摘要。`,
      { field: label, path: relPath },
    );
  }
  try {
    const actual = await readContainedBytesAndDigest(root, relPath, label);
    if (actual.sha256 !== ref.sha256) {
      pushFinding(
        findings,
        SFT_ERROR_CODES.DIGEST_TAMPERED,
        null,
        `${label}（"${relPath}"）的磁盘实际摘要与计划绑定摘要不一致；请刷新测试计划输入绑定后再执行。`,
        { path: relPath, expectedSha256: ref.sha256, actualSha256: actual.sha256 },
      );
    }
  } catch (err) {
    pushFinding(findings, err.code ?? SFT_ERROR_CODES.IO_CONTAINMENT, null, err.message, err.details);
  }
}

export async function validateTestPlan(planInput, { root = null, strictAcBehavior = false } = {}) {
  if (!planInput || typeof planInput !== "object" || Array.isArray(planInput)) {
    throw createSftError(SFT_ERROR_CODES.PLAN_INVALID, "测试计划必须是 JSON 对象；请检查输入文件内容。");
  }
  const findings = [];
  const warnings = [];

  const schemaCheck = validateContractByDefinition("testPlan", planInput);
  if (!schemaCheck.valid) {
    const rawItems = Array.isArray(planInput.items) ? planInput.items : [];
    for (const err of schemaCheck.errors) {
      if (isHandledSemanticSchemaError(err, rawItems)) continue;
      const itemMatch = /^\/items\/(\d+)(?:\/|$)/.exec(err.instancePath);
      let itemId = null;
      if (itemMatch) {
        const idx = Number(itemMatch[1]);
        const raw = rawItems[idx];
        itemId = typeof raw?.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : `items[${idx}]`;
      }
      pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `测试计划契约校验失败：${err.message}。`, {
        schemaKeyword: err.keyword,
        instancePath: err.instancePath,
      });
    }
  }

  if (planInput.schemaVersion !== 1) {
    pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, "测试计划必须声明 schemaVersion: 1。");
  }
  const normalizedStage = STAGE_MAP[planInput.stage] ?? null;
  if (!normalizedStage) {
    pushFinding(
      findings,
      SFT_ERROR_CODES.PLAN_INVALID,
      null,
      `测试计划 stage "${String(planInput.stage ?? "")}" 无效；请设为 development-baseline（开发基线）、candidate-delivery（候选交付）或 stable-acceptance（稳定业务验收）。`,
    );
  }
  if (typeof planInput.methodRevision !== "string" || planInput.methodRevision.trim() === "") {
    pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, "测试计划必须声明所依据的方法修订身份 methodRevision（如 design-testing-methodology@0.1.2）。");
  }
  if (typeof planInput.stopCondition !== "string" || planInput.stopCondition.trim() === "") {
    pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, "测试计划必须明确声明整体停止条件 stopCondition，避免无边界扩测。");
  }

  const bindings = planInput.bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, "测试计划缺少 bindings 段；请至少绑定一处设计、需求或候选输入文件。");
  } else {
    const designDocs = Array.isArray(bindings.designDocs) ? bindings.designDocs : [];
    const hasCandidate = bindings.candidateRef !== undefined && bindings.candidateRef !== null;
    const hasRequirements = bindings.requirementsRef !== undefined && bindings.requirementsRef !== null;
    if (designDocs.length === 0 && !hasCandidate && !hasRequirements) {
      pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, "bindings 中至少需要提供 designDocs、requirementsRef 或 candidateRef 之一。");
    }
    for (let i = 0; i < designDocs.length; i += 1) {
      await verifyBindingRef(designDocs[i], `bindings.designDocs[${i}]`, root, findings);
    }
    if (hasCandidate) await verifyBindingRef(bindings.candidateRef, "bindings.candidateRef", root, findings);
    if (hasRequirements) await verifyBindingRef(bindings.requirementsRef, "bindings.requirementsRef", root, findings);
  }

  const items = Array.isArray(planInput.items) ? planInput.items : [];
  if (items.length === 0) {
    pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, "测试计划 items 不能为空；请至少声明一条测试条目。");
  }

  const seenIds = new Set();
  const layerCoverage = {};
  const coveredCriteriaSet = new Set();
  const criteriaItemMap = new Map();
  const uncoveredIds = [];
  let hasNormalBaseline = false;
  let hasRiskFailureBaseline = false;

  for (const [idx, item] of items.entries()) {
    const itemId = typeof item?.id === "string" && item.id.trim() !== "" ? item.id.trim() : `items[${idx}]`;
    if (seenIds.has(itemId)) {
      pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `测试计划存在重复的条目 id "${itemId}"；请保证每项标识唯一。`);
    }
    seenIds.add(itemId);

    if (item?.verdict === "passed" || item?.passed === true) {
      pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `条目 "${itemId}" 在规划阶段被标记为通过；规划只决定测什么与怎么复用，不得预填通过结论。`);
    }
    const layer = typeof item?.layer === "string" && item.layer.trim() !== "" ? item.layer.trim() : null;
    if (!layer) {
      pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `条目 "${itemId}" 缺少测试分层字段 layer（如 unit / integration / host / e2e）。`);
    } else {
      layerCoverage[layer] = (layerCoverage[layer] ?? 0) + 1;
    }
    if (item?.verificationDepth !== undefined && !VALID_VERIFICATION_DEPTHS.has(item.verificationDepth)) {
      pushFinding(
        findings,
        SFT_ERROR_CODES.PLAN_INVALID,
        itemId,
        `条目 "${itemId}" 的 verificationDepth "${String(item.verificationDepth)}" 无效；仅允许 "direct"、"indirect" 或 "mock"。`,
      );
    }

    const disposition = DISPOSITION_MAP[item?.disposition] ?? null;
    if (!disposition) {
      pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `条目 "${itemId}" 的材料状态 disposition 无效；请使用 execute、reuse、policy-accept、historical-read、uncovered、not-applicable 或 explicitly_skipped。`);
      continue;
    }
    if (typeof item?.reason !== "string" || item.reason.trim() === "") {
      pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `条目 "${itemId}" 必须提供选择当前状态的具体理由 reason。`);
    }
    if (item?.graphNoteOnly === true && disposition !== "uncovered") {
      pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `条目 "${itemId}" 仅有制品图说明而未绑定真实原件（graphNoteOnly: true），必须保留为 uncovered。`);
    }

    if (disposition === "execute") {
      if (typeof item?.entry !== "string" || item.entry.trim() === "" || typeof item?.criterionHolder !== "string" || item.criterionHolder.trim() === "") {
        pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `本次执行条目 "${itemId}" 必须写明执行入口 entry 与判据持有人 criterionHolder。`);
      }
      if (item?.workflowRole === "normal") hasNormalBaseline = true;
      if (item?.workflowRole === "risk-failure") hasRiskFailureBaseline = true;
    } else if (disposition === "reuse") {
      if (!hasMatchingReuseFactors(item?.prior, item?.current)) {
        pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `条目 "${itemId}" 不满足有效复用前提：要求原结论为 passed、非纯历史读取，且 ${REUSE_KEYS.join("/")}（对象身份/形态/工具版本/判据版本/环境/范围）六要素与本次完全一致。`);
      }
    } else if (disposition === "policy-accept") {
      if (!item?.policy?.name || !item?.policy?.publicCoverage) {
        pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `条目 "${itemId}" 按版本政策接受时，必须注明非空的 policy.name 与公开覆盖范围 policy.publicCoverage。`);
      }
    } else if (disposition === "not-applicable") {
      if (!item?.notApplicable?.authorizedBy || !item?.notApplicable?.reason) {
        pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `条目 "${itemId}" 标记为不适用时，必须记录原要求持有方 notApplicable.authorizedBy 与范围依据 reason。`);
      }
    } else if (disposition === "explicitly_skipped") {
      if (item?.optional !== true || !item?.approvedBy || !item?.applicabilityBoundary) {
        pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, itemId, `条目 "${itemId}" 申请本轮显式跳过时，必须为可选测试（optional: true）并注明 approvedBy 与适用边界 applicabilityBoundary。`);
      }
    }

    if (disposition === "uncovered" || disposition === "historical-read") {
      uncoveredIds.push(itemId);
    } else if (disposition !== "explicitly_skipped") {
      const depth = classifyItemBehaviorDepth(item, layer, disposition);
      const itemCriteria = new Set();
      for (const rawList of [item?.coversCriteria, item?.coversAcceptanceCriteria]) {
        if (Array.isArray(rawList)) {
          for (const ac of rawList) {
            if (typeof ac === "string" && ac.trim() !== "") itemCriteria.add(ac.trim());
          }
        }
      }
      for (const acId of itemCriteria) {
        coveredCriteriaSet.add(acId);
        const list = criteriaItemMap.get(acId) ?? [];
        list.push({ id: itemId, layer: layer ?? "unspecified", disposition, depth });
        criteriaItemMap.set(acId, list);
      }
    }
  }

  if (planInput.firstBaseline === true && (!hasNormalBaseline || !hasRiskFailureBaseline)) {
    pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, "首次建立基线（firstBaseline: true）时，必须至少安排一条代表性正常路径（workflowRole: normal）和一条风险失败路径（workflowRole: risk-failure）为本次执行。");
  }

  const normalizedCriteria = normalizeDeclaredCriteria(planInput.acceptanceCriteria, findings);
  const uncoveredCriteria = [];
  const directBehaviorCriteria = [];
  const mockOnlyCriteria = [];
  const indirectOnlyCriteria = [];
  const acceptanceCriteriaCoverage = [];

  for (const crit of normalizedCriteria) {
    const coveringItems = criteriaItemMap.get(crit.id) ?? [];
    if (coveringItems.length === 0) {
      uncoveredCriteria.push(crit.id);
      acceptanceCriteriaCoverage.push({ id: crit.id, description: crit.description, status: "uncovered", coveringItemIds: [] });
      continue;
    }
    const hasNotApplicable = coveringItems.some((c) => c.depth === "not-applicable");
    const hasDirect = coveringItems.some((c) => c.depth === "direct");
    const hasIndirect = coveringItems.some((c) => c.depth === "indirect");
    const coveringItemIds = coveringItems.map((c) => c.id);
    const labelSummary = coveringItems.map((c) => `${c.id}[${c.layer}]`).join(", ");

    if (hasDirect || hasNotApplicable) {
      directBehaviorCriteria.push(crit.id);
      acceptanceCriteriaCoverage.push({
        id: crit.id,
        description: crit.description,
        status: hasDirect ? "direct" : "not-applicable",
        coveringItemIds,
      });
    } else if (!hasIndirect) {
      mockOnlyCriteria.push(crit.id);
      acceptanceCriteriaCoverage.push({ id: crit.id, description: crit.description, status: "mock-only", coveringItemIds });
      const baseMsg = `验收条件 "${crit.id}" 当前仅由纯替身/模拟测试（${labelSummary}）覆盖，尚未验证真实用户可见行为；请至少补充一条 integration / e2e / cli-smoke / direct-behavior 层用例，或为真实行为用例标注 verificationDepth: "direct"。`;
      if (strictAcBehavior || crit.requireDirectBehavior === true) {
        pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, baseMsg, { criterionId: crit.id, reasonCode: "mock_only_coverage" });
      } else {
        warnings.push({
          code: "SFT_AC_BEHAVIOR_WARNING",
          criterionId: crit.id,
          reasonCode: "mock_only_coverage",
          message: `${baseMsg}（传入 --strict-ac-behavior 可将该告警升级为硬阻断）`,
        });
      }
    } else {
      indirectOnlyCriteria.push(crit.id);
      acceptanceCriteriaCoverage.push({ id: crit.id, description: crit.description, status: "indirect-only", coveringItemIds });
      const baseMsg = `验收条件 "${crit.id}" 当前仅由模块单测层（${labelSummary}）覆盖，缺少直接行为层（integration / e2e / cli-smoke / direct-behavior 或 verificationDepth: "direct"）验证。`;
      if ((strictAcBehavior && crit.requireDirectBehavior !== false) || crit.requireDirectBehavior === true) {
        pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, baseMsg, { criterionId: crit.id, reasonCode: "missing_direct_behavior" });
      } else if (crit.structured && crit.requireDirectBehavior !== false) {
        warnings.push({
          code: "SFT_AC_BEHAVIOR_WARNING",
          criterionId: crit.id,
          reasonCode: "missing_direct_behavior",
          message: `${baseMsg}（传入 --strict-ac-behavior 或设置 requireDirectBehavior: true 可升级为硬阻断）`,
        });
      }
    }
  }

  if (uncoveredCriteria.length > 0) {
    pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, `以下验收条件尚未绑定有效的执行、复用或原权威不适用条目：${uncoveredCriteria.join(", ")}。`, { uncoveredCriteria });
  }
  if (normalizedStage === "stable-acceptance" && uncoveredIds.length > 0) {
    pushFinding(findings, SFT_ERROR_CODES.PLAN_INVALID, null, `稳定业务验收阶段不允许保留未覆盖或纯历史读取项（当前未决：${uncoveredIds.join(", ")}）。`, { uncoveredIds });
  }

  const valid = findings.length === 0;
  return {
    valid,
    readyToRun: valid && uncoveredCriteria.length === 0,
    stage: normalizedStage,
    methodRevision: planInput.methodRevision ?? null,
    layerCoverage,
    coveredCriteria: [...coveredCriteriaSet].sort(),
    uncoveredCriteria,
    directBehaviorCriteria: [...directBehaviorCriteria].sort(),
    mockOnlyCriteria: [...mockOnlyCriteria].sort(),
    indirectOnlyCriteria: [...indirectOnlyCriteria].sort(),
    acceptanceCriteriaCoverage,
    uncoveredIds,
    warnings,
    findings,
    planDigest: sha256Hex(JSON.stringify(planInput)),
  };
}
