import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backupIfNeeded, pathExists, pathTargetExists } from "../config/store.mjs";
import { isWindows } from "../paths.mjs";
import { ensureManagedContainerDirectory, hashBytes } from "./assets.mjs";

function shouldForceFileSymlinkFailure(kind) {
  return process.env.ABELWORKFLOW_TEST_FORCE_FILE_SYMLINK_EPERM === "1" && isWindows() && kind === "file";
}

async function createManagedTargetState(targetPath, sourcePath, kind, mode, status) {
  let targetHash;
  if (kind === "file" && await pathTargetExists(targetPath)) {
    targetHash = hashBytes(await fs.readFile(targetPath));
  }
  return { targetPath, sourcePath, kind, mode, status, ...(targetHash ? { targetHash } : {}) };
}

async function createSymlink(targetPath, sourcePath, linkType, kind) {
  if (shouldForceFileSymlinkFailure(kind)) {
    const error = new Error("simulated EPERM");
    error.code = "EPERM";
    throw error;
  }
  await fs.symlink(sourcePath, targetPath, linkType);
}

async function symlinkPointsTo(targetPath, sourcePath) {
  try {
    if (!(await fs.lstat(targetPath)).isSymbolicLink()) return false;
    const existing = await fs.readlink(targetPath);
    return resolve(dirname(targetPath), existing) === resolve(sourcePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function previousStateOwnsSource(previousState, sourcePath, kind) {
  return Boolean(previousState)
    && resolve(previousState.sourcePath) === resolve(sourcePath)
    && previousState.kind === kind;
}

function isUnverifiedWindowsCopy(previousState, kind) {
  return isWindows()
    && kind === "file"
    && previousState?.kind === "file"
    && previousState.mode === "copy"
    && !previousState.targetHash;
}

async function targetMatchesPreviousState(targetPath, previousState) {
  if (!previousState || !(await pathExists(targetPath))) return false;
  const targetStat = await fs.lstat(targetPath);
  if (previousState.mode === "symlink") {
    return targetStat.isSymbolicLink() && symlinkPointsTo(targetPath, previousState.sourcePath);
  }
  if (previousState.mode === "hardlink") {
    if (!targetStat.isFile()) return false;
    if (previousState.targetHash) {
      return hashBytes(await fs.readFile(targetPath)) === previousState.targetHash;
    }
    try {
      const sourceStat = await fs.stat(previousState.sourcePath);
      if (targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return false;
  }
  if (previousState.mode === "copy") {
    if (previousState.kind !== "file" || !targetStat.isFile() || !previousState.targetHash) return false;
    return hashBytes(await fs.readFile(targetPath)) === previousState.targetHash;
  }
  return false;
}

async function ordinaryFileMatchesSource(targetPath, sourcePath, kind) {
  if (kind !== "file") return false;
  try {
    const targetStat = await fs.lstat(targetPath);
    if (!targetStat.isFile()) return false;
    const [targetContent, sourceContent] = await Promise.all([
      fs.readFile(targetPath),
      fs.readFile(sourcePath)
    ]);
    return targetContent.equals(sourceContent);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function moveReplaceableTarget(targetPath) {
  const targetStat = await fs.lstat(targetPath);
  if (targetStat.isDirectory() && !targetStat.isSymbolicLink()) return false;
  await backupIfNeeded(targetPath);
  return true;
}

async function ensureManagedLink(targetPath, sourcePath, kind, previousLinkedTargets = {}, options = {}) {
  const force = options.force ?? false;
  await fs.mkdir(dirname(targetPath), { recursive: true });
  const sourceExists = await pathTargetExists(sourcePath);
  const targetExists = await pathExists(targetPath);
  const previousState = previousLinkedTargets[targetPath];
  const wasPreviouslyManaged = previousStateOwnsSource(previousState, sourcePath, kind);
  const isUnverifiedCopy = wasPreviouslyManaged && isUnverifiedWindowsCopy(previousState, kind);

  if (targetExists && await symlinkPointsTo(targetPath, sourcePath)) {
    if (!sourceExists) {
      await fs.rm(targetPath, { recursive: true, force: true });
      return { targetPath, status: "removed" };
    }
    return createManagedTargetState(targetPath, sourcePath, kind, "symlink", "unchanged");
  }

  if (!sourceExists) {
    if (!targetExists) return { targetPath, status: "removed" };
    if (!wasPreviouslyManaged) return { targetPath, status: "skipped" };
    if (isUnverifiedCopy) return { targetPath, status: "conflict" };
    if (await targetMatchesPreviousState(targetPath, previousState)) {
      await fs.rm(targetPath, { recursive: true, force: true });
      return { targetPath, status: "removed" };
    }
    if (force && await moveReplaceableTarget(targetPath)) return { targetPath, status: "removed" };
    return { targetPath, status: "conflict" };
  }

  if (targetExists && !wasPreviouslyManaged && await ordinaryFileMatchesSource(targetPath, sourcePath, kind)) {
    return createManagedTargetState(targetPath, sourcePath, kind, "copy", "unchanged");
  }

  if (targetExists) {
    if (isUnverifiedCopy) {
      if (await ordinaryFileMatchesSource(targetPath, sourcePath, kind)) {
        return createManagedTargetState(targetPath, sourcePath, kind, "copy", "unchanged");
      }
      return { targetPath, status: "conflict" };
    }
    const matchesPrevious = wasPreviouslyManaged && await targetMatchesPreviousState(targetPath, previousState);
    if (matchesPrevious && await ordinaryFileMatchesSource(targetPath, sourcePath, kind)) {
      return createManagedTargetState(targetPath, sourcePath, kind, previousState.mode, "unchanged");
    }
    if ((!matchesPrevious && !force) || !(await moveReplaceableTarget(targetPath))) {
      return { targetPath, status: "conflict" };
    }
  }

  const linkType = isWindows() ? (kind === "dir" ? "junction" : "file") : kind;
  try {
    await createSymlink(targetPath, sourcePath, linkType, kind);
    return createManagedTargetState(targetPath, sourcePath, kind, "symlink", "linked");
  } catch (error) {
    if (!shouldFallbackToManagedFile(error, kind)) throw error;
  }

  try {
    await fs.link(sourcePath, targetPath);
    return createManagedTargetState(targetPath, sourcePath, kind, "hardlink", "linked");
  } catch (error) {
    if (!shouldCopyManagedFile(error)) throw error;
  }

  await fs.cp(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: true });
  return createManagedTargetState(targetPath, sourcePath, kind, "copy", "linked");
}

function shouldFallbackToManagedFile(error, kind) {
  return kind === "file" && isWindows() && ["EPERM", "EACCES"].includes(error?.code);
}

function shouldCopyManagedFile(error) {
  return ["EPERM", "EACCES", "EXDEV", "EINVAL", "UNKNOWN"].includes(error?.code);
}

async function pathIsDirectory(path) {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes(error?.code)) return false;
    throw error;
  }
}

async function pathIsFile(path) {
  try {
    return (await fs.stat(path)).isFile();
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes(error?.code)) return false;
    throw error;
  }
}

async function ensureProviderRootDirectory(homeDir, ...segments) {
  await fs.mkdir(homeDir, { recursive: true });
  let directory = homeDir;
  for (const segment of segments) {
    directory = join(directory, segment);
    let stat;
    try {
      stat = await fs.lstat(directory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await fs.mkdir(directory);
      } catch (mkdirError) {
        if (mkdirError?.code === "EEXIST") {
          throw new Error(`Provider root conflict at ${directory}`, { cause: mkdirError });
        }
        throw mkdirError;
      }
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Provider root conflict at ${directory}`);
    }
  }
  return directory;
}

async function getDirectoryNames(root) {
  if (!(await pathIsDirectory(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const names = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) return entry.name;
    if (entry.isSymbolicLink() && await pathIsDirectory(join(root, entry.name))) return entry.name;
    return null;
  }));
  return names.filter(Boolean);
}

async function getCommandNames(commandsDir) {
  if (!(await pathIsDirectory(commandsDir))) return [];
  const entries = await fs.readdir(commandsDir, { withFileTypes: true });
  const names = await Promise.all(entries.map(async (entry) => {
    if (!entry.name.endsWith(".md")) return null;
    if (entry.isFile()) return entry.name;
    if (entry.isSymbolicLink() && await pathIsFile(join(commandsDir, entry.name))) return entry.name;
    return null;
  }));
  return names.filter(Boolean);
}

async function getPiExtensionNames(extensionsDir) {
  if (!(await pathIsDirectory(extensionsDir))) return [];
  const entries = await fs.readdir(extensionsDir, { withFileTypes: true });
  const names = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(extensionsDir, entry.name);
    if (entry.isDirectory()) return await pathIsFile(join(entryPath, "index.ts")) ? entry.name : null;
    if (entry.isFile()) return entry.name.endsWith(".ts") ? entry.name : null;
    if (!entry.isSymbolicLink()) return null;
    if (entry.name.endsWith(".ts") && await pathIsFile(entryPath)) return entry.name;
    return await pathIsFile(join(entryPath, "index.ts")) ? entry.name : null;
  }));
  return names.filter(Boolean);
}

function isWithinManagedRoot(targetPath, managedSourceRoot, pathOps = { isAbsolute, relative, sep }) {
  const relativePath = pathOps.relative(managedSourceRoot, targetPath);
  return relativePath !== ""
    && !pathOps.isAbsolute(relativePath)
    && relativePath !== ".."
    && !relativePath.startsWith(`..${pathOps.sep}`);
}

async function pruneManagedTargets(targetDir, managedSourceRoot, expectedNames, previousLinkedTargets, options = {}) {
  const resolvedTargetDir = resolve(targetDir);
  const expectedNameSet = new Set(expectedNames);
  const results = [];
  for (const [targetPath, previousState] of Object.entries(previousLinkedTargets)) {
    const resolvedTargetPath = resolve(targetPath);
    if (targetPath !== resolvedTargetPath || dirname(resolvedTargetPath) !== resolvedTargetDir) continue;
    if (!isWithinManagedRoot(resolve(previousState.sourcePath), resolve(managedSourceRoot))) continue;
    if (expectedNameSet.has(basename(resolvedTargetPath)) && await pathTargetExists(previousState.sourcePath)) continue;
    if (!(await pathExists(resolvedTargetPath))) {
      results.push({ targetPath, status: "removed" });
      continue;
    }
    const isUnverifiedCopy = isUnverifiedWindowsCopy(previousState, previousState.kind);
    const matchesPrevious = await targetMatchesPreviousState(resolvedTargetPath, previousState)
      || (isUnverifiedCopy && await ordinaryFileMatchesSource(
        resolvedTargetPath,
        previousState.sourcePath,
        previousState.kind
      ));
    if (matchesPrevious) {
      await fs.rm(resolvedTargetPath, { recursive: true, force: true });
      results.push({ targetPath, status: "removed" });
      continue;
    }
    if (isUnverifiedCopy) {
      results.push({ targetPath, status: "conflict" });
      continue;
    }
    if (options.force && await moveReplaceableTarget(resolvedTargetPath)) {
      results.push({ targetPath, status: "removed" });
      continue;
    }
    results.push({ targetPath, status: "conflict" });
  }
  return results;
}

async function linkSkillDirectories(baseDir, paths, previousLinkedTargets, options) {
  const results = [];
  const skillsRoot = join(paths.agentsDir, "skills");
  const skillNames = (await getDirectoryNames(skillsRoot)).filter((skillName) => skillName !== ".system");
  results.push(...await pruneManagedTargets(
    join(baseDir, "skills"),
    skillsRoot,
    skillNames,
    previousLinkedTargets,
    options
  ));
  for (const skillName of skillNames) {
    results.push(await ensureManagedLink(
      join(baseDir, "skills", skillName),
      join(skillsRoot, skillName),
      "dir",
      previousLinkedTargets,
      options
    ));
  }
  return results;
}

async function linkCommands(targetDir, paths, previousLinkedTargets, options) {
  const commandsRoot = join(paths.agentsDir, "commands");
  const commandFiles = await getCommandNames(commandsRoot);
  const results = await pruneManagedTargets(targetDir, commandsRoot, commandFiles, previousLinkedTargets, options);
  for (const fileName of commandFiles) {
    results.push(await ensureManagedLink(
      join(targetDir, fileName),
      join(commandsRoot, fileName),
      "file",
      previousLinkedTargets,
      options
    ));
  }
  return results;
}

async function linkClaude(paths, previousLinkedTargets = {}, options = {}) {
  const claudeDir = await ensureProviderRootDirectory(paths.homeDir, ".claude");
  await ensureManagedContainerDirectory(join(claudeDir, "commands"), join(paths.agentsDir, "commands"));
  await ensureManagedContainerDirectory(join(claudeDir, "skills"), join(paths.agentsDir, "skills"));
  return [
    await ensureManagedLink(
      join(claudeDir, "CLAUDE.md"),
      join(paths.agentsDir, "AGENTS.md"),
      "file",
      previousLinkedTargets,
      options
    ),
    ...await linkCommands(join(claudeDir, "commands"), paths, previousLinkedTargets, options),
    ...await linkSkillDirectories(claudeDir, paths, previousLinkedTargets, options)
  ];
}

async function linkCodex(paths, previousLinkedTargets = {}, options = {}) {
  const codexDir = await ensureProviderRootDirectory(paths.homeDir, ".codex");
  await ensureManagedContainerDirectory(join(codexDir, "skills"), join(paths.agentsDir, "skills"));
  await ensureManagedContainerDirectory(join(codexDir, "prompts"), join(paths.agentsDir, "commands"));
  return [
    await ensureManagedLink(
      join(codexDir, "AGENTS.md"),
      join(paths.agentsDir, "AGENTS.md"),
      "file",
      previousLinkedTargets,
      options
    ),
    ...await linkSkillDirectories(codexDir, paths, previousLinkedTargets, options),
    ...await linkCommands(join(codexDir, "prompts"), paths, previousLinkedTargets, options)
  ];
}

async function linkPi(paths, previousLinkedTargets = {}, options = {}) {
  const piAgentDir = await ensureProviderRootDirectory(paths.homeDir, ".pi", "agent");
  await ensureManagedContainerDirectory(join(piAgentDir, "skills"), join(paths.agentsDir, "skills"));
  await ensureManagedContainerDirectory(join(piAgentDir, "prompts"), join(paths.agentsDir, "commands"));
  await ensureManagedContainerDirectory(join(piAgentDir, "extensions"), join(paths.agentsDir, "extensions"));
  const results = [
    await ensureManagedLink(
      join(piAgentDir, "AGENTS.md"),
      join(paths.agentsDir, "AGENTS.md"),
      "file",
      previousLinkedTargets,
      options
    ),
    ...await linkSkillDirectories(piAgentDir, paths, previousLinkedTargets, options),
    ...await linkCommands(join(piAgentDir, "prompts"), paths, previousLinkedTargets, options)
  ];
  const extensionsRoot = join(paths.agentsDir, "extensions");
  const extensionNames = await getPiExtensionNames(extensionsRoot);
  results.push(...await pruneManagedTargets(
    join(piAgentDir, "extensions"),
    extensionsRoot,
    extensionNames,
    previousLinkedTargets,
    options
  ));
  for (const entryName of extensionNames) {
    const sourcePath = join(extensionsRoot, entryName);
    results.push(await ensureManagedLink(
      join(piAgentDir, "extensions", entryName),
      sourcePath,
      await pathIsDirectory(sourcePath) ? "dir" : "file",
      previousLinkedTargets,
      options
    ));
  }
  return results;
}

export {
  ensureManagedLink,
  getCommandNames,
  isWithinManagedRoot,
  linkClaude,
  linkCodex,
  linkPi,
  pathIsDirectory,
  pathIsFile,
  pruneManagedTargets
};
