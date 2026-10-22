# Skill Family Test

本插件面向需要为技能族变更安排测试并核收结果的 Codex 用户，提供两个配合使用的入口：`skill-family-test:skill-family-test-plan` 制定有边界的方案，`skill-family-test:skill-family-test-run` 按已接受方案组织授权执行或有效复用，并将结果写入调用方指定的 `resultFile`。插件不签发通过或发布授权，也不新增执行器、报告协议或宿主支持。

产品版本为 `0.1.0`。父工程与 `packages/skill-family-test` 工程种子均保持私有，种子版本 `0.0.0` 不是产品版本，本轮不发布 npm 包。

---

## 入口说明

| 入口 | 功能 |
|------|------|
| `skill-family-test:skill-family-test-plan` | 仅制定测试方案，不执行被测对象。根据本轮变更、业务承诺和已有证据，区分本次执行、有效复用与未覆盖项。 |
| `skill-family-test:skill-family-test-run` | 依已接受方案与用户明确授权执行，组织真实执行或复用，并将逐项结果写入调用方授权的 `resultFile`。不自动获得提交、推送或发布权限。 |

随附资源位于各入口对应的 `SKILL.md` 所在目录。测试方法正文为 `references/testing-methodology.md`，修订身份为 `design-testing-methodology@0.1.1`，由生成器投影，不可单独修改。发布形态交接读取已发布 `release-skill@0.9.34` 的 `references/upstream/release-skill-0.9.34/` 原文。

开发夹具仅用于明确的开发回归任务，普通安装与调用不依赖。

---

## 固定版本安装

<!-- release-skill:capability:safe-first-command -->

请严格使用以下命令，从公开仓库固定标签 `skill-family-test-v0.1.0` 安装 `0.1.0` 版本：

```sh
codex plugin marketplace add ifoohoo/skill-family-test --ref skill-family-test-v0.1.0
codex plugin add skill-family-test@skill-family-test
```

安装完成后，在 Codex 的已安装插件列表中确认 `skill-family-test` 已启用。**安装与启用不代表当前会话已加载入口**；需新开 Codex 会话后，方可确认两个入口均可调用。

---

## 首次使用步骤

1. 调用 `skill-family-test:skill-family-test-plan`，提供本轮变更、业务承诺与已有证据，由插件生成测试方案，明确区分本次执行、有效复用与未覆盖项。
2. 接受方案，并对需执行的检查项明确授权。
3. 调用 `skill-family-test:skill-family-test-run`，传入授权的 `resultFile` 路径，插件将按方案核收结果并写入。

> **执行前提**：首次规划调用不运行被测对象。执行入口必须以已接受方案和用户明确授权为前提，并将结果写入调用方授权的 `resultFile`；它不自动获得提交、推送或发布权限。

---

## 故障排查

若入口无法调用或执行失败，可先用 Codex 原生命令查看插件命令的用法：

```sh
codex plugin --help
```

- **插件未安装或未启用**：在 Codex 的已安装插件列表中确认 `skill-family-test` 已安装并启用；`codex plugin --help` 用于查看命令帮助，不是插件状态列表。
- **当前会话未加载入口**：安装启用后需**新开 Codex 会话**，入口方可生效。
- **命令执行报错**：检查命令返回的错误信息，对照 `codex plugin --help` 核对用法与参数。

---

## 使用边界与后续

<!-- release-skill:capability:external-write-boundary -->

执行入口只按已接受方案和用户明确授权核收结果，不自动获得提交、推送或发布权限。

- 规划阶段不得将任何检查项标记为“通过”。
- 缺证、失败、未完成或未覆盖项，执行入口不接受其作为有效候选。
- 独立验收材料由持有方保管，不进入开发、提示或示例上下文。
- 许可证为 Apache-2.0，作者为广州市风荷科技有限公司。
- 公开树不含私有 SPEC、图锁、开发判据、运行记录或独立验收原件。

下一步为新开 Codex 会话，调用入口并参考随附 `references/testing-methodology.md` 了解测试方法。
