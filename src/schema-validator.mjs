// @feature TST001 @scenario S-001 S-003
// @feature TST002 @scenario S-002 S-003
// 基于 skill-family-contracts 的 Ajv 契约编译校验器与复用六要素共同核对工具。
// 所有 CLI 与编程式入口在执行领域规则前先经过此层 Schema 校验，拒绝未知字段、非法枚举与残缺引用。

import { readFileSync } from "node:fs";
import { compileSchema } from "skill-family-contracts";

const SCHEMA_PATH = new URL("../schemas/sft-contracts.schema.json", import.meta.url);
const CONTRACT_SCHEMA_DOC = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

const VALIDATORS = new Map();

export const REUSE_KEYS = Object.freeze([
  "objectIdentity",
  "objectKind",
  "toolVersion",
  "criterionVersion",
  "environment",
  "scope",
]);

export function hasMatchingReuseFactors(prior, current) {
  return Boolean(
    prior &&
      typeof prior === "object" &&
      current &&
      typeof current === "object" &&
      prior.verdict === "passed" &&
      prior.historicalOnly !== true &&
      REUSE_KEYS.every((k) => typeof prior[k] === "string" && prior[k].trim() !== "" && prior[k] === current[k]),
  );
}

function getDefinitionValidator(definitionName) {
  let validate = VALIDATORS.get(definitionName);
  if (!validate) {
    validate = compileSchema(
      {
        schema: {
          $schema: CONTRACT_SCHEMA_DOC.$schema,
          definitions: CONTRACT_SCHEMA_DOC.definitions,
          $ref: `#/definitions/${definitionName}`,
        },
      },
      { dialect: "draft-07", policy: "strict" },
    );
    VALIDATORS.set(definitionName, validate);
  }
  return validate;
}

export function formatAjvError(err) {
  const pathLabel = err.instancePath ? err.instancePath : "根节点";
  if (err.keyword === "additionalProperties" && err.params?.additionalProperty) {
    return `${pathLabel} 存在未登记的未知字段 "${err.params.additionalProperty}"`;
  }
  if (err.keyword === "required" && err.params?.missingProperty) {
    return `${pathLabel} 缺少必填字段 "${err.params.missingProperty}"`;
  }
  if (err.keyword === "enum" && Array.isArray(err.params?.allowedValues)) {
    return `${pathLabel} 取值不在允许枚举内（允许值：${err.params.allowedValues.join(" / ")}）`;
  }
  return `${pathLabel} ${err.message ?? "不符合 Schema 契约"}`;
}

export function validateContractByDefinition(definitionName, data) {
  const validate = getDefinitionValidator(definitionName);
  const ok = validate(data);
  const errors = ok || !Array.isArray(validate.errors) ? [] : validate.errors;
  return {
    valid: Boolean(ok),
    errors: errors.map((err) => ({
      keyword: err.keyword,
      instancePath: err.instancePath ?? "",
      params: err.params ?? {},
      message: formatAjvError(err),
    })),
  };
}
