# AbelWorkflow 1.0 迁移指南

本指南适用于从 0.x 升级到 AbelWorkflow 1.0。升级要求 Node.js 22 或更高版本，并统一使用 npm。

## 1. 分离源码与部署目录

1. 将源码克隆到独立目录，例如 `~/src/AbelWorkflow`。
2. 保留 `~/.agents` 作为部署目录。
3. 在源码目录运行：

```bash
npm ci
npm ci --prefix skills/dev-browser
npm run build
node bin/abelworkflow.mjs install --agents-dir ~/.agents
```

如果旧仓库直接位于 `~/.agents`，请先人工建立新的源码目录。安装器会在写入前拒绝源码与部署目录相同或嵌套的布局，即使使用 `--force` 也不会绕过；它不会自动移动或删除未知用户文件。

## 2. metadata v2 与托管所有权

首次升级只迁移 v1 metadata 的 `features`、`managedClaudePermissions` 和 `linkedTargets`，再写入 metadata v2。`managedChildren` 不迁移为 asset 所有权，也不会触发现场认领。v2 使用内容 hash 记录精确托管路径：

- 未修改的托管文件可更新或删除。
- 与当前 source 内容完全相同的未托管文件可接管并记录 hash；其余已有路径在普通安装中保留并报告冲突。
- `--force` 仅备份并替换当前 manifest 精确声明的路径。
- v1 `managedChildren` 指向但当前 manifest 已移除的 stale 路径始终保留，即使使用 `--force` 也不删除。
- 未知文件、未知目录、用户权限、私密 `.env` 和 `.skill-lock.json` 不受 `--force` 影响。
- metadata 仅在全部安装步骤成功后写入。

`.skill-lock.json` 完全属于用户；1.0 不读取、不合并、不创建、不备份、不删除，也不将其发布。

## 3. Provider 配置

### Pi

auth-only 自定义 Provider 要求 Pi 0.80.0 或更高版本。升级时，安装器先把旧 `models.json` 中的 GPT key 安全写入 `auth.json`，成功后才从 `models.json` 删除 key，因此中间失败不会丢失凭据。其他 Provider 和未知字段保持不变。

### Claude

全新非交互配置默认使用 `standard`，不会预授权 Bash、Write 或 Edit。只有用户明确选择 `trusted` 才增加宽权限。切换档位时仅移除 metadata 记录为 AbelWorkflow 添加的权限；现有 permissions、deny、hooks 和 timeout 保持不变。

### Codex

`auth.json` 只更新当前托管 key，并保留未知认证字段、其他 Provider 和用户 token；`config.toml` 保留注释和未知 section。

## 4. Skills 与运行时

- Context7 入口由 `context7-api.js` 改为 `context7-api.cjs`，避免根 `type=module` 改变其 CommonJS 语义。
- Grok 默认模型统一为 `grok-4.20-auto`。
- 移除 `confidence-check` 与 `sequential-think` 两个 skills；工作流不再包含置信度打分门禁，改为在变更前显式列出假设与未知项。
- Prompt Enhancer 1.0 只接受显式 `PE_API_URL`、`PE_API_KEY`、`PE_MODEL` 或 CLI `--url`、`--api-key`、`--model`。它不再隐式读取全局 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`，并移除 Anthropic fallback；安装器只更新或清除 `PE_*`，保留用户的 `OPENAI_API_KEY` 和 `ANTHROPIC_API_KEY`。
- dev-browser 改为 npm-only、Node ESM 编译运行时，正式入口是 `node dist/scripts/start.js`；不再使用 Bun lock 或运行时 `npx tsx`。
- 已发布 dev-browser 缺少 runtime dependencies 时，在其目录运行 `npm ci --omit=dev`。

## 5. 私密文件与备份

POSIX 上的私密配置、临时文件和新备份使用 `0600`。新备份格式为 `<filename>.abelworkflow.bak.<timestamp>`，每个目标最多保留最近 3 份；历史 `.bak.*` 文件不会被删除。内容未变化或仅修复权限时不创建备份。

## 6. 验证

升级后重新运行安装，确认第二次安装报告零变化，并检查：

- `.skill-lock.json` 字节未变化。
- Pi `models.json` 不再包含 GPT API Key，`auth.json` 仍可用。
- Claude `standard` 未新增 Bash、Write 或 Edit。
- dev-browser 由编译后的 Node 入口启动。
- 源码目录的 `git status --short` 在安装前后相同。

## 7. 回滚

停止使用新版本后，可从对应的 `.abelworkflow.bak.*` 恢复 Provider 配置。不要删除 metadata 或未知用户文件；如需回退 npm 包，安装明确的旧版本并先保留 `~/.agents` 与 Provider 配置副本。Pi 回滚时先确认 `auth.json` 中的 key 仍可用，再考虑恢复旧 `models.json`。
