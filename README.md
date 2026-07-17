# AbelWorkflow

AbelWorkflow 为 Codex、Claude Code 和 Pi 部署统一的 Skills、工作流命令、Agent 配置与扩展。

## 环境要求

- Node.js 22 或更高版本
- npm 10 或兼容版本
- Linux、macOS 或原生 Windows

## 正式工作流命令

| 命令 | 用途 |
| --- | --- |
| `/abel-init` | 初始化 OpenSpec 环境并验证工具链 |
| `/abel-research` | 研究需求并生成约束，不实施代码 |
| `/abel-plan` | 将已确认变更细化为可执行计划 |
| `/abel-implement` | 按强制 TDD 实施已批准变更 |
| `/abel-diagnose` | 进行根因分析、回归测试和批量修复 |

工作流：

```text
/abel-init → /abel-research → /abel-plan → /abel-implement(TDD)
                                      ↘ /abel-diagnose (bug fix)
```

OpenSpec 命令保持独立：`/opsx:new`、`/opsx:ff`、`/opsx:archive`、`openspec view`、`openspec status`。

## 安装与更新

### npx

```bash
npx abelworkflow
npx abelworkflow install
npx abelworkflow@latest
```

无 TTY 的环境必须显式运行 `npx abelworkflow install`。安装器将工作流部署到 `~/.agents`，并维护 Claude、Codex 与 Pi 的链接。

### 源码安装

源码目录和部署目录必须分离，不能相同或互相嵌套。推荐流程：

```bash
git clone https://github.com/abelxiaoxing/AbelWorkflow ~/src/AbelWorkflow
cd ~/src/AbelWorkflow
npm ci
npm ci --prefix skills/dev-browser
npm run build
node bin/abelworkflow.mjs install --agents-dir ~/.agents
```

Windows PowerShell 可将源码克隆到 `$HOME\src\AbelWorkflow`，然后运行相同的 npm 命令，并使用：

```powershell
node .\bin\abelworkflow.mjs install --agents-dir "$HOME\.agents"
```

不要把源码仓库直接克隆到 `~/.agents`。已有这种布局时，先按 [1.0 迁移指南](https://github.com/abelxiaoxing/AbelWorkflow/blob/master/docs/migration-1.0.md) 人工建立独立源码目录；安装器不会猜测性移动或删除用户数据。

## 配置行为

- Claude 默认使用 `standard` 权限档，不预授权 Bash、Write 或 Edit；只有用户明确选择 `trusted` 才增加宽权限。已有 permissions、deny、hooks 和 timeout 保持不变。
- Codex 只更新 AbelWorkflow 管理的认证字段，保留未知字段、其他 Provider 和用户 token。
- Pi 0.80.0 及以上版本将 GPT API Key 保存在 `~/.pi/agent/auth.json`；`models.json` 只保留模型定义。旧 models-only key 会按先写 auth、后删除旧 key 的顺序迁移。
- Grok 默认模型统一为 `grok-4.20-auto`。
- Context7 使用显式 CommonJS 入口 `context7-api.cjs`。
- dev-browser 发布运行时使用 Node ESM 编译产物，入口为 `node dist/scripts/start.js`，不依赖 Bun 或运行时 `npx tsx`。
- skill 密钥写入 `~/.agents/skills/<skill>/.env`；这些文件属于私密配置。

`.skill-lock.json` 完全属于用户：安装器不读取、不修改、不备份、不删除，也不会把它放入发布包。

## 部署映射

| 托管内容 | Claude Code | Codex | Pi |
| --- | --- | --- | --- |
| 工作流 AGENTS 模板 | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.pi/agent/AGENTS.md` |
| `skills/<skill>/` | `~/.claude/skills/<skill>/` | `~/.codex/skills/<skill>/` | `~/.pi/agent/skills/<skill>/` |
| `abel-*.md` 命令 | `~/.claude/commands/` | `~/.codex/prompts/` | `~/.pi/agent/prompts/` |
| `extensions/*` | — | — | `~/.pi/agent/extensions/` |

## 自签名 HTTPS 中转

优先取得中转的 CA PEM，并在启动客户端前配置：

```bash
export NODE_EXTRA_CA_CERTS=/absolute/path/relay-ca.pem
export CODEX_CA_CERTIFICATE=/absolute/path/relay-ca.pem
```

不要全局设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。证书过期或主机名不匹配时应重新签发证书。

## 升级

从 0.x 升级前请阅读 [AbelWorkflow 1.0 迁移指南](https://github.com/abelxiaoxing/AbelWorkflow/blob/master/docs/migration-1.0.md)。指南涵盖源码/部署目录拆分、metadata v2、Provider 配置、用户状态、dev-browser 和回滚。
