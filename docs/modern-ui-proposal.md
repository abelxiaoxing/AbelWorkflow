# AbelWorkflow 现代化 UI 状态

> **状态：部分实施**
>
> 主菜单、表单、密码遮罩、加载状态和结果摘要已迁移到 `@clack/prompts` 与 `picocolors`。Stepper 步骤条未实现，且不属于 AbelWorkflow 1.0 的发布范围。

## 已实施

- 主菜单使用方向键导航和分组。
- 文本、密码、确认与选择输入使用统一的 Clack prompt 层。
- 密码输入由终端交互层遮罩，不依赖 `stty`。
- 安装等耗时操作显示 spinner。
- 同步与链接结果使用结构化、带颜色的摘要。
- 用户取消会转为统一的取消结果，由 CLI 入口设置退出码。

实际依赖由根 `package.json` 和 lockfile 定义，不在本文复制版本号。

## 未实施

Stepper 步骤条和可回溯 Wizard 尚未实现。它们是后续可选体验改进，不是 1.0 功能或发布门槛；文档和测试不得将其描述为已完成。

## 1.0 UI 契约

- 交互模式要求 TTY；非交互安装必须显式使用 `abelworkflow install`。
- 菜单只负责收集选择，安装器与 Provider 不读取交互输入。
- 密钥不得出现在结果摘要或日志中。
- Linux、macOS 与原生 Windows 使用同一 Node prompt 路径。
