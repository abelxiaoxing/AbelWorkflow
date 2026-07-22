import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("parseArgs normalizes command aliases and help routing", () => {
  const cases = [
    {
      argv: [],
      expected: {
        agentsDir: defaultAgentsDir,
        force: false,
        relinkOnly: false,
        nonInteractive: false,
        command: "menu"
      }
    },
    {
      argv: ["menu"],
      expected: {
        agentsDir: defaultAgentsDir,
        force: false,
        relinkOnly: false,
        nonInteractive: false,
        command: "menu"
      }
    },
    {
      argv: ["init"],
      expected: {
        agentsDir: defaultAgentsDir,
        force: false,
        relinkOnly: false,
        nonInteractive: false,
        command: "menu"
      }
    },
    {
      argv: ["install"],
      expected: {
        agentsDir: defaultAgentsDir,
        force: false,
        relinkOnly: false,
        nonInteractive: false,
        command: "install"
      }
    },
    {
      argv: ["sync"],
      expected: {
        agentsDir: defaultAgentsDir,
        force: false,
        relinkOnly: false,
        nonInteractive: false,
        command: "install"
      }
    },
    {
      argv: ["--help"],
      expected: {
        agentsDir: defaultAgentsDir,
        force: false,
        relinkOnly: false,
        nonInteractive: false,
        command: "help"
      }
    },
    {
      argv: ["-h", "install"],
      expected: {
        agentsDir: defaultAgentsDir,
        force: false,
        relinkOnly: false,
        nonInteractive: false,
        command: "help"
      }
    },
    {
      argv: ["help", "install"],
      expected: {
        agentsDir: defaultAgentsDir,
        force: false,
        relinkOnly: false,
        nonInteractive: false,
        command: "help"
      }
    },
    {
      argv: ["install", "--force", "--link-only", "--agents-dir", "custom/path"],
      expected: {
        agentsDir: "/resolved/custom/path",
        force: true,
        relinkOnly: true,
        nonInteractive: false,
        command: "install"
      }
    },
    {
      argv: ["--force", "--link-only", "--agents-dir", "custom/path", "install"],
      expected: {
        agentsDir: "/resolved/custom/path",
        force: true,
        relinkOnly: true,
        nonInteractive: false,
        command: "install"
      }
    }
  ];

  for (const { argv, expected } of cases) {
    assertParse(argv, expected);
  }
});

test("parseArgs gates install-only options outside install command", () => {
  const menuCommands = [[], ["menu"], ["init"], ["--help"], ["help"]];
  const installOnlyOptionSets = [
    { args: ["--force"] },
    { args: ["-f"] },
    { args: ["--link-only"] },
    { args: ["--agents-dir", "custom/path"] },
    { args: ["--force", "--link-only"] },
    { args: ["--force", "--agents-dir", "custom/path"] },
    { args: ["--link-only", "--agents-dir", "custom/path"] },
    { args: ["--force", "--link-only", "--agents-dir", "custom/path"] }
  ];

  for (const command of menuCommands) {
    for (const optionSet of installOnlyOptionSets) {
      assertParseError(
        [...command, ...optionSet.args],
        "`--force`、`--link-only`、`--agents-dir` 仅能与 `install` 命令一起使用"
      );
    }
  }

  for (const optionSet of installOnlyOptionSets) {
    const result = parseArgs(["install", ...optionSet.args], { defaultAgentsDir, resolvePath });
    assert.equal(result.command, "install");
  }
});

test("parseArgs rejects unknown tokens and extra positional arguments", () => {
  const unknownFlagCases = ["--unknown", "-x", "--verbose"];
  for (const token of unknownFlagCases) {
    assertParseError([token], `Unknown argument: ${token}`);
  }

  const unknownCommandCases = [
    [["deploy"], "Unknown command: deploy"],
    [["foo"], "Unknown command: foo"],
    [["help", "deploy"], "Unknown command: deploy"]
  ];
  for (const [argv, message] of unknownCommandCases) {
    assertParseError(argv, message);
  }

  const extraPositionalCases = [
    [["install", "extra"], "Unknown argument: extra"],
    [["menu", "extra"], "Unknown argument: extra"],
    [["install", "extra", "more"], "Unknown argument: extra more"]
  ];
  for (const [argv, message] of extraPositionalCases) {
    assertParseError(argv, message);
  }

  assertParseError(["--agents-dir"], "--agents-dir requires a path");
});

test("assertInteractiveMenuSupported enforces TTY only for menu command", () => {
  const commands = ["help", "install", "menu"];
  const ttyStates = [
    { inputIsTTY: true, outputIsTTY: true, shouldThrow: false },
    { inputIsTTY: true, outputIsTTY: false, shouldThrow: true },
    { inputIsTTY: false, outputIsTTY: true, shouldThrow: true },
    { inputIsTTY: false, outputIsTTY: false, shouldThrow: true }
  ];

  for (const command of commands) {
    for (const ttyState of ttyStates) {
      const act = () => assertInteractiveMenuSupported({ command, ...ttyState, nonInteractive: false });
      if (command === "menu" && ttyState.shouldThrow) {
        assert.throws(
          act,
          (error) => error instanceof Error
            && error.message === "交互式菜单需要 TTY 终端；非交互场景请显式使用 `npx abelworkflow install`"
        );
        continue;
      }
      assert.doesNotThrow(act);
    }
  }

  assert.throws(
    () => assertInteractiveMenuSupported({ command: "menu", inputIsTTY: true, outputIsTTY: true, nonInteractive: true }),
    (error) => error instanceof Error
      && error.message === "非交互模式已启用；请显式使用 `npx abelworkflow install` 进行安装"
  );
});

test("parseArgs supports --non-interactive flag", () => {
  assert.deepEqual(parseArgs(["--non-interactive"], { defaultAgentsDir, resolvePath, env: {} }), {
    agentsDir: defaultAgentsDir,
    force: false,
    relinkOnly: false,
    nonInteractive: true,
    command: "menu"
  });
});

test("parseArgs auto-enables nonInteractive when CI environment is set", () => {
  assert.deepEqual(parseArgs([], { defaultAgentsDir, resolvePath, env: { CI: "true" } }), {
    agentsDir: defaultAgentsDir,
    force: false,
    relinkOnly: false,
    nonInteractive: true,
    command: "menu"
  });
});

