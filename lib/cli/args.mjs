function parseArgs(argv, { defaultAgentsDir, resolvePath, env = process.env }) {
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
      if (!helpRequested) options.command = "menu";
    } else if (["install", "sync"].includes(positional[0])) {
      if (!helpRequested) options.command = "install";
    } else {
      throw new Error(`Unknown command: ${positional[0]}`);
    }
  }

  if (options.command !== "install" && (options.force || options.relinkOnly || options.agentsDir !== defaultAgentsDir)) {
    throw new Error("`--force`、`--link-only`、`--agents-dir` 仅能与 `install` 命令一起使用");
  }
  if (!options.nonInteractive && env.CI) options.nonInteractive = true;
  return options;
}

function assertInteractiveMenuSupported({ command, inputIsTTY, outputIsTTY, nonInteractive }) {
  if (command === "menu" && nonInteractive) {
    throw new Error("非交互模式已启用；请显式使用 `npx abelworkflow install` 进行安装");
  }
  if (command === "menu" && (!inputIsTTY || !outputIsTTY)) {
    throw new Error("交互式菜单需要 TTY 终端；非交互场景请显式使用 `npx abelworkflow install`");
  }
}

export { assertInteractiveMenuSupported, parseArgs };
