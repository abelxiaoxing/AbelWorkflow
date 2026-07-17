# AbelWorkflow 1.0 一步到位重构实施方案

## 文档状态

- 状态：设计已确认，等待实施
- 目标版本：1.0.0
- 建议 OpenSpec change：repository-hardening-refactor
- 实施方式：一个 OpenSpec change、一个 PR、一个最终版本，内部按可回滚提交推进
- 适用范围：安装器、Provider 配置、skills、dev-browser、测试、发布配置和文档
- 权威性：后续新上下文应以本文件作为本次重构的主要实施依据

## 新上下文使用规则

新上下文开始实施前必须：

1. 完整读取本文件、仓库 AGENTS.md 和当前 git status。
2. 检查代码是否已部分实施，从第一个未完成阶段继续，禁止从头重复修改。
3. 使用 rg、rg --files、git grep 和直接文件读取验证当前实现。
4. 实施前执行 confidence-check，置信度必须达到 90%。
5. 严格使用 TDD：先添加失败测试，再写最小实现，最后重构。
6. 所有修改通过 unified diff patch 应用。
7. 每个提交单元完成后运行对应测试，保持工作树中无无关修改。
8. 不引入插件框架、依赖注入容器、通用配置注册中心或新旧双实现。
9. 不自动归档 OpenSpec change；完成全部发布门槛后再由用户决定。

## 一、目标

本次重构一次性解决以下问题：

1. lib/cli.mjs 超过 3000 行，职责混杂。
2. 私密配置默认可能以 0644 创建，备份权限不统一。
3. Pi API Key 同时写入 auth.json 和 models.json。
4. Codex auth 更新会丢弃未知认证字段。
5. Claude 配置默认注入宽权限和 API_TIMEOUT_MS=1000000。
6. dev-browser standalone 与 extension 的页面 API 语义不一致。
7. extension 创建 tab 使用固定 200ms 等待，存在竞态。
8. dev-browser 依赖 lsof、PowerShell、taskkill 和 SIGKILL。
9. 源码克隆目录会被原地渲染，影响 git pull 和功能切换。
10. --force 已公开但没有实际行为。
11. .skill-lock.json 用户状态会被发布包覆盖。
12. 重复安装会产生内容相同的备份和 metadata 变化。
13. Context7 CommonJS 文件受根 type=module 影响而无法运行。
14. Sequential Think 声明的配置目录变量未实现。
15. Grok 默认模型在安装器和运行时之间不一致。
16. 根测试入口漏掉 Python、dev-browser、类型检查和发布检查。
17. dev-browser 同时维护已经漂移的 npm/Bun lock。
18. OpenSpec 目录和根 package-lock 被 .gitignore 忽略。
19. README、commands 和模板仍混用旧 /oc:* 命令。
20. confidence.ts 无调用方且核心逻辑仍是 placeholder。

## 二、明确不做的事情

- 不重写现有产品功能。
- 不改变 Claude、Codex、Pi 的外部目录约定。
- 不增加通用 Provider 插件系统。
- 不为了消除少量重复而让独立 skills 共享运行时文件。
- 不自动迁移或删除用户未知文件。
- 不保留旧 CLI 和新 CLI 两套长期实现。
- 不使用 feature flag 维持两套安装器。
- 不把仓库外 Chrome extension 的源码纳入本次重构。

## 三、架构原则

所有文件必须被归入以下四类之一：

1. 不可变源码：仓库文件和模板，安装过程不得修改。
2. AbelWorkflow 托管产物：由 manifest 和安装 metadata 记录所有权。
3. 用户状态：未知 skills、commands、.skill-lock.json 和用户自定义配置。
4. 私密凭据：API Key、Token、包含认证头的配置及其备份。

固定依赖方向：

~~~text
bin → cli → installer / providers / tools
                  ↓
          config store + 纯格式模块
~~~

约束：

- cli 只负责编排，不实现文件、Provider 或链接细节。
- installer 不读取交互输入。
- providers 不直接调用 installer 内部函数。
- config/store.mjs 是唯一配置文件写入边界。
- jsonc、dotenv、toml 模块只提供纯解析和转换函数。
- 不使用 class hierarchy；优先使用普通函数和小型数据接口。

## 四、目标目录结构

~~~text
bin/
  abelworkflow.mjs

lib/
  paths.mjs

  cli/
    main.mjs
    args.mjs
    prompts.mjs

  installer/
    install.mjs
    assets.mjs
    render.mjs
    links.mjs
    state.mjs

  config/
    store.mjs
    jsonc.mjs
    dotenv.mjs
    toml.mjs

  providers/
    claude.mjs
    codex.mjs
    pi.mjs
    skills.mjs

  tools/
    cli-installer.mjs

  templates/
    workflow/
      AGENTS.md
      commands/
        abel-init.md
        abel-research.md
        abel-plan.md
        abel-implement.md
        abel-diagnose.md
      .gitignore
    codex/
      config-base.toml
      agents/

skills/
  dev-browser/
    src/
      page-api.ts
      standalone.ts
      relay.ts
      target-registry.ts
      client.ts
      runtime.ts
      startup.ts
    scripts/
      start.ts
    dist/
    package.json
    package-lock.json
    tsconfig.json
    vitest.config.ts
~~~

最终删除：

- lib/cli.mjs
- lib/cli/logic.mjs
- skills/confidence-check/confidence.ts
- skills/dev-browser/bun.lock
- skills/context7-auto-research/context7-api.js
- 根 .skill-lock.json
- 重复或失效的 .npmignore 规则

Context7 替代文件为：

- skills/context7-auto-research/context7-api.cjs

## 五、核心接口

~~~text
main(argv, runtime): Promise<number>

createPaths({
  homeDir,
  packageRoot,
  agentsDir
}): Paths

installWorkflow({
  paths,
  relinkOnly,
  force,
  featureOverrides
}): Promise<InstallReport>

renderWorkflowTemplate(
  content,
  featureState
): string

writeText(path, content, {
  sensitive,
  backupLimit
}): Promise<WriteResult>

writeJson(path, value, options): Promise<WriteResult>

updateLockedJson(
  path,
  updater,
  options
): Promise<WriteResult>
~~~

main 不直接调用 process.exit。bin 入口根据返回值设置 process.exitCode。

WriteResult 至少包含：

~~~text
created | updated | unchanged | permission-repaired
~~~

InstallReport 至少包含：

~~~text
created
updated
unchanged
preserved
conflicts
removed
linked
~~~

## 六、配置安全与备份

config/store.mjs 必须满足：

1. 写入前比较最终字节。
2. 内容相同直接返回 unchanged。
3. 内容相同不创建备份、不写 metadata、不改变 mtime。
4. 使用目标同目录临时文件。
5. 临时文件写完后使用 rename 替换目标。
6. 写入失败时原文件必须保持可解析。
7. 失败时清理临时文件。
8. POSIX 私密文件、临时文件和备份强制 0600。
9. 已存在的 0644 私密文件在下一次读取/写入时收紧为 0600。
10. 权限修复本身不创建备份。
11. 每个目标只保留最近 3 个 AbelWorkflow 新格式备份。
12. 不删除历史旧格式 .bak.* 文件。
13. 只有 ENOENT 可以返回默认值。
14. JSON/JSONC 语法错误必须包含路径并终止写入。

建议新备份格式：

~~~text
<filename>.abelworkflow.bak.<timestamp>
~~~

私密目标：

- ~/.claude/settings.json
- ~/.claude.json
- ~/.codex/auth.json
- ~/.pi/agent/auth.json
- ~/.pi/agent/models.json
- ~/.agents/skills/*/.env

Windows 验证内容完整性和替换行为，不声明 POSIX mode 保证。

## 七、安装器所有权和 metadata v2

metadata v2 至少记录：

~~~json
{
  "schemaVersion": 2,
  "packageVersion": "1.0.0",
  "features": {},
  "managedFiles": {
    "relative/path": "sha256"
  },
  "managedClaudePermissions": [],
  "linkedTargets": {}
}
~~~

不得加入每次运行都会变化的时间字段。首次 installedAt 如需保留，只能创建一次。

同步规则：

1. 当前文件 hash 等于 metadata hash：允许正常更新。
2. 当前文件 hash 不等于 metadata hash：视为用户修改。
3. 普通安装遇到用户修改时保留并报告冲突。
4. `--force` 仅备份并替换当前 manifest 精确声明的路径。
5. --force 永远不能触碰 .env、.skill-lock.json、未知 sibling 和用户权限。
6. 未知文件和未知目录始终保留。
7. 已从新版本移除的旧托管文件：
   - 未被用户修改时可删除。
   - 被用户修改时保留并报告。
   - --force 时先备份再删除。
8. 与当前 source 内容完全相同的未托管文件可接管并记录 hash；其余已有路径在普通安装中保留并报告冲突。

v1 metadata 迁移：

- 只迁移 `features`、`managedClaudePermissions` 和 `linkedTargets`。
- `managedChildren` 不迁移为 asset 所有权，也不触发现场认领。
- v1 `managedChildren` 指向但当前 manifest 已移除的 stale 路径始终保留，即使使用 `--force` 也不删除。
- 当前 manifest 的其他已有路径遵循上面的 source-equal 接管、冲突与精确 force 规则。
- metadata 必须在全部安装步骤成功后最后写入。
- 失败安装不能写入完成状态。

## 八、源码与部署目录

createPaths 必须拒绝：

- packageRoot 与 agentsDir 相同。
- agentsDir 位于 packageRoot 内部。
- packageRoot 位于 agentsDir 内部。

--force 不能绕过该限制。

模板规则：

- 根 AGENTS.md 是仓库开发规则，不含部署占位符。
- 部署 AGENTS.md 位于 lib/templates/workflow。
- workflow 模板在内存中渲染。
- 渲染结果包含未解析占位符时立即失败。
- 源码安装前后 git status 必须保持不变。

推荐源码安装流程：

~~~text
git clone <repository> ~/src/AbelWorkflow
cd ~/src/AbelWorkflow
npm ci
npm ci --prefix skills/dev-browser
npm run build
node bin/abelworkflow.mjs install --agents-dir ~/.agents
~~~

旧 ~/.agents 源码克隆不做自动搬迁。安装器应在写入前失败，并输出人工迁移说明，避免猜测性移动或删除用户数据。

## 九、.skill-lock.json 策略

.skill-lock.json 完全属于用户：

- 不纳入 npm files。
- 不纳入 managedEntries。
- 不读取。
- 不合并。
- 不创建。
- 不备份。
- 不删除。

已有 .skill-lock.json 在安装前后必须字节完全一致。

如果仓库需要记录第三方 skill 来源，使用项目专用、不会部署到用户目录的来源文档或 manifest，不能复用用户 lock。

## 十、Provider 配置

### Pi

已核对的上游凭据顺序：

~~~text
CLI → auth.json → environment → models.json
~~~

写入顺序：

1. 读取并解析 auth、models、settings。
2. 在内存构建并验证三份最终配置。
3. 先安全写入 auth.json。
4. auth 写入成功后删除 models.providers.gpt.apiKey。
5. 写入 models.json。
6. 最后写入 settings.json。

要求：

- 读取继续兼容 models-only 旧 key。
- auth 优先于 models。
- 迁移保留其他 provider 和未知字段。
- 任何中间失败都不能造成 key 丢失。
- 支持 auth-only custom provider 的最低 Pi 版本为 0.80.0。
- 检测到更旧版本时终止配置并提示升级，不继续复制明文 key。

### Codex

- auth.json 只更新当前托管 key。
- 删除 metadata 明确记录的旧托管 key。
- 保留未知字段、其他 provider 和用户 token。
- config.toml 继续使用定向字段更新，保留注释和未知 section。
- subagent 模板部署仅覆盖 AbelWorkflow 明确拥有的文件。

### Claude

只提供两个权限配置档：

1. standard：默认，不新增 Bash、Write、Edit 等宽权限。
2. trusted：用户明确选择后才增加当前宽权限集合。

要求：

- 全新非交互安装使用 standard。
- API 配置只更新 AbelWorkflow 拥有的 env 字段。
- 不再默认注入 API_TIMEOUT_MS=1000000。
- 已有 permissions、deny、hooks、timeout 原样保留。
- metadata 记录 AbelWorkflow 实际增加的权限。
- 配置档切换只移除 metadata 中记录的权限。
- --force 不得改变权限配置档。
- augment 功能只增删自身管理的 MCP 权限。

### Grok、Context7、Prompt Enhancer

- 新增 skills/grok-search/defaults.json。
- Python runtime 和安装器共同读取 grok-4.20-auto。
- .env.example 必须通过 contract test 与 defaults.json 保持一致。
- Context7 使用显式 .cjs，更新全部 SKILL 命令。
- Prompt Enhancer 1.0 只接受显式 `PE_API_URL`、`PE_API_KEY`、`PE_MODEL` 或 CLI `--url`、`--api-key`、`--model`；不再隐式读取全局 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`，并移除 Anthropic fallback。
- Prompt Enhancer 的 `.env` 写入走 `config/store.mjs`，只更新或清除 `PE_*`，保留用户的 `OPENAI_API_KEY` 和 `ANTHROPIC_API_KEY`。

## 十一、Sequential Think 和 confidence-check

Sequential Think 配置目录优先级：

~~~text
SEQUENTIAL_THINK_CONFIG_DIR
→ XDG_CONFIG_HOME/sequential-think
→ ~/.config/sequential-think
~~~

要求：

- 显式配置目录可写时不得访问默认 HOME 目录。
- history 写入使用原子替换。
- 无法创建目录时输出明确路径错误。

confidence-check：

- 删除无人调用的 confidence.ts。
- 保留 SKILL.md 作为实际工作流规范。
- 不新增另一个形式化评分引擎。

两份 skill-local _dotenv.py 保持独立，不做共享模块抽取。

## 十二、dev-browser

### 统一 HTTP 框架

standalone 和 extension 统一使用现有 Hono：

- 删除 Express。
- 删除 @types/express。
- 保留 @hono/node-server 和 @hono/node-ws。

只增加一个最小接口：

~~~ts
interface PageBackend {
  list(): Promise<PageDescriptor[]>;
  getOrCreate(
    name: string,
    viewport?: Viewport
  ): Promise<PageDescriptor>;
  close(name: string): Promise<boolean>;
}
~~~

page-api.ts 统一：

- name 校验。
- name 长度限制。
- viewport 校验。
- POST /pages 响应。
- GET /pages 响应。
- DELETE /pages/:name 状态码。
- 错误 JSON 结构。

统一协议：

- GET / 返回 mode: standalone 或 extension。
- POST /pages 成功返回精确 targetId。
- 重复 name 返回同一物理 target。
- DELETE 成功返回 200 和 success:true。
- DELETE 不存在返回 404。
- extension DELETE 必须发送 Target.closeTarget。
- client 必须按 targetId 精确获取页面。
- 删除按 URL 或第一个页面兜底。

### target registry

target-registry.ts 只负责：

- targetId ↔ sessionId。
- name ↔ target。
- attach waiter。
- detach waiter。
- extension 断线清理。

等待规则：

1. 先查 registry。
2. 未找到时注册指定 targetId waiter。
3. attach 到达时只解析对应 waiter。
4. 超时清理 waiter 并返回明确错误。
5. extension 断开时拒绝所有 pending waiter。
6. 不使用固定 sleep。

extension close：

1. 查找 name 对应 target。
2. 发送 Target.closeTarget。
3. 等待对应 detach。
4. 成功后删除映射。
5. 超时返回 504，不能返回假成功。

### 端口冲突

删除：

- lsof
- ps
- PowerShell PID 查询
- taskkill
- SIGKILL 自动恢复

新行为：

- 使用 Node net 检测端口。
- HTTP 服务不可达但 CDP 端口占用时安全失败。
- 提示用户关闭旧浏览器或使用 --cdp-port。
- 绝不杀死无法可靠证明所有权的进程。

### 构建与运行

- Node 最低版本：22。
- TypeScript target：ES2022。
- module/moduleResolution 使用适合 Node ESM 的明确配置。
- 使用 tsc 生成 dist。
- 运行入口：node dist/scripts/start.js。
- 不再通过 npx tsx 启动已发布 skill。
- 用户脚本通过 package exports 导入编译后的 client。
- 缺少 runtime dependencies 时使用 npm ci --omit=dev。
- Chromium 安装使用已经锁定的本地 Playwright。
- 发布包不安装 Vitest、TypeScript 和类型包等开发依赖。

## 十三、依赖和发布策略

- 仓库自身和 dev-browser 统一使用 npm。
- 外部 Claude/Codex/Pi CLI 安装仍可保留现有包管理器探测。
- 根目录保留一个 package-lock.json。
- skills/dev-browser 保留一个 package-lock.json。
- 删除 bun.lock。
- package.json 增加 packageManager。
- 根和 dev-browser engines.node 统一为 >=22。
- dev-browser 显式声明 @types/node 22。
- 删除 @rollup/rollup-linux-x64-gnu。
- 根 npm package 的 prepack 必须先构建 dev-browser dist。

发布内容必须包含：

- bin
- lib
- README
- skills 的运行时文件
- extensions
- dev-browser dist、package.json、package-lock.json

发布内容不得包含：

- .skill-lock.json
- dev-browser bun.lock
- dev-browser profiles
- dev-browser tmp
- dev-browser node_modules
- dev-browser 测试文件
- 用户 .env
- Python __pycache__
- 无用构建缓存

使用一个根 .npmignore 或等价明确的发布清单，删除重复嵌套规则。

## 十四、命令、默认值和文档

唯一正式工作流命令：

~~~text
/abel-init
/abel-research
/abel-plan
/abel-implement
/abel-diagnose
~~~

OpenSpec 命令继续为：

~~~text
/opsx:new
/opsx:ff
/opsx:archive
openspec view
openspec status
~~~

必须清理：

- README 中的 /oc:*。
- command 输出标题中的 /oc:*。
- Codex template 中的 /oc:* 示例。
- 过时的 commands/oc 目录描述。
- 不存在或未实现的 OpenCode 安装能力声明。
- 过时的 modern-ui-proposal 实施状态。

不从代码生成整个 README。使用 contract tests 验证：

- command frontmatter 名称全部出现在 README。
- README 不包含旧 /oc:*。
- workflow template 不含未解析占位符。
- Grok 默认值一致。
- Codex agent 模型与基准模板一致。

## 十五、统一测试入口

根 package.json 提供：

~~~text
test:node
test:python
test:dev-browser
typecheck
build
check:docs
check:package
check
~~~

npm run check 必须聚合：

1. node --test 自动发现全部 Node 测试。
2. Python unittest discovery。
3. dev-browser Vitest。
4. dev-browser tsc --noEmit。
5. Context7 根仓库 smoke test。
6. Context7 独立复制目录 smoke test。
7. 文档和默认值 contract tests。
8. npm pack --dry-run 发布内容测试。

现有 test/cli-contracts.test.mjs 应按职责拆分：

~~~text
test/
  cli-args.test.mjs
  installer-assets.test.mjs
  installer-links.test.mjs
  config-store.test.mjs
  config-formats.test.mjs
  provider-claude.test.mjs
  provider-codex.test.mjs
  provider-pi.test.mjs
  workflow-render.test.mjs
  runtime-doc-contracts.test.mjs
  package-contents.test.mjs
  test_prompt_enhancer.py
~~~

## 十六、CI 和平台矩阵

最低 CI：

| 平台 | Node | 必须执行 |
| --- | --- | --- |
| Ubuntu | 22 | npm ci、build、check、pack |
| Windows | 22 | npm ci、build、check |
| Ubuntu | 24 | npm ci、build、check |

dev-browser 自动验证：

| 平台 | standalone | extension |
| --- | --- | --- |
| Ubuntu | 真实 headless Chromium | fake extension WebSocket |
| Windows | 真实 headless Chromium | fake extension WebSocket |

standalone 场景：

- 启动并输出 Ready。
- 创建两个相同 URL、不同 name 的页面。
- 精确 targetId。
- 重复 name 复用页面。
- list。
- 真实 close。
- 二次 close 返回 404。
- 正常退出。
- 端口冲突不杀进程。

extension 场景：

- 未连接返回 503。
- attach 事件先于 create 响应。
- attach 延迟 250ms 和 1s。
- attach 超时。
- close/detach。
- extension 断线清理 pending waiter。
- 相同 URL 页面按 targetId 区分。

仓库外正式 Chrome extension 必须在 Ubuntu 和原生 Windows 各完成一次真实 smoke，作为发布门槛。该手工门槛不能由 fake extension 代替。

## 十七、TDD 实施阶段

### 阶段 0：建立 OpenSpec 和质量基线

目标：

- 创建 repository-hardening-refactor change。
- 修复 .gitignore。
- 提交根 package-lock。
- 增加统一 check 和真实 Node CI。
- 将旧 dev-browser-cross-platform 标记为需要重新验证，不能直接归档。

测试先行：

- 新 OpenSpec change 不被忽略。
- 两个 package-lock 可被 Git 跟踪。
- 根 check 确实运行 Python 和 dev-browser。

完成门槛：

- 当前功能测试全绿。
- CI 使用真实 Node。

### 阶段 1：机械拆分 CLI

目标：

- 添加 characterization tests。
- 按目标目录移动函数。
- 保持用户行为不变。
- 最后切换 bin 到 cli/main.mjs。
- 删除旧 cli 文件。

测试先行：

- 参数解析。
- 菜单描述。
- Provider 配置纯函数。
- 安装结果。
- 链接迁移。

完成门槛：

- 无循环依赖。
- 最终树没有旧双实现。
- 全部基线测试通过。

### 阶段 2：安全写入与安装器所有权

目标：

- 实现 config/store.mjs。
- metadata v2。
- content-aware backup。
- source/deploy 隔离。
- 实现真实 --force。
- 移除 .skill-lock 管理。

测试先行：

- 0600。
- 原子失败保持原文件。
- 无效 JSON 不覆盖。
- 相同内容无写入。
- 第 4 次变化只保留 3 份备份。
- v1 → v2。
- 用户修改冲突。
- --force 精确覆盖。
- source 目录不变。

完成门槛：

- 两次相同安装零变化。
- git status 干净。

### 阶段 3：Provider 和 skill 配置

目标：

- Pi auth-only。
- Codex 保留未知认证字段。
- Claude standard/trusted。
- 私密 .env。
- Grok defaults。
- Context7 .cjs。
- Sequential Think 配置目录。
- 删除 confidence.ts。

测试先行：

- Pi 迁移失败不丢 key。
- Codex 未知字段保留。
- Claude 自定义权限保留。
- standard 不注入宽权限。
- trusted 显式注入。
- Context7 两种包作用域执行成功。
- Sequential Think 只写指定目录。

完成门槛：

- models.json 不含 gpt key。
- 所有私密文件权限正确。
- 文档默认值一致。

### 阶段 4：dev-browser 统一

目标：

- Hono 统一。
- PageBackend。
- target registry。
- 删除固定 sleep。
- 真实 close。
- 删除平台进程命令。
- tsc dist。
- npm-only。

测试先行：

- 两种 backend 共享同一契约测试。
- attach 前后顺序。
- detach 超时。
- extension 断线。
- 精确 targetId。
- 端口冲突不杀进程。

完成门槛：

- Linux/Windows 自动矩阵全绿。
- 发布 runtime 不依赖 tsx。

### 阶段 5：文档、发布与迁移

目标：

- 清理 /oc:*。
- 更新 README。
- 增加 1.0 迁移文档。
- 清理 npm 发布内容。
- 更新 OpenSpec tasks。

测试先行：

- docs contract。
- package contents contract。
- npm pack smoke。

完成门槛：

- npm run check 全绿。
- npm pack 内容正确。
- git diff --check 无错误。
- git status 无生成污染。

### 阶段 6：发布验证

目标：

- 生成 1.0.0-rc.1。
- Ubuntu/Windows 正式 extension smoke。
- 验证源码安装和 npx 安装。
- 用户确认后发布 1.0.0。

完成门槛：

- 所有自动和手工门槛通过。
- 不存在未处理高风险项。
- 用户确认归档 OpenSpec change。

## 十八、建议提交单元

~~~text
chore(repo): establish reproducible checks
refactor(cli): split installer domains
fix(installer): enforce ownership and immutable templates
fix(config): centralize secure provider writes
fix(skills): make standalone runtimes deterministic
refactor(dev-browser): unify page protocol and runtime
docs(release): align contracts for 1.0
~~~

每个提交必须：

- 对应一个明确阶段。
- TDD 红绿重构完整。
- npm run check 或阶段子集全绿。
- 不包含无关格式化。
- 可通过 git revert 独立回滚。

## 十九、回滚策略

- metadata v2 只新增字段，旧版本读取时忽略未知字段。
- metadata 最后写，失败不宣称安装完成。
- Provider 写入前创建受限权限备份。
- Pi 先写 auth，再删除 models key。
- 新备份清理只处理新前缀，不触碰历史备份。
- 源码克隆不自动移动或删除。
- dev-browser client/server 协议在同一提交发布。
- 新 client 对旧 server 的 mode 缺失按 legacy standalone 处理。
- 每个绿色提交都是独立回滚点。

## 二十、最终验收清单

- [x] lib/cli.mjs 和 lib/cli/logic.mjs 已删除。
- [x] 最终依赖方向符合本文件定义。
- [x] 根和 dev-browser 各只有一个 npm lock。
- [x] bun.lock 已删除。
- [x] npm ci 不修改 lock。
- [x] npm run check 全绿。
- [x] 私密文件和备份在 POSIX 为 0600。
- [x] 无效 JSON/JSONC 不会被覆盖。
- [x] 相同安装不写文件、不备份、不改 metadata。
- [x] 每个目标最多 3 份新备份。
- [x] .skill-lock.json 不被发布或修改。
- [x] source/deploy 相同或嵌套时安装前失败。
- [ ] 源码安装前后 git status 干净。
- [x] augment feature 可双向切换。
- [x] --force 只覆盖明确托管路径。
- [x] Pi models.json 不包含 gpt API Key。
- [x] Codex 未知认证字段保留。
- [x] Claude standard 不预授权 Bash/Write/Edit。
- [x] Claude trusted 必须显式选择。
- [x] Context7 在两种包作用域中可运行。
- [x] Sequential Think 使用指定配置目录。
- [x] confidence.ts 已删除。
- [x] Grok 默认模型统一。
- [x] README 和模板不存在旧 /oc:*。
- [x] OpenSpec 新文件不被忽略。
- [x] dev-browser 两种模式共享同一页面契约。
- [x] extension 不再使用固定 sleep。
- [x] extension close 真正关闭 tab。
- [x] client 按 targetId 精确匹配。
- [x] dev-browser 不调用 lsof、ps、PowerShell PID 查询、taskkill 或 SIGKILL。
- [x] dev-browser 发布 runtime 不依赖 npx tsx。
- [ ] Ubuntu/Windows standalone 自动测试通过。
- [ ] Ubuntu/Windows fake extension 测试通过。
- [ ] Ubuntu/Windows 正式 extension smoke 通过。
- [x] npm pack 不包含用户状态、profile、tmp、测试源码或缓存。
- [x] 1.0 迁移文档完成。
- [ ] 用户确认后才归档 OpenSpec change。

## 二十一、验证命令

实施完成后至少运行：

~~~text
npm ci
npm ci --prefix skills/dev-browser
npm run build
npm run check
npm pack --dry-run --json
git diff --check
git status --short
~~~

OpenSpec：

~~~text
openspec status --change repository-hardening-refactor
openspec validate repository-hardening-refactor --strict
~~~

## 二十二、官方依据

实施时应优先复核以下上游资料：

- Node.js packages 文档：package.json type 作用域；.cjs 始终按 CommonJS 解释。
- Node.js fs 文档：新文件默认 mode 为 0666，再受 umask 影响；mode 仅在创建时生效。
- npm ci 文档：要求 package.json 与 package-lock.json 同步，且不会修改 lock。
- Pi provider 文档：凭据解析顺序为 CLI、auth.json、环境变量、models.json。
- Playwright 文档：connectOverCDP、BrowserContext pages、远程连接断开行为。

已确认的设计结论：

- Context7 使用 .cjs，而不是依赖父 package.json。
- 私密文件创建必须显式使用 0600。
- 根和 dev-browser 作为独立部署单元，各保留一个 npm lock。
- Pi gpt key 可以迁移到 auth.json，并从 models.json 删除。

## 二十三、置信度

当前实施方案置信度为 95%，达到 90% 实施门槛：

- 重复实现检查：通过。
- 架构约束检查：通过。
- Node/npm/Pi 官方文档：通过。
- OSS 参考：部分通过；仓库外正式 Chrome extension 仍需发布前实测。
- 根因识别：通过。

剩余风险仅为仓库外 Chrome extension 的真实双平台集成，已被定义为发布门槛，不应通过代码审查假定完成。

## 二十四、新上下文推荐提示词

后续可以直接向新上下文提供：

~~~text
请完整读取 docs/abelworkflow-v1-refactor-plan.md 和 AGENTS.md。
该文档是 AbelWorkflow 1.0 重构的权威实施方案。

先检查 git status、OpenSpec 状态和当前代码是否已有部分实施，
从第一个未完成阶段继续，不要重复已完成工作。

严格遵守：
1. 实施前 confidence-check ≥90%；
2. TDD；
3. unified diff patch；
4. 每个提交单元保持测试全绿；
5. 不引入方案外架构；
6. 不自动归档 OpenSpec change。

本次只执行阶段 <阶段编号和名称>。
完成后更新测试结果、剩余风险和本文件中的验收清单。
~~~
