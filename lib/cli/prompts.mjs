import * as p from "@clack/prompts";

const interactiveMenuDescriptors = [
  { value: "full-init", label: "完整初始化", hint: "同步 + 安装 + 配置", group: "main" },
  { value: "install", label: "仅同步工作流", group: "main" },
  { value: "grok-search", label: "配置 grok-search", hint: "技能", group: "skill" },
  { value: "context7", label: "配置 context7-auto-research", hint: "技能", group: "skill" },
  { value: "pi-cli", label: "配置/安装 Pi", hint: "CLI", group: "cli" },
  { value: "codex-cli", label: "配置/安装 Codex", hint: "CLI", group: "cli" },
  { value: "claude-cli", label: "配置/安装 Claude Code", hint: "CLI", group: "cli" },
  { value: "exit", label: "退出", group: "exit" }
];
const interactiveMenuDefaultValue = "full-init";
const cliToolMenuDescriptorMap = {
  pi: [
    { value: "pi-api", label: "配置 Pi API" },
    { value: "pi-install", label: "安装/更新 Pi" },
    { value: "back", label: "返回上一级" }
  ],
  codex: [
    { value: "codex-api", label: "配置 Codex API" },
    { value: "codex-install", label: "安装/更新 Codex" },
    { value: "back", label: "返回上一级" }
  ],
  claude: [
    { value: "claude-api", label: "配置 Claude Code API" },
    { value: "claude-install", label: "安装/更新 Claude Code" },
    { value: "back", label: "返回上一级" }
  ]
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

function passwordPromptOptions(message, existingValue, validate) {
  const configured = typeof existingValue === "string" && existingValue.trim() !== "";
  return {
    message: `${message}${configured ? "（已配置，直接回车保留；输入 - 清除）" : "（输入 - 清除）"}`,
    mask: "*",
    ...(validate ? { validate } : {})
  };
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

export {
  assertNotCancelled,
  buildCliToolMenuDescriptors,
  CancelledError,
  confirmOrCancel,
  interactiveMenuDefaultValue,
  interactiveMenuDescriptors,
  passwordPromptOptions,
  required,
  requiredUnlessExisting,
  resolvePasswordValue,
  selectOrCancel
};
