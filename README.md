# AbelWorkflow

Codex、OpenCode、Claude Code 的 Skills 和 Commands 配置仓库。

## 目录结构

```
.agents/
├── skills/              # 技能目录
│   ├── time/                    # 时间与时区工具
│   ├── grok-search/             # 增强型网页搜索
│   ├── sequential-think/        # 多步推理引擎
│   ├── dev-browser/             # 浏览器自动化
│   ├── context7-auto-research/   # 自动文档检索
│   ├── confidence-check/        # 实施前信心评估
│   ├── git-commit/            # Git 提交助手
│   └── prompt-enhancer/     # 提示词优化器
├── commands/           # 命令目录
│   └── oc/                # 工作流命令
├── AGENTS.md         # Agent 全局系统 prompts
└── README.md
```

## 技能概览

| 技能 | 描述 |
|------|------|
| **time** | 时间和时区工具，获取当前时间及时区转换 |
| **grok-search** | 通过 Grok API 增强网页搜索与实时内容检索 |
| **sequential-think** | 多步推理引擎，支持假设检验与分支的复杂分析 |
| **dev-browser** | 浏览器自动化，支持导航、表单填写、截图与数据提取 |
| **context7-auto-research** | 自动从 Context7 获取最新库/框架文档 |
| **confidence-check** | 实施前置信度评估（≥90%），含架构合规与根因识别 |
| **git-commit** | Conventional Commits 规范提交，智能暂存与消息生成 |
| **prompt-enhancer** | CoT 推理优化 AI 编码提示词，模糊请求转结构化指令 |

## 命令概览

| 命令 | 描述 |
|------|------|
| **/oc:init** | 初始化 OpenSpec 环境并验证工具链 |
| **/oc:research** | 结构化需求探索与约束集生成（不实施） |
| **/oc:plan** | 将已批准变更细化为零决策可执行方案 |
| **/oc:implementation** | 以 TDD 方式实施已批准的变更 |
| **/oc:diagnose** | 系统化根因分析与批量修复报告 |

## 工作流

```
/oc:init → /oc:research → /oc:plan → /oc:implementation(TDD)
                                   ↘ /oc:diagnose (bug fix)
```

## 配置说明

- **目录位置**:
  - Linux/macOS: `~/.agents/`
  - Windows: `%USERPROFILE%\.agents\`（PowerShell: `$HOME\.agents`）
- **AGENTS.md**: Agent 全局系统 prompts 配置

## 安装与更新

### 方法一：npx 一键安装（推荐）

```bash
# 交互式初始化菜单
npx abelworkflow

# 直接执行工作流同步/重链
npx abelworkflow install

# 更新到最新发布版本
npx abelworkflow@latest
```

> 说明：
> - npm 发布包名必须使用小写，所以实际可执行命令是 `npx abelworkflow`。
> - 交互式模式下，默认会打开初始化菜单，支持：
>   - 同步 `~/.agents` 并自动重建 `~/.claude` / `~/.codex` 链接
>   - 交互式填写 `grok-search`、`context7-auto-research`、`prompt-enhancer` 的 `.env`
>   - 一键安装或更新 `Claude Code`、`Codex`
>   - 配置 `Claude Code` 的第三方 API 到 `~/.claude/settings.json`
>   - 配置 `Codex` 的第三方 API 到 `~/.codex/config.toml` 和 `~/.codex/auth.json`
> - 非交互场景请显式使用 `npx abelworkflow install`，不再保留旧的默认自动同步逻辑。

### 交互式初始化能力

`npx abelworkflow` 现在默认提供一个类似 `npx zcf` 的菜单，常见入口包括：

```bash
npx abelworkflow
npx abelworkflow init
npx abelworkflow install
npx abelworkflow --help
```

其中完整初始化会按需引导你完成：

1. 安装 AbelWorkflow 到 `~/.agents`
2. 自动链接到 `~/.claude/` 和 `~/.codex/`
3. 可选安装 `Claude Code` CLI
4. 可选配置 `Claude Code` 第三方 API
5. 可选安装 `Codex` CLI
6. 可选配置 `Codex` 第三方 API
7. 可选填写三个技能的环境变量

### 技能环境写入位置

交互式配置会把技能密钥写到 `~/.agents` 下对应 skill 目录的 `.env` 中：

| 技能 | 写入位置 | 主要字段 |
|---|---|---|
| `grok-search` | `~/.agents/skills/grok-search/.env` | `GROK_API_URL` `GROK_API_KEY` `GROK_MODEL` |
| `context7-auto-research` | `~/.agents/skills/context7-auto-research/.env` | `CONTEXT7_API_KEY` |
| `prompt-enhancer` | `~/.agents/skills/prompt-enhancer/.env` | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` `PE_MODEL` |

### 方法二：源码克隆安装

如需自定义修改或贡献代码，可手动克隆后直接运行本地 CLI：

#### 1. 克隆仓库

**Linux/macOS（bash/zsh）**

```bash
# 首次安装
git clone https://github.com/abelxiaoxing/AbelWorkflow ~/.agents

# 更新
git -C ~/.agents pull
```

**Windows（PowerShell）**

```powershell
# 首次安装
git clone https://github.com/abelxiaoxing/AbelWorkflow "$HOME\.agents"

# 更新
git -C "$HOME\.agents" pull
```

#### 2. 执行本地初始化

```bash
cd ~/.agents
node bin/abelworkflow.mjs
```

如果只想重建链接，不进入菜单：

```bash
cd ~/.agents
node bin/abelworkflow.mjs install
```

### 映射关系（本仓库 → 配置目录）

| 本仓库 | Claude Code | Codex | 说明 |
|---|---|---|---|
| `AGENTS.md` | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | 全局系统提示词/规则 |
| `skills/<skill>/` | `~/.claude/skills/<skill>/` | `~/.codex/skills/<skill>/` | Skills（每个目录一个技能） |
| `commands/oc/` | `~/.claude/commands/oc/` | `~/.codex/prompts/*.md` | Claude 读 `commands/`；Codex 读 `prompts/` |

### 验证（可选）

```bash
ls -la "$HOME/.claude/CLAUDE.md" "$HOME/.claude/commands/oc"
ls -la "$HOME/.codex/AGENTS.md" "$HOME/.codex/prompts/"{init,research,plan,implementation,diagnose}.md
cat "$HOME/.claude/settings.json" | head
cat "$HOME/.codex/config.toml" | head
```
