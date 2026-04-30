# AbelWorkflow 现代化 UI 改造方案

> **状态：已实施**（实际依赖：`@clack/prompts ^1.2.0`，`picocolors ^1.1.1`）
> 
> **注意**：Stepper 步骤条功能暂未实现，计划在后续版本中添加。

## 核心依赖

```json
{
  "dependencies": {
    "@clack/prompts": "^1.2.0",
    "picocolors": "^1.1.1"
  }
}
```

## 改造要点

### 1. 主菜单：箭头键导航 + 分组

**当前**：
```
AbelWorkflow Setup
工作流目录: ~/.agents

请选择操作
  1. 完整初始化：同步工作流 + ...
  2. 仅同步/更新工作流...
  3. 配置 grok-search...
  ...
请输入序号: 1
```

**现代化后**：
```bash
┌  AbelWorkflow Setup
│
◇  工作流目录: ~/.agents
│
◆  请选择操作
│  ● 完整初始化 — 同步工作流 + 可选安装 Claude/Codex/技能环境
│  ○ 仅同步工作流
│  ───────────── 技能配置 ─────────────
│  ○ 配置 grok-search
│  ○ 配置 context7-auto-research
│  ○ 配置 prompt-enhancer
│  ───────────── CLI 工具 ─────────────
│  ○ 安装/更新 Claude Code
│  ○ 配置 Claude API
│  ○ 安装/更新 Codex
│  ○ 配置 Codex API
│  ────────────────────────────────────
│  ○ 退出
└
```

使用 `select` + `separator` 实现分组，支持 ↑↓ 箭头导航，Enter 确认。

### 2. Wizard 流程：步骤条 + 动态重绘

**完整初始化**当前是一连串 prompt，中间失败无法回溯。改造为带**步骤条（Stepper）**的 Wizard：

```bash
┌  AbelWorkflow 完整初始化
│
◇  Step 1/7  同步工作流 ✓
│  已链接 12 个目标
│
◇  Step 2/7  Claude Code CLI ✓
│  已安装 @anthropic-ai/claude-code@0.2.56
│
◆  Step 3/7  Claude API 配置
│  ┌─ Claude Code 认证方式
│  │  ● API Key
│  │  ○ Auth Token
│  └─
│  Base URL: https://api.anthropic.com
│  API Key:  ************************sk12
│  模型:      claude-sonnet-4-20250514
│
◇  Step 4/7  Codex CLI — 跳过
│
◆  Step 5/7  Codex API 配置
│  ...
```

每一步完成后固定输出结果，未执行步骤动态渲染。`@clack/prompts` 的 `group` 和 `note` 天然支持此模式。

### 3. 加载状态：Spinner 替代静态文字

**当前**：
```
开始安装 Claude Code...
（可能卡住数秒，用户不知道在进行中）
```

**现代化后**：
```bash
│  ⠋ 正在安装 Claude Code...  (npm install -g @anthropic-ai/claude-code --force)
│  ✓ 安装完成  v0.2.56
```

使用 `spinner` 包装耗时操作，失败时 `stop('安装失败', 1)` 输出红色错误。

### 4. 表单输入：内联验证 + 密码遮罩

| 输入类型 | 当前实现 | 现代化 |
|---------|---------|--------|
| 文本 | `readline.question` | `text({ message, placeholder, validate })` |
| 密码 | 手动 `stty -echo` | `password({ mask: '*' })` 跨平台原生支持 |
| 确认 | Select 1.是 2.否 | `confirm({ active: '是', inactive: '否' })` 支持 Y/n 快捷 |
| 选择 | 输入序号 | `select` 箭头导航 |

### 5. 结果汇总：结构化输出

**当前**：
```
Linked targets:
- = /home/user/.claude/CLAUDE.md
- + /home/user/.claude/commands/oc
...
```

**现代化后**：
```bash
│
◇  同步完成  耗时 1.2s
│
┌  链接结果
│  ✓  ~/.claude/CLAUDE.md          已链接
│  ✓  ~/.claude/commands/oc        已链接
│  ✓  ~/.claude/skills/confidence-check  已链接
│  ⤵  ~/.codex/config.toml         已备份 → config.toml.bak.171439...0
└
```

使用 `table`（或手写对齐）+ `picocolors` 着色：成功=绿色、跳过=灰色、新建=青色、备份=黄色。

---

## 关键代码重构示例

### 菜单入口

```js
import * as p from '@clack/prompts';
import c from 'picocolors';

async function runInteractiveMenu(options) {
  p.intro(c.bold(c.bgCyan(c.black(' AbelWorkflow Setup '))));
  p.note(`工作流目录: ${c.cyan(pathToLabel(options.agentsDir))}`);

  while (true) {
    const choice = await p.select({
      message: '请选择操作',
      options: [
        { value: 'full-init', label: '完整初始化', hint: '同步 + 安装 + 配置' },
        { value: 'install',   label: '仅同步工作流' },
        { value: '__sep_skills__', label: '─── 技能配置 ───', disabled: true },
        { value: 'grok-search',     label: '配置 grok-search' },
        { value: 'context7',        label: '配置 context7-auto-research' },
        { value: 'prompt-enhancer', label: '配置 prompt-enhancer' },
        { value: '__sep_cli__', label: '─── CLI 工具 ───', disabled: true },
        { value: 'claude-install', label: '安装/更新 Claude Code' },
        { value: 'claude-api',     label: '配置 Claude API' },
        { value: 'codex-install',  label: '安装/更新 Codex' },
        { value: 'codex-api',      label: '配置 Codex API' },
        { value: '__sep_exit__', label: '────────────────', disabled: true },
        { value: 'exit', label: '退出' },
      ],
      initialValue: 'full-init',
    });

    if (p.isCancel(choice) || choice === 'exit') {
      p.outro(c.gray('已退出'));
      return;
    }

    await menuActions[choice](options);
  }
}
```

### 带 Spinner 的安装流程

```js
async function installManagedWorkflow(options) {
  const s = p.spinner();
  s.start('正在同步工作流文件...');

  try {
    const { managedChildren } = await syncManagedFiles(options.agentsDir);
    s.stop('工作流文件已同步');

    s.start('正在链接 Claude/Codex...');
    const claudeResults = await linkClaude(options.agentsDir, {});
    const codexResults = await linkCodex(options.agentsDir, {});
    s.stop('链接完成');

    // 结构化输出结果
    const out = [...claudeResults, ...codexResults].map(r => {
      const icon = r.status === 'unchanged' ? c.gray('✓')
                 : r.status === 'removed'   ? c.yellow('−')
                 : c.green('+');
      return `${icon}  ${pathToLabel(r.targetPath)}`;
    }).join('\n');
    p.note(out, '链接结果');
  } catch (err) {
    s.stop(c.red(`失败: ${err.message}`), 1);
    throw err;
  }
}
```

### 密码输入（跨平台，无需 stty）

```js
async function promptSecret(message, { defaultValue } = {}) {
  const value = await p.password({
    message,
    mask: '*',
    defaultValue,
  });
  if (p.isCancel(value)) process.exit(1);
  return value;
}
```

> `@clack/prompts` 内部使用 `readline` + `stdin.setRawMode`，在 Windows/macOS/Linux 均支持密码遮罩，**可删除当前所有 `stty` 相关代码**。

### 确认框（Y/n 快捷）

```js
async function promptConfirm(message, defaultValue = true) {
  return p.confirm({
    message,
    initialValue: defaultValue,
    active: '是',
    inactive: '否',
  });
}
```

---

## 实施步骤

1. **添加依赖**：`npm add @clack/prompts picocolors`
2. **封装 prompt 层**：新建 `lib/cli/prompts.mjs`，将 `promptText/promptSecret/promptSelect/promptConfirm` 全部替换为 `@clack/prompts` 封装
3. **删除旧逻辑**：移除 `setTerminalEcho`、`shouldUseVisibleSecretFallback` 等兼容代码
4. **改造主菜单**：`runInteractiveMenu` 使用 `p.select` + `p.separator`
5. **改造 Wizard**：`runFullInit` 使用 `p.group` 或顺序 `p.confirm` + 步骤输出
6. **添加 Spinner**：`installManagedWorkflow`、`installCliTool` 等耗时操作包裹 `p.spinner`
7. **美化输出**：结果汇总使用 `p.note`、`p.log.step`、`picocolors` 着色
8. **测试**：更新 `test/cli-contracts.test.mjs` 中关于 TTY 和输出的断言

---

## 预期效果

| 维度 | 改造前 | 改造后 |
|-----|--------|--------|
| 菜单导航 | 输入数字 | ↑↓ 箭头 + Enter |
| 视觉层级 | 纯白文本 | 分组线 + 颜色 + 图标 |
| 加载感知 | 无，可能假死 | Spinner 实时旋转 |
| 密码输入 | 手动 stty，Windows 明文 | 统一 `*` 遮罩 |
| 步骤引导 | 无，混乱堆叠 | Stepper 步骤条 |
| 结果阅读 | 符号标记 | 结构化列表 + 颜色 |
| 终端兼容性 | 依赖 stty | 纯 Node.js API |

此方案以**极小的依赖成本**（总计 <40KB）换取**接近 GUI 的 CLI 体验**，是当前 Node.js 生态的最佳实践。
