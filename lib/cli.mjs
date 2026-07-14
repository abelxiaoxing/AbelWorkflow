import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, link, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import c from "picocolors";
import lockfile from "proper-lockfile";
import { piInsecureTlsHeader } from "../extensions/pi-gpt-responses-compat/tls-fetch.mjs";
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
} from "./cli/logic.mjs";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(__filename));
const home = homedir();
const defaultAgentsDir = join(home, ".agents");
const installMetadataName = ".abelworkflow-install.json";
const claudeSettingsPath = join(home, ".claude", "settings.json");
const claudeMetaConfigPath = join(home, ".claude.json");
const codexConfigPath = join(home, ".codex", "config.toml");
const codexAuthPath = join(home, ".codex", "auth.json");
const codexTemplateRoot = join(packageRoot, "lib", "templates", "codex");
const codexTemplateConfigPath = join(codexTemplateRoot, "config-base.toml");
const codexTemplateAgentsPath = join(codexTemplateRoot, "agents");
const piAgentDir = join(home, ".pi", "agent");
const piAuthPath = join(piAgentDir, "auth.json");
const piModelsPath = join(piAgentDir, "models.json");
const piSettingsPath = join(piAgentDir, "settings.json");
const piProviderId = "gpt";
const piDefaultApi = "openai-completions";
const piDefaultBaseUrl = "https://api.openai.com/v1";
const piDefaultModel = "gpt-5.5";
const piAuthLockOptions = {
  stale: 30000,
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10000,
    randomize: true
  }
};
const installBackupStamp = Date.now();
const createdBackupPaths = new Set();
const augmentContextEnginePermission = "mcp__augment-context-engine";
const augmentContextEngineRetrievalTool = "mcp__augment-context-engine__codebase-retrieval";
const augmentContextEngineFeaturePrompt = {
  message: "是否启用 augment-context-engine MCP 代码检索支持？不确定建议选否，可减少 MCP 安装和配置麻烦。",
  initialValue: false
};
const localCodebaseRetrievalPolicy = "Use local codebase retrieval with `rg`, `rg --files`, `git grep`, and direct file reads. Do not require augment-context-engine MCP.";
const augmentCodebaseRetrievalPolicy = `Use \`${augmentContextEngineRetrievalTool}\` as the primary codebase search tool.`;
const claudeModelEnvKeys = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL"
];
const defaultClaudeSettings = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  env: {
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_BASE_URL: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: "",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
    CLAUDE_CODE_SUBAGENT_MODEL: "",
    API_TIMEOUT_MS: "1000000"
  },
  includeCoAuthoredBy: false,
  permissions: {
    allow: [
      "Bash",
      "Skill",
      "LS",
      "Read",
      "Agent",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      "NotebookRead",
      "NotebookEdit"
    ],
    deny: []
  },
  hooks: {},
  alwaysThinkingEnabled: true,
  language: "Chinese"
};
const managedEntries = [
  { target: "AGENTS.md" },
  { target: "README.md" },
  { target: "commands", preserveExisting: true },
  { target: "skills", preserveExisting: true, filter: shouldCopySkillPath },
  { target: "extensions", preserveExisting: true },
  { target: ".skill-lock.json" },
  { target: ".gitignore", sourceCandidates: [".gitignore", ".npmignore"] }
];
const ignoredSkillPathPatterns = [
  /(^|\/)\.env$/,
  /(^|\/)\.venv(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)tmp(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /^dev-browser\/profiles(\/|$)/,
  /^dev-browser\/tmp(\/|$)/
];

function buildDefaultClaudeSettings({ augmentContextEngine = false } = {}) {
  const settings = {
    ...defaultClaudeSettings,
    env: { ...defaultClaudeSettings.env },
    permissions: {
      ...defaultClaudeSettings.permissions,
      allow: [...defaultClaudeSettings.permissions.allow],
      deny: [...defaultClaudeSettings.permissions.deny]
    },
    hooks: { ...defaultClaudeSettings.hooks }
  };

  if (augmentContextEngine && !settings.permissions.allow.includes(augmentContextEnginePermission)) {
    settings.permissions.allow.push(augmentContextEnginePermission);
  }

  return settings;
}

function getAugmentContextEnginePromptOptions() {
  return { ...augmentContextEngineFeaturePrompt };
}

function resolveAugmentContextEngineFeature(options = {}, previousMetadata = {}) {
  if (typeof options.augmentContextEngine === "boolean") {
    return options.augmentContextEngine;
  }

  if (typeof previousMetadata?.features?.augmentContextEngine === "boolean") {
    return previousMetadata.features.augmentContextEngine;
  }

  return false;
}

function getWorkflowRenderValues(augmentContextEngine) {
  return {
    CODEBASE_RETRIEVAL_POLICY: augmentContextEngine
      ? augmentCodebaseRetrievalPolicy
      : localCodebaseRetrievalPolicy,
    AUGMENT_CONTEXT_ENGINE_VALIDATION: augmentContextEngine
      ? `Verify MCP availability:\n   - \`${augmentContextEngineRetrievalTool}\``
      : "Skip augment-context-engine MCP validation; use local retrieval tools.",
    CODEBASE_RETRIEVAL_MANDATORY_RULE: augmentContextEngine
      ? `Mandatory use of \`${augmentContextEngineRetrievalTool}\``
      : "Mandatory use of configured codebase retrieval policy.",
    CODEBASE_RETRIEVAL_STRUCTURE_REFERENCE: augmentContextEngine
      ? `Inspect codebase structure: \`${augmentContextEngineRetrievalTool}\` with \`file list --recursive\`.`
      : "Inspect codebase structure with `rg --files`, `git grep`, and direct file reads.",
    CODEBASE_RETRIEVAL_PATTERN_AUDIT: augmentContextEngine
      ? `Use augment-context-engine to validate against existing codebase patterns.\n   ${augmentContextEngineRetrievalTool}: "Search for existing implementations similar to change <change_name>. Keywords: [key concepts from proposal]"`
      : "Use `rg`, `rg --files`, `git grep`, and direct file reads to validate against existing codebase patterns."
  };
}

function renderManagedWorkflowContent(content, { augmentContextEngine = false } = {}) {
  let nextContent = content;
  for (const [key, value] of Object.entries(getWorkflowRenderValues(augmentContextEngine))) {
    nextContent = nextContent.replaceAll(`{{${key}}}`, value);
  }
  return nextContent;
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

function pathToLabel(path) {
  return path.replace(home, "~");
}

function maskSecret(value) {
  if (!value) {
    return "未配置";
  }
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }
  return `${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectLineEnding(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function collapseBlankLines(content, lineEnding) {
  return content.replace(/(?:\r?\n){3,}/gu, `${lineEnding}${lineEnding}`);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function pathTargetExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function createBackupPath(targetPath) {
  let index = 0;
  while (true) {
    const backupPath = `${targetPath}.bak.${installBackupStamp}${index ? `-${index}` : ""}`;
    if (!(await pathExists(backupPath))) {
      return backupPath;
    }
    index += 1;
  }
}

async function backupExistingPath(targetPath) {
  if (createdBackupPaths.has(targetPath) || !(await pathExists(targetPath))) {
    return null;
  }

  const backupPath = await createBackupPath(targetPath);
  await cp(targetPath, backupPath, { recursive: true, force: false });
  createdBackupPaths.add(targetPath);
  p.log.message(`已备份已有配置: ${pathToLabel(targetPath)} -> ${pathToLabel(backupPath)}`);
  return backupPath;
}

async function backupPrivateFile(targetPath, content) {
  if (createdBackupPaths.has(targetPath) || !(await pathExists(targetPath))) {
    return null;
  }

  const backupPath = await createBackupPath(targetPath);
  await writeFile(backupPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  createdBackupPaths.add(targetPath);
  p.log.message(`已备份已有配置: ${pathToLabel(targetPath)} -> ${pathToLabel(backupPath)}`);
  return backupPath;
}

async function backupIfNeeded(targetPath) {
  if (!(await pathExists(targetPath))) {
    return null;
  }

  const backupPath = await createBackupPath(targetPath);
  await rename(targetPath, backupPath);
  p.log.message(`已备份已有配置: ${pathToLabel(targetPath)} -> ${pathToLabel(backupPath)}`);
  return backupPath;
}

async function syncManagedFiles(agentsDir) {
  await mkdir(agentsDir, { recursive: true });

  const previousMetadata = await readInstallMetadata(agentsDir);
  const managedChildren = {};

  for (const entry of managedEntries) {
    const source = await resolveManagedEntrySource(entry);
    const target = join(agentsDir, entry.target);
    if (entry.preserveExisting) {
      managedChildren[entry.target] = await syncPreservedManagedEntry(
        source,
        target,
        entry,
        previousMetadata.managedChildren?.[entry.target] ?? []
      );
    } else {
      await replaceManagedEntry(source, target, entry);
    }
  }

  return { previousMetadata, managedChildren };
}

async function resolveManagedEntrySource(entry) {
  for (const candidate of entry.sourceCandidates ?? [entry.target]) {
    const source = join(packageRoot, candidate);
    if (await pathExists(source)) {
      return source;
    }
  }

  const expected = (entry.sourceCandidates ?? [entry.target]).join(", ");
  throw new Error(`Missing managed entry in package: ${expected}`);
}

async function removeIfNotDirectory(path) {
  if (!(await pathExists(path))) {
    return;
  }

  const entryStat = await lstat(path);
  if (entryStat.isDirectory()) {
    return;
  }

  try {
    if (entryStat.isSymbolicLink() && (await stat(path)).isDirectory()) {
      return;
    }
  } catch {
  }

  await rm(path, { recursive: true, force: true });
}

async function ensureManagedContainerDirectory(targetPath, sourcePath) {
  if (await pathExists(targetPath)) {
    const targetStat = await lstat(targetPath);
    if (targetStat.isSymbolicLink() && await pathsReferToSameEntry(targetPath, sourcePath)) {
      await unlink(targetPath);
    }
  }

  await removeIfNotDirectory(targetPath);
  await mkdir(targetPath, { recursive: true });
}

async function replaceManagedEntry(source, target, entry) {
  if (await pathsReferToSameEntry(source, target)) {
    return;
  }

  const sourceStat = await lstat(source);
  if (sourceStat.isDirectory()) {
    await backupExistingPath(target);
    await rm(target, { recursive: true, force: true });
  } else if (await pathExists(target)) {
    await backupExistingPath(target);
    const targetStat = await lstat(target);
    if (targetStat.isDirectory()) {
      await rm(target, { recursive: true, force: true });
    }
  }

  await cp(source, target, {
    recursive: true,
    force: true,
    filter: entry.filter ? (sourcePath) => entry.filter(source, sourcePath) : undefined
  });
}

async function pathsReferToSameEntry(sourcePath, targetPath) {
  if (resolve(sourcePath) === resolve(targetPath)) {
    return true;
  }

  try {
    const [sourceRealPath, targetRealPath] = await Promise.all([realpath(sourcePath), realpath(targetPath)]);
    return sourceRealPath === targetRealPath;
  } catch {
    return false;
  }
}

function shouldCopySkillPath(skillsRoot, sourcePath) {
  const relativePath = relative(skillsRoot, sourcePath);
  if (!relativePath) {
    return true;
  }

  const normalizedPath = relativePath.replaceAll("\\", "/");
  return !ignoredSkillPathPatterns.some((pattern) => pattern.test(normalizedPath));
}

async function readInstallMetadata(agentsDir) {
  const metadataPath = join(agentsDir, installMetadataName);
  if (!(await pathExists(metadataPath))) {
    return {};
  }

  try {
    return JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeInstallMetadata(agentsDir, metadata) {
  await writeFile(join(agentsDir, installMetadataName), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function linkedTargetsFromResults(results) {
  return Object.fromEntries(
    results
      .filter((result) => result.sourcePath)
      .map((result) => [
        result.targetPath,
        {
          sourcePath: result.sourcePath,
          kind: result.kind,
          mode: result.mode
        }
      ])
  );
}

function mergeLinkedTargets(previousLinkedTargets = {}, results = []) {
  const nextLinkedTargets = { ...previousLinkedTargets };
  for (const result of results) {
    if (result.sourcePath) {
      nextLinkedTargets[result.targetPath] = {
        sourcePath: result.sourcePath,
        kind: result.kind,
        mode: result.mode
      };
      continue;
    }
    if (result.status === "removed") {
      delete nextLinkedTargets[result.targetPath];
    }
  }
  return nextLinkedTargets;
}

async function renderManagedWorkflowFile(path, augmentContextEngine) {
  if (!(await pathIsFile(path))) {
    return;
  }

  const content = await readFile(path, "utf8");
  const rendered = renderManagedWorkflowContent(content, { augmentContextEngine });
  if (rendered !== content) {
    await writeFile(path, rendered, "utf8");
  }
}

async function renderManagedWorkflowFiles(agentsDir, augmentContextEngine) {
  await renderManagedWorkflowFile(join(agentsDir, "AGENTS.md"), augmentContextEngine);

  const commandsDir = join(agentsDir, "commands");
  const commandFiles = await getCommandNames(commandsDir);
  for (const fileName of commandFiles) {
    await renderManagedWorkflowFile(join(commandsDir, fileName), augmentContextEngine);
  }
}

async function syncPreservedManagedEntry(sourceRoot, targetRoot, entry, previousManagedChildren) {
  await removeIfNotDirectory(targetRoot);
  await mkdir(targetRoot, { recursive: true });

  const previousManagedChildSet = new Set(previousManagedChildren);
  const sourceChildren = await getManagedChildNames(sourceRoot, entry.filter);
  const sourceChildSet = new Set(sourceChildren);
  const currentManagedChildren = [];

  for (const childName of previousManagedChildren) {
    if (!sourceChildSet.has(childName)) {
      await rm(join(targetRoot, childName), { recursive: true, force: true });
    }
  }

  for (const childName of sourceChildren) {
    if (!(await shouldSyncManagedChild(join(targetRoot, childName), previousManagedChildSet.has(childName)))) {
      continue;
    }

    await syncManagedSubtree(
      join(sourceRoot, childName),
      join(targetRoot, childName),
      sourceRoot,
      entry.filter
    );
    currentManagedChildren.push(childName);
  }

  return currentManagedChildren;
}

async function shouldSyncManagedChild(targetPath, wasPreviouslyManaged) {
  if (wasPreviouslyManaged) {
    return true;
  }

  return !(await pathTargetExists(targetPath));
}

async function getManagedChildNames(sourceRoot, filter) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  return entries
    .filter((entry) => !filter || filter(sourceRoot, join(sourceRoot, entry.name)))
    .map((entry) => entry.name);
}

async function syncManagedSubtree(sourcePath, targetPath, managedRoot, filter) {
  if (await pathsReferToSameEntry(sourcePath, targetPath)) {
    return;
  }

  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isDirectory()) {
    if (await pathExists(targetPath)) {
      const targetStat = await lstat(targetPath);
      if (targetStat.isSymbolicLink()) {
        await unlink(targetPath);
      } else if (targetStat.isDirectory()) {
        await rm(targetPath, { recursive: true, force: true });
      }
    }

    await cp(sourcePath, targetPath, { recursive: true, force: true });
    return;
  }

  await removeIfNotDirectory(targetPath);
  await mkdir(targetPath, { recursive: true });
  await pruneMissingManagedPaths(sourcePath, targetPath, managedRoot, filter);
  await cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
    filter: filter ? (candidatePath) => filter(managedRoot, candidatePath) : undefined
  });
}

async function pruneMissingManagedPaths(sourcePath, targetPath, managedRoot, filter) {
  if (!(await pathExists(targetPath))) {
    return;
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const targetEntryPath = join(targetPath, entry.name);
    const sourceEntryPath = join(sourcePath, entry.name);
    if (filter && !filter(managedRoot, sourceEntryPath)) {
      continue;
    }

    if (!(await pathExists(sourceEntryPath))) {
      await rm(targetEntryPath, { recursive: true, force: true });
      continue;
    }

    const sourceEntryStat = await lstat(sourceEntryPath);
    if (entry.isDirectory()) {
      if (!sourceEntryStat.isDirectory()) {
        await rm(targetEntryPath, { recursive: true, force: true });
        continue;
      }

      await pruneMissingManagedPaths(sourceEntryPath, targetEntryPath, managedRoot, filter);
      continue;
    }

    if (sourceEntryStat.isDirectory()) {
      await rm(targetEntryPath, { recursive: true, force: true });
    }
  }
}

function getPlatform() {
  return process.env.ABELWORKFLOW_TEST_PLATFORM || process.platform;
}

function isWindows() {
  return getPlatform() === "win32";
}

function shouldForceFileSymlinkFailure(kind) {
  return process.env.ABELWORKFLOW_TEST_FORCE_FILE_SYMLINK_EPERM === "1" && isWindows() && kind === "file";
}

function createManagedTargetState(targetPath, sourcePath, kind, mode, status) {
  return { targetPath, sourcePath, kind, mode, status };
}

async function createSymlink(targetPath, sourcePath, linkType, kind) {
  if (shouldForceFileSymlinkFailure(kind)) {
    const error = new Error("simulated EPERM");
    error.code = "EPERM";
    throw error;
  }

  await symlink(sourcePath, targetPath, linkType);
}

async function ensureManagedLink(targetPath, sourcePath, kind, previousLinkedTargets) {
  await mkdir(dirname(targetPath), { recursive: true });
  const sourceResolved = resolve(sourcePath);
  const sourceExists = await pathTargetExists(sourcePath);

  if (await pathExists(targetPath)) {
    const targetStat = await lstat(targetPath);
    if (targetStat.isSymbolicLink()) {
      const existing = await readlink(targetPath);
      const existingResolved = resolve(dirname(targetPath), existing);
      if (existingResolved === sourceResolved) {
        if (!sourceExists) {
          await rm(targetPath, { recursive: true, force: true });
          return { targetPath, status: "removed" };
        }

        return createManagedTargetState(targetPath, sourcePath, kind, "symlink", "unchanged");
      }
    }

    const previousState = previousLinkedTargets[targetPath];
    const wasPreviouslyManaged =
      previousState &&
      resolve(previousState.sourcePath) === sourceResolved &&
      previousState.kind === kind;

    if (!sourceExists) {
      if (wasPreviouslyManaged) {
        await rm(targetPath, { recursive: true, force: true });
        return { targetPath, status: "removed" };
      }

      return { targetPath, status: "skipped" };
    }

    if (wasPreviouslyManaged) {
      await rm(targetPath, { recursive: true, force: true });
    } else {
      await backupIfNeeded(targetPath);
    }
  } else if (!sourceExists) {
    return { targetPath, status: "skipped" };
  }

  const linkType = isWindows() ? (kind === "dir" ? "junction" : "file") : kind;

  try {
    await createSymlink(targetPath, sourcePath, linkType, kind);
    return createManagedTargetState(targetPath, sourcePath, kind, "symlink", "linked");
  } catch (error) {
    if (!shouldFallbackToManagedFile(error, kind)) {
      throw error;
    }
  }

  try {
    await link(sourcePath, targetPath);
    return createManagedTargetState(targetPath, sourcePath, kind, "hardlink", "linked");
  } catch (error) {
    if (!shouldCopyManagedFile(error)) {
      throw error;
    }
  }

  await cp(sourcePath, targetPath, { recursive: true, force: true });
  return createManagedTargetState(targetPath, sourcePath, kind, "copy", "copied");
}

function shouldFallbackToManagedFile(error, kind) {
  return kind === "file" && isWindows() && ["EPERM", "EACCES"].includes(error?.code);
}

function shouldCopyManagedFile(error) {
  return ["EPERM", "EACCES", "EXDEV", "EINVAL", "UNKNOWN"].includes(error?.code);
}

async function linkSkillDirectories(baseDir, agentsDir, previousLinkedTargets) {
  const results = [];
  const skillsRoot = join(agentsDir, "skills");
  const skillNames = (await getDirectoryNames(skillsRoot)).filter((skillName) => skillName !== ".system");
  results.push(...(await pruneManagedTargets(join(baseDir, "skills"), skillsRoot, skillNames, previousLinkedTargets)));
  for (const skillName of skillNames) {
    results.push(
      await ensureManagedLink(
        join(baseDir, "skills", skillName),
        join(skillsRoot, skillName),
        "dir",
        previousLinkedTargets
      )
    );
  }
  return results;
}

async function getDirectoryNames(root) {
  if (!(await pathIsDirectory(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const names = await Promise.all(
    entries.map(async (entry) => ((await isDirectoryEntry(root, entry)) ? entry.name : null))
  );
  return names.filter(Boolean);
}

async function getCommandNames(commandsDir) {
  if (!(await pathIsDirectory(commandsDir))) {
    return [];
  }

  const entries = await readdir(commandsDir, { withFileTypes: true });
  const names = await Promise.all(
    entries.map(async (entry) => ((await isMarkdownFileEntry(commandsDir, entry)) ? entry.name : null))
  );
  return names.filter(Boolean);
}

async function getPiExtensionNames(extensionsDir) {
  if (!(await pathIsDirectory(extensionsDir))) {
    return [];
  }

  const entries = await readdir(extensionsDir, { withFileTypes: true });
  const names = await Promise.all(
    entries.map(async (entry) => ((await isPiExtensionEntry(extensionsDir, entry)) ? entry.name : null))
  );
  return names.filter(Boolean);
}

async function pathIsDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathIsFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectoryEntry(root, entry) {
  if (entry.isDirectory()) {
    return true;
  }

  if (!entry.isSymbolicLink()) {
    return false;
  }

  return pathIsDirectory(join(root, entry.name));
}

async function isMarkdownFileEntry(root, entry) {
  if (!entry.name.endsWith(".md")) {
    return false;
  }

  if (entry.isFile()) {
    return true;
  }

  if (!entry.isSymbolicLink()) {
    return false;
  }

  return pathIsFile(join(root, entry.name));
}

async function isPiExtensionEntry(root, entry) {
  const entryPath = join(root, entry.name);
  if (entry.isDirectory()) {
    return pathIsFile(join(entryPath, "index.ts"));
  }
  if (entry.isFile()) {
    return entry.name.endsWith(".ts");
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  if (entry.name.endsWith(".ts") && await pathIsFile(entryPath)) {
    return true;
  }
  return pathIsFile(join(entryPath, "index.ts"));
}

async function pruneManagedTargets(targetDir, managedSourceRoot, expectedNames, previousLinkedTargets) {
  if (!(await pathExists(targetDir))) {
    return [];
  }

  const expectedNameSet = new Set(expectedNames);
  const results = [];
  const entries = await readdir(targetDir, { withFileTypes: true });

  for (const entry of entries) {
    const targetPath = join(targetDir, entry.name);
    if (entry.isSymbolicLink()) {
      const existing = await readlink(targetPath);
      const existingResolved = resolve(dirname(targetPath), existing);
      if (!isWithinManagedRoot(existingResolved, managedSourceRoot)) {
        continue;
      }

      if (expectedNameSet.has(entry.name) && (await pathTargetExists(existingResolved))) {
        continue;
      }

      await rm(targetPath, { recursive: true, force: true });
      results.push({ targetPath, status: "removed" });
      continue;
    }

    const previousState = previousLinkedTargets[targetPath];
    if (!previousState || !isWithinManagedRoot(resolve(previousState.sourcePath), managedSourceRoot)) {
      continue;
    }

    if (expectedNameSet.has(entry.name) && (await pathTargetExists(previousState.sourcePath))) {
      continue;
    }

    await rm(targetPath, { recursive: true, force: true });
    results.push({ targetPath, status: "removed" });
  }

  return results;
}

function isWithinManagedRoot(targetPath, managedSourceRoot) {
  const relativePath = relative(managedSourceRoot, targetPath);
  if (!relativePath) {
    return false;
  }

  return relativePath !== ".." && !relativePath.startsWith(`..${isWindows() ? "\\" : "/"}`);
}

async function linkClaude(agentsDir, previousLinkedTargets) {
  const claudeDir = join(home, ".claude");
  await mkdir(claudeDir, { recursive: true });
  await ensureManagedContainerDirectory(join(claudeDir, "commands"), join(agentsDir, "commands"));
  await ensureManagedContainerDirectory(join(claudeDir, "skills"), join(agentsDir, "skills"));

  return [
    await ensureManagedLink(
      join(claudeDir, "CLAUDE.md"),
      join(agentsDir, "AGENTS.md"),
      "file",
      previousLinkedTargets
    ),
    ...(await (async () => {
      const commandFiles = await getCommandNames(join(agentsDir, "commands"));
      const r = [];
      r.push(...(await pruneManagedTargets(
        join(claudeDir, "commands"),
        join(agentsDir, "commands"),
        commandFiles,
        previousLinkedTargets
      )));
      for (const fileName of commandFiles) {
        r.push(
          await ensureManagedLink(
            join(claudeDir, "commands", fileName),
            join(agentsDir, "commands", fileName),
            "file",
            previousLinkedTargets
          )
        );
      }
      return r;
    })()),
    ...(await linkSkillDirectories(claudeDir, agentsDir, previousLinkedTargets))
  ];
}

async function linkCodex(agentsDir, previousLinkedTargets) {
  const results = [];
  const codexDir = join(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  await ensureManagedContainerDirectory(join(codexDir, "skills"), join(agentsDir, "skills"));
  await ensureManagedContainerDirectory(join(codexDir, "prompts"), join(agentsDir, "commands"));

  results.push(
    await ensureManagedLink(
      join(codexDir, "AGENTS.md"),
      join(agentsDir, "AGENTS.md"),
      "file",
      previousLinkedTargets
    )
  );
  results.push(...(await linkSkillDirectories(codexDir, agentsDir, previousLinkedTargets)));

  const commandFiles = await getCommandNames(join(agentsDir, "commands"));
  results.push(
    ...(await pruneManagedTargets(
      join(codexDir, "prompts"),
      join(agentsDir, "commands"),
      commandFiles,
      previousLinkedTargets
    ))
  );
  for (const fileName of commandFiles) {
    results.push(
      await ensureManagedLink(
        join(codexDir, "prompts", fileName),
        join(agentsDir, "commands", fileName),
        "file",
        previousLinkedTargets
      )
    );
  }

  return results;
}

async function linkPi(agentsDir, previousLinkedTargets) {
  const results = [];
  await mkdir(piAgentDir, { recursive: true });
  await ensureManagedContainerDirectory(join(piAgentDir, "skills"), join(agentsDir, "skills"));
  await ensureManagedContainerDirectory(join(piAgentDir, "prompts"), join(agentsDir, "commands"));
  await ensureManagedContainerDirectory(join(piAgentDir, "extensions"), join(agentsDir, "extensions"));

  results.push(
    await ensureManagedLink(
      join(piAgentDir, "AGENTS.md"),
      join(agentsDir, "AGENTS.md"),
      "file",
      previousLinkedTargets
    )
  );
  results.push(...(await linkSkillDirectories(piAgentDir, agentsDir, previousLinkedTargets)));

  const commandFiles = await getCommandNames(join(agentsDir, "commands"));
  results.push(
    ...(await pruneManagedTargets(
      join(piAgentDir, "prompts"),
      join(agentsDir, "commands"),
      commandFiles,
      previousLinkedTargets
    ))
  );
  for (const fileName of commandFiles) {
    results.push(
      await ensureManagedLink(
        join(piAgentDir, "prompts", fileName),
        join(agentsDir, "commands", fileName),
        "file",
        previousLinkedTargets
      )
    );
  }

  const extensionNames = await getPiExtensionNames(join(agentsDir, "extensions"));
  results.push(
    ...(await pruneManagedTargets(
      join(piAgentDir, "extensions"),
      join(agentsDir, "extensions"),
      extensionNames,
      previousLinkedTargets
    ))
  );
  for (const entryName of extensionNames) {
    const sourcePath = join(agentsDir, "extensions", entryName);
    const kind = await pathIsDirectory(sourcePath) ? "dir" : "file";
    results.push(
      await ensureManagedLink(
        join(piAgentDir, "extensions", entryName),
        sourcePath,
        kind,
        previousLinkedTargets
      )
    );
  }

  return results;
}

async function installManagedWorkflow(options) {
  let previousMetadata = {};
  let managedChildren = {};
  let augmentContextEngine = false;
  const s = p.spinner();

  if (!options.relinkOnly) {
    s.start("正在同步工作流文件...");
    try {
      ({ previousMetadata, managedChildren } = await syncManagedFiles(options.agentsDir));
      augmentContextEngine = resolveAugmentContextEngineFeature(options, previousMetadata);
      await renderManagedWorkflowFiles(options.agentsDir, augmentContextEngine);
    } catch (e) {
      s.cancel(c.red(`同步失败: ${e.message}`));
      throw e;
    }
    s.stop("工作流文件已同步");
  } else if (!(await pathExists(options.agentsDir))) {
    throw new Error(`${options.agentsDir} does not exist; remove --link-only or install first`);
  } else {
    previousMetadata = await readInstallMetadata(options.agentsDir);
    managedChildren = previousMetadata.managedChildren ?? {};
    augmentContextEngine = resolveAugmentContextEngineFeature(options, previousMetadata);
  }

  const previousLinkedTargets = previousMetadata.linkedTargets ?? {};
  s.start("正在链接 Claude / Codex / Pi...");
  let claudeResults;
  let codexResults;
  let piResults;
  try {
    claudeResults = await linkClaude(options.agentsDir, previousLinkedTargets);
    codexResults = await linkCodex(options.agentsDir, previousLinkedTargets);
    piResults = await linkPi(options.agentsDir, previousLinkedTargets);
  } catch (e) {
    s.cancel(c.red(`链接失败: ${e.message}`));
    throw e;
  }
  s.stop("链接完成");

  const linkedTargets = linkedTargetsFromResults([...claudeResults, ...codexResults, ...piResults]);

  const managedClaudePermissions = await ensureClaudeSettingsForFeature(augmentContextEngine, previousMetadata);

  await writeInstallMetadata(options.agentsDir, {
    package: "abelworkflow",
    installedAt: new Date().toISOString(),
    features: {
      ...(previousMetadata.features && typeof previousMetadata.features === "object" ? previousMetadata.features : {}),
      augmentContextEngine
    },
    managedChildren,
    managedClaudePermissions,
    linkedTargets
  });

  const resultLines = [...claudeResults, ...codexResults, ...piResults].map((result) => {
    const icon = result.status === "unchanged" ? c.gray("=")
      : result.status === "removed" ? c.yellow("−")
        : c.green("+");
    return `${icon}  ${pathToLabel(result.targetPath)}`;
  }).join("\n");

  p.note(resultLines, "链接结果");
  p.log.step(`工作流目录: ${c.cyan(pathToLabel(options.agentsDir))}`);
  p.log.message(`完成后可运行 ${c.cyan("npx abelworkflow@latest")} 更新托管文件`);
}

async function readJsonFileSafe(path, fallback = {}) {
  if (!(await pathExists(path))) {
    return fallback;
  }

  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFileSafe(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function writeJsonFileWithBackup(path, data) {
  await backupExistingPath(path);
  await writeJsonFileSafe(path, data);
}

async function ensurePrivateJsonFile(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    return false;
  }
}

async function updatePiAuthFile(path, apiKey) {
  const created = await ensurePrivateJsonFile(path);
  const release = await lockfile.lock(path, piAuthLockOptions);
  try {
    await chmod(path, 0o600);
    const content = await readFile(path, "utf8");
    const auth = JSON.parse(content);
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
      throw new TypeError("Pi auth.json must contain a JSON object");
    }
    if (!created) {
      await backupPrivateFile(path, content);
    }
    await writeFile(path, `${JSON.stringify(buildPiAuthConfig(auth, apiKey), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await chmod(path, 0o600);
  } finally {
    await release();
  }
}

function stripJsonComments(content) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < content.length && content[i] !== "\n") {
        i += 1;
      }
      if (i < content.length) {
        output += content[i];
      }
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
        output += content[i] === "\n" ? "\n" : "";
        i += 1;
      }
      i += 1;
      continue;
    }

    output += char;
  }
  return stripJsonTrailingCommas(output);
}

function stripJsonTrailingCommas(content) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === ",") {
      let nextIndex = i + 1;
      while (nextIndex < content.length && /\s/u.test(content[nextIndex])) {
        nextIndex += 1;
      }
      if (content[nextIndex] === "}" || content[nextIndex] === "]") {
        continue;
      }
    }

    output += char;
  }
  return output;
}

async function readJsoncFileSafe(path, fallback = {}) {
  if (!(await pathExists(path))) {
    return fallback;
  }

  try {
    return JSON.parse(stripJsonComments(await readFile(path, "utf8")));
  } catch {
    return fallback;
  }
}

function parsePiModelIds(value) {
  return [...new Set(String(value || "")
    .split(/[\n,]+/u)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function getOpenAiUrlPathname(value) {
  const input = String(value || "").trim();
  try {
    return new URL(input).pathname.replace(/\/+$/u, "");
  } catch {
    return input.split(/[?#]/u)[0].replace(/\/+$/u, "");
  }
}

function inferPiApiFromBaseUrl(value) {
  const pathname = getOpenAiUrlPathname(value);
  if (pathname.endsWith("/v1/chat/completions")) {
    return "openai-completions";
  }
  if (pathname.endsWith("/v1/responses")) {
    return "openai-responses";
  }
  return null;
}

function normalizeOpenAiBaseUrl(value) {
  const input = String(value || "").trim();
  try {
    const url = new URL(input);
    let pathname = url.pathname.replace(/\/+$/u, "")
      .replace(/\/v1\/(?:chat\/completions|responses)$/u, "/v1");
    if (!pathname.endsWith("/v1")) {
      pathname = `${pathname}/v1`;
    }
    url.pathname = pathname;
    return url.toString();
  } catch {
    const baseUrl = input.replace(/\/+$/u, "")
      .replace(/\/v1\/(?:chat\/completions|responses)$/u, "/v1");
    return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  }
}

function getPiApiPromptOptions() {
  return [
    { value: "openai-completions", label: "OpenAI Chat Completions（推荐）" },
    { value: "openai-responses", label: "OpenAI Responses API" }
  ];
}

function resolveExistingPiApiConfig(modelsConfig = {}, settings = {}, auth = {}) {
  const provider = modelsConfig.providers?.[piProviderId] && typeof modelsConfig.providers[piProviderId] === "object"
    ? modelsConfig.providers[piProviderId]
    : {};
  const credential = auth[piProviderId] && typeof auth[piProviderId] === "object"
    ? auth[piProviderId]
    : {};
  const authApiKey = credential.type === "api_key" && typeof credential.key === "string"
    ? credential.key
    : "";
  const models = Array.isArray(provider.models) ? provider.models.filter((model) => model?.id) : [];
  return {
    baseUrl: provider.baseUrl || piDefaultBaseUrl,
    api: provider.api || piDefaultApi,
    apiKey: authApiKey || provider.apiKey || "",
    modelIds: models.map((model) => model.id),
    defaultModel: settings.defaultProvider === piProviderId && settings.defaultModel
      ? settings.defaultModel
      : models[0]?.id || piDefaultModel
  };
}

function buildPiModelConfig(modelId, existingModel = {}) {
  return {
    ...existingModel,
    id: modelId,
    name: existingModel.name || modelId,
    reasoning: existingModel.reasoning ?? true,
    input: Array.isArray(existingModel.input) ? existingModel.input : ["text", "image"],
    contextWindow: existingModel.contextWindow ?? 262144,
    maxTokens: existingModel.maxTokens ?? 64000
  };
}

function hasPiInsecureTlsSetting(modelsConfig = {}) {
  const headers = modelsConfig.providers?.[piProviderId]?.headers;
  return headers && typeof headers === "object"
    ? Object.keys(headers).some((key) => key.toLowerCase() === piInsecureTlsHeader)
    : false;
}

function buildPiModelsConfig(modelsConfig = {}, { baseUrl, api, apiKey, modelIds, insecureTls = false }) {
  const providers = modelsConfig.providers && typeof modelsConfig.providers === "object" ? modelsConfig.providers : {};
  const currentProvider = providers[piProviderId] && typeof providers[piProviderId] === "object" ? providers[piProviderId] : {};
  const headers = currentProvider.headers && typeof currentProvider.headers === "object"
    ? { ...currentProvider.headers }
    : {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === piInsecureTlsHeader) {
      delete headers[key];
    }
  }
  if (insecureTls) {
    headers[piInsecureTlsHeader] = new URL(baseUrl).origin;
  }
  const existingModels = new Map(
    (Array.isArray(currentProvider.models) ? currentProvider.models : [])
      .filter((model) => model?.id)
      .map((model) => [model.id, model])
  );

  const provider = {
    ...currentProvider,
    baseUrl,
    api,
    apiKey,
    compat: {
      ...(currentProvider.compat && typeof currentProvider.compat === "object" ? currentProvider.compat : {}),
      supportsDeveloperRole: false
    },
    models: modelIds.map((modelId) => buildPiModelConfig(modelId, existingModels.get(modelId)))
  };
  if (Object.keys(headers).length) {
    provider.headers = headers;
  } else {
    delete provider.headers;
  }

  return {
    ...modelsConfig,
    providers: {
      ...providers,
      [piProviderId]: provider
    }
  };
}

function buildPiAuthConfig(auth = {}, apiKey) {
  const credential = auth[piProviderId] && typeof auth[piProviderId] === "object" ? auth[piProviderId] : {};
  return {
    ...auth,
    [piProviderId]: {
      ...credential,
      type: "api_key",
      key: apiKey
    }
  };
}

function buildPiSettingsConfig(settings = {}, defaultModel) {
  return {
    ...settings,
    defaultProvider: piProviderId,
    defaultModel,
    defaultThinkingLevel: settings.defaultThinkingLevel || "high",
    enableSkillCommands: settings.enableSkillCommands ?? true
  };
}

function parseDotenv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      values[key] = value;
    }
  }
  return values;
}

async function readDotenvFile(path) {
  if (!(await pathExists(path))) {
    return {};
  }

  try {
    return parseDotenv(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

function quoteEnvValue(value) {
  if (/^[A-Za-z0-9_./:@-]+$/u.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function renderDotenv(values) {
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${quoteEnvValue(String(value))}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

async function updateDotenvFile(path, updates) {
  const current = await readDotenvFile(path);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      delete current[key];
    } else {
      current[key] = String(value);
    }
  }
  await backupExistingPath(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderDotenv(current), "utf8");
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

async function ensureWorkflowPresent(agentsDir) {
  if (await pathExists(join(agentsDir, "AGENTS.md"))) {
    return;
  }

  p.log.message("未检测到已安装的 AbelWorkflow，先执行一次工作流同步。");
  await installManagedWorkflow({
    agentsDir,
    force: false,
    relinkOnly: false
  });
}

async function configureGrokSearchEnv(agentsDir) {
  await ensureWorkflowPresent(agentsDir);
  const envPath = join(agentsDir, "skills", "grok-search", ".env");
  const existing = await readDotenvFile(envPath);
  const baseUrl = await p.text({
    message: "Grok API URL",
    defaultValue: existing.GROK_API_URL || "https://api.x.ai/v1",
    validate: required()
  });
  assertNotCancelled(baseUrl);

  const apiKey = await p.password({
    message: "Grok API Key（输入 - 清除）",
    mask: "*",
    defaultValue: existing.GROK_API_KEY || undefined,
    validate: requiredUnlessExisting(existing.GROK_API_KEY, "Grok API Key 不能为空")
  });
  assertNotCancelled(apiKey);
  const finalApiKey = resolvePasswordValue(apiKey, existing.GROK_API_KEY);

  const model = await p.text({
    message: "Grok 默认模型",
    defaultValue: existing.GROK_MODEL || "grok-4-fast",
    validate: required()
  });
  assertNotCancelled(model);

  const useTavily = await confirmOrCancel({
    message: "是否同时配置 Tavily 作为额外搜索源？",
    initialValue: Boolean(existing.TAVILY_API_KEY)
  });

  const tavilyKey = useTavily
    ? await p.password({
        message: "Tavily API Key（输入 - 清除）",
        mask: "*",
        defaultValue: existing.TAVILY_API_KEY || undefined,
        validate: requiredUnlessExisting(existing.TAVILY_API_KEY, "Tavily API Key 不能为空")
      })
    : "";
  if (useTavily) assertNotCancelled(tavilyKey);
  const finalTavilyKey = useTavily ? resolvePasswordValue(tavilyKey, existing.TAVILY_API_KEY) : null;

  await updateDotenvFile(envPath, {
    GROK_API_URL: baseUrl,
    GROK_API_KEY: finalApiKey,
    GROK_MODEL: model,
    TAVILY_API_KEY: finalTavilyKey,
    TAVILY_ENABLED: useTavily ? "true" : null
  });

  p.log.step(`已写入 ${pathToLabel(envPath)}`);
}

async function configureContext7Env(agentsDir) {
  await ensureWorkflowPresent(agentsDir);
  const envPath = join(agentsDir, "skills", "context7-auto-research", ".env");
  const existing = await readDotenvFile(envPath);
  const apiKey = await p.password({
    message: "Context7 API Key (可选，输入 - 清除)",
    mask: "*",
    defaultValue: existing.CONTEXT7_API_KEY || undefined
  });
  assertNotCancelled(apiKey);
  const finalApiKey = resolvePasswordValue(apiKey, existing.CONTEXT7_API_KEY);

  await updateDotenvFile(envPath, {
    CONTEXT7_API_KEY: finalApiKey
  });

  p.log.step(`已写入 ${pathToLabel(envPath)}`);
}

function hasPromptEnhancerApiConfig(config) {
  return [config.PE_API_URL, config.PE_API_KEY, config.PE_MODEL]
    .every((value) => typeof value === "string" && value.trim() !== "");
}

function resolvePromptEnhancerMode(existing) {
  return hasPromptEnhancerApiConfig(existing) ? "openai-compatible" : "agent";
}

async function configurePromptEnhancerEnv(agentsDir) {
  await ensureWorkflowPresent(agentsDir);
  const envPath = join(agentsDir, "skills", "prompt-enhancer", ".env");
  const existing = await readDotenvFile(envPath);
  const mode = await selectOrCancel({
    message: "请选择 prompt-enhancer 的运行方式",
    options: [
      { value: "openai-compatible", label: "第三方 OpenAI 兼容接口" },
      { value: "agent", label: "直接使用当前 Agent" }
    ],
    initialValue: resolvePromptEnhancerMode(existing)
  });

  if (mode === "openai-compatible") {
    const apiUrl = await p.text({
      message: "PE_API_URL",
      defaultValue: existing.PE_API_URL || undefined,
      validate: required()
    });
    assertNotCancelled(apiUrl);

    const apiKey = await p.password({
      message: "PE_API_KEY（输入 - 清除）",
      mask: "*",
      defaultValue: existing.PE_API_KEY || undefined,
      validate: requiredUnlessExisting(existing.PE_API_KEY, "PE_API_KEY 不能为空")
    });
    assertNotCancelled(apiKey);
    const finalApiKey = resolvePasswordValue(apiKey, existing.PE_API_KEY);

    const model = await p.text({
      message: "PE_MODEL",
      defaultValue: existing.PE_MODEL || undefined,
      validate: required()
    });
    assertNotCancelled(model);

    await updateDotenvFile(envPath, {
      PE_API_URL: apiUrl,
      PE_API_KEY: finalApiKey,
      PE_MODEL: model,
      ANTHROPIC_API_KEY: null,
      OPENAI_API_KEY: null
    });
  } else {
    await updateDotenvFile(envPath, {
      PE_API_URL: null,
      PE_API_KEY: null,
      PE_MODEL: null,
      ANTHROPIC_API_KEY: null,
      OPENAI_API_KEY: null
    });
  }

  p.log.step(`已写入 ${pathToLabel(envPath)}`);
}

function mergeClaudeSettingsWithDefaults(settings, { augmentContextEngine = false } = {}) {
  const defaults = buildDefaultClaudeSettings({ augmentContextEngine });
  const env = settings?.env && typeof settings.env === "object" ? settings.env : {};
  const permissions = settings?.permissions && typeof settings.permissions === "object" ? settings.permissions : {};
  return {
    ...defaults,
    ...settings,
    env: {
      ...defaults.env,
      ...env
    },
    permissions: {
      ...defaults.permissions,
      ...permissions,
      allow: Array.isArray(permissions.allow) ? permissions.allow : defaults.permissions.allow,
      deny: Array.isArray(permissions.deny) ? permissions.deny : defaults.permissions.deny
    },
    hooks: settings?.hooks && typeof settings.hooks === "object" ? settings.hooks : defaults.hooks
  };
}

function applyClaudeInsecureTlsSetting(env = {}, enabled = false) {
  const nextEnv = { ...env };
  if (enabled) {
    nextEnv.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  } else if (nextEnv.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    delete nextEnv.NODE_TLS_REJECT_UNAUTHORIZED;
  }
  return nextEnv;
}

function getPreviousManagedClaudePermissions(previousMetadata = {}) {
  return Array.isArray(previousMetadata.managedClaudePermissions)
    ? previousMetadata.managedClaudePermissions.filter((value) => typeof value === "string")
    : [];
}

function applyClaudePermissionFeature(settings, {
  augmentContextEngine = false,
  previousManagedPermissions = []
} = {}) {
  const hasSettings = settings && typeof settings === "object";
  const wasManaged = previousManagedPermissions.includes(augmentContextEnginePermission);
  if (!hasSettings && !augmentContextEngine) {
    return { settings, changed: false, managedPermissions: [] };
  }

  const defaults = buildDefaultClaudeSettings({ augmentContextEngine: false });
  const nextSettings = hasSettings
    ? {
        ...settings,
        permissions: settings.permissions && typeof settings.permissions === "object"
          ? { ...settings.permissions }
          : {}
      }
    : defaults;
  const permissions = nextSettings.permissions;
  const allow = Array.isArray(permissions.allow)
    ? [...permissions.allow]
    : [...defaults.permissions.allow];
  let changed = !hasSettings;
  let isManaged = wasManaged;

  if (augmentContextEngine) {
    if (!allow.includes(augmentContextEnginePermission)) {
      allow.push(augmentContextEnginePermission);
      changed = true;
      isManaged = true;
    }
  } else if (wasManaged && allow.includes(augmentContextEnginePermission)) {
    allow.splice(allow.indexOf(augmentContextEnginePermission), 1);
    changed = true;
    isManaged = false;
  } else {
    isManaged = false;
  }

  permissions.allow = allow;
  if (!Array.isArray(permissions.deny)) {
    permissions.deny = [...defaults.permissions.deny];
  }
  nextSettings.permissions = permissions;

  return {
    settings: nextSettings,
    changed,
    managedPermissions: isManaged ? [augmentContextEnginePermission] : []
  };
}

async function ensureClaudeSettingsForFeature(augmentContextEngine, previousMetadata) {
  const settingsExists = await pathExists(claudeSettingsPath);
  const settings = settingsExists ? await readJsonFileSafe(claudeSettingsPath, {}) : undefined;
  const result = applyClaudePermissionFeature(settings, {
    augmentContextEngine,
    previousManagedPermissions: getPreviousManagedClaudePermissions(previousMetadata)
  });

  if (result.changed && result.settings) {
    if (settingsExists) {
      await backupExistingPath(claudeSettingsPath);
    }
    await writeJsonFileSafe(claudeSettingsPath, result.settings);
  }

  return result.managedPermissions;
}

function getExistingClaudeApiConfig(settings) {
  const env = mergeClaudeSettingsWithDefaults(settings).env;
  return {
    baseUrl: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    authType: env.ANTHROPIC_AUTH_TOKEN ? "auth_token" : "api_key",
    key: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "",
    model: claudeModelEnvKeys.map((field) => env[field]).find(Boolean) || "",
    insecureTls: env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  };
}

function ensureApprovedClaudeApiKey(config, apiKey) {
  if (!apiKey) {
    return config;
  }

  const truncated = apiKey.slice(0, 20);
  if (!config.customApiKeyResponses || typeof config.customApiKeyResponses !== "object") {
    config.customApiKeyResponses = { approved: [], rejected: [] };
  }
  if (!Array.isArray(config.customApiKeyResponses.approved)) {
    config.customApiKeyResponses.approved = [];
  }
  if (!Array.isArray(config.customApiKeyResponses.rejected)) {
    config.customApiKeyResponses.rejected = [];
  }

  config.customApiKeyResponses.rejected = config.customApiKeyResponses.rejected.filter((item) => item !== truncated);
  if (!config.customApiKeyResponses.approved.includes(truncated)) {
    config.customApiKeyResponses.approved.push(truncated);
  }

  return config;
}

async function configureClaudeApi() {
  const settings = await readJsonFileSafe(claudeSettingsPath, {});
  const existing = getExistingClaudeApiConfig(settings);
  const authType = await selectOrCancel({
    message: "Claude Code 第三方 API 认证方式",
    options: [
      { value: "api_key", label: "API Key" },
      { value: "auth_token", label: "Auth Token" }
    ],
    initialValue: existing.authType
  });

  const baseUrl = await p.text({
    message: "Claude Code Base URL",
    defaultValue: existing.baseUrl,
    validate: required()
  });
  assertNotCancelled(baseUrl);

  const key = await p.password({
    message: authType === "auth_token" ? "Claude Code Auth Token（输入 - 清除）" : "Claude Code API Key（输入 - 清除）",
    mask: "*",
    defaultValue: existing.key || undefined,
    validate: requiredUnlessExisting(existing.key, "API Key / Auth Token 不能为空")
  });
  assertNotCancelled(key);
  const finalKey = resolvePasswordValue(key, existing.key);

  const insecureTls = await confirmOrCancel({
    message: "是否跳过 Claude Code TLS 证书校验？仅证书无法修复时启用（会放宽该进程全部 HTTPS 请求）",
    initialValue: existing.insecureTls
  });

  const model = await p.text({
    message: "Claude Code 模型",
    defaultValue: existing.model || undefined,
    validate: required()
  });
  assertNotCancelled(model);

  const nextSettings = mergeClaudeSettingsWithDefaults(settings);
  nextSettings.env = applyClaudeInsecureTlsSetting(nextSettings.env, insecureTls);
  nextSettings.env.ANTHROPIC_BASE_URL = baseUrl;

  if (authType === "auth_token") {
    nextSettings.env.ANTHROPIC_AUTH_TOKEN = finalKey;
    delete nextSettings.env.ANTHROPIC_API_KEY;
  } else {
    nextSettings.env.ANTHROPIC_API_KEY = finalKey;
    delete nextSettings.env.ANTHROPIC_AUTH_TOKEN;
  }
  for (const field of claudeModelEnvKeys) {
    nextSettings.env[field] = model;
  }

  await writeJsonFileWithBackup(claudeSettingsPath, nextSettings);

  const metaConfig = await readJsonFileSafe(claudeMetaConfigPath, {});
  metaConfig.hasCompletedOnboarding = true;
  ensureApprovedClaudeApiKey(metaConfig, finalKey);
  await writeJsonFileWithBackup(claudeMetaConfigPath, metaConfig);

  p.log.step(`已更新 ${pathToLabel(claudeSettingsPath)} (${authType}, ${baseUrl}, ${maskSecret(finalKey)})`);
}

function updateTopLevelTomlField(content, field, value) {
  const lineEnding = detectLineEnding(content);
  if (value === null) {
    return removeTopLevelTomlField(content, field);
  }

  const { topLevel, rest } = splitTopLevelTomlContent(content);
  const entry = extractTopLevelTomlEntries(content).find((item) => item.field === field);
  const nextLine = `${field} = ${JSON.stringify(value)}`;
  let nextTopLevel;

  if (entry) {
    const start = topLevel.indexOf(entry.raw);
    if (start === -1) {
      return content;
    }
    nextTopLevel = `${topLevel.slice(0, start)}${nextLine}${topLevel.slice(start + entry.raw.length)}`;
  } else {
    nextTopLevel = topLevel.trimEnd()
      ? `${topLevel.trimEnd()}${lineEnding}${nextLine}${lineEnding}`
      : `${nextLine}${lineEnding}`;
  }

  nextTopLevel = nextTopLevel.trimEnd();

  if (rest && nextTopLevel) {
    nextTopLevel = `${nextTopLevel}${lineEnding}${lineEnding}`;
  }

  return `${nextTopLevel}${rest}`;
}

function removeTopLevelTomlField(content, field) {
  const lineEnding = detectLineEnding(content);
  const { topLevel, rest } = splitTopLevelTomlContent(content);
  const entry = extractTopLevelTomlEntries(content).find((item) => item.field === field);
  if (!entry) {
    return content;
  }

  const start = topLevel.indexOf(entry.raw);
  if (start === -1) {
    return content;
  }

  let nextTopLevel = `${topLevel.slice(0, start)}${topLevel.slice(start + entry.raw.length)}`;
  nextTopLevel = collapseBlankLines(nextTopLevel, lineEnding).trimEnd();

  if (rest && nextTopLevel) {
    nextTopLevel = `${nextTopLevel}${lineEnding}${lineEnding}`;
  }

  return `${nextTopLevel}${rest}`;
}

function removeTomlSection(content, sectionName) {
  const lineEnding = detectLineEnding(content);
  const sectionHeaderRegex = new RegExp(
    `(?:^|\\r?\\n)\\[${escapeRegExp(sectionName)}\\](?:[ \\t]+#.*)?[ \\t]*\\r?$`,
    "mu"
  );
  const headerMatch = sectionHeaderRegex.exec(content);
  if (!headerMatch) {
    return content;
  }

  const sectionStart = headerMatch[0].startsWith("\n") || headerMatch[0].startsWith("\r\n")
    ? headerMatch.index + headerMatch[0].indexOf("[")
    : headerMatch.index;
  const headerLineEnd = content.indexOf(lineEnding, sectionStart);
  const bodyStart = headerLineEnd === -1 ? content.length : headerLineEnd + lineEnding.length;
  const nextSectionStart = findTomlSectionStart(content, bodyStart);
  const sectionEnd = nextSectionStart === -1 ? content.length : nextSectionStart;
  return collapseBlankLines(`${content.slice(0, sectionStart)}${content.slice(sectionEnd)}`, lineEnding).trimEnd();
}

function buildTomlSection(sectionName, values, lineEnding = "\n") {
  const lines = [`[${sectionName}]`];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (typeof value === "string") {
      lines.push(`${key} = ${JSON.stringify(value)}`);
    } else if (typeof value === "boolean") {
      lines.push(`${key} = ${value ? "true" : "false"}`);
    } else {
      lines.push(`${key} = ${String(value)}`);
    }
  }
  return `${lines.join(lineEnding)}${lineEnding}`;
}

function formatTomlValue(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function getTomlLines(content) {
  if (!content) {
    return [];
  }

  const chunks = content.match(/[^\r\n]*(?:\r?\n|$)/gu) || [];
  const lines = [];
  let offset = 0;

  for (const chunk of chunks) {
    if (!chunk && offset >= content.length) {
      break;
    }

    const lineEndingMatch = chunk.match(/\r?\n$/u);
    const lineEnding = lineEndingMatch ? lineEndingMatch[0] : "";
    lines.push({
      line: lineEnding ? chunk.slice(0, -lineEnding.length) : chunk,
      start: offset
    });
    offset += chunk.length;

    if (!lineEnding && offset >= content.length) {
      break;
    }
  }

  return lines;
}

function findTomlSectionStart(content, fromIndex = 0) {
  const scopedContent = content.slice(fromIndex);
  let multilineDelimiter = "";

  for (const { line, start } of getTomlLines(scopedContent)) {
    const trimmed = line.trim();

    if (multilineDelimiter) {
      if (line.includes(multilineDelimiter)) {
        multilineDelimiter = "";
      }
      continue;
    }

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (/^\[[^\]]+\]\s*(?:#.*)?$/u.test(trimmed)) {
      return fromIndex + start;
    }

    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/u);
    if (!match) {
      continue;
    }

    const delimiter = getTomlMultilineStringDelimiter(match[2].trimStart());
    if (delimiter && match[2].indexOf(delimiter, delimiter.length) === -1) {
      multilineDelimiter = delimiter;
    }
  }

  return -1;
}

function splitTopLevelTomlContent(content) {
  const topLevelEnd = findTomlSectionStart(content);
  return {
    topLevel: topLevelEnd === -1 ? content : content.slice(0, topLevelEnd),
    rest: topLevelEnd === -1 ? "" : content.slice(topLevelEnd)
  };
}

function getTomlMultilineStringDelimiter(value) {
  if (value.startsWith(`"""`)) {
    return `"""`;
  }
  if (value.startsWith(`'''`)) {
    return `'''`;
  }
  return "";
}

function extractTopLevelTomlEntries(content) {
  const { topLevel } = splitTopLevelTomlContent(content);
  const lineEnding = detectLineEnding(topLevel);
  const lines = topLevel.split(/\r?\n/u);
  const entries = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/u);
    if (!match) {
      continue;
    }

    const rawLines = [line];
    const delimiter = getTomlMultilineStringDelimiter(match[2].trimStart());
    if (delimiter && match[2].indexOf(delimiter, delimiter.length) === -1) {
      for (index += 1; index < lines.length; index += 1) {
        rawLines.push(lines[index]);
        if (lines[index].includes(delimiter)) {
          break;
        }
      }
    }

    entries.push({
      field: match[1],
      raw: rawLines.join(lineEnding)
    });
  }

  return entries;
}

function mergeMissingTopLevelTomlEntries(content, entries) {
  if (!entries.length) {
    return content;
  }

  const lineEnding = detectLineEnding(content);
  const { topLevel, rest } = splitTopLevelTomlContent(content);
  const existingFields = new Set(extractTopLevelTomlEntries(content).map(({ field }) => field));
  const missingEntries = entries.filter(({ field }) => !existingFields.has(field));
  if (!missingEntries.length) {
    return content;
  }

  let nextTopLevel = topLevel.trimEnd();
  for (const entry of missingEntries) {
    nextTopLevel = nextTopLevel
      ? `${nextTopLevel}${lineEnding}${entry.raw}`
      : entry.raw;
  }

  nextTopLevel = nextTopLevel.trimEnd();
  if (rest && nextTopLevel) {
    nextTopLevel = `${nextTopLevel}${lineEnding}${lineEnding}`;
  }
  return `${nextTopLevel}${rest}`;
}

function updateTomlBodyFields(body, values, lineEnding = "\n") {
  const normalizedBody = body.replace(/\r?\n$/u, "");
  const lines = normalizedBody ? normalizedBody.split(/\r?\n/u) : [];
  const remaining = new Map(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
  const managedFields = new Set(remaining.keys());
  const seenFields = new Set();
  const nextLines = [];

  for (const rawLine of lines) {
    const match = rawLine.match(/^(\s*)([A-Za-z0-9_]+)\s*=\s*.*$/u);
    if (!match || !managedFields.has(match[2])) {
      nextLines.push(rawLine);
      continue;
    }

    if (seenFields.has(match[2])) {
      continue;
    }

    nextLines.push(`${match[1]}${match[2]} = ${formatTomlValue(remaining.get(match[2]))}`);
    seenFields.add(match[2]);
    remaining.delete(match[2]);
  }

  for (const [field, value] of remaining) {
    nextLines.push(`${field} = ${formatTomlValue(value)}`);
  }

  return nextLines.join(lineEnding);
}

function updateTomlSectionFields(content, sectionName, values) {
  const lineEnding = detectLineEnding(content);
  const sectionHeaderRegex = new RegExp(
    `^\\[${escapeRegExp(sectionName)}\\](?:[ \\t]+#.*)?[ \\t]*\\r?$`,
    "mu"
  );
  const headerMatch = sectionHeaderRegex.exec(content);

  if (!headerMatch) {
    const nextSection = buildTomlSection(sectionName, values, lineEnding).trimEnd();
    return content.trimEnd()
      ? `${content.trimEnd()}${lineEnding}${lineEnding}${nextSection}${lineEnding}`
      : `${nextSection}${lineEnding}`;
  }

  const sectionStart = headerMatch.index;
  const headerLineEnd = content.indexOf(lineEnding, sectionStart);
  const bodyStart = headerLineEnd === -1 ? content.length : headerLineEnd + lineEnding.length;
  const headerLine = content.slice(sectionStart, headerLineEnd === -1 ? content.length : headerLineEnd);
  const nextSectionStart = findTomlSectionStart(content, bodyStart);
  const sectionEnd = nextSectionStart === -1 ? content.length : nextSectionStart;
  const prefix = content.slice(0, sectionStart);
  const body = content.slice(bodyStart, sectionEnd);
  const suffix = content.slice(sectionEnd);
  const nextBody = updateTomlBodyFields(body, values, lineEnding);
  const renderedSection = nextBody
    ? `${headerLine}${lineEnding}${nextBody}${lineEnding}`
    : `${headerLine}${lineEnding}`;

  return `${prefix}${renderedSection}${suffix.replace(/^\r?\n/u, "")}`;
}

function readTopLevelTomlString(content, field) {
  const { topLevel } = splitTopLevelTomlContent(content);
  for (const line of topLevel.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(new RegExp(`^${escapeRegExp(field)}\\s*=\\s*"([^"]+)"$`, "u"));
    if (match) {
      return match[1];
    }
  }
  return "";
}

function parseTomlSection(content, sectionName) {
  const lineEnding = detectLineEnding(content);
  const sectionHeaderRegex = new RegExp(
    `^\\[${escapeRegExp(sectionName)}\\](?:[ \\t]+#.*)?[ \\t]*\\r?$`,
    "mu"
  );
  const headerMatch = sectionHeaderRegex.exec(content);
  if (!headerMatch) {
    return {};
  }

  const sectionStart = headerMatch.index;
  const headerLineEnd = content.indexOf(lineEnding, sectionStart);
  const bodyStart = headerLineEnd === -1 ? content.length : headerLineEnd + lineEnding.length;
  const nextSectionStart = findTomlSectionStart(content, bodyStart);
  const body = content.slice(bodyStart, nextSectionStart === -1 ? content.length : nextSectionStart);

  const values = {};
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const stringMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/u);
    if (stringMatch) {
      values[stringMatch[1]] = stringMatch[2];
      continue;
    }
    const boolMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(true|false)\s*(?:#.*)?$/u);
    if (boolMatch) {
      values[boolMatch[1]] = boolMatch[2] === "true";
      continue;
    }
    const numberMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(-?\d+(?:\.\d+)?)\s*(?:#.*)?$/u);
    if (numberMatch) {
      values[numberMatch[1]] = Number(numberMatch[2]);
    }
  }
  return values;
}

function stripCodexSubagentDefaults(content) {
  const lineEnding = detectLineEnding(content);
  let nextContent = removeTopLevelTomlField(content, "approvals_reviewer");
  nextContent = removeTopLevelTomlField(nextContent, "developer_instructions");
  nextContent = removeTomlSection(nextContent, "agents");

  const featureValues = parseTomlSection(nextContent, "features");
  delete featureValues.multi_agent;
  delete featureValues.guardian_approval;
  nextContent = removeTomlSection(nextContent, "features");

  if (Object.keys(featureValues).length) {
    const featuresSection = buildTomlSection("features", featureValues, lineEnding).trimEnd();
    nextContent = nextContent.trimEnd()
      ? `${nextContent.trimEnd()}${lineEnding}${lineEnding}${featuresSection}${lineEnding}`
      : `${featuresSection}${lineEnding}`;
  }

  return nextContent;
}

function mergeCodexTemplateDefaults(content, templateContent) {
  const defaultTopLevelFields = new Set([
    "personality",
    "disable_response_storage",
    "approvals_reviewer",
    "approval_policy",
    "sandbox_mode",
    "service_tier",
    "model",
    "model_reasoning_effort",
    "developer_instructions"
  ]);
  const templateEntries = extractTopLevelTomlEntries(templateContent)
    .filter(({ field }) => defaultTopLevelFields.has(field));
  let nextContent = mergeMissingTopLevelTomlEntries(content, templateEntries);

  for (const sectionName of ["agents", "features"]) {
    const templateValues = parseTomlSection(templateContent, sectionName);
    const currentValues = parseTomlSection(nextContent, sectionName);
    const missingValues = Object.fromEntries(
      Object.entries(templateValues).filter(([field]) => !(field in currentValues))
    );
    if (Object.keys(missingValues).length) {
      nextContent = updateTomlSectionFields(nextContent, sectionName, missingValues);
    }
  }

  return nextContent;
}

async function loadBundledCodexConfigTemplate() {
  return readFile(codexTemplateConfigPath, "utf8");
}

async function deployBundledCodexAgents() {
  const targetDir = join(home, ".codex", "agents");
  await mkdir(targetDir, { recursive: true });
  const entries = (await readdir(codexTemplateAgentsPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const deployed = [];
  for (const name of entries) {
    const source = join(codexTemplateAgentsPath, name);
    const target = join(targetDir, name);
    await backupExistingPath(target);
    await cp(source, target, { force: true });
    deployed.push(target);
  }
  return deployed;
}

function getDefaultCodexEnvKey(providerId) {
  return `${providerId.toUpperCase().replace(/-/gu, "_")}_API_KEY`;
}

function resolveExistingCodexApiConfig(content, auth = {}) {
  const providerId = readTopLevelTomlString(content, "model_provider") || "abelworkflow";
  const provider = parseTomlSection(content, `model_providers.${providerId}`);
  const requiresOpenAiAuth = provider.requires_openai_auth !== false;
  const configuredEnvKey = provider.temp_env_key || "";
  const defaultEnvKey = requiresOpenAiAuth ? "OPENAI_API_KEY" : getDefaultCodexEnvKey(providerId);
  const envKey = configuredEnvKey || defaultEnvKey;
  const apiKeyCandidates = [
    configuredEnvKey,
    envKey,
    defaultEnvKey,
    "OPENAI_API_KEY"
  ].filter(Boolean);
  const apiKeyMatch = apiKeyCandidates.find((key) => typeof auth[key] === "string" && auth[key]);
  const apiKey = apiKeyMatch ? auth[apiKeyMatch] : "";

  return {
    providerId,
    providerName: provider.name || providerId,
    baseUrl: provider.base_url || "https://api.openai.com/v1",
    envKey,
    legacyEnvKeys: configuredEnvKey && configuredEnvKey !== envKey ? [configuredEnvKey] : [],
    apiKey
  };
}

async function getExistingCodexApiConfig() {
  const content = await pathExists(codexConfigPath) ? await readFile(codexConfigPath, "utf8") : "";
  const auth = await readJsonFileSafe(codexAuthPath, {});
  return resolveExistingCodexApiConfig(content, auth);
}

async function ensurePiResourcesLinked(agentsDir) {
  const { previousMetadata, managedChildren } = await syncManagedFiles(agentsDir);
  const augmentContextEngine = resolveAugmentContextEngineFeature({}, previousMetadata);
  await renderManagedWorkflowFiles(agentsDir, augmentContextEngine);

  const previousLinkedTargets = previousMetadata.linkedTargets ?? {};
  const piResults = await linkPi(agentsDir, previousLinkedTargets);
  await writeInstallMetadata(agentsDir, {
    ...previousMetadata,
    package: previousMetadata.package || "abelworkflow",
    installedAt: previousMetadata.installedAt || new Date().toISOString(),
    features: {
      ...(previousMetadata.features && typeof previousMetadata.features === "object" ? previousMetadata.features : {}),
      augmentContextEngine
    },
    managedChildren,
    managedClaudePermissions: getPreviousManagedClaudePermissions(previousMetadata),
    linkedTargets: mergeLinkedTargets(previousLinkedTargets, piResults)
  });
  return piResults;
}

async function configurePiApi(agentsDir) {
  const auth = await readJsonFileSafe(piAuthPath, {});
  const modelsConfig = await readJsoncFileSafe(piModelsPath, {});
  const settings = await readJsonFileSafe(piSettingsPath, {});
  const existing = resolveExistingPiApiConfig(modelsConfig, settings, auth);

  const baseUrlInput = await p.text({
    message: "Pi gpt Base URL",
    defaultValue: existing.baseUrl,
    validate: required()
  });
  assertNotCancelled(baseUrlInput);
  const inferredApi = inferPiApiFromBaseUrl(baseUrlInput);
  const baseUrl = normalizeOpenAiBaseUrl(baseUrlInput);

  const insecureTls = await confirmOrCancel({
    message: "是否仅为 Pi gpt 中转请求跳过 TLS 证书校验？仅证书无法修复时启用",
    initialValue: hasPiInsecureTlsSetting(modelsConfig)
  });

  const piApiOptions = getPiApiPromptOptions();
  const api = inferredApi || await selectOrCancel({
    message: "Pi gpt API 类型",
    options: piApiOptions,
    initialValue: piApiOptions.some((option) => option.value === existing.api) ? existing.api : piDefaultApi
  });

  const apiKey = await p.password({
    message: "Pi gpt API Key（输入 - 清除）",
    mask: "*",
    defaultValue: existing.apiKey || undefined,
    validate: requiredUnlessExisting(existing.apiKey, "API Key 不能为空")
  });
  assertNotCancelled(apiKey);
  const finalApiKey = resolvePasswordValue(apiKey, existing.apiKey);

  const modelIdsText = await p.text({
    message: "Pi gpt 模型 ID（多个用逗号分隔）",
    defaultValue: (existing.modelIds.length ? existing.modelIds : [existing.defaultModel]).join(","),
    validate: (value) => parsePiModelIds(value).length ? undefined : "至少需要一个模型 ID"
  });
  assertNotCancelled(modelIdsText);
  const modelIds = parsePiModelIds(modelIdsText);

  const defaultModel = await p.text({
    message: "Pi 默认模型",
    defaultValue: modelIds.includes(existing.defaultModel) ? existing.defaultModel : modelIds[0],
    validate: (value) => modelIds.includes(String(value || "").trim()) ? undefined : "默认模型必须在模型 ID 列表中"
  });
  assertNotCancelled(defaultModel);

  const finalDefaultModel = String(defaultModel).trim();
  await ensurePiResourcesLinked(agentsDir);
  await updatePiAuthFile(piAuthPath, finalApiKey);
  await writeJsonFileWithBackup(piModelsPath, buildPiModelsConfig(modelsConfig, {
    baseUrl,
    api,
    apiKey: finalApiKey,
    modelIds,
    insecureTls
  }));
  await writeJsonFileWithBackup(piSettingsPath, buildPiSettingsConfig(settings, finalDefaultModel));

  p.log.step(`已更新 ${pathToLabel(piModelsPath)} (${piProviderId}, ${baseUrl})`);
  p.log.step(`已更新 ${pathToLabel(piSettingsPath)} (默认模型: ${finalDefaultModel})`);
  p.log.step(`已更新 ${pathToLabel(piAuthPath)} (${maskSecret(finalApiKey)})`);
  p.log.step(`已链接 Pi 扩展到 ${pathToLabel(join(piAgentDir, "extensions"))}`);
}

async function configureCodexApi() {
  const existing = await getExistingCodexApiConfig();
  const providerId = existing.providerId || "abelworkflow";
  const providerName = existing.providerName || providerId;
  const baseUrlInput = await p.text({
    message: "Codex Base URL",
    defaultValue: existing.baseUrl,
    validate: required()
  });
  assertNotCancelled(baseUrlInput);
  const baseUrl = normalizeOpenAiBaseUrl(baseUrlInput);

  const apiKey = await p.password({
    message: "Codex 第三方 API Key（输入 - 清除）",
    mask: "*",
    defaultValue: existing.apiKey || undefined,
    validate: requiredUnlessExisting(existing.apiKey, "API Key 不能为空")
  });
  assertNotCancelled(apiKey);
  const finalApiKey = resolvePasswordValue(apiKey, existing.apiKey);

  const shouldDeploySubagents = await confirmOrCancel({ message: "是否部署 Codex subagents 配置？", initialValue: true });

  const envKey = existing.envKey || "OPENAI_API_KEY";
  const currentContent = await pathExists(codexConfigPath) ? await readFile(codexConfigPath, "utf8") : "";
  const templateContent = await loadBundledCodexConfigTemplate();
  const content = buildCodexConfigContent(currentContent, {
    templateContent,
    mergeMissingTemplateDefaults: true,
    includeSubagentDefaults: shouldDeploySubagents,
    providerId,
    providerName,
    baseUrl,
    envKey
  });

  await backupExistingPath(codexConfigPath);
  await mkdir(dirname(codexConfigPath), { recursive: true });
  await writeFile(codexConfigPath, content, "utf8");

  const auth = mergeCodexAuthData(await readJsonFileSafe(codexAuthPath, {}), envKey, finalApiKey, existing.legacyEnvKeys || []);
  await writeJsonFileWithBackup(codexAuthPath, auth);

  p.log.step(`已更新 ${pathToLabel(codexConfigPath)} (${providerId}, ${baseUrl})`);
  p.log.step(`已更新 ${pathToLabel(codexAuthPath)} (${maskSecret(finalApiKey)})`);
  if (String(baseUrl).startsWith("https://") && !process.env.CODEX_CA_CERTIFICATE && !process.env.SSL_CERT_FILE) {
    p.log.message("自签名证书需在启动 Codex 前设置 CODEX_CA_CERTIFICATE=/absolute/path/relay-ca.pem。");
  }
  if (shouldDeploySubagents) {
    const deployed = await deployBundledCodexAgents();
    p.log.step(`已部署 ${deployed.length} 个 Codex subagents 到 ${pathToLabel(join(home, ".codex", "agents"))}`);
  } else {
    p.log.message("已跳过 Codex subagents 部署。");
  }
}

function buildCodexConfigContent(currentContent, {
  templateContent = "",
  mergeMissingTemplateDefaults = false,
  includeSubagentDefaults = true,
  providerId,
  providerName,
  baseUrl,
  envKey
}) {
  const effectiveTemplateContent = includeSubagentDefaults
    ? templateContent
    : stripCodexSubagentDefaults(templateContent);
  const hasCurrentContent = Boolean(currentContent.trim());
  let content = hasCurrentContent ? currentContent : effectiveTemplateContent;
  if (!includeSubagentDefaults && hasCurrentContent) {
    content = stripCodexSubagentDefaults(content);
  }
  if (hasCurrentContent && mergeMissingTemplateDefaults && effectiveTemplateContent.trim()) {
    content = mergeCodexTemplateDefaults(content, effectiveTemplateContent);
  }
  const lineEnding = detectLineEnding(content);
  if (includeSubagentDefaults && readTopLevelTomlString(content, "approvals_reviewer") === "reviewer") {
    content = updateTopLevelTomlField(content, "approvals_reviewer", "guardian_subagent");
  }
  content = updateTopLevelTomlField(content, "model_provider", providerId);
  content = updateTopLevelTomlField(content, "preferred_auth_method", "apikey");
  content = updateTomlSectionFields(content, `model_providers.${providerId}`, {
    name: providerName,
    base_url: baseUrl,
    wire_api: "responses",
    temp_env_key: envKey,
    requires_openai_auth: true,
    supports_websockets: true
  });
  return `${content.trim()}${lineEnding}`;
}

function mergeCodexAuthData(auth, envKey, apiKey, legacyEnvKeys = []) {
  return { [envKey]: apiKey };
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

async function installCliTool(tool) {
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

async function runFullInit(options) {
  const augmentContextEngine = options.nonInteractive
    ? false
    : await confirmOrCancel(getAugmentContextEnginePromptOptions());

  await installManagedWorkflow({
    agentsDir: options.agentsDir,
    force: options.force,
    relinkOnly: false,
    augmentContextEngine
  });

  if (await confirmOrCancel({ message: "是否安装或更新 Claude Code CLI？", initialValue: false })) {
    await installCliTool("claude");
  }
  if (await confirmOrCancel({ message: "是否配置 Claude Code 第三方 API？", initialValue: commandExists("claude") })) {
    await configureClaudeApi();
  }
  if (await confirmOrCancel({ message: "是否安装或更新 Codex CLI？", initialValue: false })) {
    await installCliTool("codex");
  }
  if (await confirmOrCancel({ message: "是否配置 Codex 第三方 API？", initialValue: commandExists("codex") })) {
    await configureCodexApi();
  }
  if (await confirmOrCancel({ message: "是否安装或更新 Pi CLI？", initialValue: false })) {
    await installCliTool("pi");
  }
  if (await confirmOrCancel({ message: "是否配置 Pi gpt 自定义 API？", initialValue: commandExists("pi") })) {
    await configurePiApi(options.agentsDir);
  }
  if (await confirmOrCancel({ message: "是否填写 grok-search 环境变量？", initialValue: false })) {
    await configureGrokSearchEnv(options.agentsDir);
  }
  if (await confirmOrCancel({ message: "是否填写 context7-auto-research 环境变量？", initialValue: false })) {
    await configureContext7Env(options.agentsDir);
  }
  if (await confirmOrCancel({ message: "是否填写 prompt-enhancer 环境变量？", initialValue: false })) {
    await configurePromptEnhancerEnv(options.agentsDir);
  }

  p.log.success(c.green("AbelWorkflow 完整初始化完成"));
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
        "pi-install": async () => installCliTool("pi"),
        "pi-api": async () => configurePiApi(options.agentsDir)
      }
    },
    "codex-cli": {
      tool: "codex",
      title: "Codex",
      actions: {
        "codex-install": async () => installCliTool("codex"),
        "codex-api": async () => configureCodexApi()
      }
    },
    "claude-cli": {
      tool: "claude",
      title: "Claude Code",
      actions: {
        "claude-install": async () => installCliTool("claude"),
        "claude-api": async () => configureClaudeApi()
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
    install: async () => installManagedWorkflow({
      agentsDir: options.agentsDir,
      force: options.force,
      relinkOnly: options.relinkOnly
    }),
    "grok-search": async () => configureGrokSearchEnv(options.agentsDir),
    context7: async () => configureContext7Env(options.agentsDir),
    "prompt-enhancer": async () => configurePromptEnhancerEnv(options.agentsDir),
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

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    defaultAgentsDir,
    resolvePath: resolve
  });

  if (options.command === "help") {
    printHelp();
    return;
  }

  // 非交互模式下菜单命令自动回退为 install
  if (options.command === "menu" && options.nonInteractive) {
    console.log("检测到非交互模式，自动执行工作流安装...");
    options.command = "install";
  }

  if (options.command === "install") {
    try {
      await installManagedWorkflow(options);
    } catch (error) {
      const message = `操作失败: ${error.message || String(error)}`;
      // 非交互模式输出纯文本便于日志捕获/管道处理；交互模式使用 clack 格式化输出
      if (options.nonInteractive) {
        console.error(message);
      } else {
        p.outro(c.red(message));
      }
      process.exit(1);
    }
    return;
  }

  assertInteractiveMenuSupported({
    command: options.command,
    inputIsTTY: input.isTTY,
    outputIsTTY: output.isTTY,
    nonInteractive: options.nonInteractive
  });

  try {
    await runInteractiveMenu(options);
  } catch (error) {
    const message = `操作失败: ${error.message || String(error)}`;
    // 非交互模式输出纯文本便于日志捕获/管道处理；交互模式使用 clack 格式化输出
    if (options.nonInteractive) {
      console.error(message);
    } else {
      p.outro(c.red(message));
    }
    process.exit(1);
  }
}

export {
  applyClaudeInsecureTlsSetting,
  applyClaudePermissionFeature,
  buildCliToolInstallCommand,
  buildDefaultClaudeSettings,
  buildCodexConfigContent,
  buildPiAuthConfig,
  buildPiModelsConfig,
  buildPiSettingsConfig,
  chooseCliInstallPackageManager,
  getPackageManagerInstallHelp,
  getAugmentContextEnginePromptOptions,
  getRunCommandSpawnOptions,
  hasPromptEnhancerApiConfig,
  inferPackageManagerFromCommandPath,
  getPiApiPromptOptions,
  inferPiApiFromBaseUrl,
  main,
  mergeCodexAuthData,
  mergeClaudeSettingsWithDefaults,
  normalizeOpenAiBaseUrl,
  renderManagedWorkflowContent,
  resolveAugmentContextEngineFeature,
  resolvePromptEnhancerMode,
  resolveExistingCodexApiConfig,
  parsePiModelIds,
  resolveExistingPiApiConfig,
  stripJsonComments,
  updatePiAuthFile,
  updateTomlSectionFields
};
