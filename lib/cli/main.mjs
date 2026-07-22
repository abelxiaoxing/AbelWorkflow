import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import * as p from "@clack/prompts";
import c from "picocolors";
import { assertInteractiveMenuSupported, parseArgs } from "./args.mjs";
import * as promptApi from "./prompts.mjs";
import {
  ensurePiResourcesLinked,
  ensureWorkflowPresent,
  installManagedWorkflow,
  packageVersionFor
} from "../installer/install.mjs";
import {
  finalizeProviderInstallMetadata,
  getPreviousManagedCodexAgentFiles,
  getPreviousManagedCodexAuthKeys,
  readInstallMetadata,
  writeInstallMetadata
} from "../installer/state.mjs";
import { configureClaudeApi } from "../providers/claude.mjs";
import { configureCodexApi } from "../providers/codex.mjs";
import { configurePiApi } from "../providers/pi.mjs";
import {
  configureContext7Env,
  configureGrokSearchEnv,
  configurePromptEnhancerEnv
} from "../providers/skills.mjs";
import { commandExists, installCliTool } from "../tools/cli-installer.mjs";
import { createPaths, defaultPaths, pathToLabel } from "../paths.mjs";

const {
  buildCliToolMenuDescriptors,
  CancelledError,
  confirmOrCancel,
  interactiveMenuDefaultValue,
  interactiveMenuDescriptors
} = promptApi;

const installReportSummaryFields = [
  ["新增", "created"],
  ["更新", "updated"],
  ["未变", "unchanged"],
  ["删除", "removed"],
  ["链接", "linked"],
  ["保留", "preserved"],
  ["冲突", "conflicts"]
];

function uniqueReportPaths(paths = []) {
  return [...new Set(paths)];
}

function presentInstallReport(report, reportOutput) {
  const pathsByField = Object.fromEntries(installReportSummaryFields.map(([, field]) => [
    field,
    uniqueReportPaths(report[field])
  ]));
  reportOutput.message(`安装摘要：${installReportSummaryFields
    .map(([label, field]) => `${label} ${pathsByField[field].length}`)
    .join("，")}`);

  for (const [message, field] of [
    ["已更新", "updated"],
    ["已跳过", "unchanged"]
  ]) {
    const paths = pathsByField[field];
    if (paths.length > 0) {
      reportOutput.message([
        `${message} ${paths.length} 个${field === "unchanged" ? "未变化" : ""}文件：`,
        ...paths.map((path) => `- ${path}`)
      ].join("\n"));
    }
  }

  const conflictPaths = pathsByField.conflicts;
  const conflictSet = new Set(conflictPaths);
  const preservedPaths = pathsByField.preserved.filter((path) => !conflictSet.has(path));
  if (conflictPaths.length > 0) {
    reportOutput.warn([
      `检测到 ${conflictPaths.length} 个冲突，相关路径已保留：`,
      ...conflictPaths.map((path) => `- ${path}`),
      "确认可覆盖后，请在原安装命令中加入 `--force` 后重试。"
    ].join("\n"));
  }
  if (preservedPaths.length > 0) {
    reportOutput.message([
      `另有 ${preservedPaths.length} 个非冲突路径已保留：`,
      ...preservedPaths.map((path) => `- ${path}`)
    ].join("\n"));
  }
}

async function runManagedInstall(options) {
  const report = await installManagedWorkflow(options);
  presentInstallReport(report, p.log);
  return report;
}

async function ensureWorkflowPresentWithReport(paths) {
  const report = await ensureWorkflowPresent(paths);
  presentInstallReport(report, p.log);
  return report;
}

async function ensurePiResourcesLinkedWithReport(paths) {
  const report = await ensurePiResourcesLinked(paths);
  presentInstallReport(report, p.log);
  return report;
}

function printHelp() {
  console.log(`${c.bold("AbelWorkflow")} ${c.cyan("installer")}

${c.bold("Usage:")}
  ${c.cyan("npx abelworkflow")}
  ${c.cyan("npx abelworkflow init")}
  ${c.cyan("npx abelworkflow install")}
  ${c.cyan("npx abelworkflow install --force")}
  ${c.cyan("npx abelworkflow install --link-only")}
  ${c.cyan("npx abelworkflow install --agents-dir /custom/path")}
  ${c.cyan("npx abelworkflow --non-interactive")}

${c.bold("Default behavior:")}
  - npx abelworkflow: open the interactive setup menu.
  - npx abelworkflow install: sync managed files and links explicitly.
  - --non-interactive: auto-execute install (skip interactive menu); auto-enabled in CI.
`);
}

async function configureCodexForPaths(paths) {
  const metadata = await readInstallMetadata(paths);
  const packageVersion = await packageVersionFor(paths, metadata);
  const result = await configureCodexApi(paths, promptApi, {
    managedAuthKeys: getPreviousManagedCodexAuthKeys(metadata),
    managedCodexAgentFiles: getPreviousManagedCodexAgentFiles(metadata)
  });
  await writeInstallMetadata(paths, finalizeProviderInstallMetadata({
    previousMetadata: metadata,
    packageVersion,
    overrides: {
      managedCodexAuthKeys: result.managedAuthKeys,
      managedCodexAgentFiles: result.managedCodexAgentFiles
    }
  }));
}

async function configureClaudeForPaths(paths) {
  const metadata = await readInstallMetadata(paths);
  const packageVersion = await packageVersionFor(paths, metadata);
  await configureClaudeApi(paths, promptApi);
  await writeInstallMetadata(paths, finalizeProviderInstallMetadata({
    previousMetadata: metadata,
    packageVersion
  }));
}

async function runFullInit(options) {
  const installReport = await runManagedInstall({
    paths: options.paths,
    force: options.force,
    relinkOnly: false
  });

  if (await confirmOrCancel({ message: "是否安装或更新 Claude Code CLI？", initialValue: false })) {
    await installCliTool("claude", promptApi);
  }
  if (await confirmOrCancel({ message: "是否配置 Claude Code 第三方 API？", initialValue: commandExists("claude") })) {
    await configureClaudeForPaths(options.paths);
  }
  if (await confirmOrCancel({ message: "是否安装或更新 Codex CLI？", initialValue: false })) {
    await installCliTool("codex", promptApi);
  }
  if (await confirmOrCancel({ message: "是否配置 Codex 第三方 API？", initialValue: commandExists("codex") })) {
    await configureCodexForPaths(options.paths);
  }
  if (await confirmOrCancel({ message: "是否安装或更新 Pi CLI？", initialValue: false })) {
    await installCliTool("pi", promptApi);
  }
  if (await confirmOrCancel({ message: "是否配置 Pi 当前有效 Provider API？", initialValue: commandExists("pi") })) {
    await configurePiApi(options.paths, ensurePiResourcesLinked, promptApi);
  }
  if (await confirmOrCancel({ message: "是否填写 grok-search 环境变量？", initialValue: false })) {
    await configureGrokSearchEnv(options.paths, ensureWorkflowPresent, promptApi);
  }
  if (await confirmOrCancel({ message: "是否填写 context7-auto-research 环境变量？", initialValue: false })) {
    await configureContext7Env(options.paths, ensureWorkflowPresent, promptApi);
  }
  if (await confirmOrCancel({ message: "是否填写 prompt-enhancer 环境变量？", initialValue: false })) {
    await configurePromptEnhancerEnv(options.paths, ensureWorkflowPresent, promptApi);
  }

  const conflictCount = uniqueReportPaths(installReport.conflicts).length;
  if (conflictCount > 0) {
    p.log.warn(c.yellow(`AbelWorkflow 初始化流程结束；已保留 ${conflictCount} 个工作流冲突`));
  } else {
    p.log.success(c.green("AbelWorkflow 完整初始化完成"));
  }
}

async function runInteractiveMenu(options) {
  p.intro(c.bold(c.bgCyan(c.black(" AbelWorkflow Setup "))));
  p.log.message(`工作流目录: ${c.cyan(pathToLabel(options.agentsDir))}`);

  const buildOption = (d) => {
    const opt = { value: d.value, label: d.label };
    if (d.hint) {
      opt.hint = d.hint;
    }
    return opt;
  };
  const cliToolMenus = {
    "pi-cli": {
      tool: "pi",
      title: "Pi",
      actions: {
        "pi-install": async () => installCliTool("pi", promptApi),
        "pi-api": async () => configurePiApi(options.paths, ensurePiResourcesLinkedWithReport, promptApi)
      }
    },
    "codex-cli": {
      tool: "codex",
      title: "Codex",
      actions: {
        "codex-install": async () => installCliTool("codex", promptApi),
        "codex-api": async () => configureCodexForPaths(options.paths)
      }
    },
    "claude-cli": {
      tool: "claude",
      title: "Claude Code",
      actions: {
        "claude-install": async () => installCliTool("claude", promptApi),
        "claude-api": async () => configureClaudeForPaths(options.paths)
      }
    }
  };
  const runCliToolMenu = async ({ tool, title, actions }) => {
    while (true) {
      const choice = await p.select({
        message: `请选择 ${title} 操作`,
        options: buildCliToolMenuDescriptors(tool).map(buildOption),
        initialValue: `${tool}-install`
      });

      if (p.isCancel(choice) || choice === "back") {
        return;
      }

      const action = actions[choice];
      if (!action) {
        p.log.warn(`未知 CLI 工具菜单选项: ${choice}`);
        continue;
      }
      await action();
    }
  };
  const menuActions = {
    "full-init": async () => runFullInit(options),
    install: async () => runManagedInstall({
      paths: options.paths,
      force: options.force,
      relinkOnly: options.relinkOnly
    }),
    "grok-search": async () => configureGrokSearchEnv(options.paths, ensureWorkflowPresentWithReport, promptApi),
    context7: async () => configureContext7Env(options.paths, ensureWorkflowPresentWithReport, promptApi),
    "prompt-enhancer": async () => configurePromptEnhancerEnv(options.paths, ensureWorkflowPresentWithReport, promptApi),
    "pi-cli": async () => runCliToolMenu(cliToolMenus["pi-cli"]),
    "codex-cli": async () => runCliToolMenu(cliToolMenus["codex-cli"]),
    "claude-cli": async () => runCliToolMenu(cliToolMenus["claude-cli"])
  };

  while (true) {
    const selectOptions = [
      ...interactiveMenuDescriptors
        .filter((d) => d.group === "main")
        .map(buildOption),
      { value: "__sep_skills__", label: "─── 技能配置 ───", disabled: true },
      ...interactiveMenuDescriptors
        .filter((d) => d.group === "skill")
        .map(buildOption),
      { value: "__sep_cli__", label: "─── CLI 工具 ───", disabled: true },
      ...interactiveMenuDescriptors
        .filter((d) => d.group === "cli")
        .map(buildOption),
      { value: "__sep_exit__", label: "────────────────", disabled: true },
      ...interactiveMenuDescriptors
        .filter((d) => d.group === "exit")
        .map(buildOption)
    ];

    const choice = await p.select({
      message: "请选择操作",
      options: selectOptions,
      initialValue: interactiveMenuDefaultValue
    });

    if (p.isCancel(choice)) {
      p.outro(c.gray("已退出"));
      return;
    }
    if (choice === "exit") {
      p.outro(c.gray("已退出"));
      return;
    }

    const action = menuActions[choice];
    if (!action) {
      p.log.warn(`未知菜单选项: ${choice}`);
      continue;
    }

    try {
      await action();
    } catch (error) {
      if (error instanceof CancelledError) {
        p.log.warn("操作已取消，返回菜单");
        continue;
      }
      throw error;
    }
  }
}

async function main(argv, runtime = {}) {
  const options = parseArgs(argv, {
    defaultAgentsDir: runtime.defaultAgentsDir || defaultPaths.agentsDir,
    resolvePath: runtime.resolvePath || resolve
  });

  if (options.command === "help") {
    printHelp();
    return 0;
  }

  if (options.command === "menu" && options.nonInteractive) {
    console.log("检测到非交互模式，自动执行工作流安装...");
    options.command = "install";
  }

  if (options.command === "install") {
    try {
      await runManagedInstall({
        ...options,
        paths: createPaths({
          homeDir: runtime.homeDir ?? defaultPaths.homeDir,
          packageRoot: runtime.packageRoot ?? defaultPaths.packageRoot,
          agentsDir: options.agentsDir
        })
      });
    } catch (error) {
      const message = `操作失败: ${error.message || String(error)}`;
      if (options.nonInteractive) console.error(message);
      else p.outro(c.red(message));
      return 1;
    }
    return 0;
  }

  assertInteractiveMenuSupported({
    command: options.command,
    inputIsTTY: runtime.inputIsTTY ?? input.isTTY,
    outputIsTTY: runtime.outputIsTTY ?? output.isTTY,
    nonInteractive: options.nonInteractive
  });

  try {
    await runInteractiveMenu({
      ...options,
      paths: createPaths({
        homeDir: runtime.homeDir ?? defaultPaths.homeDir,
        packageRoot: runtime.packageRoot ?? defaultPaths.packageRoot,
        agentsDir: options.agentsDir
      })
    });
    return 0;
  } catch (error) {
    const message = `操作失败: ${error.message || String(error)}`;
    if (options.nonInteractive) console.error(message);
    else p.outro(c.red(message));
    return 1;
  }
}

export {
  main,
  presentInstallReport,
  printHelp,
  runFullInit,
  runInteractiveMenu
};
