# 合并 abel-research / abel-plan 为 abel-design — 实施方案（评审修订版 v3）

> 状态：评审完成，待新上下文实施。
> 新命令完整正文见附录 A；实施时以附录 A 为目标正文，不临场改变语义。
> 本文件是本次改造的唯一实施计划；仓库中不存在 `docs/abel-design-merge-improvement-proposal.md`，不安排不存在文件的删除动作。

## 1. 背景与目标

### 1.1 五个现有命令审计

| 命令 | 当前实际职责 | 主要问题 | 本期处理 |
| --- | --- | --- | --- |
| `abel-init` | 检查/全局安装 OpenSpec、初始化项目、检查技能 | 缺失工具时直接安装 `@latest`，未先确认外部写入；也未验证后续命令依赖的 JSON/schema 能力 | 正文不改；列入后续安全性改进 |
| `abel-research` | 初始摄入、代码探索、约束汇总、证据后澄清，并直接生成 proposal/specs/design/tasks | Phase 0 把“可开始探索”写成“需求已清晰”；过早创建 change；硬编码 `/opsx:new`、目录和 artifact；无 Resume/strict audit | 被 `abel-design` 吸收并删除 |
| `abel-plan` | 再做技术分析、歧义消除、PBT 提取和批准检查 | 不消费明确的 research 交接契约；固定读取 `specs`；没有 artifact 写入位置；强制每个 requirement 使用 PBT；传入 change name 后仍总是询问 | 被 `abel-design` 吸收并删除 |
| `abel-implement` | 按 task 执行 Red/Green/Refactor，并最终评审 | 无 readiness/strict/traceability preflight；不消费 task 验证契约；忽略已传入 change name；重复 `Guardrails` 标题；无法区分既有测试失败 | 本期做最小契约适配，不做全面重写 |
| `abel-diagnose` | 多问题根因分析、补丁生成、顺序应用与验证 | 报告早于应用/验证；无真实 Red 复现门禁；状态缺少 `FAILED`；并行写集约束不足 | 正文不改；列入后续改进 |

### 1.2 research / plan 重叠的准确结论

1. **不是所有澄清都重复**：research Phase 0 的最低摄入与 Phase 7 的证据后澄清本应同时存在；真正的问题是二者没有清晰退出契约，plan 因而再次执行全量歧义审计。
2. **不是 artifact 写了两遍**：research 已负责生成全套 artifacts，plan 又重新推导其内容，却没有定义回写位置。问题是“分析与物化所有权冲突”，不是两次文件写入。
3. **行为与技术边界混杂**：research 直接生成 design/tasks，plan 又要求 JWT/bcrypt 等技术参数；原 v2 附录仍把 JWT/bcrypt 示例放在 Behavior Phase，若不修正，合并后只会把跨命令重叠搬到同一文件内部。
4. **检索能力被阶段割裂**：grok 与 context7 并非同一种检索，问题在于它们没有围绕同一决策账本按需触发，导致后阶段重新建立上下文。
5. **生产者与消费者断链**：design 即使输出 `READY_TO_IMPLEMENT` 和 task 验证契约，现有 implement 也不会验证或消费，端到端门禁仍可被绕过。

### 目标

合并公开入口为 `/abel-design`，采用**内部双闸门 + 决策账本 + schema 驱动 + 状态续跑**结构：

- 合并的是用户入口和上下文，不是需求设计与技术设计的语义边界：Gate A 收敛行为决策，Gate B 收敛实质技术决策与任务/验证映射。
- 退出条件是 `BLOCKING_DECISIONS = 0`，其含义是“零个未解决的阻塞决策”，不是实现阶段零局部判断；允许多轮澄清，不穷举机械实现细节。
- Gate 按决策语义划分，不按固定 artifact 文件名划分；先建立 artifact plan，再由 active schema 驱动写入与 Resume（`status --json` + `instructions --json`）。
- change 创建一律使用 CLI `openspec new change <change-name>`（不依赖 `/opsx:new`，理由见 §6 C1）。
- PBT 按适用性提取（显式决策，见 §7 Q9）。
- 每项任务携带验证契约，并由 `abel-implement` preflight 消费（Requirement → Scenario → Verification → Task 可追溯）。

### 范围与非目标

- **实施范围仅限本仓库内文件**；不评估、不提示、不触碰任何仓库外副本。
- 本期不改动 `abel-init` / `abel-diagnose` 正文；`abel-implement` 只增加 readiness preflight、验证契约消费和必要清理，不改变其 TDD 主职责。
- 不更新历史文档 `docs/abelworkflow-v1-refactor-plan.md`。
- 不恢复或修改用户已删除的 `docs/modern-ui-proposal.md`，不覆盖根 `AGENTS.md` 中现有的用户修改。
- 当前无法宣称“仅 1 个既有失败”：2026-07-21 的 `/usr/local/bin/node` 实为指向 Bun 的 shim，不能运行 `node:test`；`npm test` 还因缺少 `@clack/prompts` 未进入测试。运行器和依赖就绪后，已删除的 modern-ui 文档还可能触发 docs-contract 失败。实施上下文必须先取得真实 Node.js 22+ 环境并记录 baseline，再以“目标测试全绿 + 全量测试无新增失败”验收。

---

## 2. 新命令设计：abel-design.md

### 2.1 状态机（定稿）

```text
/abel-design [requirement | --change <change_name>]

├─ Phase 0  Entry, Mode & Readiness（只读）
│  ├─ 验证 OpenSpec root、所需 CLI/JSON 字段及 effective schema；创建 change 前先做 schema 兼容性预检
│  ├─ 显式 --change 或精确命中已有 change → Resume；不得把拼错的 change 静默当新需求
│  ├─ 按 CLI 选择 / change metadata / project config / default 解析 effective schema
│  └─ New：最低摄入“问题/目标 + 范围锚点”；生成 provisional name、查重，仍不写文件
│
├─ Phase 1  Evidence Exploration（只读）
│  ├─ 单边界 → 主代理直接探索；多独立边界且平台允许 → 并行 explorer + 8 字段 JSON
│  ├─ 模式审计 {{CODEBASE_RETRIEVAL_PATTERN_AUDIT}}
│  ├─ 按需 context7（库/API 官方契约）与 grok（架构模式/最佳实践）
│  └─ 校验并聚合证据；更新 Decision Ledger 与 PBT 边界筛查
│
├─ Phase 2  Behavior Clarification Loop（允许多轮，只回答 WHAT）
│  ├─ 目标、范围、非目标、可观察场景/成功标准、数据/安全/隐私政策
│  ├─ 每轮只问当前最高影响的阻塞问题（证据 + 推荐默认值 + 影响）
│  ├─ 回答扩大范围 → 返回 Phase 1 增量探索
│  └─ 退出：行为类未解决阻塞决策 = 0
│
├─ ⛔ Gate A  Approve Behavior Contract
│  ├─ 展示行为合同与 Decision Ledger 摘要；用户明确批准
│  ├─ 基于最终范围重算/查重 change name
│  ├─ New 模式此时才运行 openspec new change <name> [--schema <schema>]
│  └─ 建立 Artifact Plan，按协议物化当前可安全写入的行为类 artifacts
│
├─ Phase 3  Technical Derivation（回答 HOW）
│  ├─ 从 Gate A、代码模式、官方 API 契约推导技术设计
│  └─ 机械决定直接记录；实质权衡进入 Phase 4
│
├─ Phase 4  Technical Decision & Verification Loop
│  ├─ 接口、数据流、错误机制、依赖/算法/关键参数
│  ├─ PBT 适用性提取；建立稳定 Requirement/Scenario 引用
│  ├─ 形成 Requirement → Scenario → Verification → Task 链
│  ├─ 每项 task 形成验证契约；技术类未解决阻塞决策 = 0
│  └─ 在内存中生成剩余 artifact 的拟议内容/unified diff
│
├─ ⛔ Gate B  Approve Implementation Contract
│  ├─ 展示实质技术决策、任务/验证映射及物化预览；用户明确批准
│  └─ 按 Artifact Plan 拓扑循环写入其余 ready artifacts
│
└─ Exit  Readiness Audit
   ├─ openspec validate <change> --strict --type change 零问题
   ├─ applyRequires 列出的每个 artifact id 均为 done
   ├─ artifacts 双向一致且可追溯；task 验证契约完整
   ├─ BLOCKING_DECISIONS = 0；Gate A/B 批准在当前会话可证明
   └─ READY_TO_IMPLEMENT
```

### 2.2 行为与技术决策边界

| 分类 | Gate | 典型内容 | 不属于该分类的例子 |
| --- | --- | --- | --- |
| 行为合同（WHAT） | A | 用户可观察结果、范围/非目标、输入输出规则、失败行为、数据保留/隐私/兼容政策、成功标准 | JWT vs session、bcrypt cost、表结构、缓存/队列选型 |
| 实施合同（HOW） | B | 接口与数据流、依赖、存储/算法、错误实现机制、关键技术参数、任务拆分与验证命令 | 新增用户场景、改变数据政策、扩大产品范围 |
| 机械决定 | 无新增 Gate | 被仓库唯一约定决定的命名/路径/测试位置，以及无外部行为影响且易回退的局部细节 | 存在两个以上实质差异选项、不可逆或跨模块决策 |

- JWT/bcrypt 等例子只允许出现在 Phase 4，不得再出现在 Behavior Phase。
- 维护会话内 `Decision Ledger`：`id / class / question / evidence / options / recommendation / resolution / status / affected_artifacts`。
- `BLOCKING_DECISIONS` 是 ledger 中 `status = unresolved` 且非机械决定的数量。Gate A/B 后把已批准决策写入正式 artifacts；不得新增运行时 ledger/approval 文件。

### 2.3 Gate、Artifact Plan 与写入协议

Gate 是决策批准边界，不是固定文件边界。OpenSpec 1.6.0 的默认 spec-driven schema 中 `design` 与 `specs` 均依赖 `proposal`，`tasks` 依赖 `design + specs`，`applyRequires = [tasks]`；通常会形成 Gate A 写 proposal/specs、Gate B 写 design/tasks，但实现不得按 artifact 名称硬编码。

创建 change 前先用 `openspec schema which <schema> --json`、`openspec schema validate <schema> --json`、`openspec templates --schema <schema> --json` 与 schema 定义做只读兼容性预检；还必须确认 `apply.tracks` 非空、为具体相对路径且与恰好一个 artifact 的 `generates` 一致。创建或恢复 change 后，再以 `status --json` 与每个可读取 artifact 的 `instructions --json` 建立最终 Artifact Plan：

| 字段 | 含义 |
| --- | --- |
| artifact id / output | 使用响应中的 `artifactPaths`、`outputPath`、`resolvedOutputPath`、`existingOutputPaths` |
| deps / status | `dependencies`、`ready/done/blocked`、`missingDeps` |
| decision class | `behavior` / `technical` / `mixed`；依据将承载的**实质决策**，不因机械影响信息或文件名误判 |
| write gate | behavior → A；technical/mixed → B；若 DAG 依赖尚未满足则延后 |

自定义 schema 的处理规则：

1. `mixed` artifact 一律等到 Gate B，不得为了尽早落盘把技术选择偷渡到 Gate A。
2. behavior artifact 若依赖 Gate B artifact，延后到 Gate B 后按 DAG 写入；Gate A 可以只保留会话内批准摘要。
3. 若预检发现 schema 要求在批准行为前写文件、要求写出 change 目录，或无法在不引入未批准技术决策的情况下满足依赖，必须在创建 change 前停止并请用户选择兼容 schema/映射；“遵循 schema”不能覆盖决策语义门禁。

**Artifact 写入协议**（每个 artifact 单独循环）：

1. 运行 `openspec status --change <name> --json`，核对 `schemaName`、`changeRoot`、artifact 状态、路径、依赖和 `applyRequires`；`existingOutputPaths` 为空时不得把它误当新文件目标。
2. 对当前 ready/done artifact 运行 `openspec instructions <artifact-id> --change <name> --json`，读取 template/rules/dependencies，并更新 Artifact Plan。
3. 读取依赖与已有输出，检查向前和向后一致性；只在 `changeRoot` 内拟定内容。
4. 在对应 Gate 前展示决策摘要与拟议 unified diff；Gate 已批准后若物化不引入新决策，可直接写入，若出现新实质决策则返回相应 loop 重新批准。
5. 新 artifact 必须为 ready；已有 done artifact 只有在获批 loop-back/一致性修复明确命中它时才可编辑。每次只写一个，随后立即重跑 status，不批量假设后续路径或状态。

### 2.4 回退规则

- 用户回答扩大模块、场景或数据边界 → 返回 Phase 1，仅做增量探索。
- 技术分析推翻行为合同 → 返回 Phase 2，只重开受影响决策，并同步所有受影响 artifacts。
- Gate B 仅认为物化不忠实 → 返回 Phase 3/4，未受影响的 Gate A 决策保持批准。
- strict validation、verification contract 或可追溯性失败 → 回到最早引入不一致的阶段。
- 不得为保持提问轮次外观而隐藏晚发现的阻塞问题。

### 2.5 Resume 规则

`status` 的 `done/isComplete` 只证明规划文件存在，不证明内容正确或 Gate 获批；本机 1.6.0 对不存在 change 返回结构化 `change_error` 且退出码为 1。禁止按固定文件名/存在性跳转，禁止新增运行时审批状态文件。

1. 解析模式：显式 `--change` 优先；否则精确命中已有 change 才进入 Resume。
2. 运行 `openspec status --change <name> --json`，以响应的 `schemaName/changeRoot/artifactPaths` 为准。
3. 读取所有 `existingOutputPaths`、依赖与相关 artifacts；执行 strict validation、模板完整性、跨 artifact 一致性和 traceability 检查。
4. 从内容重建 Gate A/B 摘要。当前会话无法证明的批准必须由用户重新确认；“调用了 Resume/Implement”本身不等于批准摘要内容。
5. 根据状态选择下一步：

| 状态 | 行为 |
| --- | --- |
| 显式 Resume 但 `change_error` | 停止并让用户确认拼写或切换 New；不得静默创建 |
| artifacts 不完整 | 重建并确认最近安全 Gate，再按 Artifact Plan 处理 ready artifact |
| artifacts 完整但 validation/traceability 失败 | 回到最早不一致阶段 |
| `applyRequires` 对应 artifacts 均 done | 仍先补齐无法证明的 Gate 批准，再执行 Exit audit |
| 只有上一会话未落盘分析 | 无法恢复该分析，重跑只读探索与 ledger 重建 |

### 2.6 决策权限模型

- **必须用户批准**：目标、范围、非目标、可观察成功行为；数据、安全、隐私、兼容性、迁移规则；新依赖、跨模块架构、不可逆变更；存在实质权衡的技术选择及关键参数。
- **代理可机械决定**：仓库既有约定唯一决定的命名、文件位置、局部结构；不改变外部行为且易回退的实现细节；已批准设计直接推导出的测试位置与执行顺序。
- 机械决定记录到相应 artifact 但不再反问；两个以上选项存在实质差异时升级为阻塞决策。

### 2.7 模板机制约束

- 新命令只使用 `lib/installer/render.mjs` 已定义的四个占位符：
  `{{CODEBASE_RETRIEVAL_POLICY}}` / `{{CODEBASE_RETRIEVAL_MANDATORY_RULE}}` /
  `{{CODEBASE_RETRIEVAL_STRUCTURE_REFERENCE}}` / `{{CODEBASE_RETRIEVAL_PATTERN_AUDIT}}`。
- 不新增占位符。
- 同步修复 render.mjs：augment Pattern Audit 当前引用 `<change_name>` 与 proposal 关键词，而 design 在 change 创建前就会使用；改为 `current requirement` / `key concepts from the requirement`。
- 包裹注释统一为 `<!-- ABEL:START -->` / `<!-- ABEL:END -->`。

### 2.8 frontmatter

- 现有命令均有 frontmatter；render 测试要求文件以 `---\n` 开头，docs-contracts 解析 `name:`。
- 参数提示改为 `[requirement | --change <change_name>]`，同时保留“自由文本精确命中已有 change”的便利 fallback。
- 定稿正文见附录 A。

### 2.9 Stage Skill Matrix 与 OpenSpec 命令修正

两处 AGENTS.md 的矩阵列头 `Research | Plan` 合并为 `Design`：

| Skill | Design | Implement | Diagnose |
| --- | :---: | :---: | :---: |
| /grok-search | ✅ | ❌ | ✅ |
| /context7-auto-research | ✅ | ✅ | ✅ |
| /dev-browser | ○ | ✅ | ✅ |
| /time | ○ | ✅ | ○ |

README 与两处 AGENTS.md 移除 expanded-only 的 `/opsx:new`、`/opsx:ff`，改列本机 OpenSpec 1.6.0 core profile 实际生成的六个命令：`/opsx:propose`、`/opsx:explore`、`/opsx:apply`、`/opsx:update`、`/opsx:sync`、`/opsx:archive`；保留 `openspec view`、`openspec status`。

---

## 3. 文件改动清单

| # | 文件 | 动作 | 内容 |
| --- | --- | --- | --- |
| 1 | `lib/templates/workflow/commands/abel-design.md` | 新建 | 以附录 A 为目标正文 |
| 2 | `lib/templates/workflow/commands/abel-research.md` | 删除 | 被 #1 吸收 |
| 3 | `lib/templates/workflow/commands/abel-plan.md` | 删除 | 被 #1 吸收 |
| 4 | `lib/templates/workflow/commands/abel-implement.md` | 修改 | 增加 §3.1 的最小 consumer preflight/验证契约消费；清理重复标题 |
| 5 | `lib/installer/render.mjs` | 修改 | augment Pattern Audit 改为 `current requirement` / `key concepts from the requirement` |
| 6 | `lib/templates/workflow/AGENTS.md` | 修改 | 流程图、Skill Matrix、core OpenSpec 命令按 §2.9 同步 |
| 7 | `AGENTS.md`（仓库根） | 修改 | 同 #6；只改目标行，保留现有用户修改 |
| 8 | `README.md` | 修改 | research/plan 合为 design；流程图和 core 命令同步；文案见 Q8 |
| 9 | `test/docs-contracts.test.mjs` | 修改 | 命令集合改为 design/diagnose/implement/init；断言六个 core 命令与 view/status |
| 10 | `test/workflow-render.test.mjs` | 修改 | 命令文件字母序集合同步 |
| 11 | `test/workflow-render-characterization.test.mjs` | 修改 | 占位符渲染命令数组同步 |
| 12 | `test/installer-characterization.test.mjs` | 修改 | source-clone canary 从 research 改为 design（两处） |
| 13 | `test/workflow-design-contract.test.mjs` | 新增 | design 语义契约测试，见 §5 |
| 14 | `test/workflow-implement-contract.test.mjs` | 新增 | implement consumer/preflight 契约测试，见 §5 |
| 15 | `test/installer-command-upgrade.test.mjs` | 新增 | 只补命令集合升级的端到端缺口；不重复 assets/links 单元矩阵 |

**明确不动**：`docs/abelworkflow-v1-refactor-plan.md`（历史归档）、用户已删除的 `docs/modern-ui-proposal.md`、`abel-init`、`abel-diagnose`。

### 3.1 abel-implement 最小适配契约

在任何代码/测试写入前按顺序执行：

1. change 选择：显式参数优先；只有缺失或无法唯一解析时才询问，不再无条件运行 `openspec view` 要求确认。
2. `status --json`：读取 `schemaName/changeRoot/artifactPaths/applyRequires/artifacts`。
3. 运行 `openspec schema which <schemaName> --json`，读取 resolved `schema.yaml` 的 `apply.tracks`；它必须在 `changeRoot` 内解析为一个已存在的具体普通文件，不得从 apply instructions 的 `contextFiles/tasks` 推断。
4. 要求 `applyRequires` 中每个 artifact id 的状态为 `done`；数组非空或一般完成标志不充分。
5. `openspec validate <change> --strict --type change` 必须零问题；读取所有规划 artifacts 与 `openspec instructions apply --change <change> --json`。
6. 校验 Gate A/B 摘要、稳定 Requirement/Scenario 引用、每个 task 的验证契约；manual-only task 不具备 implementation readiness。当前会话无法证明 Gate 批准时，展示重建摘要并要求用户确认。
7. 写入前运行并记录受影响 baseline tests 与 full suite；记录命令、退出码和规范化失败 identity/reason。既有 full-suite 失败必须与目标 Red 分开；不得把既有失败当作 Red。
8. 任一前置项失败即停止并返回 `/abel-design --change <name>`；implement 不现场补产品、行为或架构决策。
9. 每项任务从验证契约取得 verification type、Red command/预期原因、Green 行为、affected-suite command 和目标范围。Red 必须因目标缺陷失败；失败原因不符、命令失效或 task 只能手工验证时停止回到 design。
10. 非行为代码任务使用先失败的可执行 static verification；验证子条目不得使用 Markdown checkbox。完成 task 后在 schema `apply.tracks` 解析出的具体文件中按 Task ID 唯一定位并更新 checkbox，不硬编码文件名；最终重跑同一 full-suite 命令并要求相对 baseline 无新增失败 identity。

---

## 4. 实施步骤

1. **建立 baseline**：先检查 `git status` 并记录用户改动；确认 `node` 是支持 `node:test` 的真实 Node.js 22+（不是 Bun shim）。若运行器不满足则停止请求环境修复；若依赖缺失，在获准联网后按根 `package-lock.json` 安装，再记录目标测试与全量测试结果。不得为“全绿”恢复 modern-ui 文档。
2. **改测试（Red）**：先改 #9-#12、新建 #13-#15；运行目标测试，确认只因新 design/implement 契约或命令集合尚未实现而失败。
3. **修 renderer**：完成 #5，确认两种 feature state 的 pattern audit 均符合新入口语义。
4. **建 design 命令**：将附录 A 落盘为 #1；先让 design/render contract 变绿。
5. **适配 implement**：按 §3.1 完成 #4；让 implement contract 变绿。
6. **删旧命令并验证升级**：删除 #2/#3；使 installer command-upgrade 测试变绿。
7. **同步文档与模板**：完成 #6-#8，保留根 AGENTS.md 的既有非目标 diff。
8. **目标验证（Green）**：
   - design/implement 语义契约、render、installer upgrade 测试全绿；docs-contracts 用 `node --test --test-name-pattern="README documents every official workflow and OpenSpec command" test/docs-contracts.test.mjs` 验证本期子测试，整文件结果留到 baseline 对比；
   - 对 `abel-design.md` 分别跑 `renderWorkflowTemplate(source, { augmentContextEngine: true/false })`，确认无残留 `{{...}}` 占位符；
   - 确认 `abel-design` 在字母序断言中的位置正确（design < diagnose < implement < init）。
9. **全量验证**：运行 `npm test`；若 baseline 本来非零，逐项比较并证明无新增失败，不接受笼统“与本期无关”。
10. **自查一致性**：README 与两处 AGENTS.md 的 Workflow、Skill Matrix、core opsx 行一致；`git diff --check` 通过；目标外文件无新增变化。

---

## 5. 验收标准

- [ ] `lib/templates/workflow/commands/` 下仅余 4 个命令：init / design / implement / diagnose。
- [ ] design/implement/render/installer 目标测试及 docs-contracts 本期相关命名子测试全绿；`npm test` 相对已记录 baseline 无新增失败。
- [ ] README 与两处 AGENTS.md 中不再出现 `abel-research` / `abel-plan` / `/opsx:new` / `/opsx:ff` 字样。
- [ ] README 与两处 AGENTS.md 完整列出 core 六命令：propose / explore / apply / update / sync / archive，并保留 view/status。
- [ ] 新命令渲染后（两种 feature state）无未替换占位符；augment 渲染产物中的 Pattern Audit 片段不含 `<change_name>`（frontmatter 参数提示仍按 §2.8 保留）。
- [ ] 新命令内容与附录 A 逐字一致。
- [ ] `test/workflow-design-contract.test.mjs` 钉住以下稳定语义，避免对无关措辞做整段快照：
  - 不含 `/opsx:new`，含 `openspec new change`；
  - Phase 2 明确允许多轮，并明确 WHAT/HOW 边界；JWT/bcrypt 只出现在技术阶段；
  - 含 `Before Gate A: strictly read-only`；
  - 含 Decision Ledger、Artifact Plan、mixed artifact → Gate B 与不兼容 schema fail-closed；
  - 含 `openspec status --change` 与 `openspec instructions` 的逐 artifact 拓扑写入协议；
  - 新 artifact 仅在 ready 时创建，done artifact 仅在获批 loop-back/一致性修复时编辑；
  - Resume 含 `Never infer user approval from artifact existence`；
  - `applyRequires` 的判定是“其中每个 artifact id 为 done”，不是数组非空或 `isComplete`；
  - 所有 change validation 显式使用 `--type change`，并含 schema `apply.tracks` 兼容性检查；
  - manual-only task 不得通过 Gate B/Exit；
  - 含 `BLOCKING_DECISIONS`、稳定 Requirement/Scenario 引用、PBT 适用性规则；
  - frontmatter 以 `---\n` 开头且 `name: abel-design`；
  - README/两处 AGENTS.md 含 `/abel-design` 和完整 core 命令集。
- [ ] `test/workflow-implement-contract.test.mjs` 钉住：参数优先、status JSON/typed strict validation/applyRequires/traceability/Gate 重确认、affected + full-suite baseline、manual-only 拒绝、验证契约驱动 Red、失败返回 design、从 schema `apply.tracks` 解析跟踪文件且不硬编码。
- [ ] `test/installer-command-upgrade.test.mjs` 只用临时 fixture 覆盖：
  - fresh install 只部署 init/design/implement/diagnose，三 Provider 链接同步；
  - v2 metadata 记录且未修改的旧命令被安全删除，Provider 链接同步清理；
  - v2 用户修改过的旧命令在非 force 下保留并报告冲突，相关 Provider 入口也保留；
  - `--force` 下该旧命令备份后移除，能够证明所有权的 Provider 入口同步清理。

`.skill-lock.json`、v1 stale 路径、Windows 无哈希 copy、stale asset 基础三态和 link pruning 细节已由现有 `installer-assets.test.mjs` / `installer-links.test.mjs` 覆盖；这些测试必须继续通过，但新集成测试不得机械复制其单元矩阵。

---

## 6. 风险与缓解

| # | 风险/反例 | 缓解 |
| --- | --- | --- |
| C1 | `/opsx:new`、`/opsx:ff` 属 expanded profile，默认 core 1.6.0 实际有六个命令，原 v2 验收只列了三个 | design 创建改用 CLI；README/AGENTS/测试列全 propose/explore/apply/update/sync/archive |
| C2 | 固定 artifact 名或“遵循 schema”都不足以处理 mixed/reversed 自定义 DAG | Artifact Plan 语义分类；mixed 延至 Gate B；不兼容 schema fail closed |
| C3 | `done/isComplete`、调用 Resume 或调用 Implement 都不能证明用户批准了具体合同 | 重建 Gate 摘要并在当前会话重确认；Exit/Implement preflight 同时检查 |
| C4 | v2 stale command 的 source 与 Provider 链接有多种所有权状态；force 也不能覆盖 v1 Windows 无哈希 copy | 新集成测试区分 v2 unchanged/modified/force；现有 assets/links 测试继续覆盖 v1 与无哈希 copy |
| C5 | design 生产验证契约而 implement 不消费，会形成“看似就绪、实际可绕过”的断链 | 本期纳入 §3.1 最小 implement 适配及契约测试 |
| C6 | Behavior Phase 中出现 JWT/bcrypt 等 HOW 决策，会在单命令内部重现 research/plan 重叠 | 明确 WHAT/HOW 分类，技术例子全部移到 Phase 4 |
| R1 | 合并后单会话变长 | Resume 支持跨会话重建；单边界由主代理低成本探索 |
| R2 | 单文件演变为 god prompt | 以 Decision Ledger、Artifact Plan 和两个 Gate 分段；语义测试防止职责重新混合 |
| R3 | characterization 测试本意是钉住现状 | 先显式更新预期并观察 Red，diff 作为有意行为变更记录 |
| R4 | OpenSpec 按包含 `- [ ]` / `- [x]` 的行计 task，验证子项若也用 checkbox 会污染进度 | 每个 task 仅一个顶层 checkbox；验证契约使用普通缩进 bullet，测试钉住无嵌套 checkbox |
| R5 | OpenSpec 后续版本的 JSON/profile 发生漂移 | Phase 0 检查能力和必需字段；失败时给出 remediation，不仅比较版本号 |
| R6 | 当前 Node 命令是 Bun shim、依赖缺失且工作区已有非目标删除，无法直接证明全量 Green | 先取得真实 Node.js 22+ 与依赖并记录 baseline；目标测试必须全绿，全量只允许已逐项记录的既有失败 |

---

## 7. 定稿决策（新上下文无需重问）

| # | 决策点 | 结论 |
| --- | --- | --- |
| Q1 | 命令名 | `abel-design` |
| Q2 | 旧文件 | 直接删除，不留兼容层 |
| Q3 | 实施范围 | 仅限本仓库内文件 |
| Q4 | Skill Matrix | 合并后 Design 列 grok-search 为 ✅ |
| Q5 | frontmatter | 保留（机制强制要求，替代而非新增） |
| Q6 | 包裹注释 | `<!-- ABEL:START/END -->` |
| Q7 | 实施方式 | design 目标正文附于附录 A；语义测试只钉稳定契约，不钉无关措辞 |
| Q8 | README 文案 | `通过双闸门澄清生成可实施、可验证规格`，避免把“零阻塞决策”误写成“零局部判断” |
| Q9 | PBT 适用性 | 存在不变量/往返/幂等/顺序/边界/状态转换时必须提取 property + falsification strategy；不适用时使用 example/E2E/static 并记录理由，不机械全覆盖 |
| Q10 | change 创建 | 一律 `openspec new change` CLI；仓库文档不再引用 `/opsx:new`、`/opsx:ff`（默认 core profile 不含二者，需 `openspec config profile` 手动开启） |
| Q11 | Gate 与 Resume | 按决策语义划分；Artifact Plan 由 status/instructions 驱动；mixed → Gate B；不兼容 schema 停止；不新增运行时审批状态文件 |
| Q12 | implement / diagnose | implement 最小 preflight/consumer 适配纳入本期；diagnose 改进继续后置 |
| Q13 | 测试范围 | design + implement 最小语义契约测试；升级测试只补三 Provider 端到端缺口 |
| Q14 | 行为/技术边界 | Gate A 只批准 WHAT；JWT/bcrypt/依赖/架构参数属于 Gate B |
| Q15 | core 命令 | propose / explore / apply / update / sync / archive，另保留 view/status CLI |

---

## 8. 本轮评审证据

| 证据 | 已核实结论 |
| --- | --- |
| 五个命令正文、renderer、installer assets/links 与现有测试 | §1 的职责/缺口、四占位符、v1/v2/force 所有权行为均来自当前仓库代码 |
| 本机 `openspec 1.6.0` help 与临时 fixture | `new change --json`、status/instructions JSON 字段、默认 DAG、`applyRequires=[tasks]`、不存在 change 的 `change_error` + exit 1 均成立 |
| OpenSpec 官方 [`docs/opsx.md`](https://github.com/Fission-AI/OpenSpec/blob/main/docs/opsx.md) 与 [`src/core/profiles.ts`](https://github.com/Fission-AI/OpenSpec/blob/main/src/core/profiles.ts) | `/opsx:new`/`ff` 为 expanded；core 包含 propose/explore/apply/update/sync/archive |
| OpenSpec 官方 [`docs/agent-contract.md`](https://github.com/Fission-AI/OpenSpec/blob/main/docs/agent-contract.md) 与 [`docs/customization.md`](https://github.com/Fission-AI/OpenSpec/blob/main/docs/customization.md) | status/instructions 的 schema 驱动字段和自定义 artifact DAG/apply.requires 契约 |
| OpenSpec [`cli-list` task-counting specification](https://github.com/Fission-AI/OpenSpec/blob/main/openspec/specs/cli-list/spec.md) | 按 Markdown `- [ ]` / `- [x]` 行统计 task，因此验证子项不能再使用 checkbox |
| 2026-07-21 本地测试命令 | `/usr/local/bin/node -> /usr/sbin/bun`，直接 `node --test` 无法进入 runner；`npm test` 另缺 `@clack/prompts`，原 v2 的“仅一个 docs failure”基线不可采用 |

---

## 9. 后续任务（本期不实施）

- **F1 `abel-init` 安全性**：全局安装前确认；评估版本钉定/能力检测；区分 init/update，并给出无写入的 remediation。
- **F2 语义契约测试扩充**：子代理 JSON 校验、真实 custom schema reversed/mixed DAG、Resume 状态表的行为级 fixture。
- **F3 `abel-diagnose` 五项改进**：修复前先跑回归确认因目标缺陷失败；write set 不相交才并行生成补丁；batch report 移到应用与验证之后；reviewer 只返回 findings、主代理局部 TDD 修复；增加 `FAILED` 状态与明确回退点。
- **F4 `abel-implement` 全面精简**：按前后端实际 write set 选择 reviewer，删除固定双 reviewer 和冗长展示模板；本期只做契约闭环所需最小修改。

---

## 10. 新上下文交接

建议新上下文直接使用：

```text
请严格按 docs/abel-design-merge-plan.md（评审修订版 v3）实施。
先读取适用 AGENTS.md、检查并保护既有工作区改动，明确假设/未知；按 §4 执行 TDD，
只修改 §3 文件，目标测试必须全绿，全量测试相对 baseline 不得新增失败。
不要恢复 docs/modern-ui-proposal.md，不要重问 §7 已定稿决策。
```

实施者必须先确认当前工作区与 §1 baseline 是否仍一致；若出现新的关键冲突，只暂停受影响步骤，不擅自覆盖用户改动。

---

## 附录 A：abel-design.md 完整正文（原样落盘）

```markdown
---
name: abel-design
description: Transform requirements into implementation-ready, traceable specs via gated clarification.
category: abel
tags: [abel, design, constraints, PBT, subagents]
argument-hint: [requirement | --change <change_name>]
---

<!-- ABEL:START -->

# abel-design — Gated Design Mode (Specs Only, No Implementation)

## Non-Negotiable Rules (Highest Priority)
1. DESIGN MODE ONLY — you MUST NOT generate implementation code.
2. WRITE SCOPE:
   - Before Gate A: strictly read-only; persist nothing.
   - After Gate A: write ONLY inside the resolved `changeRoot`. Create only ready artifacts; edit a done artifact only when an approved loop-back/consistency repair explicitly targets it.
3. NEVER assume or guess — every blocking decision goes to the user (see Decision Model).
4. Final output: a schema-valid, fully traceable OpenSpec change with BLOCKING_DECISIONS = 0, READY_TO_IMPLEMENT.

**Skill Integration**: See `Stage Skill Matrix` (Design column)

---

## Decision Model
- Maintain an in-session Decision Ledger with: `id`, `class`, `question`, `evidence`, `options`, `recommendation`, `resolution`, `status`, `affected_artifacts`.
- `BLOCKING_DECISIONS` is the count of unresolved, non-mechanical decisions in that ledger.
- Behavior decisions answer WHAT: observable outcomes, scope/non-goals, scenarios, failure behavior, data/security/privacy/compatibility policies and success criteria.
- Technical decisions answer HOW: interfaces, data flow, dependencies, storage/algorithms, implementation error mechanisms and key technical parameters.
- MUST be approved by the user: goal, scope, non-goals and observable success behavior; data, security, privacy, compatibility and migration rules; new dependencies, cross-module architecture, irreversible changes; any technical choice with substantive trade-offs, including key parameters.
- MAY be decided mechanically by the agent: naming, file locations and local structure uniquely determined by existing repo conventions; easily reversible details with no external behavior change; test placement and execution order derived directly from the approved design.
- Record mechanical decisions and never re-ask them. Two or more viable options with substantive differences → escalate to a blocking decision.
- Do NOT create a runtime ledger or approval-state file. Materialize approved decisions only in schema artifacts.

## Phase 0 — Entry, Mode & Readiness (read-only)
- Verify an initialized OpenSpec root and the required CLI capabilities: `new change`, `list --json`, `schemas --json`, `schema which --json`, `schema validate --json`, `templates --json`, `status --json`, `instructions --json`, and `validate --strict`. If unavailable, STOP with actionable `/abel-init` remediation; do not initialize or update from this command.
- Resolve mode:
  - Explicit `--change <name>` → Resume. If that change does not exist, STOP and ask the user to correct the name or choose New mode.
  - Otherwise, an exact existing-change match → Resume.
  - Otherwise → New mode; do not silently interpret an explicit/resume-like typo as a requirement.
- Resolve the effective schema by precedence: explicit schema choice, existing change metadata, project config, then `spec-driven`; verify it appears in `openspec schemas --json`.
- Before creating a change, run `openspec schema which <schema> --json` and `openspec schema validate <schema> --json`, inspect its definition and `openspec templates --schema <schema> --json`, and perform a preliminary behavior/technical/mixed dependency check. Implementation compatibility also requires a non-empty concrete `apply.tracks` that matches exactly one artifact's `generates`. An incompatible schema must fail closed before creation.
- New mode minimum intake before ANY exploration:
  - Problem/goal statement, AND
  - Scope anchor (which module/directory is involved).
- If either intake item is missing, ask the user concisely before proceeding.
- Generate a provisional kebab-case change name and check `openspec list --changes --json`. Recompute and confirm it from the final Gate A scope before creation. Persist nothing yet.

## Phase 1 — Evidence Exploration (read-only)
- {{CODEBASE_RETRIEVAL_POLICY}}
- Single context boundary → main agent explores directly.
- Multiple independent context boundaries, when the platform permits → dispatch parallel Explore subagents:
  - Divide by context boundary (NOT functional role); each boundary self-contained.
  - Each subagent receives: {{CODEBASE_RETRIEVAL_MANDATORY_RULE}}, a clear scope, and the mandatory JSON output schema:
{
  "module_name": "所探索的上下文边界",
  "existing_structures": ["关键结构/模式"],
  "existing_conventions": ["约定/标准"],
  "constraints_discovered": ["硬约束"],
  "open_questions": ["需用户输入的歧义"],
  "dependencies": ["跨模块依赖"],
  "risks": ["风险/阻碍"],
  "success_criteria_hints": ["可观察的成功行为"]
}
- Validate every subagent JSON before aggregation; aggregate constraints, dependencies, risks, conflicts and questions into the Decision Ledger.
- Audit existing codebase patterns:
  {{CODEBASE_RETRIEVAL_PATTERN_AUDIT}}
- On-demand /context7-auto-research: verify candidate libraries/APIs against official contracts.
- On-demand /grok-search: architectural patterns and best practices for candidate directions.
- PBT boundary screening: probe empty input, idempotency, ordering, size/value bounds, state-transition legality → feed the question list for Phase 2.
- Reference: {{CODEBASE_RETRIEVAL_STRUCTURE_REFERENCE}}

## Phase 2 — Behavior Clarification Loop (multiple rounds allowed)
- Cover WHAT only: goal, scope, non-goals, observable scenarios/success criteria, failure behavior, and data/security/privacy/compatibility policies.
- Do not choose libraries, protocols, algorithms, storage, topology or implementation parameters in this phase; route them to Phase 4.
- Each round asks ONLY the current highest-impact blocking questions, grouped concisely, each with evidence, impact and a recommended default.
- Anti-patterns (flag and reject):
  - Observable behavior deferred to implementation ("error behavior decided while coding")
  - Technical mechanisms smuggled in as product requirements
- Target behavior patterns:
  - "Lock the account for 30 minutes after 5 consecutive failed logins."
  - "Retain audit records for 30 days and never expose secrets in responses."
  - "For an empty query, return an empty result within the approved latency bound."
- An answer that widens modules, scenarios or data boundaries → return to Phase 1 for INCREMENTAL exploration only.
- Loop until unresolved behavior decisions = 0.

## ⛔ Gate A — Approve Behavior Contract
- Present the behavior contract and affected Decision Ledger entries; the user explicitly approves goal, scope/non-goals, scenarios/success criteria and policies.
- Recompute the change name from the approved scope and recheck duplicates.
- New mode: ONLY NOW create the change with `openspec new change <change-name>` (add `--schema <schema>` only for an explicit non-default choice).
- Build the Artifact Plan, then materialize only behavior-class artifacts that are safe and ready.

## Artifact Plan & Write Protocol
- Before New-mode creation, build a preliminary compatibility map from the resolved schema definition/templates. After creation or in Resume mode, build the final Artifact Plan from `status --json` and available `instructions --json`. Record the schema's `apply.tracks`; for every artifact record capture id/output paths, dependencies/status, substantive decision class (`behavior|technical|mixed`), write Gate, and affected decisions. Mechanical impact information alone does not make an artifact mixed.
- Classify by the decisions the artifact carries, never by a hardcoded artifact name:
  - behavior → Gate A
  - technical or mixed → Gate B
  - behavior depending on a Gate B artifact → defer until after Gate B and then follow the DAG
- If the schema requires a write before Gate A, a write outside `changeRoot`, or an unapproved technical decision to unlock behavior, STOP before New-mode creation and ask the user to select a compatible schema/mapping. Schema order never overrides decision approval.
- Mandatory loop for EVERY artifact write:
  1. Run `openspec status --change <change-name> --json`; verify `schemaName`, `changeRoot`, `artifactPaths`, status/dependencies and `applyRequires`. `existingOutputPaths` may be empty and is not a new-file target.
  2. Run `openspec instructions <artifact-id> --change <change-name> --json`; follow its template/rules/dependencies.
  3. Read dependencies and existing outputs; check consistency in both directions.
  4. Prepare content in memory and show the decision summary or unified diff before the corresponding Gate. If materialization reveals a new substantive decision, return to the relevant loop and re-approve it.
  5. After Gate approval, create exactly one ready artifact, or edit one done artifact explicitly targeted by an approved loop-back/consistency repair. Rerun status after every write and process newly unlocked artifacts topologically.

## Phase 3 — Technical Derivation
- Derive the technical design from the Gate A contract, existing codebase patterns and official API contracts.
- Mechanical decisions → record directly in the design. Substantive trade-offs → Phase 4.

## Phase 4 — Technical Decision & Verification Loop
- Cover HOW: interfaces, data flow, implementation error mechanisms, dependencies/algorithms and key parameters. Examples include JWT vs session design and an approved bcrypt cost factor.
- Apply the same evidence/options/recommendation format to every substantive technical decision; update the Decision Ledger.
- PBT applicability rule (screen with the six categories: commutativity/associativity, idempotency, round-trip, invariant preservation, monotonicity, bounds):
  - Behavior with invariants, round-trips, idempotency, ordering, bounds or state transitions → MUST extract a property + falsification strategy.
  - Behavior unsuited to PBT → use example/E2E/static verification and record why PBT does not apply. Do NOT force every requirement through every category.
- Give every scenario a stable reference: `<spec-path>#<requirement-heading>/<scenario-heading>` and require those headings to be unique within the spec; maintain Requirement → Scenario → Verification → Task.
- Every task has exactly one schema checkbox and a verification contract using ordinary indented bullets, NEVER nested `- [ ]`/`- [x]` lines:
  - Task ID / dependencies
  - Requirement + stable Scenario reference
  - Verification type: property | example | E2E | static
  - Red command + expected failure reason
  - Green expected behavior
  - Affected-suite verification command
  - Target scope/files
- For a non-behavior-change task, the Red command is a pre-change executable static verification. Manual-only verification is not implementation-ready and MUST NOT pass Gate B or Exit; reshape the task until it has executable property/example/E2E/static verification.
- Loop until unresolved technical decisions = 0; prepare proposed remaining artifact contents/unified diffs in memory.

## ⛔ Gate B — Approve Implementation Contract
- Verify Phase 3/4 faithfully expand the Gate A contract; no unapproved new decisions introduced.
- Present substantive technical decisions, task/verification mapping and artifact materialization preview.
- The user explicitly approves that implementation contract.
- Write the remaining ready artifacts one at a time per the Artifact Plan & Write Protocol.

## Loop-Back Rules
- A user answer widens modules, scenarios or data boundaries → return to Phase 1.
- Technical analysis overturns the behavior contract → return to Phase 2; re-approve ONLY the affected decisions and synchronize all affected artifacts.
- Gate B finds the materialization unfaithful → return to Phase 3/4; unaffected Gate A decisions remain approved.
- Strict validation, verification-contract or traceability failure → return to the earliest phase that introduced the inconsistency.
- Never hide a late-discovered blocking question.

## Resume Rules
- Never infer user approval from artifact existence: `status` reporting `done` proves file completion only, not Gate approval.
- Never resume by fixed file names or file existence alone; the active schema decides.
- Algorithm:
  1. Run `openspec status --change <change-name> --json`.
  2. Use its `schemaName`, `changeRoot`, `artifactPaths` and statuses; read all `existingOutputPaths` and dependencies.
  3. Check `openspec validate <change-name> --strict --type change`, template completeness, cross-artifact consistency, traceability and verification contracts.
  4. Rebuild Gate A/B summaries and the Artifact Plan. Re-confirm every Gate approval that cannot be proven in the current conversation.
  5. Choose the next step:
     - Explicit Resume change not found (`change_error`) → STOP for spelling/New-mode confirmation; never create silently.
     - Artifacts incomplete → repair/confirm the nearest safe Gate, then handle the artifacts the schema reports ready.
     - Artifacts complete but validation/traceability fails → earliest inconsistent phase.
     - Every artifact id listed in `applyRequires` is `done` → re-confirm any unproven Gate, then run the Exit audit.
     - Only in-session, un-persisted analysis exists → no mid-loop resume; re-run the read-only analysis.
- Do NOT create runtime approval-state files; re-confirming the Gate summary IS the resume mechanism.

## Exit Criteria
- [ ] `openspec validate <change-name> --strict --type change` returns zero issues
- [ ] Every artifact id in `applyRequires` has status `done`
- [ ] Schema `apply.tracks` resolves to the generated task artifact inside `changeRoot`
- [ ] Artifacts are consistent and traceable; every task has a valid verification contract
- [ ] Every task has executable property/example/E2E/static verification; no task is manual-only
- [ ] BLOCKING_DECISIONS = 0
- [ ] User has explicitly approved the reconstructed/current Gate A and Gate B summaries in this conversation
- [ ] Status: READY_TO_IMPLEMENT

## Reference
- `openspec context --json` / `openspec schemas --json`
- `openspec view` / `openspec list --changes --json` / `openspec list --specs` (conflicts with existing specs)
- `openspec status --change <change-name> --json` / `openspec instructions <artifact-id> --change <change-name> --json`
- `openspec new change <change-name>` (Gate A only)
- `openspec show <change-name> --json --deltas-only` when validation fails
- `rg -n "Constraint:|MUST|MUST NOT|INVARIANT:|PROPERTY:" openspec/` before defining new ones
<!-- ABEL:END -->
```
