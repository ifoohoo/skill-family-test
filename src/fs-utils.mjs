// @feature TST001 @scenario S-003
// @feature TST002 @scenario S-003
// 项目根目录内的文件安全读取、SHA-256 摘要计算与原子落盘辅助函数。
// 复用 skill-family-harness-node@0.25.0 的 readFileStrict（含 O_NOFOLLOW 与句柄身份复核）与 publishFileOrReplace（含暂存、校验与目录落盘同步）。

import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  digestBytes,
  HARNESS_ERROR_KINDS,
  HarnessError,
  publishFileOrReplace,
  readFileStrict,
} from "skill-family-harness-node";
import { createSftError, SFT_ERROR_CODES } from "./errors.mjs";

export const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

export function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return digestBytes(buf);
}

export function normalizeRelativePath(rawPath, label = "path") {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw createSftError(
      SFT_ERROR_CODES.IO_CONTAINMENT,
      `字段 ${label} 不能为空；请提供相对于项目根目录的普通文件路径（例如 ".runs/test/plan.json"）。`,
      { field: label, path: rawPath },
    );
  }
  if (rawPath.includes("\0") || rawPath.includes("\\") || path.isAbsolute(rawPath)) {
    throw createSftError(
      SFT_ERROR_CODES.IO_CONTAINMENT,
      `路径 "${rawPath}" 超出受控范围（不允许绝对路径、反斜杠或空字节）；请改用项目根目录内的 POSIX 相对路径。`,
      { field: label, path: rawPath },
    );
  }
  const parts = rawPath.split("/");
  const clean = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw createSftError(
        SFT_ERROR_CODES.IO_CONTAINMENT,
        `路径 "${rawPath}" 含有上级目录跳转 ".."；所有测试输入与证据文件必须位于项目根目录之内。`,
        { field: label, path: rawPath },
      );
    }
    clean.push(part);
  }
  if (clean.length === 0) {
    throw createSftError(
      SFT_ERROR_CODES.IO_CONTAINMENT,
      `路径 "${rawPath}" 不能指向根目录本身；请指定具体文件路径。`,
      { field: label, path: rawPath },
    );
  }
  return clean.join("/");
}

function mapHarnessReadError(err, relPath, rootAbs) {
  if (!(err instanceof HarnessError)) return err;
  if (err.kind === HARNESS_ERROR_KINDS.MISSING_RESOURCE) {
    return createSftError(
      SFT_ERROR_CODES.IO_CONTAINMENT,
      `找不到所需文件 "${relPath}"；请确认文件已生成且路径相对于根目录 "${rootAbs}" 正确。`,
      { path: relPath, reason: "missing", harnessKind: err.kind },
    );
  }
  if (err.kind === HARNESS_ERROR_KINDS.UNSAFE_STATE_ENTRY) {
    return createSftError(
      SFT_ERROR_CODES.IO_CONTAINMENT,
      `路径 "${relPath}" 为符号链接或存在安全风险（O_NOFOLLOW 拒绝）；测试计划与证据只接受普通单链文件。`,
      { path: relPath, reason: "symlink", harnessKind: err.kind },
    );
  }
  return createSftError(
    SFT_ERROR_CODES.IO_CONTAINMENT,
    `无法安全读取文件 "${relPath}"（${err.message}）；请确认目标为项目根目录内的普通文件。`,
    { path: relPath, reason: "read-failed", harnessKind: err.kind },
  );
}

export async function resolveSafeRegularFile(rootDir, rawRelPath, { mustExist = true, label = "path" } = {}) {
  const relPath = normalizeRelativePath(rawRelPath, label);
  const rootAbs = await realpath(path.resolve(rootDir)).catch(() => null);
  if (!rootAbs) {
    throw createSftError(
      SFT_ERROR_CODES.IO_CONTAINMENT,
      `指定的项目根目录 "${rootDir}" 不存在或无法访问；请核对 --root 参数。`,
      { rootDir },
    );
  }

  let current = rootAbs;
  const segments = relPath.split("/");
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    const st = await lstat(current).catch((err) => (err?.code === "ENOENT" ? null : Promise.reject(err)));
    if (!st) {
      if (mustExist) {
        throw createSftError(
          SFT_ERROR_CODES.IO_CONTAINMENT,
          `找不到所需文件 "${relPath}"；请确认文件已生成且路径相对于根目录 "${rootAbs}" 正确。`,
          { path: relPath, reason: "missing" },
        );
      }
      return { rootAbs, relPath, absPath: path.join(rootAbs, relPath), exists: false };
    }
    if (st.isSymbolicLink()) {
      throw createSftError(
        SFT_ERROR_CODES.IO_CONTAINMENT,
        `路径 "${relPath}" 包含符号链接（位于 "${segments.slice(0, i + 1).join("/")}"）；测试计划与证据只接受普通文件。`,
        { path: relPath, reason: "symlink" },
      );
    }
    const isLast = i === segments.length - 1;
    if (isLast && !st.isFile()) {
      throw createSftError(
        SFT_ERROR_CODES.IO_CONTAINMENT,
        `路径 "${relPath}" 不是普通文件；请指向具体的 JSON 或文本原件，不要传入目录或特殊设备。`,
        { path: relPath, reason: "not-regular-file" },
      );
    }
    if (!isLast && !st.isDirectory()) {
      throw createSftError(
        SFT_ERROR_CODES.IO_CONTAINMENT,
        `路径 "${relPath}" 的父级组件不是目录；请检查中间路径是否被同名文件占用。`,
        { path: relPath, reason: "invalid-parent" },
      );
    }
  }
  return { rootAbs, relPath, absPath: current, exists: true };
}

export async function readContainedBytesAndDigest(rootDir, rawRelPath, label = "file") {
  const resolved = await resolveSafeRegularFile(rootDir, rawRelPath, { mustExist: true, label });
  try {
    const strict = await readFileStrict(resolved.rootAbs, resolved.relPath);
    return { ...resolved, bytes: strict.content, sha256: strict.sha256 };
  } catch (err) {
    throw mapHarnessReadError(err, resolved.relPath, resolved.rootAbs);
  }
}

export async function readContainedJson(rootDir, rawRelPath, label = "jsonFile") {
  const loaded = await readContainedBytesAndDigest(rootDir, rawRelPath, label);
  try {
    return { ...loaded, data: JSON.parse(loaded.bytes.toString("utf8")) };
  } catch (err) {
    throw createSftError(
      SFT_ERROR_CODES.INVALID_JSON,
      `文件 "${loaded.relPath}" 不是合法的 JSON（${err.message}）；请检查括号、引号与尾随逗号后重试。`,
      { path: loaded.relPath },
    );
  }
}

export async function readExternalTextStrict(filePath, label = "--input") {
  const resolved = path.resolve(filePath);
  const st = await lstat(resolved).catch((err) => {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      throw createSftError(
        SFT_ERROR_CODES.IO_CONTAINMENT,
        `无法读取 ${label} 文件 "${filePath}"（找不到文件）；请检查文件路径是否正确。`,
        { path: filePath, reason: "missing" },
      );
    }
    throw createSftError(
      SFT_ERROR_CODES.IO_CONTAINMENT,
      `无法访问 ${label} 文件 "${filePath}"（${err.code ?? err.message}）。`,
      { path: filePath },
    );
  });
  if (st.isSymbolicLink()) {
    throw createSftError(
      SFT_ERROR_CODES.IO_CONTAINMENT,
      `${label} 文件 "${filePath}" 为符号链接；禁止通过软链接传入测试输入。`,
      { path: filePath, reason: "symlink" },
    );
  }
  if (!st.isFile()) {
    throw createSftError(
      SFT_ERROR_CODES.IO_CONTAINMENT,
      `${label} 路径 "${filePath}" 不是普通文件。`,
      { path: filePath, reason: "not-regular-file" },
    );
  }
  const realParent = await realpath(path.dirname(resolved));
  try {
    const strict = await readFileStrict(realParent, path.basename(resolved), { encoding: "utf8" });
    return strict.content;
  } catch (err) {
    throw mapHarnessReadError(err, filePath, realParent);
  }
}

export async function writeContainedTextAtomic(rootDir, rawRelPath, text) {
  const resolved = await resolveSafeRegularFile(rootDir, rawRelPath, { mustExist: false, label: "outPath" });
  const parentDir = path.dirname(resolved.absPath);
  await mkdir(parentDir, { recursive: true });
  const content = String(text);
  try {
    const published = await publishFileOrReplace(resolved.rootAbs, resolved.relPath, content);
    return { relPath: resolved.relPath, absPath: published.path, sha256: published.sha256 };
  } catch (err) {
    if (err instanceof HarnessError) {
      throw createSftError(
        SFT_ERROR_CODES.IO_CONTAINMENT,
        `无法安全写入目标文件 "${resolved.relPath}"（${err.message}）；请确认父目录未含符号链接且目标不是只读/特殊节点。`,
        { path: resolved.relPath, harnessKind: err.kind },
      );
    }
    throw err;
  }
}

export async function writeContainedJsonAtomic(rootDir, rawRelPath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  return writeContainedTextAtomic(rootDir, rawRelPath, text);
}

export function matchDependencyPattern(pattern, targetRelPath) {
  const cleanPattern = normalizeRelativePath(pattern, "dependsOnFiles");
  const cleanTarget = normalizeRelativePath(targetRelPath, "changedFile");
  if (cleanPattern === cleanTarget) return true;
  const pSegs = cleanPattern.split("/");
  const tSegs = cleanTarget.split("/");
  const walk = (pi, ti) => {
    if (pi === pSegs.length) return ti === tSegs.length;
    if (pSegs[pi] === "**") {
      for (let skip = 0; ti + skip <= tSegs.length; skip += 1) {
        if (walk(pi + 1, ti + skip)) return true;
      }
      return false;
    }
    if (ti === tSegs.length) return false;
    const regex = new RegExp(`^${pSegs[pi].replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    return regex.test(tSegs[ti]) && walk(pi + 1, ti + 1);
  };
  return walk(0, 0);
}
