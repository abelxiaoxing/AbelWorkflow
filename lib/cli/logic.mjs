import * as p from "@clack/prompts";

const interactiveMenuDescriptors = [
  { value: "full-init", label: "完整初始化", hint: "同步 + 安装 + 配置", group: "main" },
  { value: "install", label: "仅同步工作流", group: "main" },
  { value: "grok-search", label: "配置 grok-search", hint: "技能", group: "skill" },
  { value: "context7", label: "配置 context7-auto-research", hint: "技能", group: "skill" },
  { value: "prompt-enhancer", label: "配置 prompt-enhancer", hint: "技能", group: "skill" },
  { value: "claude-install", label: "安装/更新 Claude Code", hint: "CLI", group: "cli" },
  { value: "claude-api", label: "配置 Claude API", hint: "CLI", group: "cli" },
  { value: "codex-install", label: "安装/更新 Codex", hint: "CLI", group: "cli" },
  { value: "codex-api", label: "配置 Codex API", hint: "CLI", group: "cli" },
  { value: "exit", label: "退出", group: "exit" }
];

const interactiveMenuDefaultValue = "full-init";

class CancelledError extends Error {
  constructor(message = "用户取消") {
    super(message);
    this.name = "CancelledError";
  }
}

function required(message = "此项不能为空") {
  return (value) => {
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
      return message;
    }
  };
}

function requiredUnlessExisting(existingValue, message = "此项不能为空") {
  return (value) => {
    if ((value === undefined || value === null || (typeof value === "string" && value.trim() === "")) && !existingValue) {
      return message;
    }
  };
}

/**
 * 回退逻辑：用户输入非空则用新值，否则用旧值。
 * 输入 "-" 表示清除已有值（返回 undefined）。
 * existingValue 可能来自 dotenv / JSON 读取，会传入空字符串；
 * 空字符串将被净化为 undefined，避免写入无意义的空配置。
 * 注意：本函数仅适用于字符串类型的配置值，不适用于可能为 0/false 的数字或布尔值。
 */
function resolvePasswordValue(userInput, existingValue) {
  if (typeof userInput === "string") {
    const trimmed = userInput.trim();
    if (trimmed === "") {
      if (typeof existingValue === "string" && existingValue.trim() === "") {
        return undefined;
      }
      return existingValue || undefined;
    }
    return trimmed === "-" ? undefined : trimmed;
  }
  if (typeof existingValue === "string" && existingValue.trim() === "") {
    return undefined;
  }
  return existingValue || undefined;
}

function assertNotCancelled(value) {
  if (p.isCancel(value)) {
    throw new CancelledError();
  }
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

function parseArgs(argv, { defaultAgentsDir, resolvePath }) {
  const options = {
    agentsDir: defaultAgentsDir,
    force: false,
    relinkOnly: false,
    nonInteractive: false,
    command: "menu"
  };
  const positional = [];
  let helpRequested = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force" || arg === "-f") {
      options.force = true;
      continue;
    }
    if (arg === "--link-only") {
      options.relinkOnly = true;
      continue;
    }
    if (arg === "--agents-dir") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--agents-dir requires a path");
      }
      options.agentsDir = resolvePath(value);
      i += 1;
      continue;
    }
    if (arg === "--non-interactive") {
      options.nonInteractive = true;
      continue;
    }
    if (arg === "--help" || arg === "-h" || arg === "help") {
      helpRequested = true;
      options.command = "help";
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error(`Unknown argument: ${positional.slice(1).join(" ")}`);
  }

  if (positional[0]) {
    if (["menu", "init"].includes(positional[0])) {
      if (!helpRequested) {
        options.command = "menu";
      }
    } else if (["install", "sync"].includes(positional[0])) {
      if (!helpRequested) {
        options.command = "install";
      }
    } else {
      throw new Error(`Unknown command: ${positional[0]}`);
    }
  }

  if (options.command !== "install" && (options.force || options.relinkOnly || options.agentsDir !== defaultAgentsDir)) {
    throw new Error("`--force`、`--link-only`、`--agents-dir` 仅能与 `install` 命令一起使用");
  }

  if (!options.nonInteractive && process.env.CI) {
    options.nonInteractive = true;
  }

  return options;
}

function assertInteractiveMenuSupported({ command, inputIsTTY, outputIsTTY, nonInteractive }) {
  // 防御性检查（死代码守护）：main() 已在调用前将非交互 menu 降级为 install，
  // 此处仅防止外部直接调用 assertInteractiveMenuSupported 时漏掉判断。
  if (command === "menu" && nonInteractive) {
    throw new Error("非交互模式已启用；请显式使用 `npx abelworkflow install` 进行安装");
  }
  if (command === "menu" && (!inputIsTTY || !outputIsTTY)) {
    throw new Error("交互式菜单需要 TTY 终端；非交互场景请显式使用 `npx abelworkflow install`");
  }
}

function getRunCommandSpawnOptions(platform = process.env.ABELWORKFLOW_TEST_PLATFORM || process.platform) {
  return {
    stdio: "inherit",
    shell: platform === "win32"
  };
}

export {
  assertInteractiveMenuSupported,
  assertNotCancelled,
  CancelledError,
  confirmOrCancel,
  getRunCommandSpawnOptions,
  interactiveMenuDefaultValue,
  interactiveMenuDescriptors,
  parseArgs,
  required,
  requiredUnlessExisting,
  resolvePasswordValue,
  selectOrCancel
};
