# Code Agents

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
| **time** | 获取当前时间、时区转换 |
| **grok-search** | 网页搜索和实时内容检索 |
| **sequential-think** | 复杂问题的系统化分析 |
| **dev-browser** | 浏览器自动化与网页交互 |
| **context7-auto-research** | 自动获取最新文档 |
| **confidence-check** | 实施前验证（≥90% 信心要求） |
| **git-commit** | 规范提交信息生成 |
| **prompt-enhancer** | AI 编码提示词优化 |

## 命令概览

| 命令 | 描述 |
|------|------|
| **/oc:init** | 初始化 OpenSpec 环境 |
| **/oc:research** | 需求研究与约束分析 |
| **/oc:plan** | 制定可执行方案 |
| **/oc:implementation** | TDD 方式实施 |
| **/oc:diagnose** | 诊断与修复 |

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

### Linux/macOS（bash/zsh）

```bash
# 首次安装
git clone https://github.com/abelxiaoxing/agent-toolkit ~/.agents

# 更新
git -C ~/.agents pull
```

### Windows（PowerShell）

```powershell
# 首次安装
git clone https://github.com/abelxiaoxing/agent-toolkit "$HOME\.agents"

# 更新
git -C "$HOME\.agents" pull
```

## 链接到 Claude Code / Codex（ln -s）

> 目标：把本仓库作为「单一来源」，通过符号链接同步到 `~/.claude/` 和 `~/.codex/`。以后只需 `git -C ~/.agents pull`，两边配置会自动更新。

### 映射关系（本仓库 → 配置目录）

| 本仓库 | Claude Code | Codex | 说明 |
|---|---|---|---|
| `AGENTS.md` | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | 全局系统提示词/规则 |
| `skills/<skill>/` | `~/.claude/skills/<skill>/` | `~/.codex/skills/<skill>/` | Skills（每个目录一个技能） |
| `commands/oc/` | `~/.claude/commands/oc/` | `~/.codex/prompts/*.md` | Claude 读 `commands/`；Codex 读 `prompts/` |

### Linux/macOS（bash/zsh）

```bash
AGENTS_DIR="$HOME/.agents"

# Claude Code
mkdir -p "$HOME/.claude/commands" "$HOME/.claude/skills"
ln -s "$AGENTS_DIR/AGENTS.md" "$HOME/.claude/CLAUDE.md"
ln -s "$AGENTS_DIR/commands/oc" "$HOME/.claude/commands/oc"
for d in "$AGENTS_DIR/skills/"*; do
  [ -d "$d" ] && ln -s "$d" "$HOME/.claude/skills/"
done

# Codex
mkdir -p "$HOME/.codex/skills" "$HOME/.codex/prompts"
ln -s "$AGENTS_DIR/AGENTS.md" "$HOME/.codex/AGENTS.md"
for d in "$AGENTS_DIR/skills/"*; do
  [ -d "$d" ] && ln -s "$d" "$HOME/.codex/skills/"
done
ln -s "$AGENTS_DIR/commands/oc/init.md" "$HOME/.codex/prompts/init.md"
ln -s "$AGENTS_DIR/commands/oc/research.md" "$HOME/.codex/prompts/research.md"
ln -s "$AGENTS_DIR/commands/oc/plan.md" "$HOME/.codex/prompts/plan.md"
ln -s "$AGENTS_DIR/commands/oc/implementation.md" "$HOME/.codex/prompts/implementation.md"
ln -s "$AGENTS_DIR/commands/oc/diagnose.md" "$HOME/.codex/prompts/diagnose.md"
```

> 提示：
> - 如果提示 `File exists`，说明目标路径已存在：先备份/删除原文件（例如 `mv ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak`），再重新执行 `ln -s`。
> - 不建议把整个 `skills/` 目录直接链接成 `~/.codex/skills`，否则可能遮住 Codex 自带的 `~/.codex/skills/.system/`。

### 验证（可选）

```bash
ls -la "$HOME/.claude/CLAUDE.md" "$HOME/.claude/commands/oc"
ls -la "$HOME/.codex/AGENTS.md" "$HOME/.codex/prompts/"{init,research,plan,implementation,diagnose}.md
```
