import { spawn, spawnSync } from "node:child_process";
import { cp, link, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(__filename));
const home = homedir();
const defaultAgentsDir = join(home, ".agents");
const installMetadataName = ".abelworkflow-install.json";
const claudeSettingsPath = join(home, ".claude", "settings.json");
const claudeVscodeConfigPath = join(home, ".claude", "config.json");
const claudeMetaConfigPath = join(home, ".claude.json");
const codexConfigPath = join(home, ".codex", "config.toml");
const codexAuthPath = join(home, ".codex", "auth.json");
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
      "NotebookEdit",
      "mcp__augment-context-engine"
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
const menuChoices = [
  { value: "full-init", label: "完整初始化：同步工作流 + 可选安装/配置 Claude Code、Codex、技能环境" },
  { value: "install", label: "仅同步/更新工作流到 ~/.agents 并重新链接 Claude/Codex" },
  { value: "grok-search", label: "配置 grok-search 环境变量" },
  { value: "context7", label: "配置 context7-auto-research 环境变量" },
  { value: "prompt-enhancer", label: "配置 prompt-enhancer 环境变量" },
  { value: "claude-install", label: "安装或更新 Claude Code CLI" },
  { value: "claude-api", label: "配置 Claude Code 第三方 API" },
  { value: "codex-install", label: "安装或更新 Codex CLI" },
  { value: "codex-api", label: "配置 Codex 第三方 API" },
  { value: "exit", label: "退出" }
];

function parseArgs(argv) {
  const options = {
    agentsDir: defaultAgentsDir,
    force: false,
    relinkOnly: false,
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
      options.agentsDir = resolve(value);
      i += 1;
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

  if (options.command === "menu" && (options.force || options.relinkOnly || options.agentsDir !== defaultAgentsDir)) {
    throw new Error("`--force`、`--link-only`、`--agents-dir` 仅能与 `install` 命令一起使用");
  }

  return options;
}

function printHelp() {
  console.log(`AbelWorkflow installer

Usage:
  npx abelworkflow
  npx abelworkflow init
  npx abelworkflow install
  npx abelworkflow install --force
  npx abelworkflow install --link-only
  npx abelworkflow install --agents-dir /custom/path

Default behavior:
  - npx abelworkflow: open the interactive setup menu.
  - npx abelworkflow install: sync managed files and links explicitly.
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

async function backupIfNeeded(targetPath, force) {
  if (!(await pathExists(targetPath))) {
    return null;
  }
  if (!force) {
    const backupPath = `${targetPath}.bak.${Date.now()}`;
    await rename(targetPath, backupPath);
    return backupPath;
  }
  await rm(targetPath, { recursive: true, force: true });
  return null;
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

async function replaceManagedEntry(source, target, entry) {
  if (await pathsReferToSameEntry(source, target)) {
    return;
  }

  const sourceStat = await lstat(source);
  if (sourceStat.isDirectory()) {
    await rm(target, { recursive: true, force: true });
  } else if (await pathExists(target)) {
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
      if (targetStat.isDirectory()) {
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

async function ensureManagedLink(targetPath, sourcePath, kind, force, previousLinkedTargets) {
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
      await backupIfNeeded(targetPath, force);
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

async function linkSkillDirectories(baseDir, agentsDir, force, previousLinkedTargets) {
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
        force,
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

function getResultMarker(status) {
  if (status === "unchanged") {
    return "=";
  }

  if (status === "removed") {
    return "-";
  }

  return "+";
}

async function linkClaude(agentsDir, force, previousLinkedTargets) {
  const claudeDir = join(home, ".claude");
  await mkdir(claudeDir, { recursive: true });
  await removeIfNotDirectory(join(claudeDir, "commands"));
  await removeIfNotDirectory(join(claudeDir, "skills"));
  await mkdir(join(claudeDir, "commands"), { recursive: true });
  await mkdir(join(claudeDir, "skills"), { recursive: true });

  return [
    await ensureManagedLink(
      join(claudeDir, "CLAUDE.md"),
      join(agentsDir, "AGENTS.md"),
      "file",
      force,
      previousLinkedTargets
    ),
    await ensureManagedLink(
      join(claudeDir, "commands", "oc"),
      join(agentsDir, "commands", "oc"),
      "dir",
      force,
      previousLinkedTargets
    ),
    ...(await linkSkillDirectories(claudeDir, agentsDir, force, previousLinkedTargets))
  ];
}

async function linkCodex(agentsDir, force, previousLinkedTargets) {
  const results = [];
  const codexDir = join(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  await removeIfNotDirectory(join(codexDir, "skills"));
  await removeIfNotDirectory(join(codexDir, "prompts"));
  await mkdir(join(codexDir, "skills"), { recursive: true });
  await mkdir(join(codexDir, "prompts"), { recursive: true });

  results.push(
    await ensureManagedLink(
      join(codexDir, "AGENTS.md"),
      join(agentsDir, "AGENTS.md"),
      "file",
      force,
      previousLinkedTargets
    )
  );
  results.push(...(await linkSkillDirectories(codexDir, agentsDir, force, previousLinkedTargets)));

  const commandFiles = await getCommandNames(join(agentsDir, "commands", "oc"));
  results.push(
    ...(await pruneManagedTargets(
      join(codexDir, "prompts"),
      join(agentsDir, "commands", "oc"),
      commandFiles,
      previousLinkedTargets
    ))
  );
  for (const fileName of commandFiles) {
    results.push(
      await ensureManagedLink(
        join(codexDir, "prompts", fileName),
        join(agentsDir, "commands", "oc", fileName),
        "file",
        force,
        previousLinkedTargets
      )
    );
  }

  return results;
}

async function installManagedWorkflow(options) {
  let previousMetadata = {};
  let managedChildren = {};

  if (!options.relinkOnly) {
    ({ previousMetadata, managedChildren } = await syncManagedFiles(options.agentsDir));
  } else if (!(await pathExists(options.agentsDir))) {
    throw new Error(`${options.agentsDir} does not exist; remove --link-only or install first`);
  } else {
    previousMetadata = await readInstallMetadata(options.agentsDir);
    managedChildren = previousMetadata.managedChildren ?? {};
  }

  const previousLinkedTargets = previousMetadata.linkedTargets ?? {};
  const claudeResults = await linkClaude(options.agentsDir, options.force, previousLinkedTargets);
  const codexResults = await linkCodex(options.agentsDir, options.force, previousLinkedTargets);
  const linkedTargets = Object.fromEntries(
    [...claudeResults, ...codexResults]
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

  await writeInstallMetadata(options.agentsDir, {
    package: "abelworkflow",
    installedAt: new Date().toISOString(),
    managedChildren,
    linkedTargets
  });

  console.log(`Installed AbelWorkflow into ${options.agentsDir}`);
  console.log("");
  console.log("Linked targets:");
  for (const result of [...claudeResults, ...codexResults]) {
    console.log(`- ${getResultMarker(result.status)} ${result.targetPath}`);
  }
  console.log("");
  console.log("Done. Re-run `npx abelworkflow@latest` to update the managed files.");
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderDotenv(current), "utf8");
}

function currentChoiceIndex(choices, defaultValue) {
  if (defaultValue === undefined) {
    return -1;
  }
  return choices.findIndex((choice) => choice.value === defaultValue);
}

async function setTerminalEcho(enabled) {
  if (!input.isTTY || isWindows()) {
    return;
  }

  const result = spawnSync("stty", [enabled ? "echo" : "-echo"], { stdio: ["inherit", "ignore", "ignore"] });
  if (result.error) {
    throw result.error;
  }
}

async function promptText(message, options = {}) {
  const { defaultValue, allowEmpty = false } = options;

  while (true) {
    const suffix = defaultValue !== undefined && defaultValue !== ""
      ? ` [${defaultValue}]`
      : "";
    const rl = createInterface({ input, output });
    let answer;
    try {
      answer = await rl.question(`${message}${suffix}: `);
    } finally {
      rl.close();
    }

    const value = answer.trim();
    if (!value && defaultValue !== undefined) {
      return defaultValue;
    }
    if (!value && !allowEmpty) {
      console.log("此项不能为空。");
      continue;
    }
    return value;
  }
}

async function promptSecret(message, options = {}) {
  const { defaultValue, allowEmpty = false } = options;

  if (!input.isTTY || isWindows()) {
    while (true) {
      const suffix = defaultValue !== undefined && defaultValue !== ""
        ? " [直接回车保留现有值]"
        : "";
      const rl = createInterface({ input, output });
      let answer;
      try {
        answer = await rl.question(`${message}${suffix}: `);
      } finally {
        rl.close();
      }

      const value = answer.trim();
      if (!value && defaultValue !== undefined) {
        return defaultValue;
      }
      if (!value && !allowEmpty) {
        console.log("此项不能为空。");
        continue;
      }
      return value;
    }
  }

  while (true) {
    const suffix = defaultValue !== undefined && defaultValue !== ""
      ? " [直接回车保留现有值]"
      : "";
    const rl = createInterface({ input, output, terminal: true });
    let answer;
    try {
      await setTerminalEcho(false);
      answer = await rl.question(`${message}${suffix}: `);
      output.write("\n");
    } finally {
      await setTerminalEcho(true);
      rl.close();
    }

    const value = answer.trim();
    if (!value && defaultValue !== undefined) {
      return defaultValue;
    }
    if (!value && !allowEmpty) {
      console.log("此项不能为空。");
      continue;
    }
    return value;
  }
}

async function promptSelect(message, choices, options = {}) {
  const defaultIndex = currentChoiceIndex(choices, options.defaultValue);
  console.log(`\n${message}`);
  choices.forEach((choice, index) => {
    const defaultMarker = index === defaultIndex ? " [默认]" : "";
    console.log(`  ${index + 1}. ${choice.label}${defaultMarker}`);
  });

  while (true) {
    const fallbackValue = defaultIndex >= 0 ? String(defaultIndex + 1) : undefined;
    const answer = await promptText("请输入序号", { defaultValue: fallbackValue, allowEmpty: defaultIndex >= 0 });
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) {
      return choices[index].value;
    }
    const direct = choices.find((choice) => choice.value === answer);
    if (direct) {
      return direct.value;
    }
    console.log("无效选择，请重新输入。");
  }
}

async function promptConfirm(message, defaultValue = true) {
  const value = await promptSelect(message, [
    { value: true, label: "是" },
    { value: false, label: "否" }
  ], { defaultValue });
  return value;
}

function commandExists(command) {
  const checker = isWindows() ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}

async function runCommand(command, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
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

function sanitizeProviderId(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/gu, "-")
    .replace(/[^a-z0-9_-]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "") || "abelworkflow";
}

async function ensureWorkflowPresent(agentsDir) {
  if (await pathExists(join(agentsDir, "AGENTS.md"))) {
    return;
  }

  console.log("未检测到已安装的 AbelWorkflow，先执行一次工作流同步。");
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
  const baseUrl = await promptText("Grok API URL", {
    defaultValue: existing.GROK_API_URL || "https://api.x.ai/v1"
  });
  const apiKey = await promptSecret("Grok API Key", {
    defaultValue: existing.GROK_API_KEY || undefined
  });
  const model = await promptText("Grok 默认模型", {
    defaultValue: existing.GROK_MODEL || "grok-4-fast"
  });
  const useTavily = await promptConfirm("是否同时配置 Tavily 作为额外搜索源？", Boolean(existing.TAVILY_API_KEY));
  const tavilyKey = useTavily
    ? await promptSecret("Tavily API Key", { defaultValue: existing.TAVILY_API_KEY || undefined })
    : "";

  await updateDotenvFile(envPath, {
    GROK_API_URL: baseUrl,
    GROK_API_KEY: apiKey,
    GROK_MODEL: model,
    TAVILY_API_KEY: useTavily ? tavilyKey : null,
    TAVILY_ENABLED: useTavily ? "true" : null
  });

  console.log(`已写入 ${pathToLabel(envPath)}`);
}

async function configureContext7Env(agentsDir) {
  await ensureWorkflowPresent(agentsDir);
  const envPath = join(agentsDir, "skills", "context7-auto-research", ".env");
  const existing = await readDotenvFile(envPath);
  const apiKey = await promptSecret("Context7 API Key", {
    defaultValue: existing.CONTEXT7_API_KEY || undefined,
    allowEmpty: true
  });

  await updateDotenvFile(envPath, {
    CONTEXT7_API_KEY: apiKey || null
  });

  console.log(`已写入 ${pathToLabel(envPath)}`);
}

function resolvePromptEnhancerMode(existing) {
  if (existing.ANTHROPIC_API_KEY) {
    return "anthropic";
  }
  if (existing.OPENAI_API_KEY) {
    return "openai";
  }
  return "local";
}

async function configurePromptEnhancerEnv(agentsDir) {
  await ensureWorkflowPresent(agentsDir);
  const envPath = join(agentsDir, "skills", "prompt-enhancer", ".env");
  const existing = await readDotenvFile(envPath);
  const mode = await promptSelect("请选择 prompt-enhancer 使用的提供方", [
    { value: "anthropic", label: "Anthropic 兼容 Key" },
    { value: "openai", label: "OpenAI 兼容 Key" },
    { value: "local", label: "仅保留本地模板兜底，不写 API Key" }
  ], { defaultValue: resolvePromptEnhancerMode(existing) });

  if (mode === "anthropic") {
    const apiKey = await promptSecret("ANTHROPIC_API_KEY", {
      defaultValue: existing.ANTHROPIC_API_KEY || undefined
    });
    const model = await promptText("PE_MODEL", {
      defaultValue: existing.PE_MODEL || "claude-sonnet-4-20250514"
    });

    await updateDotenvFile(envPath, {
      ANTHROPIC_API_KEY: apiKey,
      OPENAI_API_KEY: null,
      PE_MODEL: model
    });
  } else if (mode === "openai") {
    const apiKey = await promptSecret("OPENAI_API_KEY", {
      defaultValue: existing.OPENAI_API_KEY || undefined
    });
    const model = await promptText("PE_MODEL", {
      defaultValue: existing.PE_MODEL || "gpt-4o"
    });

    await updateDotenvFile(envPath, {
      OPENAI_API_KEY: apiKey,
      ANTHROPIC_API_KEY: null,
      PE_MODEL: model
    });
  } else {
    await updateDotenvFile(envPath, {
      ANTHROPIC_API_KEY: null,
      OPENAI_API_KEY: null
    });
  }

  console.log(`已写入 ${pathToLabel(envPath)}`);
}

function mergeClaudeSettingsWithDefaults(settings) {
  const env = settings?.env && typeof settings.env === "object" ? settings.env : {};
  const permissions = settings?.permissions && typeof settings.permissions === "object" ? settings.permissions : {};
  return {
    ...defaultClaudeSettings,
    ...settings,
    env: {
      ...defaultClaudeSettings.env,
      ...env
    },
    permissions: {
      ...defaultClaudeSettings.permissions,
      ...permissions,
      allow: Array.isArray(permissions.allow) ? permissions.allow : defaultClaudeSettings.permissions.allow,
      deny: Array.isArray(permissions.deny) ? permissions.deny : defaultClaudeSettings.permissions.deny
    },
    hooks: settings?.hooks && typeof settings.hooks === "object" ? settings.hooks : defaultClaudeSettings.hooks
  };
}

function getExistingClaudeApiConfig(settings) {
  const env = mergeClaudeSettingsWithDefaults(settings).env;
  return {
    baseUrl: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    authType: env.ANTHROPIC_AUTH_TOKEN ? "auth_token" : "api_key",
    key: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "",
    model: claudeModelEnvKeys.map((field) => env[field]).find(Boolean) || ""
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
  const authType = await promptSelect("Claude Code 第三方 API 认证方式", [
    { value: "api_key", label: "API Key" },
    { value: "auth_token", label: "Auth Token" }
  ], { defaultValue: existing.authType });
  const baseUrl = await promptText("Claude Code Base URL", {
    defaultValue: existing.baseUrl
  });
  const key = await promptSecret(authType === "auth_token" ? "Claude Code Auth Token" : "Claude Code API Key", {
    defaultValue: existing.key || undefined
  });
  const model = await promptText("Claude Code 模型", {
    defaultValue: existing.model || undefined
  });

  const nextSettings = mergeClaudeSettingsWithDefaults(settings);
  nextSettings.env.ANTHROPIC_BASE_URL = baseUrl;

  if (authType === "auth_token") {
    nextSettings.env.ANTHROPIC_AUTH_TOKEN = key;
    delete nextSettings.env.ANTHROPIC_API_KEY;
  } else {
    nextSettings.env.ANTHROPIC_API_KEY = key;
    delete nextSettings.env.ANTHROPIC_AUTH_TOKEN;
  }
  for (const field of claudeModelEnvKeys) {
    nextSettings.env[field] = model;
  }

  await writeJsonFileSafe(claudeSettingsPath, nextSettings);

  const vscodeConfig = await readJsonFileSafe(claudeVscodeConfigPath, {});
  vscodeConfig.primaryApiKey = "abelworkflow";
  await writeJsonFileSafe(claudeVscodeConfigPath, vscodeConfig);

  const metaConfig = await readJsonFileSafe(claudeMetaConfigPath, {});
  metaConfig.hasCompletedOnboarding = true;
  ensureApprovedClaudeApiKey(metaConfig, key);
  await writeJsonFileSafe(claudeMetaConfigPath, metaConfig);

  console.log(`已更新 ${pathToLabel(claudeSettingsPath)} (${authType}, ${baseUrl}, ${maskSecret(key)})`);
}

function updateTopLevelTomlField(content, field, value) {
  const lineEnding = detectLineEnding(content);
  const firstSectionMatch = content.match(/^\[/mu);
  const topLevelEnd = firstSectionMatch?.index ?? content.length;
  let topLevel = content.slice(0, topLevelEnd);
  const rest = content.slice(topLevelEnd);
  const fieldRegex = new RegExp(`^(#\\s*)?${escapeRegExp(field)}\\s*=\\s*["'][^"']*["'][ \\t]*(?:#.*)?\\r?$`, "mu");

  if (value === null) {
    topLevel = collapseBlankLines(topLevel.replace(fieldRegex, ""), lineEnding);
  } else {
    const nextLine = `${field} = ${JSON.stringify(value)}`;
    if (fieldRegex.test(topLevel)) {
      topLevel = topLevel.replace(fieldRegex, nextLine);
    } else {
      topLevel = topLevel.trimEnd()
        ? `${topLevel.trimEnd()}${lineEnding}${nextLine}${lineEnding}`
        : `${nextLine}${lineEnding}`;
    }
  }

  topLevel = topLevel.trimEnd();

  if (rest && topLevel) {
    topLevel = `${topLevel}${lineEnding}${lineEnding}`;
  }

  return `${topLevel}${rest}`;
}

function removeTomlSection(content, sectionName) {
  const lineEnding = detectLineEnding(content);
  const sectionRegex = new RegExp(`(?:\\r?\\n)?\\[${escapeRegExp(sectionName)}\\][\\s\\S]*?(?=\\r?\\n\\[|$)`, "gu");
  return collapseBlankLines(content.replace(sectionRegex, ""), lineEnding).trimEnd();
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

function readTopLevelTomlString(content, field) {
  let inSection = false;
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = true;
      continue;
    }
    if (inSection) {
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
  const match = content.match(new RegExp(`\\[${escapeRegExp(sectionName)}\\]\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\[|$)`, "u"));
  if (!match) {
    return {};
  }

  const values = {};
  for (const rawLine of match[1].split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const stringMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"$/u);
    if (stringMatch) {
      values[stringMatch[1]] = stringMatch[2];
      continue;
    }
    const boolMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(true|false)$/u);
    if (boolMatch) {
      values[boolMatch[1]] = boolMatch[2] === "true";
    }
  }
  return values;
}

async function getExistingCodexApiConfig() {
  const content = await pathExists(codexConfigPath) ? await readFile(codexConfigPath, "utf8") : "";
  const auth = await readJsonFileSafe(codexAuthPath, {});
  const providerId = readTopLevelTomlString(content, "model_provider") || "abelworkflow";
  const provider = parseTomlSection(content, `model_providers.${providerId}`);
  const envKey = provider.temp_env_key || "OPENAI_API_KEY";
  return {
    providerId,
    providerName: provider.name || (providerId === "abelworkflow" ? "AbelWorkflow" : providerId),
    baseUrl: provider.base_url || "https://api.openai.com/v1",
    envKey,
    apiKey: auth[envKey] || ""
  };
}

async function configureCodexApi() {
  const existing = await getExistingCodexApiConfig();
  const providerId = existing.providerId || "abelworkflow";
  const providerName = existing.providerName || "AbelWorkflow";
  const baseUrl = await promptText("Codex Base URL", {
    defaultValue: existing.baseUrl
  });
  const apiKey = await promptSecret("Codex 第三方 API Key", {
    defaultValue: existing.apiKey || undefined
  });
  const envKey = `${providerId.toUpperCase().replace(/-/gu, "_")}_API_KEY`;

  let content = await pathExists(codexConfigPath) ? await readFile(codexConfigPath, "utf8") : "";
  const lineEnding = detectLineEnding(content);
  content = updateTopLevelTomlField(content, "model_provider", providerId);
  content = removeTomlSection(content, `model_providers.${providerId}`);
  content = `${content.trimEnd() ? `${content.trimEnd()}${lineEnding}${lineEnding}` : ""}${buildTomlSection(`model_providers.${providerId}`, {
    name: providerName,
    base_url: baseUrl,
    wire_api: "responses",
    temp_env_key: envKey,
    requires_openai_auth: true
  }, lineEnding)}`;

  await mkdir(dirname(codexConfigPath), { recursive: true });
  await writeFile(codexConfigPath, `${content.trim()}${lineEnding}`, "utf8");

  const auth = await readJsonFileSafe(codexAuthPath, {});
  auth[envKey] = apiKey;
  await writeJsonFileSafe(codexAuthPath, auth);

  console.log(`已更新 ${pathToLabel(codexConfigPath)} (${providerId}, ${baseUrl})`);
  console.log(`已更新 ${pathToLabel(codexAuthPath)} (${maskSecret(apiKey)})`);
}

async function installCliTool(tool) {
  const toolConfig = {
    claude: {
      label: "Claude Code",
      command: "claude",
      packageName: "@anthropic-ai/claude-code"
    },
    codex: {
      label: "Codex",
      command: "codex",
      packageName: "@openai/codex"
    }
  }[tool];

  if (!toolConfig) {
    throw new Error(`Unsupported tool: ${tool}`);
  }

  const installed = commandExists(toolConfig.command);
  if (installed) {
    const shouldUpdate = await promptConfirm(`${toolConfig.label} 已检测到，是否继续执行 npm 强制安装/更新？`, false);
    if (!shouldUpdate) {
      console.log(`跳过 ${toolConfig.label} 安装。`);
      return;
    }
  }

  console.log(`开始安装 ${toolConfig.label}...`);
  await runCommand("npm", ["install", "-g", toolConfig.packageName, "--force"]);
  console.log(`${toolConfig.label} 安装完成。`);
}

async function runFullInit(options) {
  await installManagedWorkflow({
    agentsDir: options.agentsDir,
    force: options.force,
    relinkOnly: false
  });

  if (await promptConfirm("是否安装或更新 Claude Code CLI？", false)) {
    await installCliTool("claude");
  }
  if (await promptConfirm("是否配置 Claude Code 第三方 API？", commandExists("claude"))) {
    await configureClaudeApi();
  }
  if (await promptConfirm("是否安装或更新 Codex CLI？", false)) {
    await installCliTool("codex");
  }
  if (await promptConfirm("是否配置 Codex 第三方 API？", commandExists("codex"))) {
    await configureCodexApi();
  }
  if (await promptConfirm("是否填写 grok-search 环境变量？", true)) {
    await configureGrokSearchEnv(options.agentsDir);
  }
  if (await promptConfirm("是否填写 context7-auto-research 环境变量？", true)) {
    await configureContext7Env(options.agentsDir);
  }
  if (await promptConfirm("是否填写 prompt-enhancer 环境变量？", true)) {
    await configurePromptEnhancerEnv(options.agentsDir);
  }

  console.log("\nAbelWorkflow 完整初始化完成。");
}

async function runInteractiveMenu(options) {
  console.log("AbelWorkflow Setup");
  console.log(`工作流目录: ${pathToLabel(options.agentsDir)}`);

  while (true) {
    const choice = await promptSelect("请选择操作", menuChoices, { defaultValue: "full-init" });

    if (choice === "exit") {
      return;
    }

    if (choice === "full-init") {
      await runFullInit(options);
      continue;
    }
    if (choice === "install") {
      await installManagedWorkflow({
        agentsDir: options.agentsDir,
        force: options.force,
        relinkOnly: options.relinkOnly
      });
      continue;
    }
    if (choice === "grok-search") {
      await configureGrokSearchEnv(options.agentsDir);
      continue;
    }
    if (choice === "context7") {
      await configureContext7Env(options.agentsDir);
      continue;
    }
    if (choice === "prompt-enhancer") {
      await configurePromptEnhancerEnv(options.agentsDir);
      continue;
    }
    if (choice === "claude-install") {
      await installCliTool("claude");
      continue;
    }
    if (choice === "claude-api") {
      await configureClaudeApi();
      continue;
    }
    if (choice === "codex-install") {
      await installCliTool("codex");
      continue;
    }
    if (choice === "codex-api") {
      await configureCodexApi();
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "help") {
    printHelp();
    return;
  }

  if (options.command === "install") {
    await installManagedWorkflow(options);
    return;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error("交互式菜单需要 TTY 终端；非交互场景请显式使用 `npx abelworkflow install`");
  }

  await runInteractiveMenu(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
