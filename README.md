# Skill Family Test

本插件面向多宿主智能体环境（OpenAI Codex、Claude Code、Kimi Code、Qoder、WorkBuddy / CodeBuddy 及 Antigravity），提供测试规划与执行核收两个协同技能入口，帮助技能族项目围绕本轮真实变更制定有边界的测试方案、安全复用未受影响的既有证据，并在授权范围内核收测试结果。插件本身不签发业务通过或发布批准，所有领域判读权仍归原责任方。

当前公开插件版本由根目录 `VERSION` 定义（`0.2.4`）。

---

## 入口与方法目录

| 技能入口 | 职责与边界 |
| --- | --- |
| `skill-family-test-plan` | 只制定测试方案，不运行被测产品。根据交付阶段、本轮变更、业务承诺与既有证据，明确划分本次执行、有效复用、可选显式跳过与未覆盖项，禁止在规划阶段预填通过结论。 |
| `skill-family-test-run` | 依据已接受方案和用户明确授权组织真实运行或增量复用，区分环境未执行与产品失败，并将逐项核收结果写入调用方授权的 `resultFile` 或收据路径。 |

随附的测试方法参考位于各技能目录下的 `references/testing-methodology.md`（修订身份 `design-testing-methodology@0.1.2`，由构建器受管投影生成，不可单独手改）。进入正式发布流程时，按随包携带的 `references/upstream/release-skill-0.9.34/` 公开规范交接候选结果。

公开载荷同时提供：
- 六大宿主插件清单：`.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.codebuddy-plugin/plugin.json`、`.kimi-plugin/plugin.json`、`.qoder-plugin/plugin.json` 与根级 `plugin.json`（Antigravity）；
- 方法注册目录：`agent-methods/catalog.yaml`（登记 `skill-family-test.plan` 与 `skill-family-test.run` 两个逻辑入口，供接入 `agent-method-registry` 的项目按需解析绑定）。

开发回归夹具仅在明确声明的开发回归任务中按需读取，普通安装与日常调用不依赖任何开发夹具。

---

## 固定版本安装（插件 + 公开 npm 包）

<!-- release-skill:capability:safe-first-command -->

完整接入 `skill-family-test` 包含两步：**在 AI 宿主安装 `skill-family-test` 插件**，以及**在项目或环境中安装公开 npm 包 `skill-family-test`（提供 `sft` CLI）**。

1. **安装 AI 宿主插件**

   在 Codex 中，使用以下命令从公开仓库固定标签 `skill-family-test-v0.2.4` 安装本插件：

   ```sh
   codex plugin marketplace add ifoohoo/skill-family-test --ref skill-family-test-v0.2.4
   codex plugin add skill-family-test@skill-family-test
   ```

   在 Claude Code、Kimi Code、Qoder 或 WorkBuddy / CodeBuddy 中，可按各宿主的插件市场或仓库安装命令指向同一公开仓库固定标签 `skill-family-test-v0.2.4`（对应读取 `.claude-plugin/plugin.json`、`.kimi-plugin/plugin.json`、`.qoder-plugin/plugin.json` 或 `.codebuddy-plugin/plugin.json`）。在 Google Antigravity 中，将固定版本仓库克隆至 `~/.gemini/config/plugins/skill-family-test`，宿主会自动识别根级 `plugin.json`。

   安装并启用插件后，**当前已打开的会话不会自动热加载新入口**；请新开一个宿主会话后再调用两个测试技能。

2. **安装公开 npm 包 `skill-family-test`（提供 `sft` CLI）**

   在需要执行确定性计划校验、收据核收、增量失效计算或防过拟合探针的项目或环境（Node.js `>=22.22.2 <23`）安装公开 npm 包：

   ```sh
   pnpm add -D skill-family-test
   # 或
   npm install -D skill-family-test
   ```

---

## 标准使用流程与 CLI 辅助

1. **制定测试方案**：调用 `skill-family-test-plan`，传入本轮变更说明、交付阶段、业务承诺与已有测试证据，获得带明确停止条件的测试计划。
2. **审阅与授权**：确认计划中的本次执行项、复用依据与可选跳过边界，对需要实际运行的检查命令给出明确授权。
3. **执行与结果核收**：调用 `skill-family-test-run` 并指定输出路径，按计划组织运行、隔离编排异常与产品缺陷，输出结构化核收记录。

安装公开 npm 包 `skill-family-test` 后，即可直接通过 `npx sft` 调用确定性 CLI 完成机器校验与报告渲染：

```sh
npx sft validate-plan --root /absolute/project/path --input test-plan.json --format markdown
npx sft record-run --root /absolute/project/path --input run-input.json --out receipt.json --format markdown
npx sft invalidate-changed --root /absolute/project/path --input invalidation-manifest.json --format markdown
npx sft eval-smoke --root /absolute/project/path --input smoke-suite.json --format markdown
```

---

## 常见故障排查

若在 Codex 中无法发现或调用技能入口，先通过原生帮助命令核对插件子命令语法：

```sh
codex plugin --help
```

- **入口未出现在可用技能列表**：先检查宿主插件列表中 `skill-family-test` 是否处于已安装且启用状态（`codex plugin --help` 仅输出命令行用法，不展示已安装列表），确认无误后**新开一个会话**使入口生效。
- **执行阶段拒绝运行某条命令**：核对是否已先接受测试方案并对该检查项给出了明确执行授权；仅写在方案里的命令文本不会自动获准运行。
- **`sft` CLI 报路径或摘要错误**：根据终端输出的 `[SFT_*]` 错误提示核对 `--root` 是否指向项目根目录、引用文件是否为普通文件（非软链接），以及设计原件修改后是否已刷新摘要。

---

## 安全与权责边界

<!-- release-skill:capability:external-write-boundary -->

测试执行入口只按已接受方案与用户的明确授权组织检查并写入指定收据，**绝不自动获得 Git 提交、推送、打标签或公开发布权限**。

- 规划阶段严禁将任何检查项预标为“通过”；可选测试的显式跳过（`explicitly_skipped`）固定为“未评估”，绝不等同于测试通过。
- 存在缺证、失败、环境未执行或未覆盖的必测项时，整案不作为合格候选接受。
- 独立验收材料由验收持有方隔离保管，不进入开发调试、提示词调优或公开示例上下文。
- 公开产物采用 Apache-2.0 许可证，由广州市风荷科技有限公司维护，不含私有实施规格、制品图锁、开发判据、运行日志或隐藏验收原件。
