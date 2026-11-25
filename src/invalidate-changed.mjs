// @feature TST002 @scenario S-003
// 变更摘要对比与增量复测失效计算器（覆盖 US-030 定向复测与防篡改旧证冒用）。

import { createSftError, SFT_ERROR_CODES } from "./errors.mjs";
import {
  matchDependencyPattern,
  normalizeRelativePath,
  readContainedBytesAndDigest,
  SHA256_HEX_REGEX,
} from "./fs-utils.mjs";
import { validateContractByDefinition } from "./schema-validator.mjs";

async function resolveCurrentMap(baselineMap, currentFiles, trackedPaths, root) {
  const resolved = new Map();
  if (root) {
    const candidates = new Set([
      ...baselineMap.keys(),
      ...(Array.isArray(trackedPaths) ? trackedPaths.map((p) => normalizeRelativePath(p, "trackedPaths")) : []),
    ]);
    for (const rel of candidates) {
      try {
        const file = await readContainedBytesAndDigest(root, rel, "trackedSource");
        resolved.set(rel, file.sha256);
      } catch (err) {
        if (err?.details?.reason === "missing") {
          resolved.set(rel, null);
        } else {
          throw err;
        }
      }
    }
    return resolved;
  }

  if (currentFiles && typeof currentFiles === "object" && !Array.isArray(currentFiles)) {
    for (const [rawPath, digest] of Object.entries(currentFiles)) {
      const rel = normalizeRelativePath(rawPath, "currentFiles");
      if (digest !== null && !SHA256_HEX_REGEX.test(String(digest))) {
        throw createSftError(SFT_ERROR_CODES.INVALIDATION_FAILED, `currentFiles["${rel}"] 必须是 64 位小写 sha256 摘要，或用 null 表示文件已删除。`);
      }
      resolved.set(rel, digest);
    }
  }
  return resolved;
}

export async function invalidateChangedTests(manifestInput, { root = null } = {}) {
  if (!manifestInput || typeof manifestInput !== "object" || Array.isArray(manifestInput)) {
    throw createSftError(SFT_ERROR_CODES.INVALIDATION_FAILED, "增量失效计算输入必须是 JSON 对象。");
  }
  if (manifestInput.schemaVersion !== 1) {
    throw createSftError(SFT_ERROR_CODES.INVALIDATION_FAILED, "增量失效计算输入必须声明 schemaVersion: 1。");
  }
  if (!manifestInput.baselineFiles || typeof manifestInput.baselineFiles !== "object" || Array.isArray(manifestInput.baselineFiles)) {
    throw createSftError(SFT_ERROR_CODES.INVALIDATION_FAILED, "必须提供对象类型的 baselineFiles（记录上次测试时的文件 sha256 摘要）。");
  }
  if (root && manifestInput.currentFiles !== undefined) {
    throw createSftError(
      SFT_ERROR_CODES.INVALIDATION_FAILED,
      "已指定 --root 实时读取磁盘文件摘要时，禁止同时传入 currentFiles 覆盖磁盘真实文件哈希。",
    );
  }
  if (!root && (!manifestInput.currentFiles || typeof manifestInput.currentFiles !== "object" || Array.isArray(manifestInput.currentFiles))) {
    throw createSftError(SFT_ERROR_CODES.INVALIDATION_FAILED, "未指定 --root 读取实时工作区时，必须在输入中提供 currentFiles 摘要映射。");
  }

  const schemaCheck = validateContractByDefinition("invalidationManifest", manifestInput);
  if (!schemaCheck.valid) {
    throw createSftError(
      SFT_ERROR_CODES.INVALIDATION_FAILED,
      `增量失效清单契约校验失败：${schemaCheck.errors.map((e) => e.message).join("；")}。`,
      { errors: schemaCheck.errors },
    );
  }

  const baselineMap = new Map();
  for (const [rawPath, digest] of Object.entries(manifestInput.baselineFiles)) {
    const rel = normalizeRelativePath(rawPath, "baselineFiles");
    if (typeof digest !== "string" || !SHA256_HEX_REGEX.test(digest)) {
      throw createSftError(SFT_ERROR_CODES.INVALIDATION_FAILED, `baselineFiles["${rel}"] 必须是合法的 64 位小写 sha256 摘要。`);
    }
    baselineMap.set(rel, digest);
  }

  const currentMap = await resolveCurrentMap(baselineMap, manifestInput.currentFiles, manifestInput.trackedPaths, root);
  const allPaths = new Set([...baselineMap.keys(), ...currentMap.keys()]);
  const changedDetails = [];
  for (const rel of [...allPaths].sort()) {
    const before = baselineMap.has(rel) ? baselineMap.get(rel) : null;
    const after = currentMap.has(rel) ? currentMap.get(rel) : before;
    if (before === null && after !== null) {
      changedDetails.push({ path: rel, changeKind: "added", beforeSha256: null, afterSha256: after });
    } else if (before !== null && after === null) {
      changedDetails.push({ path: rel, changeKind: "deleted", beforeSha256: before, afterSha256: null });
    } else if (before !== after) {
      changedDetails.push({ path: rel, changeKind: "modified", beforeSha256: before, afterSha256: after });
    }
  }
  const changedFiles = changedDetails.map((d) => d.path);
  const criterionVersions = manifestInput.criterionVersions ?? {};
  const evidenceItems = Array.isArray(manifestInput.evidenceItems) ? manifestInput.evidenceItems : [];

  const reusableIds = [];
  const invalidatedIds = [];
  const items = [];

  for (const [idx, entry] of evidenceItems.entries()) {
    const id = typeof entry?.id === "string" && entry.id.trim() !== "" ? entry.id.trim() : `evidenceItems[${idx}]`;
    const nonPassDisposition = new Set(["explicitly_skipped", "not_executed", "failed", "incomplete", "uncovered"]);
    if (entry?.verdict !== "passed" || nonPassDisposition.has(entry?.disposition)) {
      invalidatedIds.push(id);
      items.push({
        id,
        status: "invalidated",
        reasonCode: "prior_not_passed",
        reason: "原记录并非真实通过结论（例如失败、未执行或显式跳过），不能在增量复测中当作通过证据复用。",
        invalidatedByFiles: [],
      });
      continue;
    }

    const evidenceFiles = Array.isArray(entry?.evidenceFiles) ? entry.evidenceFiles : [];
    if (evidenceFiles.length === 0) {
      invalidatedIds.push(id);
      items.push({
        id,
        status: "invalidated",
        reasonCode: "missing_evidence",
        reason: "未提供可核验的 evidenceFiles 证据引用（空数组或缺失），禁止空证据复用旧通过结论。",
        invalidatedByFiles: [],
      });
      continue;
    }

    if (!root) {
      throw createSftError(
        SFT_ERROR_CODES.INVALID_ARGS,
        `测试项 "${id}" 引用了 evidenceFiles 磁盘证据文件，必须同时传入 --root <项目根目录> 以核验实际摘要。`,
        { itemId: id },
      );
    }

    let tamperedEvidencePath = null;
    for (const ref of evidenceFiles) {
      const rel = normalizeRelativePath(ref?.path ?? "", `evidenceItems[${idx}].evidenceFiles`);
      if (!SHA256_HEX_REGEX.test(String(ref?.sha256 ?? ""))) {
        tamperedEvidencePath = rel;
        break;
      }
      try {
        const actual = await readContainedBytesAndDigest(root, rel, "evidenceFile");
        if (actual.sha256 !== ref.sha256) {
          tamperedEvidencePath = rel;
          break;
        }
      } catch {
        tamperedEvidencePath = rel;
        break;
      }
    }
    if (tamperedEvidencePath) {
      invalidatedIds.push(id);
      items.push({
        id,
        status: "invalidated",
        reasonCode: "evidence_tampered",
        reason: `既有证据原件 "${tamperedEvidencePath}" 缺失或摘要与原收据不一致，已拒绝旧证复用，必须重跑。`,
        invalidatedByFiles: [tamperedEvidencePath],
      });
      continue;
    }

    const deps = Array.isArray(entry?.dependsOnFiles) ? entry.dependsOnFiles.filter((p) => typeof p === "string" && p.trim() !== "") : [];
    if (deps.length === 0) {
      invalidatedIds.push(id);
      items.push({
        id,
        status: "invalidated",
        reasonCode: "missing_dependencies",
        reason: "未声明 dependsOnFiles 依赖文件范围，无法证明本轮变更未触及该测试，按安全原则要求重跑。",
        invalidatedByFiles: [],
      });
      continue;
    }

    const expectedCriterion = criterionVersions[id] ?? criterionVersions["*"];
    if (expectedCriterion !== undefined && entry.criterionVersion !== expectedCriterion) {
      invalidatedIds.push(id);
      items.push({
        id,
        status: "invalidated",
        reasonCode: "criterion_changed",
        reason: `判据版本已从 "${String(entry.criterionVersion ?? "未知")}" 变更为 "${expectedCriterion}"，旧通过结论不能直接沿用。`,
        invalidatedByFiles: [],
      });
      continue;
    }

    const matchedChanged = changedFiles.filter((changed) => deps.some((pattern) => matchDependencyPattern(pattern, changed)));
    if (matchedChanged.length > 0) {
      invalidatedIds.push(id);
      items.push({
        id,
        status: "invalidated",
        reasonCode: "dependency_changed",
        reason: `依赖文件发生变更（${matchedChanged.join(", ")}），必须失效旧观察并重跑本项。`,
        invalidatedByFiles: matchedChanged,
      });
      continue;
    }

    reusableIds.push(id);
    items.push({
      id,
      status: "reusable",
      reasonCode: "unchanged_and_verified",
      reason: "依赖文件摘要、判据版本与证据原件均核验未变，可安全复用既有通过结论。",
      invalidatedByFiles: [],
    });
  }

  return {
    schemaVersion: 1,
    kind: "skill-family-test.invalidation-report",
    changedFiles,
    changedDetails,
    reusableIds,
    invalidatedIds,
    allReusable: invalidatedIds.length === 0,
    items,
  };
}
