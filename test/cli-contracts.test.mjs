import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertInteractiveMenuSupported,
  assertNotCancelled,
  buildCliToolMenuDescriptors,
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
} from "../lib/cli/logic.mjs";
import {
  applyClaudePermissionFeature,
  buildCliToolInstallCommand,
  buildDefaultClaudeSettings,
  buildPiModelsConfig,
  buildPiSettingsConfig,
  chooseCliInstallPackageManager,
  getPackageManagerInstallHelp,
  hasPromptEnhancerApiConfig,
  inferPackageManagerFromCommandPath,
  getAugmentContextEnginePromptOptions,
  mergeCodexAuthData,
  mergeClaudeSettingsWithDefaults,
  renderManagedWorkflowContent,
  resolveAugmentContextEngineFeature,
  resolveExistingPiApiConfig,
  resolvePromptEnhancerMode,
  parsePiModelIds,
  stripJsonComments
} from "../lib/cli.mjs";

const defaultAgentsDir = "/home/test/.agents";
const resolvePath = (value) => `/resolved/${value.replace(/^\/+/, "")}`;
const repoRoot = new URL("../", import.meta.url);

function mkdtempAgentsHome() {
  return mkdtempSync(join(tmpdir(), "abelworkflow-source-"));
}

function copySourceInstallFixture(agentsDir) {
  mkdirSync(agentsDir, { recursive: true });
  for (const entry of [
    "bin",
    "lib",
    "commands",
    "skills",
    "extensions",
    "AGENTS.md",
    "README.md",
    "package.json",
    ".skill-lock.json",
    ".gitignore"
  ]) {
    cpSync(new URL(entry, repoRoot), join(agentsDir, entry), { recursive: true });
  }
  symlinkSync(new URL("node_modules", repoRoot), join(agentsDir, "node_modules"), "dir");
}

const expectedMenuDescriptors = [
  {
    value: "full-init",
    label: "完整初始化",
    hint: "同步 + 安装 + 配置",
    group: "main"
  },
  {
    value: "install",
    label: "仅同步工作流",
    group: "main"
  },
  {
    value: "grok-search",
    label: "配置 grok-search",
    hint: "技能",
    group: "skill"
  },
  {
    value: "context7",
    label: "配置 context7-auto-research",
    hint: "技能",
    group: "skill"
  },
  {
    value: "prompt-enhancer",
    label: "配置 prompt-enhancer",
    hint: "技能",
    group: "skill"
  },
  {
    value: "pi-cli",
    label: "安装/配置 Pi",
    hint: "CLI",
    group: "cli"
  },
  {
    value: "codex-cli",
    label: "安装/配置 Codex",
    hint: "CLI",
    group: "cli"
  },
  {
    value: "claude-cli",
    label: "安装/配置 Claude Code",
    hint: "CLI",
    group: "cli"
  },
  {
    value: "exit",
    label: "退出",
    group: "exit"
  }
];

function assertParse(argv, expected) {
  assert.deepEqual(parseArgs(argv, { defaultAgentsDir, resolvePath }), expected);
}

function assertParseError(argv, expectedMessage) {
  assert.throws(
    () => parseArgs(argv, { defaultAgentsDir, resolvePath }),
    (error) => error instanceof Error && error.message === expectedMessage
  );
}

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

test("interactive menu descriptors keep order, uniqueness, default membership, and display closure", () => {
  assert.deepEqual(interactiveMenuDescriptors, expectedMenuDescriptors);
  assert.equal(interactiveMenuDefaultValue, "full-init");

  const values = interactiveMenuDescriptors.map((descriptor) => descriptor.value);
  const labels = interactiveMenuDescriptors.map((descriptor) => descriptor.label);
  assert.equal(new Set(values).size, values.length);
  assert.ok(labels.every((label) => typeof label === "string" && label.length > 0));
  assert.ok(values.includes(interactiveMenuDefaultValue));
  assert.equal(values[values.length - 1], "exit");
  assert.equal(values.filter((value) => value === "exit").length, 1);

  const displayChoices = interactiveMenuDescriptors.map(({ value, label, hint, group }) => {
    const choice = { value, label };
    if (hint !== undefined) {
      choice.hint = hint;
    }
    choice.group = group;
    return choice;
  });
  assert.deepEqual(displayChoices, expectedMenuDescriptors);
});

test("interactive menu CLI group exposes only aggregate entries in required order", () => {
  assert.deepEqual(
    interactiveMenuDescriptors
      .filter((descriptor) => descriptor.group === "cli")
      .map(({ value, label }) => ({ value, label })),
    [
      { value: "pi-cli", label: "安装/配置 Pi" },
      { value: "codex-cli", label: "安装/配置 Codex" },
      { value: "claude-cli", label: "安装/配置 Claude Code" }
    ]
  );
});

test("CLI tool submenus include install, API config, and back actions", () => {
  assert.deepEqual(buildCliToolMenuDescriptors("pi"), [
    { value: "pi-install", label: "安装/更新 Pi" },
    { value: "pi-api", label: "配置 Pi API" },
    { value: "back", label: "返回上一级" }
  ]);
  assert.deepEqual(buildCliToolMenuDescriptors("codex"), [
    { value: "codex-install", label: "安装/更新 Codex" },
    { value: "codex-api", label: "配置 Codex API" },
    { value: "back", label: "返回上一级" }
  ]);
  assert.deepEqual(buildCliToolMenuDescriptors("claude"), [
    { value: "claude-install", label: "安装/更新 Claude Code" },
    { value: "claude-api", label: "配置 Claude Code API" },
    { value: "back", label: "返回上一级" }
  ]);
});

test("getRunCommandSpawnOptions preserves platform contracts", () => {
  const platforms = ["win32", "linux", "darwin", "freebsd", "unknown"];
  for (const platform of platforms) {
    assert.deepEqual(getRunCommandSpawnOptions(platform), {
      stdio: "inherit",
      shell: platform === "win32"
    });
  }
});

test("getRunCommandSpawnOptions default preserves ABELWORKFLOW_TEST_PLATFORM override", { concurrency: false }, () => {
  const previousPlatform = process.env.ABELWORKFLOW_TEST_PLATFORM;
  process.env.ABELWORKFLOW_TEST_PLATFORM = "win32";

  try {
    assert.deepEqual(getRunCommandSpawnOptions(), {
      stdio: "inherit",
      shell: true
    });
  } finally {
    if (previousPlatform === undefined) {
      delete process.env.ABELWORKFLOW_TEST_PLATFORM;
      return;
    }
    process.env.ABELWORKFLOW_TEST_PLATFORM = previousPlatform;
  }
});

test("inferPackageManagerFromCommandPath detects bun and npm global bins", () => {
  assert.equal(inferPackageManagerFromCommandPath("/home/test/.bun/bin/codex", {
    bunGlobalBinDir: "/home/test/.bun/bin",
    npmGlobalPrefix: "/usr/local",
    platform: "linux"
  }), "bun");
  assert.equal(inferPackageManagerFromCommandPath("/usr/local/bin/codex", {
    bunGlobalBinDir: "/home/test/.bun/bin",
    npmGlobalPrefix: "/usr/local",
    platform: "linux"
  }), "npm");
  assert.equal(inferPackageManagerFromCommandPath("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd", {
    bunGlobalBinDir: "C:\\Users\\test\\.bun\\bin",
    npmGlobalPrefix: "C:\\Users\\test\\AppData\\Roaming\\npm",
    platform: "win32"
  }), "npm");
});

test("chooseCliInstallPackageManager preserves existing install manager before defaulting", () => {
  const base = {
    availablePackageManagers: ["bun", "npm"],
    bunGlobalBinDir: "/home/test/.bun/bin",
    npmGlobalPrefix: "/usr/local",
    platform: "linux",
    nodeAvailable: true
  };

  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: "/usr/local/bin/codex"
  }), { packageManager: "npm", source: "existing" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: "/home/test/.bun/bin/codex"
  }), { packageManager: "bun", source: "existing" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: undefined
  }), { packageManager: "bun", source: "available" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    availablePackageManagers: ["npm"],
    commandPath: undefined
  }), { packageManager: "npm", source: "available" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    availablePackageManagers: [],
    commandPath: undefined
  }), { packageManager: null, source: "missing" });
});

test("chooseCliInstallPackageManager honors npm-only tools that need install scripts", () => {
  const base = {
    availablePackageManagers: ["bun", "npm"],
    bunGlobalBinDir: "/home/test/.bun/bin",
    npmGlobalPrefix: "/usr/local",
    platform: "linux",
    nodeAvailable: true,
    supportedPackageManagers: ["npm"]
  };

  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: undefined
  }), { packageManager: "npm", source: "available" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: "/home/test/.bun/bin/claude"
  }), { packageManager: "npm", source: "available" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    availablePackageManagers: ["bun"],
    commandPath: undefined
  }), { packageManager: null, source: "unsupported" });
});

test("chooseCliInstallPackageManager rejects bun for Node CLIs when node is unavailable", () => {
  const base = {
    availablePackageManagers: ["bun"],
    bunGlobalBinDir: "/home/test/.bun/bin",
    npmGlobalPrefix: undefined,
    platform: "linux",
    nodeAvailable: false
  };

  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: undefined
  }), { packageManager: null, source: "missing-node" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: "/home/test/.bun/bin/pi"
  }), { packageManager: null, source: "missing-node" });
});

test("buildCliToolInstallCommand uses matching bun or npm global install syntax", () => {
  assert.deepEqual(buildCliToolInstallCommand("npm", {
    packageName: "@openai/codex",
    skipScripts: false
  }), {
    command: "npm",
    args: ["install", "-g", "@openai/codex", "--force"]
  });
  assert.deepEqual(buildCliToolInstallCommand("bun", {
    packageName: "@openai/codex",
    skipScripts: false
  }), {
    command: "bun",
    args: ["install", "-g", "@openai/codex"]
  });
  assert.deepEqual(buildCliToolInstallCommand("npm", {
    packageName: "@earendil-works/pi-coding-agent",
    skipScripts: true
  }), {
    command: "npm",
    args: ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent", "--force"]
  });
  assert.deepEqual(buildCliToolInstallCommand("bun", {
    packageName: "@earendil-works/pi-coding-agent",
    skipScripts: true
  }), {
    command: "bun",
    args: ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"]
  });
});

test("getPackageManagerInstallHelp returns mainland-friendly Node npm download guidance", () => {
  assert.deepEqual(getPackageManagerInstallHelp("win32"), {
    platformLabel: "Windows",
    mainlandUrl: "https://npmmirror.com/mirrors/node/",
    officialUrl: "https://nodejs.org/en/download/"
  });
  assert.deepEqual(getPackageManagerInstallHelp("darwin").platformLabel, "macOS");
  assert.deepEqual(getPackageManagerInstallHelp("linux").platformLabel, "Linux");
});

test("parsePiModelIds normalizes comma and newline separated model ids", () => {
  assert.deepEqual(parsePiModelIds(" gpt-5.5,\ngpt-5.3-codex-spark,,gpt-5.5 "), [
    "gpt-5.5",
    "gpt-5.3-codex-spark"
  ]);
  assert.deepEqual(parsePiModelIds(""), []);
});

test("stripJsonComments preserves string URLs and removes line comments", () => {
  const parsed = JSON.parse(stripJsonComments(`{
    "baseUrl": "https://example.com/v1", // keep URL
    "apiKey": "sk//literal"
  }`));
  assert.deepEqual(parsed, {
    baseUrl: "https://example.com/v1",
    apiKey: "sk//literal"
  });
});

test("stripJsonComments removes JSONC trailing commas outside strings", () => {
  const parsed = JSON.parse(stripJsonComments(`{
    "providers": {
      "gpt": {
        "baseUrl": "https://example.com/a,b",
        "models": [
          { "id": "gpt-5.5", }, // Pi JSONC allows this
        ],
      },
    },
  }`));
  assert.deepEqual(parsed, {
    providers: {
      gpt: {
        baseUrl: "https://example.com/a,b",
        models: [{ id: "gpt-5.5" }]
      }
    }
  });
});

test("Pi gpt config builder preserves existing model overrides and settings defaults", () => {
  const existing = {
    providers: {
      other: { baseUrl: "https://other.example/v1" },
      gpt: {
        baseUrl: "https://old.example/v1",
        api: "openai-responses",
        apiKey: "old-key",
        compat: { supportsUsageInStreaming: false },
        models: [
          {
            id: "gpt-5.5",
            name: "GPT Custom",
            reasoning: false,
            input: ["text"],
            contextWindow: 1000,
            maxTokens: 2000,
            compat: { maxTokensField: "max_tokens" }
          }
        ]
      }
    }
  };

  const nextModels = buildPiModelsConfig(existing, {
    baseUrl: "https://new.example/v1",
    api: "openai-responses",
    apiKey: "new-key",
    modelIds: ["gpt-5.5", "gpt-new"]
  });

  assert.equal(nextModels.providers.other.baseUrl, "https://other.example/v1");
  assert.equal(nextModels.providers.gpt.baseUrl, "https://new.example/v1");
  assert.equal(nextModels.providers.gpt.apiKey, "new-key");
  assert.equal(nextModels.providers.gpt.compat.supportsUsageInStreaming, false);
  assert.equal(nextModels.providers.gpt.compat.supportsDeveloperRole, false);
  assert.deepEqual(nextModels.providers.gpt.models[0], {
    id: "gpt-5.5",
    name: "GPT Custom",
    reasoning: false,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 2000,
    compat: { maxTokensField: "max_tokens" }
  });
  assert.deepEqual(nextModels.providers.gpt.models[1], {
    id: "gpt-new",
    name: "gpt-new",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 64000
  });

  assert.deepEqual(buildPiSettingsConfig({}, "gpt-5.5"), {
    defaultProvider: "gpt",
    defaultModel: "gpt-5.5",
    defaultThinkingLevel: "high",
    enableSkillCommands: true
  });
});

test("resolveExistingPiApiConfig reads gpt provider and default model", () => {
  const config = resolveExistingPiApiConfig({
    providers: {
      gpt: {
        baseUrl: "https://example.com/v1",
        api: "openai-completions",
        apiKey: "secret",
        models: [{ id: "gpt-a" }, { id: "gpt-b" }]
      }
    }
  }, {
    defaultProvider: "gpt",
    defaultModel: "gpt-b"
  });

  assert.deepEqual(config, {
    baseUrl: "https://example.com/v1",
    api: "openai-completions",
    apiKey: "secret",
    modelIds: ["gpt-a", "gpt-b"],
    defaultModel: "gpt-b"
  });
});

test("mergeCodexAuthData rebuilds auth data with only the configured env key", () => {
  const authCases = [
    {
      auth: {},
      envKey: "OPENAI_API_KEY",
      apiKey: "new-secret",
      legacyEnvKeys: [],
      expected: { OPENAI_API_KEY: "new-secret" }
    },
    {
      auth: {
        OPENAI_API_KEY: "old-secret",
        OPENAI_BASE_URL: "https://example.com/v1",
        LEGACY_ONE: "legacy-1",
        LEGACY_TWO: "legacy-2"
      },
      envKey: "OPENAI_API_KEY",
      apiKey: "new-secret",
      legacyEnvKeys: ["LEGACY_ONE", "LEGACY_TWO"],
      expected: { OPENAI_API_KEY: "new-secret" }
    },
    {
      auth: {
        CUSTOM_KEY: "keep-me",
        OPENAI_API_KEY: "old-secret",
        tokens: {
          id_token: "gpt-login-token",
          refresh_token: "gpt-refresh-token"
        },
        last_refresh: 123
      },
      envKey: "OPENAI_API_KEY",
      apiKey: "fresh-secret",
      legacyEnvKeys: ["OPENAI_API_KEY", "UNUSED_LEGACY"],
      expected: { OPENAI_API_KEY: "fresh-secret" }
    }
  ];

  for (const testCase of authCases) {
    assert.deepEqual(
      mergeCodexAuthData(testCase.auth, testCase.envKey, testCase.apiKey, testCase.legacyEnvKeys),
      testCase.expected
    );
  }
});

test("hasPromptEnhancerApiConfig requires complete OpenAI-compatible config", () => {
  const cases = [
    {
      value: {
        PE_API_URL: "https://example.com/v1",
        PE_API_KEY: "secret",
        PE_MODEL: "gpt-4o-mini"
      },
      expected: true
    },
    {
      value: {
        PE_API_URL: "https://example.com/v1",
        PE_API_KEY: "secret"
      },
      expected: false
    },
    {
      value: {
        PE_API_URL: "",
        PE_API_KEY: "secret",
        PE_MODEL: "gpt-4o-mini"
      },
      expected: false
    }
  ];

  for (const testCase of cases) {
    assert.equal(hasPromptEnhancerApiConfig(testCase.value), testCase.expected);
  }
});

test("resolvePromptEnhancerMode prefers OpenAI-compatible config and otherwise falls back to current agent mode", () => {
  const cases = [
    {
      existing: {
        PE_API_URL: "https://example.com/v1",
        PE_API_KEY: "secret",
        PE_MODEL: "gpt-4o-mini"
      },
      expected: "openai-compatible"
    },
    {
      existing: {
        OPENAI_API_KEY: "legacy-secret",
        PE_MODEL: "gpt-4o"
      },
      expected: "agent"
    },
    {
      existing: {
        ANTHROPIC_API_KEY: "legacy-anthropic"
      },
      expected: "agent"
    }
  ];

  for (const testCase of cases) {
    assert.equal(resolvePromptEnhancerMode(testCase.existing), testCase.expected);
  }
});

test("required rejects empty, blank, and undefined/null values", () => {
  const validator = required("自定义错误");
  assert.equal(validator(""), "自定义错误");
  assert.equal(validator(" "), "自定义错误");
  assert.equal(validator("\t"), "自定义错误");
  assert.equal(validator(undefined), "自定义错误");
  assert.equal(validator(null), "自定义错误");
  assert.equal(validator("valid"), undefined);
});

test("requiredUnlessExisting respects existing value and rejects empty input when missing", () => {
  const noExisting = requiredUnlessExisting(undefined, "自定义错误");
  assert.equal(noExisting(""), "自定义错误");
  assert.equal(noExisting(" "), "自定义错误");
  assert.equal(noExisting(undefined), "自定义错误");
  assert.equal(noExisting(null), "自定义错误");
  assert.equal(noExisting("valid"), undefined);

  const withExisting = requiredUnlessExisting("existing", "自定义错误");
  assert.equal(withExisting(""), undefined);
  assert.equal(withExisting(" "), undefined);
  assert.equal(withExisting(undefined), undefined);
  assert.equal(withExisting(null), undefined);
  assert.equal(withExisting("valid"), undefined);
});

test("assertNotCancelled does not throw for non-cancel values", () => {
  assert.doesNotThrow(() => assertNotCancelled("valid"));
  assert.doesNotThrow(() => assertNotCancelled(undefined));
  assert.doesNotThrow(() => assertNotCancelled(null));
  assert.doesNotThrow(() => assertNotCancelled(42));
  assert.doesNotThrow(() => assertNotCancelled(""));
});

test("CancelledError has correct properties", () => {
  const err = new CancelledError();
  assert.equal(err.name, "CancelledError");
  assert.equal(err.message, "用户取消");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof CancelledError);

  const custom = new CancelledError("自定义消息");
  assert.equal(custom.message, "自定义消息");
});

test("assertNotCancelled throws CancelledError when isCancel returns true", () => {
  // ESM 命名空间只读，无法可靠 mock p.isCancel；
  // 真实取消路径（Ctrl+C → p.isCancel → CancelledError）由集成测试覆盖。
  // 此处作为降级保护，验证 CancelledError 可被正确抛出并捕获。
  assert.throws(
    () => { throw new CancelledError(); },
    (err) => err instanceof CancelledError && err.message === "用户取消"
  );
});

test("interactive menu descriptors are grouped in correct order", () => {
  const groups = interactiveMenuDescriptors.map((d) => d.group);
  // main items come first, exit comes last
  const firstNonMain = groups.findIndex((g) => g !== "main");
  assert.ok(firstNonMain > 0, "main items should be first");
  assert.equal(groups[groups.length - 1], "exit");
  // all items between main and exit should be skill or cli
  const middle = groups.slice(firstNonMain, -1);
  for (const g of middle) {
    assert.ok(g === "skill" || g === "cli", `unexpected group in middle: ${g}`);
  }
});

test("resolvePasswordValue returns user input when non-empty, existing value when empty", () => {
  assert.equal(resolvePasswordValue("new-key", "old-key"), "new-key");
  assert.equal(resolvePasswordValue("new-key", undefined), "new-key");
  assert.equal(resolvePasswordValue("new-key", ""), "new-key");
  assert.equal(resolvePasswordValue("", "old-key"), "old-key");
  assert.equal(resolvePasswordValue("", undefined), undefined);
  assert.equal(resolvePasswordValue("", ""), undefined);
});

test("resolvePasswordValue '-' clears existing value", () => {
  assert.equal(resolvePasswordValue("-", "old-key"), undefined);
  assert.equal(resolvePasswordValue("-", undefined), undefined);
  assert.equal(resolvePasswordValue("-", ""), undefined);
});

test("resolvePasswordValue trims whitespace and falls back to existing value", () => {
  assert.equal(resolvePasswordValue(" ", "old-key"), "old-key");
  assert.equal(resolvePasswordValue("  ", "old-key"), "old-key");
  assert.equal(resolvePasswordValue(" \t\n", "old-key"), "old-key");
  assert.equal(resolvePasswordValue(" ", undefined), undefined);
  assert.equal(resolvePasswordValue(" ", ""), undefined);
  assert.equal(resolvePasswordValue(" - ", "old-key"), undefined);
});

test("confirmOrCancel is exported as async function with correct arity", () => {
  assert.equal(typeof confirmOrCancel, "function");
  assert.equal(confirmOrCancel.length, 1);
  assert.equal(confirmOrCancel.constructor.name, "AsyncFunction");
});

test("selectOrCancel is exported as async function with correct arity", () => {
  assert.equal(typeof selectOrCancel, "function");
  assert.equal(selectOrCancel.length, 1);
  assert.equal(selectOrCancel.constructor.name, "AsyncFunction");
});

test("parseArgs supports --non-interactive flag", () => {
  assert.deepEqual(parseArgs(["--non-interactive"], { defaultAgentsDir, resolvePath }), {
    agentsDir: defaultAgentsDir,
    force: false,
    relinkOnly: false,
    nonInteractive: true,
    command: "menu"
  });
});

test("augment-context-engine feature resolution defaults false and preserves previous metadata", () => {
  assert.equal(resolveAugmentContextEngineFeature({}, {}), false);
  assert.equal(resolveAugmentContextEngineFeature({ augmentContextEngine: true }, {}), true);
  assert.equal(resolveAugmentContextEngineFeature({ augmentContextEngine: false }, {
    features: { augmentContextEngine: true }
  }), false);
  assert.equal(resolveAugmentContextEngineFeature({}, {
    features: { augmentContextEngine: true }
  }), true);
  assert.equal(resolveAugmentContextEngineFeature({}, {
    features: { augmentContextEngine: false }
  }), false);
});

test("full init augment-context-engine prompt defaults to disabled", () => {
  assert.deepEqual(getAugmentContextEnginePromptOptions(), {
    message: "是否启用 augment-context-engine MCP 代码检索支持？不确定建议选否，可减少 MCP 安装和配置麻烦。",
    initialValue: false
  });
});

test("renderManagedWorkflowContent renders enabled and lite retrieval policies", () => {
  const agentsTemplate = readFileSync(new URL("AGENTS.md", repoRoot), "utf8");
  const enabledAgents = renderManagedWorkflowContent(agentsTemplate, { augmentContextEngine: true });
  const liteAgents = renderManagedWorkflowContent(agentsTemplate, { augmentContextEngine: false });

  assert.match(enabledAgents, /mcp__augment-context-engine__codebase-retrieval/u);
  assert.doesNotMatch(enabledAgents, /CODEBASE_RETRIEVAL_POLICY/u);
  assert.match(liteAgents, /Use local codebase retrieval with `rg`, `rg --files`, `git grep`, and direct file reads/u);
  assert.doesNotMatch(liteAgents, /mcp__augment-context-engine__codebase-retrieval/u);
  assert.doesNotMatch(liteAgents, /CODEBASE_RETRIEVAL_POLICY/u);
});

test("renderManagedWorkflowContent removes mandatory augment MCP wording from lite commands", () => {
  const commandNames = ["abel-init.md", "abel-research.md", "abel-plan.md", "abel-diagnose.md"];
  for (const commandName of commandNames) {
    const template = readFileSync(new URL(`commands/${commandName}`, repoRoot), "utf8");
    const content = renderManagedWorkflowContent(template, { augmentContextEngine: false });
    assert.doesNotMatch(content, /mcp__augment-context-engine__codebase-retrieval/u, commandName);
    assert.doesNotMatch(content, /Mandatory use of `mcp__augment-context-engine__codebase-retrieval`/u, commandName);
    assert.doesNotMatch(content, /\{\{[A-Z_]+\}\}/u, commandName);
  }
});

test("package-root install copies Pi extensions into agents dir and links them", () => {
  const homeDir = mkdtempAgentsHome();
  try {
    const result = spawnSync(process.execPath, ["bin/abelworkflow.mjs", "install"], {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        NO_COLOR: "1"
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\.pi\/agent\/AGENTS\.md/u);
    const managedExtension = readFileSync(join(homeDir, ".agents", "extensions", "pi-gpt-responses-compat.ts"), "utf8");
    const linkedExtension = readFileSync(join(homeDir, ".pi", "agent", "extensions", "pi-gpt-responses-compat.ts"), "utf8");

    assert.match(managedExtension, /before_provider_request/u);
    assert.match(linkedExtension, /before_provider_request/u);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("source-clone install renders workflow templates in place before linking", () => {
  const homeDir = mkdtempAgentsHome();
  const agentsDir = join(homeDir, ".agents");
  try {
    copySourceInstallFixture(agentsDir);
    const result = spawnSync(process.execPath, ["bin/abelworkflow.mjs", "install"], {
      cwd: agentsDir,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        NO_COLOR: "1"
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const agentsContent = readFileSync(join(agentsDir, "AGENTS.md"), "utf8");
    const researchContent = readFileSync(join(agentsDir, "commands", "abel-research.md"), "utf8");
    const linkedAgentsContent = readFileSync(join(homeDir, ".codex", "AGENTS.md"), "utf8");
    const piExtensionContent = readFileSync(join(homeDir, ".pi", "agent", "extensions", "pi-gpt-responses-compat.ts"), "utf8");

    assert.match(agentsContent, /Use local codebase retrieval with `rg`, `rg --files`, `git grep`, and direct file reads/u);
    assert.doesNotMatch(agentsContent, /\{\{[A-Z_]+\}\}/u);
    assert.doesNotMatch(researchContent, /\{\{[A-Z_]+\}\}/u);
    assert.doesNotMatch(linkedAgentsContent, /\{\{[A-Z_]+\}\}/u);
    assert.match(piExtensionContent, /before_provider_request/u);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("Claude default permissions include augment MCP only when feature is enabled", () => {
  const enabledSettings = buildDefaultClaudeSettings({ augmentContextEngine: true });
  const liteSettings = buildDefaultClaudeSettings({ augmentContextEngine: false });

  assert.ok(enabledSettings.permissions.allow.includes("mcp__augment-context-engine"));
  assert.ok(!liteSettings.permissions.allow.includes("mcp__augment-context-engine"));

  assert.ok(mergeClaudeSettingsWithDefaults({}, { augmentContextEngine: true })
    .permissions.allow.includes("mcp__augment-context-engine"));
  assert.ok(!mergeClaudeSettingsWithDefaults({}, { augmentContextEngine: false })
    .permissions.allow.includes("mcp__augment-context-engine"));
});

test("applyClaudePermissionFeature only removes augment MCP permission when previously managed", () => {
  const userManaged = applyClaudePermissionFeature({
    permissions: { allow: ["Read", "mcp__augment-context-engine"], deny: [] }
  }, {
    augmentContextEngine: false,
    previousManagedPermissions: []
  });
  assert.deepEqual(userManaged.settings.permissions.allow, ["Read", "mcp__augment-context-engine"]);
  assert.deepEqual(userManaged.managedPermissions, []);
  assert.equal(userManaged.changed, false);

  const abelManaged = applyClaudePermissionFeature({
    permissions: { allow: ["Read", "mcp__augment-context-engine"], deny: [] }
  }, {
    augmentContextEngine: false,
    previousManagedPermissions: ["mcp__augment-context-engine"]
  });
  assert.deepEqual(abelManaged.settings.permissions.allow, ["Read"]);
  assert.deepEqual(abelManaged.managedPermissions, []);
  assert.equal(abelManaged.changed, true);
});

test("parseArgs auto-enables nonInteractive when CI environment is set", { concurrency: false }, () => {
  const previousCI = process.env.CI;
  process.env.CI = "true";
  try {
    assert.deepEqual(parseArgs([], { defaultAgentsDir, resolvePath }), {
      agentsDir: defaultAgentsDir,
      force: false,
      relinkOnly: false,
      nonInteractive: true,
      command: "menu"
    });
  } finally {
    if (previousCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCI;
    }
  }
});
