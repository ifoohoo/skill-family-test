// @feature TST001 @scenario S-003
// 轻量多样本防过拟合探针（覆盖 US-005 工程化前最小代表性样本验证、US-007 换材料回归对比）。

import { createSftError, SFT_ERROR_CODES } from "./errors.mjs";
import { readContainedBytesAndDigest, sha256Hex } from "./fs-utils.mjs";
import { validateContractByDefinition } from "./schema-validator.mjs";

const ALLOWED_ASSERTION_KEYS = new Set([
  "minLength",
  "requiredSubstrings",
  "forbiddenSubstrings",
  "requiredJsonFields",
  "equalsJsonFields",
]);

function canonicalizeValue(val) {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(canonicalizeValue).join(",")}]`;
  const keys = Object.keys(val).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeValue(val[k])}`).join(",")}}`;
}

function shapeSignature(val) {
  if (typeof val === "string") {
    const trimmed = val.trim();
    const hasCodeFence = trimmed.includes("```");
    const hasList = /(?:^|\n)\s*[-*\d]/.test(trimmed);
    const lengthBucket = trimmed.length < 40 ? "short" : trimmed.length < 200 ? "medium" : "long";
    return `text:${lengthBucket}:fence=${hasCodeFence}:list=${hasList}`;
  }
  if (Array.isArray(val)) return `array:${val.length > 0 ? typeof val[0] : "empty"}`;
  if (val && typeof val === "object") return `object:${Object.keys(val).sort().join(",")}`;
  return typeof val;
}

function evaluateAssertions(outputValue, assertions = {}) {
  const failures = [];
  if (!assertions || typeof assertions !== "object" || Array.isArray(assertions)) {
    return { verdict: "failed", failures: ["assertions 必须是 JSON 对象"] };
  }
  const assertionKeys = Object.keys(assertions);
  if (assertionKeys.length === 0) {
    return { verdict: "failed", failures: ["assertions 未声明任何断言条件"] };
  }
  for (const key of assertionKeys) {
    if (!ALLOWED_ASSERTION_KEYS.has(key)) {
      failures.push(`assertions 包含未知断言键 "${key}"（仅支持 ${[...ALLOWED_ASSERTION_KEYS].join("、")}）`);
    }
  }
  const textView = typeof outputValue === "string" ? outputValue : JSON.stringify(outputValue ?? "");
  let parsedObj = outputValue && typeof outputValue === "object" ? outputValue : null;
  if (!parsedObj && typeof outputValue === "string") {
    try {
      const candidate = JSON.parse(outputValue);
      if (candidate && typeof candidate === "object") parsedObj = candidate;
    } catch {
      // 纯文本输出无需强制为 JSON
    }
  }

  if (assertions.minLength !== undefined) {
    if (typeof assertions.minLength !== "number" || !Number.isInteger(assertions.minLength) || assertions.minLength < 0) {
      failures.push("assertions.minLength 必须是非负整数");
    } else if (textView.trim().length < assertions.minLength) {
      failures.push(`输出长度（${textView.trim().length}）小于要求的最小长度 ${assertions.minLength}`);
    }
  }
  if (assertions.requiredSubstrings !== undefined && !Array.isArray(assertions.requiredSubstrings)) {
    failures.push("assertions.requiredSubstrings 必须是字符串数组");
  }
  for (const sub of Array.isArray(assertions.requiredSubstrings) ? assertions.requiredSubstrings : []) {
    if (!textView.includes(sub)) failures.push(`输出缺少必需的关键内容 "${sub}"`);
  }
  if (assertions.forbiddenSubstrings !== undefined && !Array.isArray(assertions.forbiddenSubstrings)) {
    failures.push("assertions.forbiddenSubstrings 必须是字符串数组");
  }
  for (const sub of Array.isArray(assertions.forbiddenSubstrings) ? assertions.forbiddenSubstrings : []) {
    if (textView.includes(sub)) failures.push(`输出包含禁止出现的内容 "${sub}"`);
  }
  if (assertions.requiredJsonFields !== undefined && !Array.isArray(assertions.requiredJsonFields)) {
    failures.push("assertions.requiredJsonFields 必须是字符串数组");
  }
  if (Array.isArray(assertions.requiredJsonFields) && assertions.requiredJsonFields.length > 0) {
    if (!parsedObj || Array.isArray(parsedObj)) {
      failures.push("断言要求 JSON 对象字段，但输出不是可解析的 JSON 对象");
    } else {
      for (const field of assertions.requiredJsonFields) {
        if (!Object.hasOwn(parsedObj, field) || parsedObj[field] === undefined || parsedObj[field] === null) {
          failures.push(`JSON 输出缺少必需字段 "${field}"`);
        }
      }
    }
  }
  if (assertions.equalsJsonFields !== undefined && (!assertions.equalsJsonFields || typeof assertions.equalsJsonFields !== "object" || Array.isArray(assertions.equalsJsonFields))) {
    failures.push("assertions.equalsJsonFields 必须是键值对对象");
  }
  if (assertions.equalsJsonFields && typeof assertions.equalsJsonFields === "object" && !Array.isArray(assertions.equalsJsonFields)) {
    if (!parsedObj || Array.isArray(parsedObj)) {
      failures.push("断言要求比对 JSON 字段值，但输出不是 JSON 对象");
    } else {
      for (const [field, expected] of Object.entries(assertions.equalsJsonFields)) {
        if (canonicalizeValue(parsedObj[field]) !== canonicalizeValue(expected)) {
          failures.push(`JSON 字段 "${field}" 实际值为 ${JSON.stringify(parsedObj[field])}，与期望值 ${JSON.stringify(expected)} 不符`);
        }
      }
    }
  }
  return { verdict: failures.length === 0 ? "passed" : "failed", failures };
}

async function loadPayload(directValue, fileField, root, label) {
  if (directValue !== undefined) return directValue;
  if (typeof fileField === "string" && fileField.trim() !== "") {
    if (!root) {
      throw createSftError(SFT_ERROR_CODES.INVALID_ARGS, `${label} 引用了文件路径 "${fileField}"，请同时传入 --root 指定项目根目录。`);
    }
    const loaded = await readContainedBytesAndDigest(root, fileField, label);
    return loaded.bytes.toString("utf8");
  }
  return undefined;
}

export async function evaluateSmokeSamples(suiteInput, { root = null } = {}) {
  if (!suiteInput || typeof suiteInput !== "object" || Array.isArray(suiteInput)) {
    throw createSftError(SFT_ERROR_CODES.SMOKE_OVERFIT_RISK, "最小样本探针输入必须是 JSON 对象。");
  }
  if (suiteInput.schemaVersion !== 1) {
    throw createSftError(SFT_ERROR_CODES.SMOKE_OVERFIT_RISK, "最小样本探针输入必须声明 schemaVersion: 1。");
  }
  if (typeof suiteInput.skillId !== "string" || suiteInput.skillId.trim() === "") {
    throw createSftError(SFT_ERROR_CODES.SMOKE_OVERFIT_RISK, "必须指定被验证的技能标识 skillId。");
  }

  const schemaCheck = validateContractByDefinition("evalSmokeSuite", suiteInput);
  const rawSamples = Array.isArray(suiteInput.samples) ? suiteInput.samples : [];
  const findings = [];
  if (!schemaCheck.valid) {
    for (const err of schemaCheck.errors) {
      if (err.instancePath === "/samples" && err.keyword === "minItems") continue;
      if (err.instancePath === "" || err.instancePath === "/schemaVersion" || err.instancePath === "/skillId") {
        throw createSftError(
          SFT_ERROR_CODES.SMOKE_OVERFIT_RISK,
          `最小样本探针顶层契约校验失败：${err.message}。`,
          { schemaKeyword: err.keyword, instancePath: err.instancePath },
        );
      }
      const sampleMatch = /^\/samples\/(\d+)(?:\/|$)/.exec(err.instancePath);
      const idx = sampleMatch ? Number(sampleMatch[1]) : null;
      const sampleId = idx !== null && typeof rawSamples[idx]?.id === "string" && rawSamples[idx].id.trim() !== ""
        ? rawSamples[idx].id.trim()
        : idx !== null
          ? `samples[${idx}]`
          : null;
      findings.push({
        code: SFT_ERROR_CODES.SMOKE_OVERFIT_RISK,
        sampleId,
        message: `样本契约校验失败：${err.message}。`,
        schemaKeyword: err.keyword,
        instancePath: err.instancePath,
      });
    }
  }

  if (rawSamples.length < 2) {
    findings.push({
      code: SFT_ERROR_CODES.SMOKE_OVERFIT_RISK,
      sampleId: null,
      message: `当前仅提供了 ${rawSamples.length} 份样本；工程化前验证与防过拟合回归至少需要 2 份异构真实样本，禁止仅凭单一样本宣称泛化成立。`,
    });
  }

  const seenIds = new Set();
  const inputDigests = new Set();
  const heterogeneityKeys = new Set();
  const evaluatedSamples = [];
  const summary = { improved: 0, preservedPass: 0, regressed: 0, stillFailing: 0, initialPass: 0, initialFail: 0 };
  let hasBaselineComparison = false;

  for (const [idx, sample] of rawSamples.entries()) {
    const id = typeof sample?.id === "string" && sample.id.trim() !== "" ? sample.id.trim() : `samples[${idx}]`;
    if (seenIds.has(id)) {
      findings.push({ code: SFT_ERROR_CODES.SMOKE_OVERFIT_RISK, sampleId: id, message: `样本集存在重复 id "${id}"。` });
    }
    seenIds.add(id);

    const inputVal = await loadPayload(sample?.input, sample?.inputFile, root, `samples[${idx}].input`);
    if (inputVal === undefined || (typeof inputVal === "string" && inputVal.trim() === "")) {
      findings.push({ code: SFT_ERROR_CODES.SMOKE_OVERFIT_RISK, sampleId: id, message: `样本 "${id}" 缺少有效输入内容 input。` });
      continue;
    }
    const inputSha256 = sha256Hex(canonicalizeValue(inputVal));
    inputDigests.add(inputSha256);
    const kindTag = typeof sample?.scenarioKind === "string" && sample.scenarioKind.trim() !== "" ? sample.scenarioKind.trim() : null;
    heterogeneityKeys.add(kindTag ? `kind:${kindTag}` : shapeSignature(inputVal));

    const candidateOutput = await loadPayload(sample?.candidateOutput, sample?.candidateOutputFile, root, `samples[${idx}].candidateOutput`);
    if (candidateOutput === undefined) {
      findings.push({ code: SFT_ERROR_CODES.SMOKE_OVERFIT_RISK, sampleId: id, message: `样本 "${id}" 缺少修改后候选输出 candidateOutput。` });
      continue;
    }
    const assertions = sample?.assertions ?? {};
    const hasAnyRule = assertions && typeof assertions === "object" && !Array.isArray(assertions) && Object.keys(assertions).length > 0;
    if (!hasAnyRule) {
      findings.push({ code: SFT_ERROR_CODES.SMOKE_OVERFIT_RISK, sampleId: id, message: `样本 "${id}" 未声明任何只读判定条件 assertions，无法验证业务输出是否达标。` });
    } else {
      const unknownAssertionKeys = Object.keys(assertions).filter((k) => !ALLOWED_ASSERTION_KEYS.has(k));
      if (unknownAssertionKeys.length > 0) {
        findings.push({
          code: SFT_ERROR_CODES.SMOKE_OVERFIT_RISK,
          sampleId: id,
          message: `样本 "${id}" 的 assertions 包含未知断言键（${unknownAssertionKeys.join(", ")}），拒绝空混过关。`,
        });
      }
    }

    const afterEval = evaluateAssertions(candidateOutput, assertions);
    const baselineOutput = await loadPayload(sample?.baselineOutput, sample?.baselineOutputFile, root, `samples[${idx}].baselineOutput`);
    let beforeVerdict = "not-provided";
    let transition = afterEval.verdict === "passed" ? "initial_pass" : "initial_fail";

    if (baselineOutput !== undefined) {
      hasBaselineComparison = true;
      const beforeEval = evaluateAssertions(baselineOutput, assertions);
      beforeVerdict = beforeEval.verdict;
      if (beforeVerdict === "passed" && afterEval.verdict === "failed") {
        transition = "regressed";
        summary.regressed += 1;
        findings.push({
          code: SFT_ERROR_CODES.SMOKE_OVERFIT_RISK,
          sampleId: id,
          message: `样本 "${id}" 发生回归退化（修改前 passed -> 修改后 failed）：疑似针对新材料硬编码打补丁破坏了既有正常样本。`,
        });
      } else if (beforeVerdict === "failed" && afterEval.verdict === "passed") {
        transition = "improved";
        summary.improved += 1;
      } else if (beforeVerdict === "passed" && afterEval.verdict === "passed") {
        transition = "preserved_pass";
        summary.preservedPass += 1;
      } else {
        transition = "still_failing";
        summary.stillFailing += 1;
      }
    } else if (afterEval.verdict === "passed") {
      summary.initialPass += 1;
    } else {
      summary.initialFail += 1;
    }

    evaluatedSamples.push({
      id,
      scenarioKind: kindTag,
      inputSha256,
      beforeVerdict,
      afterVerdict: afterEval.verdict,
      transition,
      failedAssertions: afterEval.failures,
    });
  }

  const uniqueInputs = inputDigests.size === evaluatedSamples.length && evaluatedSamples.length >= 2;
  const diverseStructure = heterogeneityKeys.size >= 2;
  const heterogeneous = uniqueInputs && diverseStructure;
  if (evaluatedSamples.length >= 2 && !uniqueInputs) {
    findings.push({
      code: SFT_ERROR_CODES.SMOKE_OVERFIT_RISK,
      sampleId: null,
      message: "样本集中存在完全相同的输入内容（inputSha256 重复）；请提供真正不同的真实业务材料。",
    });
  } else if (evaluatedSamples.length >= 2 && !diverseStructure) {
    findings.push({
      code: SFT_ERROR_CODES.SMOKE_OVERFIT_RISK,
      sampleId: null,
      message: "所有样本具有完全相同的结构指纹且未区分 scenarioKind（例如正常输入与边界/杂乱输入）；请补充异构样本以防模板过拟合。",
    });
  }

  const allAfterPassed = evaluatedSamples.length >= 2 && evaluatedSamples.every((s) => s.afterVerdict === "passed");
  return {
    schemaVersion: 1,
    kind: "skill-family-test.eval-smoke-report",
    skillId: suiteInput.skillId,
    passed: findings.length === 0 && heterogeneous && allAfterPassed,
    sampleCount: evaluatedSamples.length,
    heterogeneous,
    hasBaselineComparison,
    comparisonSummary: summary,
    samples: evaluatedSamples,
    findings,
  };
}
