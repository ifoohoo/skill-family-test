// @feature TST001 @scenario S-001
// @feature TST002 @scenario S-002
// 测试核收包错误码与结构化异常定义。
// 保持机器错误码常量稳定，错误消息直接写明失败原因与下一步修复方法。

export const SFT_ERROR_CODES = Object.freeze({
  INVALID_ARGS: "SFT_INVALID_ARGS",
  IO_CONTAINMENT: "SFT_IO_CONTAINMENT",
  INVALID_JSON: "SFT_INVALID_JSON",
  PLAN_INVALID: "SFT_PLAN_INVALID",
  RECEIPT_INVALID: "SFT_RECEIPT_INVALID",
  DIGEST_TAMPERED: "SFT_DIGEST_TAMPERED",
  INVALIDATION_FAILED: "SFT_INVALIDATION_FAILED",
  SMOKE_OVERFIT_RISK: "SFT_SMOKE_OVERFIT_RISK",
  REPLAY_MISMATCH: "SFT_REPLAY_MISMATCH",
});

export const SFT_EXIT_CODES = Object.freeze({
  OK: 0,
  BLOCKED: 1,
  USAGE_OR_SECURITY: 2,
});

export class SftError extends Error {
  /**
   * @param {string} code 稳定机器错误码（取自 SFT_ERROR_CODES）
   * @param {string} message 面向调用者的中文问题说明与修复指引
   * @param {Record<string, unknown>} [details] 机器可读的附加上下文
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SftError";
    this.code = code;
    this.details = details;
    this.exitCode =
      code === SFT_ERROR_CODES.INVALID_ARGS ||
      code === SFT_ERROR_CODES.IO_CONTAINMENT ||
      code === SFT_ERROR_CODES.INVALID_JSON
        ? SFT_EXIT_CODES.USAGE_OR_SECURITY
        : SFT_EXIT_CODES.BLOCKED;
  }
}

export function createSftError(code, message, details = {}) {
  return new SftError(code, message, details);
}
