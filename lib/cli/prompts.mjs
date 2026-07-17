import * as p from "@clack/prompts";

const interactiveMenuDescriptors = [
  { value: "full-init", label: "完整初始化", hint: "同步 + 安装 + 配置", group: "main" },
  { value: "install", label: "仅同步工作流", group: "main" },
  { value: "grok-search", label: "配置 grok-search", hint: "技能", group: "skill" },
  { value: "context7", label: "配置 context7-auto-research", hint: "技能", group: "skill" },
  { value: "prompt-enhancer", label: "配置 prompt-enhancer", hint: "技能", group: "skill" },
  { value: "pi-cli", label: "安装/配置 Pi", hint: "CLI", group: "cli" },
  { value: "codex-cli", label: "安装/配置 Codex", hint: "CLI", group: "cli" },
  { value: "claude-cli", label: "安装/配置 Claude Code", hint: "CLI", group: "cli" },
  { value: "exit", label: "退出", group: "exit" }
];
const interactiveMenuDefaultValue = "full-init";
const cliToolMenuDescriptorMap = {
  pi: [
    { value: "pi-install", label: "安装/更新 Pi" },
    { value: "pi-api", label: "配置 Pi API" },
    { value: "back", label: "返回上一级" }
  ],
  codex: [
    { value: "codex-install", label: "安装/更新 Codex" },
    { value: "codex-api", label: "配置 Codex API" },
    { value: "back", label: "返回上一级" }
  ],
  claude: [
    { value: "claude-install", label: "安装/更新 Claude Code" },
    { value: "claude-api", label: "配置 Claude Code API" },
    { value: "back", label: "返回上一级" }
  ]
};
const augmentContextEngineFeaturePrompt = {
  message: "是否启用 augment-context-engine MCP 代码检索支持？不确定建议选否，可减少 MCP 安装和配置麻烦。",
  initialValue: false
};

class CancelledError extends Error {
  constructor(message = "用户取消") {
    super(message);
    this.name = "CancelledError";
  }
}

function buildCliToolMenuDescriptors(tool) {
  const descriptors = cliToolMenuDescriptorMap[tool];
  if (!descriptors) throw new Error(`Unknown CLI tool: ${tool}`);
  return descriptors.map((descriptor) => ({ ...descriptor }));
}

function required(message = "此项不能为空") {
  return (value) => {
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return message;
  };
}

function requiredUnlessExisting(existingValue, message = "此项不能为空") {
  return (value) => {
    if ((value === undefined || value === null || (typeof value === "string" && value.trim() === "")) && !existingValue) return message;
  };
}

function resolvePasswordValue(userInput, existingValue) {
  if (typeof userInput === "string") {
    const trimmed = userInput.trim();
    if (trimmed === "") {
      if (typeof existingValue === "string" && existingValue.trim() === "") return undefined;
      return existingValue || undefined;
    }
    return trimmed === "-" ? undefined : trimmed;
  }
  if (typeof existingValue === "string" && existingValue.trim() === "") return undefined;
  return existingValue || undefined;
}

function assertNotCancelled(value) {
  if (p.isCancel(value)) throw new CancelledError();
}

async function confirmOrCancel({ message, initialValue = false }) {
  const value = await p.confirm({ message, initialValue, active: "是", inactive: "否" });
  assertNotCancelled(value);
  return value;
}

async function selectOrCancel(options) {
  const value = await p.select(options);
  assertNotCancelled(value);
  return value;
}

function getAugmentContextEnginePromptOptions() {
  return { ...augmentContextEngineFeaturePrompt };
}

function getClaudePermissionProfilePromptOptions(initialValue = "standard") {
  return {
    message: "请选择 Claude Code 权限配置档",
    options: [
      { value: "standard", label: "standard（默认，不预授权 Bash/Write/Edit）" },
      { value: "trusted", label: "trusted（显式授予完整工具权限）" }
    ],
    initialValue: initialValue === "trusted" ? "trusted" : "standard"
  };
}

export {
  assertNotCancelled,
  buildCliToolMenuDescriptors,
  CancelledError,
  confirmOrCancel,
  getClaudePermissionProfilePromptOptions,
  getAugmentContextEnginePromptOptions,
  interactiveMenuDefaultValue,
  interactiveMenuDescriptors,
  required,
  requiredUnlessExisting,
  resolvePasswordValue,
  selectOrCancel
};
