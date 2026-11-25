# skill-family-test

`skill-family-test` 是技能族生态的跨技能共享测试核收库与确定性 CLI 工具包（提供 `sft` 命令），按 `support` 支撑分层独立发布至公开 npm 仓库。它负责在零网络条件下校验测试计划、核收结构化运行收据、计算改动增量失效范围、运行多样本防过拟合探针，并渲染结论前置的 Markdown 报告。

需要让 AI 编程宿主调用规划与执行工作流时，请同时在对应宿主安装 `skill-family-test` 多宿主插件（提供 `skill-family-test-plan` 与 `skill-family-test-run` 两个协同技能）。

## 运行要求与安装

<!-- release-skill:capability:safe-first-command -->

- **Node.js**：`>=22.22.2 <23`
- **直接依赖**：`skill-family-contracts`、`skill-family-harness-node`

在项目工作区或全局环境安装公开 npm 包：

```bash
pnpm add -D skill-family-test
# 或
npm install -D skill-family-test
```

安装完成后即可通过 `npx sft`（或工作区内 `pnpm exec sft`）执行 CLI，或在 Node.js ESM 代码中导入编程接口：

```js
import {
  validateTestPlan,
  recordTestRun,
  invalidateChangedTests,
  evaluateSmokeSamples,
  renderAcceptanceReport,
} from "skill-family-test";
```

## `sft` CLI 子命令与退出码

```bash
sft --help
sft validate-plan --root <项目根目录> --input test-plan.json [--strict-ac-behavior] [--format json|markdown]
sft record-run --root <项目根目录> --input run-input.json --out receipt.json [--format json|markdown]
sft invalidate-changed --root <项目根目录> --input invalidation-manifest.json [--format json|markdown]
sft eval-smoke --root <项目根目录> --input smoke-suite.json [--format json|markdown]
sft render-report --input receipt.json [--root <项目根目录> --out report.md]
```

| 子命令 | 核心职责 |
| --- | --- |
| `validate-plan` | 校验测试方案阶段边界、原件 SHA-256 摘要，以及验收条件（`AC-*`）直接行为层覆盖（支持 `--strict-ac-behavior`） |
| `record-run` | 核收测试运行记录与证据摘要，隔离 `explicitly_skipped`（`not-evaluated`）与 `orchestration_error`（环境未执行） |
| `invalidate-changed` | 对比变更前后的文件摘要与判据版本，精准计算可安全复用项与必须重跑的失效项 |
| `eval-smoke` | 运行工程化前最小代表性样本探针（强制 `>=2` 份异构样本与修改前后交叉回归对比） |
| `render-report` | 将核收结果 JSON 渲染为结论前置的 Markdown 报告 |

退出码约定：
- `0`：核验通过或报告生成成功
- `1`：计划/核收/回归校验未通过或存在阻断项
- `2`：参数错误、JSON 解析失败或路径安全收容违规（拒绝符号链接与根目录逃逸）

## 常见故障排查与权责边界

<!-- release-skill:capability:external-write-boundary -->

`sft` 仅在本地零网络条件下读取 `--root` 内的普通文件，并仅在显式传入 `--out` 时写入调用方指定的本地收据或报告文件，**不执行任何 Git 提交、推送、打标签或远端发布动作**。

- **命令以退出码 `2` 终止**：先运行 `sft --help` 核对子命令参数，并根据 `[SFT_*]` 错误提示检查 `--root` 是否指向真实项目根目录、输入路径是否包含符号链接，以及 `--json` 是否与 `--format markdown` 同时传入。
- **命令以退出码 `1` 终止**：查看输出的阻断明细，确认设计原件修改后已更新测试计划中的 SHA-256 摘要，且没有把可选跳过（`explicitly_skipped`）或环境未执行项当作通过。

## 许可与作者

- 许可证：Apache-2.0（详见同目录 `LICENSE` 与 `NOTICE`）
- 维护方：广州市风荷科技有限公司
- 公开插件与源码说明：[ifoohoo/skill-family-test](https://github.com/ifoohoo/skill-family-test)
