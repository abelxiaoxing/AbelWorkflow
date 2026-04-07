import { cp, link, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(__filename));
const home = homedir();
const defaultAgentsDir = join(home, ".agents");
const installMetadataName = ".abelworkflow-install.json";
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

function parseArgs(argv) {
  const options = {
    agentsDir: defaultAgentsDir,
    force: false,
    relinkOnly: false
  };

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
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`AbelWorkflow installer

Usage:
  npx abelworkflow
  npx abelworkflow --force
  npx abelworkflow --link-only
  npx abelworkflow --agents-dir /custom/path
`);
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
    // Broken symlinks should be replaced so managed content can be restored.
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
    const stat = await lstat(targetPath);
    if (stat.isSymbolicLink()) {
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

    if (
      wasPreviouslyManaged
    ) {
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

async function install() {
  const options = parseArgs(process.argv.slice(2));
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

install().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
