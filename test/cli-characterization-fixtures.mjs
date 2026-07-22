import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInteractiveMenuSupported, parseArgs } from "../lib/cli/args.mjs";
import {
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
} from "../lib/cli/prompts.mjs";
import {
  applyClaudeInsecureTlsSetting,
  buildDefaultClaudeSettings,
  mergeClaudeSettingsWithDefaults
} from "../lib/providers/claude.mjs";
import { mergeCodexAuthData, resolveExistingCodexApiConfig } from "../lib/providers/codex.mjs";
import {
  buildPiAuthConfig,
  buildPiModelsConfig,
  buildPiSettingsConfig,
  getPiApiPromptOptions,
  inferPiApiFromBaseUrl,
  normalizeOpenAiBaseUrl,
  parsePiModelIds,
  resolveExistingPiApiConfig
} from "../lib/providers/pi.mjs";
import { hasPromptEnhancerApiConfig, resolvePromptEnhancerMode } from "../lib/providers/skills.mjs";
import { stripJsonComments } from "../lib/config/jsonc.mjs";
import {
  buildCliToolInstallCommand,
  chooseCliInstallPackageManager,
  getPackageManagerInstallHelp,
  getRunCommandSpawnOptions,
  inferPackageManagerFromCommandPath
} from "../lib/tools/cli-installer.mjs";
import { piInsecureTlsHeader } from "../extensions/pi-gpt-responses-compat/tls-fetch.mjs";

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
    "skills",
    "extensions",
    "AGENTS.md",
    "README.md",
    "package.json",
    ".gitignore"
  ]) {
    cpSync(new URL(entry, repoRoot), join(agentsDir, entry), { recursive: true });
  }
  symlinkSync(new URL("node_modules", repoRoot), join(agentsDir, "node_modules"), "dir");
}

const expectedMenuDescriptors = [
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

function assertParse(argv, expected) {
  assert.deepEqual(parseArgs(argv, { defaultAgentsDir, resolvePath }), expected);
}

function assertParseError(argv, expectedMessage) {
  assert.throws(
    () => parseArgs(argv, { defaultAgentsDir, resolvePath }),
    (error) => error instanceof Error && error.message === expectedMessage
  );
}

export {
  applyClaudeInsecureTlsSetting,
  assert,
  assertInteractiveMenuSupported,
  assertNotCancelled,
  assertParse,
  assertParseError,
  buildCliToolInstallCommand,
  buildCliToolMenuDescriptors,
  buildDefaultClaudeSettings,
  buildPiAuthConfig,
  buildPiModelsConfig,
  buildPiSettingsConfig,
  CancelledError,
  chooseCliInstallPackageManager,
  confirmOrCancel,
  copySourceInstallFixture,
  defaultAgentsDir,
  existsSync,
  expectedMenuDescriptors,
  getPackageManagerInstallHelp,
  getPiApiPromptOptions,
  getRunCommandSpawnOptions,
  hasPromptEnhancerApiConfig,
  inferPackageManagerFromCommandPath,
  inferPiApiFromBaseUrl,
  interactiveMenuDefaultValue,
  interactiveMenuDescriptors,
  join,
  lstatSync,
  mergeClaudeSettingsWithDefaults,
  mergeCodexAuthData,
  mkdirSync,
  mkdtempAgentsHome,
  normalizeOpenAiBaseUrl,
  parseArgs,
  parsePiModelIds,
  passwordPromptOptions,
  piInsecureTlsHeader,
  readFileSync,
  required,
  requiredUnlessExisting,
  resolveExistingCodexApiConfig,
  resolveExistingPiApiConfig,
  resolvePasswordValue,
  resolvePath,
  resolvePromptEnhancerMode,
  repoRoot,
  rmSync,
  selectOrCancel,
  spawnSync,
  stripJsonComments,
  symlinkSync,
  test,
  writeFileSync
};
