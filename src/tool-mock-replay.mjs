// @feature TST002 @scenario S-003
// 外部工具 / MCP / CLI I/O 录制夹具密封与离线确定性替身回放引擎（Wave 4D-1）。
// 服务含外部网络、浏览器或 MCP 副作用的技能族：封存时强制脱敏凭据与个人宿主机路径并绑定规范化摘要，回放时零外部调用重算内外部摘要并校验参数漂移。

import { digestDocument } from "skill-family-contracts";
import { createSftError, SFT_ERROR_CODES } from "./errors.mjs";
import { SHA256_HEX_REGEX, sha256Hex } from "./fs-utils.mjs";

export const TOOL_MOCK_FIXTURE_KIND = "skill-family-test.tool-mock-fixture";
export const TOOL_REPLAY_RECEIPT_KIND = "skill-family-test.tool-replay-receipt";

const VALID_CATEGORIES = new Set([
  "mcp_call",
  "command_exec",
  "network",
  "file_read",
  "file_write",
  "subagent_spawn",
  "other",
]);

const VALID_SIDE_EFFECTS = new Set([
  "read_only",
  "workspace_write",
  "external_side_effect",
]);

const VALID_MATCH_MODES = new Set(["strict_args", "ordered_sequence"]);

const SENSITIVE_KEY_PATTERN = /(?:authorization|auth|api[_-]?key|token|secret|password|cookie|private[_-]?key|credential)/i;

const SECRET_AND_PATH_RULES = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g, "[REDACTED_JWT]"],
  [/\bsk-[A-Za-z0-9_-]{4,}(?![A-Za-z0-9_-])/g, "[REDACTED_SECRET]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})(?![A-Za-z0-9_-])/g, "[REDACTED_SECRET]"],
  [/\bnpm_[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/g, "[REDACTED_SECRET]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9_-])/g, "[REDACTED_AWS_KEY]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_-])/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAIza[0-9A-Za-z_-]{20,}(?![A-Za-z0-9_-])/g, "[REDACTED_GCP_KEY]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "[REDACTED_SECRET]"],
  [/(https?:\/\/)([^/\s:@]+:[^/\s@]+@)/gi, "$1[REDACTED_AUTH]@"],
  [/\b([A-Za-z0-9_]*(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|ACCESS_KEY|CLIENT_SECRET)=)([^\s"'&]+)/gi, "$1[REDACTED_SECRET]"],
  [/\/Users\/(?!\[REDACTED_USER\])[^/\s"']+/g, "/Users/[REDACTED_USER]"],
  [/\/home\/(?!\[REDACTED_USER\])[^/\s"']+/g, "/home/[REDACTED_USER]"],
  [/\/Volumes\/(?!\[REDACTED_VOLUME\])[^/\s"']+(?:\s[^/\s"'-]+)*(?=\/)/g, "/Volumes/[REDACTED_VOLUME]"],
  [/\/Volumes\/(?!\[REDACTED_VOLUME\])[^/\s"']+/g, "/Volumes/[REDACTED_VOLUME]"],
  [/[A-Za-z]:\\Users\\(?!\[REDACTED_USER\])[^\\\s"']+/g, "C:\\Users\\[REDACTED_USER]"],
];

export function redactMockSecrets(value) {
  if (typeof value === "string") {
    let out = value;
    for (const [re, replacement] of SECRET_AND_PATH_RULES) {
      out = out.replace(re, replacement);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactMockSecrets(item));
  }
  if (value !== null && typeof value === "object") {
    const clean = {};
    for (const key of Object.keys(value).sort()) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        clean[key] = "[REDACTED_SECRET]";
      } else {
        clean[key] = redactMockSecrets(value[key]);
      }
    }
    return clean;
  }
  return value;
}

export function canonicalizeMockArgs(args) {
  return redactMockSecrets(args ?? {});
}

export function computeCanonicalArgsSha256(args) {
  const normalized = canonicalizeMockArgs(args);
  if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
    return digestDocument(normalized);
  }
  return digestDocument({ value: normalized });
}

function serializeResponseDeterministic(response) {
  return typeof response === "string" ? response : JSON.stringify(response);
}

function normalizeInteraction(raw, idx) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `第 ${idx + 1} 条工具替身交互记录必须是对象。`,
      { index: idx },
    );
  }
  const toolName = typeof raw.toolName === "string" ? raw.toolName.trim() : "";
  if (!toolName) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `第 ${idx + 1} 条工具替身交互缺少非空 toolName。`,
      { index: idx },
    );
  }
  const category = raw.category ?? "mcp_call";
  if (!VALID_CATEGORIES.has(category)) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `第 ${idx + 1} 条交互的 category="${String(category)}" 非法；允许值：${[...VALID_CATEGORIES].join(", ")}。`,
      { index: idx, category },
    );
  }
  const sideEffectClass = raw.sideEffectClass ?? "read_only";
  if (!VALID_SIDE_EFFECTS.has(sideEffectClass)) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `第 ${idx + 1} 条交互的 sideEffectClass="${String(sideEffectClass)}" 非法；允许值：${[...VALID_SIDE_EFFECTS].join(", ")}。`,
      { index: idx, sideEffectClass },
    );
  }
  const args = canonicalizeMockArgs(raw.args ?? {});
  const argsSha256 = computeCanonicalArgsSha256(args);
  const response = redactMockSecrets(raw.response ?? "");
  const responseSha256 = sha256Hex(serializeResponseDeterministic(response));
  const exitCode = Number.isInteger(raw.exitCode) ? raw.exitCode : 0;

  return {
    interactionId:
      typeof raw.interactionId === "string" && raw.interactionId.trim()
        ? raw.interactionId.trim()
        : `mock-call-${idx + 1}`,
    seq: idx,
    toolName,
    category,
    sideEffectClass,
    args,
    argsSha256,
    response,
    responseSha256,
    exitCode,
    required: raw.required !== false,
  };
}

export function sealToolMockFixture(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      "sealToolMockFixture 输入必须是包含 fixtureId、targetSkillId 与 interactions 的 JSON 对象。",
    );
  }
  const fixtureId = typeof input.fixtureId === "string" ? input.fixtureId.trim() : "";
  const targetSkillId = typeof input.targetSkillId === "string" ? input.targetSkillId.trim() : "";
  if (!fixtureId || !targetSkillId) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      "工具替身夹具必须同时提供非空 fixtureId 与 targetSkillId。",
      { fixtureId, targetSkillId },
    );
  }
  if (!Array.isArray(input.interactions) || input.interactions.length === 0) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `工具替身夹具 "${fixtureId}" 至少需要包含 1 条 interactions 记录。`,
      { fixtureId },
    );
  }

  const interactions = input.interactions.map((item, idx) => normalizeInteraction(item, idx));
  const seenIds = new Set();
  for (const item of interactions) {
    if (seenIds.has(item.interactionId)) {
      throw createSftError(
        SFT_ERROR_CODES.INVALID_ARGS,
        `工具替身夹具 "${fixtureId}" 存在重复的 interactionId="${item.interactionId}"。`,
        { fixtureId, interactionId: item.interactionId },
      );
    }
    seenIds.add(item.interactionId);
  }
  const unsigned = {
    schemaVersion: 1,
    kind: TOOL_MOCK_FIXTURE_KIND,
    fixtureId,
    targetSkillId,
    description: typeof input.description === "string" ? redactMockSecrets(input.description.trim()) : "",
    redactionApplied: true,
    interactions,
  };
  const fixtureDigestSha256 = digestDocument(unsigned);
  return {
    ...unsigned,
    fixtureDigestSha256,
  };
}

export function verifyToolMockFixtureSeal(fixture) {
  if (!fixture || typeof fixture !== "object" || fixture.kind !== TOOL_MOCK_FIXTURE_KIND) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `输入不是合法的 ${TOOL_MOCK_FIXTURE_KIND} 文档。`,
    );
  }
  if (
    fixture.schemaVersion !== 1 ||
    fixture.redactionApplied !== true ||
    typeof fixture.fixtureId !== "string" ||
    !fixture.fixtureId.trim() ||
    typeof fixture.targetSkillId !== "string" ||
    !fixture.targetSkillId.trim() ||
    typeof fixture.description !== "string" ||
    redactMockSecrets(fixture.description) !== fixture.description
  ) {
    throw createSftError(
      SFT_ERROR_CODES.DIGEST_TAMPERED,
      `工具替身夹具 "${String(fixture.fixtureId ?? "")}" 顶层元数据不自洽或 description 含未脱敏敏感内容。`,
    );
  }
  if (typeof fixture.fixtureDigestSha256 !== "string" || !SHA256_HEX_REGEX.test(fixture.fixtureDigestSha256)) {
    throw createSftError(
      SFT_ERROR_CODES.DIGEST_TAMPERED,
      `工具替身夹具 "${String(fixture.fixtureId ?? "")}" 缺少合法的 64 位 fixtureDigestSha256。`,
    );
  }
  if (!Array.isArray(fixture.interactions) || fixture.interactions.length === 0) {
    throw createSftError(
      SFT_ERROR_CODES.DIGEST_TAMPERED,
      `工具替身夹具 "${String(fixture.fixtureId ?? "")}" 缺少非空 interactions 列表。`,
    );
  }
  const { fixtureDigestSha256: declared, ...unsigned } = fixture;
  const recomputed = digestDocument(unsigned);
  if (recomputed !== declared) {
    throw createSftError(
      SFT_ERROR_CODES.DIGEST_TAMPERED,
      `工具替身夹具 "${fixture.fixtureId}" 摘要失配（声明 ${declared}，重算 ${recomputed}）；请运行 sft seal-mock 重新生成受控夹具。`,
      { fixtureId: fixture.fixtureId, declared, recomputed },
    );
  }

  // 逐条核验内部摘要自洽性、枚举合法性与已脱敏不变性（拦截手工改写 args/response 后重算外层摘要的伪造夹具）
  const seenIds = new Set();
  for (let idx = 0; idx < fixture.interactions.length; idx += 1) {
    const it = fixture.interactions[idx];
    if (
      !it ||
      typeof it !== "object" ||
      it.seq !== idx ||
      typeof it.interactionId !== "string" ||
      !it.interactionId.trim() ||
      seenIds.has(it.interactionId) ||
      typeof it.toolName !== "string" ||
      !it.toolName.trim() ||
      !VALID_CATEGORIES.has(it.category) ||
      !VALID_SIDE_EFFECTS.has(it.sideEffectClass) ||
      typeof it.required !== "boolean" ||
      !Number.isInteger(it.exitCode)
    ) {
      throw createSftError(
        SFT_ERROR_CODES.DIGEST_TAMPERED,
        `工具替身夹具 "${fixture.fixtureId}" 第 ${idx + 1} 条交互结构或枚举不自洽。`,
        { index: idx },
      );
    }
    seenIds.add(it.interactionId);
    const redactedArgs = redactMockSecrets(it.args ?? {});
    const redactedResp = redactMockSecrets(it.response ?? "");
    if (
      JSON.stringify(redactedArgs) !== JSON.stringify(it.args ?? {}) ||
      JSON.stringify(redactedResp) !== JSON.stringify(it.response ?? "")
    ) {
      throw createSftError(
        SFT_ERROR_CODES.DIGEST_TAMPERED,
        `工具替身夹具 "${fixture.fixtureId}" 第 ${idx + 1} 条交互包含未脱敏凭据或宿主机路径。`,
        { index: idx, interactionId: it.interactionId },
      );
    }
    const expectedArgsSha = computeCanonicalArgsSha256(redactedArgs);
    const expectedRespSha = sha256Hex(serializeResponseDeterministic(redactedResp));
    if (it.argsSha256 !== expectedArgsSha || it.responseSha256 !== expectedRespSha) {
      throw createSftError(
        SFT_ERROR_CODES.DIGEST_TAMPERED,
        `工具替身夹具 "${fixture.fixtureId}" 第 ${idx + 1} 条交互内部 argsSha256/responseSha256 与实际载荷不一致。`,
        { index: idx, interactionId: it.interactionId },
      );
    }
  }

  return { valid: true, fixtureDigestSha256: recomputed };
}

export function createDeterministicToolReplayer(fixture, { matchMode = "strict_args" } = {}) {
  if (!VALID_MATCH_MODES.has(matchMode)) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      `不支持的回放匹配模式 "${String(matchMode)}"；仅支持 strict_args 或 ordered_sequence。`,
      { matchMode },
    );
  }
  const { fixtureDigestSha256 } = verifyToolMockFixtureSeal(fixture);
  const interactions = fixture.interactions;
  const consumedIndexes = new Set();
  const traceEvents = [];
  const unexpectedCalls = [];
  const recordedMismatchReasons = [];
  let cursor = 0;

  function invoke(toolName, rawArgs = {}) {
    const cleanName = String(toolName ?? "").trim();
    const cleanArgs = canonicalizeMockArgs(rawArgs);
    const argsSha256 = computeCanonicalArgsSha256(cleanArgs);

    let matchedIdx = -1;
    if (matchMode === "ordered_sequence") {
      let scan = cursor;
      while (scan < interactions.length) {
        const candidate = interactions[scan];
        if (candidate.toolName === cleanName && candidate.argsSha256 === argsSha256) {
          matchedIdx = scan;
          cursor = scan + 1;
          break;
        }
        if (candidate.required !== false) {
          break;
        }
        scan += 1;
      }
    } else {
      matchedIdx = interactions.findIndex(
        (item, idx) => !consumedIndexes.has(idx) && item.toolName === cleanName && item.argsSha256 === argsSha256,
      );
    }

    if (matchedIdx === -1) {
      const mismatch = {
        callIndex: traceEvents.length + unexpectedCalls.length,
        toolName: cleanName,
        argsSha256,
        matchMode,
      };
      unexpectedCalls.push(mismatch);
      const msg = `离线工具替身回放未命中：调用 "${cleanName}"（argsSha256=${argsSha256}，模式=${matchMode}）与已封存夹具不匹配。`;
      recordedMismatchReasons.push(msg);
      throw createSftError(SFT_ERROR_CODES.REPLAY_MISMATCH, msg, mismatch);
    }

    consumedIndexes.add(matchedIdx);
    const matched = interactions[matchedIdx];
    const event = {
      callIndex: traceEvents.length,
      interactionId: matched.interactionId,
      toolName: matched.toolName,
      category: matched.category,
      sideEffectClass: matched.sideEffectClass,
      argsSha256: matched.argsSha256,
      responseSha256: matched.responseSha256,
      exitCode: matched.exitCode,
      status: matched.exitCode === 0 ? "succeeded" : "failed",
    };
    traceEvents.push(event);
    return {
      ok: matched.exitCode === 0,
      exitCode: matched.exitCode,
      response: structuredClone(matched.response),
      interactionId: matched.interactionId,
      argsSha256: matched.argsSha256,
      responseSha256: matched.responseSha256,
    };
  }

  function finalize({ allowUnconsumedOptional = true } = {}) {
    const unconsumedRequired = interactions
      .filter((item, idx) => !consumedIndexes.has(idx) && (item.required !== false || !allowUnconsumedOptional))
      .map((item) => item.interactionId);
    const mismatchReasons = [
      ...recordedMismatchReasons,
      ...(unconsumedRequired.length > 0
        ? [`尚有必选替身交互未被消费：${unconsumedRequired.join(", ")}`]
        : []),
    ];
    const passed = unexpectedCalls.length === 0 && unconsumedRequired.length === 0 && mismatchReasons.length === 0;
    const baseReceipt = {
      schemaVersion: 1,
      kind: TOOL_REPLAY_RECEIPT_KIND,
      fixtureId: fixture.fixtureId,
      targetSkillId: fixture.targetSkillId,
      fixtureDigestSha256,
      matchMode,
      passed,
      summary: {
        totalInteractions: interactions.length,
        consumedCount: consumedIndexes.size,
        unconsumedRequiredCount: unconsumedRequired.length,
        unexpectedCallCount: unexpectedCalls.length,
      },
      unconsumedRequiredIds: unconsumedRequired,
      unexpectedCalls,
      mismatchReasons,
      traceEvents,
    };
    return {
      ...baseReceipt,
      receiptDigestSha256: digestDocument(baseReceipt),
    };
  }

  return { invoke, finalize };
}

export function verifyToolReplayRun(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.observedCalls)) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_ARGS,
      "verifyToolReplayRun 输入必须是包含 fixture 与数组类型 observedCalls 的 JSON 对象。",
    );
  }
  const replayer = createDeterministicToolReplayer(input.fixture, {
    matchMode: input.matchMode ?? "strict_args",
  });
  for (const call of input.observedCalls) {
    try {
      replayer.invoke(call?.toolName, call?.args ?? {});
    } catch (err) {
      if (err?.code !== SFT_ERROR_CODES.REPLAY_MISMATCH) {
        throw err;
      }
    }
  }
  return replayer.finalize();
}
