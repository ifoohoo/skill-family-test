---
name: skill-family-test-run
description: 按已接受的测试方案与明确授权组织真实测试执行、增量复用与结果核收，隔离环境未执行与产品失败，并将结构化结果写回指定收据或候选 resultFile。
---

# 组织执行并核收结果

本技能依据已接受的测试方案和调用方的明确执行授权，组织真实测试运行、核验有效复用证据，并将逐项判读与收据交回原职责方。**方案里的命令文本本身不构成执行授权；未经调用方授权的命令一律不得运行，测试核收通过也不自动赋予 Git 提交、推送、打标签或发布权限。**

加载本技能时，以当前 `SKILL.md` 所在目录为基准读取同目录下的 `references/testing-methodology.md`（修订身份 `design-testing-methodology@0.1.2`）及 `references/upstream/release-skill-0.9.34/02-project-config.md`、`references/upstream/release-skill-0.9.34/test-intake.schema.json`、`references/upstream/release-skill-0.9.34/SOURCE.md`，不依赖调用方当前目录或本机绝对路径。仅当本次任务明确是开发回归时，才查阅开发夹具与预设判据；普通用户调用不把开发夹具当作依赖。

## 一、按影响面推进执行、返工与增量复测

遵循 `references/testing-methodology.md` 中“从本批变更推进到稳定验证”的顺序开展工作：

1. **先跑聚焦验证，再刷官方派生**：实施与返工期间优先运行能直接验证当前改动的聚焦测试，通过后调用项目既有官方入口刷新受影响的生成物或锁文件，最后在稳定快照上集中审阅并运行一次完整权威门禁，不为每处小改动反复跑全套慢门禁。
2. **区分编排环境故障与真实产品失败**：
   - **编排或环境未执行（`not_executed` / `orchestration_error`）**：因 `PATH` 未前置匹配 Node.js 版本、工作目录不对、依赖未装或命令参数拼写错误而未跑进被测产品逻辑时，在授权范围内修正环境并继续，同时保留原始报错记录；未能修正时如实记为 `not_executed`，绝不混同于产品逻辑缺陷，也绝不算通过。
   - **产品失败（`failed` / `product_failure`）**：被测产品真实运行后违反合同、Schema 或领域判据时，按原阶段、原对象完整保留失败记录交回产品方修复，严禁通过改参数、降判据或只挑成功重试掩盖失败。在正常任务中提前发现并修正路径拼写不判任务失败；但若未实际发生“真实工具报错 -> 参数修正 -> 继续调用”，不得声称故障恢复专项（如 `TC-002`）已通过验证。
3. **返工后的增量失效与复用重算**：产品修复或局部改动后，只重判或补测受影响条目，已成立且依赖未变的有效通过项不再重跑。若项目或环境已安装公开 npm 包 `skill-family-test`（提供 `sft` CLI，可通过 `pnpm add -D skill-family-test` 或 `npm install -D skill-family-test` 安装，与宿主内的 `skill-family-test` 插件配合使用），可通过文件 SHA-256 摘要精确计算失效范围并拦截被篡改的旧证据：
   ```bash
   npx sft invalidate-changed --root /absolute/project/path --input invalidation-manifest.json --format markdown
   ```
   判据版本更新后，旧规则下的通过结论失效（标记为待重判或待补测），观察材料充足时按新判据重判，不足时补跑，不得把新规则结论回填篡改为旧规则通过。

## 二、结果核收红线与 `sft` CLI 收据生成

1. **退出码零不等于业务通过**：进程退出码为 `0`、JSON 结构合法或脚本正常结束，都不能单独证明业务达标。只要业务目标尚未完成，处置状态只能记为 `incomplete`（`verdict: not-evaluated`）；业务是否通过由原方案指定的领域验收人（`acceptor`）判读，“不适用”由原要求持有方（`owner`）给出范围依据。
2. **可选测试显式跳过（`explicitly_skipped`）严禁冒充通过**：仅对 `optional: true` 且经维护者明确批准本轮跳过的可选测试，才允许生成 `explicitly_skipped` 记录，并必填批准人（`approvedBy`）、跳过原因（`reason`）、适用边界（`applicabilityBoundary`）、残余风险（`residualRisks`）与仍在兜底的基础必检门禁（`fallbackGates`）。跳过项的结论固定为 `not-evaluated`，**绝不计入 `passed`**；必选门禁严禁跳过。
3. **结构化核收与可读摘要**：可用 `sft` CLI 校验证据文件摘要、生成收据并渲染结论前置的 Markdown 报告：
   ```bash
   npx sft record-run --root /absolute/project/path --input run-input.json --out receipt.json --format markdown
   ```
   存在缺证、失败、未执行或未覆盖的必测项时，整案保持未通过；补齐同一对象的缺项并经原判据核验后即停止，不把增量复测结果改名为完整门禁记录。获准的有限降级须如实记录预期差距与返工条件，不得写成“95% 实测成功率”。

## 三、独立验收边界与发布形态交接

1. **独立材料边界**：独立验收材料与隐藏答案由验收持有方隔离保管，不进入开发上下文或外部表达服务。访问隔离无法核实时，仅暂停该项独立验收结论，不伪造隔离环境，也不阻断其他已就绪条目的执行核收。
2. **发布候选交接（`release-skill@0.9.34`）**：仅当调用方明确处于真实发布流程时，才对照同目录 `references/upstream/release-skill-0.9.34/02-project-config.md` 与 `test-intake.schema.json`（来源见同目录 `SOURCE.md`）组织交接，平时开发回归不为套用本入口而伪造发布候选：
   - 只读调用方的 `requirementsFile`、阶段与候选对象，直接使用发布工具计算好的 `subjectDigest`，不修改要求附件或已接受原件。
   - 将逐项结果写入授权的 `resultFile`（顶层仅含 `formatVersion`、`subjectDigest`、`requirementsSha256`、`results`，不含顶层 `PASS` 字段；标准发布 Schema 中每项 `disposition` 使用 `executed`、`reused`、`not-applicable`、`failed`、`incomplete`、`uncovered`）。
   - 缺证或未完成时交回同一 `candidatePath` 供补测后继续准备；正式接受后的原件保持路径与字节不变，新批次另用新路径。若调用方使用的 `release-skill` 版本与随包参考不一致，由消费方核对兼容性，不仅凭 Schema 相似直接宣布组合通过。

<!-- @feature TST002 @scenario S-001 S-002 S-003 -->
<!-- @feature TST003 @scenario S-004 -->
