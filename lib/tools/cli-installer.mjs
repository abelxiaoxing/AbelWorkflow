import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import * as p from "@clack/prompts";
import c from "picocolors";
import { defaultPaths, getPlatform, isWindows } from "../paths.mjs";

const { homeDir: home } = defaultPaths;

function getRunCommandSpawnOptions(platform = getPlatform()) {
  return { stdio: "inherit", shell: platform === "win32" };
}

function getCommandPath(command) {
  const checker = isWindows() ? "where" : "which";
  const result = spawnSync(checker, [command], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
}

function commandExists(command) {
  return Boolean(getCommandPath(command));
}

function readCommandOutput(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: isWindows(),
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) {
    return undefined;
  }
  const outputValue = result.stdout.trim();
  return outputValue || undefined;
}

async function runCommand(command, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, getRunCommandSpawnOptions(getPlatform()));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function normalizeInstallPath(value) {
  if (!value) {
    return "";
  }
  return value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

function installPathIsWithin(path, parentPath) {
  const normalizedPath = normalizeInstallPath(path);
  const normalizedParent = normalizeInstallPath(parentPath);
  return Boolean(normalizedPath && normalizedParent)
    && (normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`));
}

function getNpmGlobalBinDirs(npmGlobalPrefix, platform = getPlatform()) {
  if (!npmGlobalPrefix) {
    return [];
  }
  return platform === "win32" ? [npmGlobalPrefix] : [join(npmGlobalPrefix, "bin")];
}

function inferPackageManagerFromCommandPath(commandPath, {
  bunGlobalBinDir,
  npmGlobalPrefix,
  platform = getPlatform()
} = {}) {
  if (installPathIsWithin(commandPath, bunGlobalBinDir)) {
    return "bun";
  }
  if (getNpmGlobalBinDirs(npmGlobalPrefix, platform)
    .some((binDir) => installPathIsWithin(commandPath, binDir))) {
    return "npm";
  }
  return null;
}

function chooseCliInstallPackageManager({
  commandPath,
  availablePackageManagers = [],
  bunGlobalBinDir,
  npmGlobalPrefix,
  platform = getPlatform(),
  nodeAvailable = true,
  supportedPackageManagers = ["bun", "npm"]
} = {}) {
  const supported = new Set(supportedPackageManagers);
  const available = new Set(availablePackageManagers.filter((packageManager) => {
    if (!supported.has(packageManager)) {
      return false;
    }
    return packageManager !== "bun" || nodeAvailable;
  }));
  const bunBlockedByMissingNode = !nodeAvailable
    && supported.has("bun")
    && availablePackageManagers.includes("bun");
  const existingPackageManager = inferPackageManagerFromCommandPath(commandPath, {
    bunGlobalBinDir,
    npmGlobalPrefix,
    platform
  });

  if (existingPackageManager && available.has(existingPackageManager)) {
    return { packageManager: existingPackageManager, source: "existing" };
  }
  for (const packageManager of ["bun", "npm"]) {
    if (available.has(packageManager)) {
      return { packageManager, source: "available" };
    }
  }
  return {
    packageManager: null,
    source: bunBlockedByMissingNode ? "missing-node" : (availablePackageManagers.length > 0 ? "unsupported" : "missing")
  };
}

function buildCliToolInstallCommand(packageManager, { packageName, skipScripts = false }) {
  if (packageManager === "npm") {
    return {
      command: "npm",
      args: [
        "install",
        "-g",
        ...(skipScripts ? ["--ignore-scripts"] : []),
        packageName,
        "--force"
      ]
    };
  }
  if (packageManager === "bun") {
    return {
      command: "bun",
      args: [
        "install",
        "-g",
        ...(skipScripts ? ["--ignore-scripts"] : []),
        packageName
      ]
    };
  }
  throw new Error(`Unsupported package manager: ${packageManager}`);
}

function getPackageManagerInstallHelp(platform = getPlatform()) {
  const platformLabel = {
    darwin: "macOS",
    win32: "Windows",
    linux: "Linux"
  }[platform] || platform;
  return {
    platformLabel,
    mainlandUrl: "https://npmmirror.com/mirrors/node/",
    officialUrl: "https://nodejs.org/en/download/"
  };
}

function getAvailablePackageManagers() {
  return ["bun", "npm"].filter((packageManager) => commandExists(packageManager));
}

function getBunGlobalBinDir(availablePackageManagers = getAvailablePackageManagers()) {
  if (!availablePackageManagers.includes("bun")) {
    return undefined;
  }
  return readCommandOutput("bun", ["pm", "bin", "-g"]) || join(home, ".bun", "bin");
}

function getNpmGlobalPrefix(availablePackageManagers = getAvailablePackageManagers()) {
  if (!availablePackageManagers.includes("npm")) {
    return undefined;
  }
  return readCommandOutput("npm", ["prefix", "-g"]);
}

async function installCliTool(tool, { confirmOrCancel }) {
  const toolConfig = {
    claude: {
      label: "Claude Code",
      command: "claude",
      packageName: "@anthropic-ai/claude-code",
      supportedPackageManagers: ["npm"],
      installRequirement: "Claude Code 安装需要执行 postinstall；Bun 默认会阻止该脚本，因此需使用 npm。"
    },
    codex: {
      label: "Codex",
      command: "codex",
      packageName: "@openai/codex"
    },
    pi: {
      label: "Pi",
      command: "pi",
      packageName: "@earendil-works/pi-coding-agent",
      skipScripts: true
    }
  }[tool];

  if (!toolConfig) {
    throw new Error(`Unsupported tool: ${tool}`);
  }

  const commandPath = getCommandPath(toolConfig.command);
  const installed = Boolean(commandPath);
  const availablePackageManagers = getAvailablePackageManagers();
  const packageManagerChoice = chooseCliInstallPackageManager({
    commandPath,
    availablePackageManagers,
    bunGlobalBinDir: getBunGlobalBinDir(availablePackageManagers),
    npmGlobalPrefix: getNpmGlobalPrefix(availablePackageManagers),
    platform: getPlatform(),
    nodeAvailable: commandExists("node"),
    supportedPackageManagers: toolConfig.supportedPackageManagers
  });

  if (!packageManagerChoice.packageManager) {
    const help = getPackageManagerInstallHelp();
    p.log.warn(`未检测到可用于安装 ${toolConfig.label} 的包管理器。`);
    if (packageManagerChoice.source === "missing-node") {
      p.log.message(`${toolConfig.label} 是 Node CLI；使用 Bun 安装前也需要先安装 Node.js。`);
    }
    if (toolConfig.installRequirement) {
      p.log.message(toolConfig.installRequirement);
    }
    p.log.message(`${help.platformLabel} 可先安装 Node.js/npm，再重新运行安装。`);
    p.log.message(`中国大陆镜像: ${help.mainlandUrl}`);
    p.log.message(`官方下载页: ${help.officialUrl}`);
    return;
  }

  if (installed) {
    const managerMessage = packageManagerChoice.source === "existing"
      ? `检测到原安装方式为 ${packageManagerChoice.packageManager}`
      : `未识别原安装方式，将使用 ${packageManagerChoice.packageManager}`;
    const shouldUpdate = await confirmOrCancel({
      message: `${toolConfig.label} 已检测到（${managerMessage}），是否继续安装/更新？`,
      initialValue: false
    });
    if (!shouldUpdate) {
      p.log.message(`跳过 ${toolConfig.label} 安装。`);
      return;
    }
  }

  const installCommand = buildCliToolInstallCommand(packageManagerChoice.packageManager, toolConfig);
  const s = p.spinner();
  s.start(`正在使用 ${packageManagerChoice.packageManager} 安装 ${toolConfig.label}...`);
  try {
    await runCommand(installCommand.command, installCommand.args);
    s.stop(`${toolConfig.label} 安装完成`);
  } catch (e) {
    s.cancel(c.red(`${toolConfig.label} 安装失败: ${e.message}`));
    throw e;
  }
}

export {
  buildCliToolInstallCommand,
  chooseCliInstallPackageManager,
  getPackageManagerInstallHelp,
  getRunCommandSpawnOptions,
  inferPackageManagerFromCommandPath,
  installCliTool,
  commandExists
};
