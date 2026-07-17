import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  backupIfNeeded,
  pathExists,
  pathTargetExists,
  readJsonFileSafe,
  writeText
} from "../config/store.mjs";
import { renderWorkflowTemplate } from "./render.mjs";
import { createInstallReport, readInstallMetadata } from "./state.mjs";

const ignoredSkillPathPatterns = [
  /(^|\/)\.env$/u,
  /(^|\/)\.skill-lock\.json$/u,
  /(^|\/)\.venv(\/|$)/u,
  /(^|\/)__pycache__(\/|$)/u,
  /(^|\/)node_modules(\/|$)/u,
  /(^|\/)tmp(\/|$)/u,
  /(^|\/)build(\/|$)/u,
  /^dev-browser\/profiles(\/|$)/u,
  /^dev-browser\/tmp(\/|$)/u
];

function normalizeRelativePath(path) {
  return path.replaceAll("\\", "/");
}

function validateManagedFilePath(candidate) {
  if (typeof candidate !== "string") {
    throw new Error(`Invalid managed file path: ${String(candidate)}`);
  }
  const normalized = normalizeRelativePath(candidate);
  const segments = normalized.split("/");
  if (!normalized
    || candidate !== normalized
    || normalized.startsWith("/")
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.includes("\0")
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid managed file path: ${candidate}`);
  }
  return normalized;
}

async function resolveManagedFilePath(paths, candidate) {
  const normalized = validateManagedFilePath(candidate);
  const rootPath = resolve(paths.agentsDir);
  const targetPath = resolve(rootPath, normalized);
  if (normalizeRelativePath(relative(rootPath, targetPath)) !== normalized) {
    throw new Error(`Invalid managed file path: ${candidate}`);
  }
  let ancestorPath = rootPath;
  for (const segment of normalized.split("/").slice(0, -1)) {
    ancestorPath = join(ancestorPath, segment);
    try {
      if ((await fs.lstat(ancestorPath)).isSymbolicLink()) {
        throw new Error(`Invalid managed file path: ${candidate}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return targetPath;
}

function mapGitignoreTemplate(relativePath) {
  return relativePath.replace(/(^|\/)gitignore\.template$/u, "$1.gitignore");
}

function hashBytes(content) {
  return createHash("sha256").update(content).digest("hex");
}

function shouldCopySkillPath(skillsRoot, sourcePath) {
  const relativePath = normalizeRelativePath(relative(skillsRoot, sourcePath));
  if (!relativePath) return true;
  if (/(^|\/)dist(\/|$)/u.test(relativePath) && !/^dev-browser\/dist(\/|$)/u.test(relativePath)) return false;
  return !ignoredSkillPathPatterns.some((pattern) => pattern.test(relativePath));
}

async function collectFiles(root, outputPrefix, { filter, mapTargetPath, render } = {}) {
  const assets = new Map();
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = join(directory, entry.name);
      if (filter && !filter(root, sourcePath)) continue;
      if (entry.isDirectory()) {
        const nested = await visit(sourcePath);
        for (const [key, value] of nested) assets.set(key, value);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const sourceRelativePath = normalizeRelativePath(relative(root, sourcePath));
      if (sourceRelativePath.endsWith(".skill-lock.json")) continue;
      const sourceContent = await fs.readFile(sourcePath);
      const renderedContent = render
        ? Buffer.from(render(sourceContent.toString("utf8"), sourceRelativePath))
        : sourceContent;
      const sourceStat = await fs.stat(sourcePath);
      const targetRelativePath = normalizeRelativePath(join(
        outputPrefix,
        mapTargetPath ? mapTargetPath(sourceRelativePath) : sourceRelativePath
      ));
      assets.set(targetRelativePath, {
        content: renderedContent,
        hash: hashBytes(renderedContent),
        sourceHash: hashBytes(sourceContent),
        mode: sourceStat.mode & 0o777,
        sourcePath
      });
    }
    return assets;
  }
  return visit(root);
}

async function addAssetTree(manifest, root, outputPrefix, options = {}) {
  if (!(await pathTargetExists(root))) {
    if (options.required) throw new Error(`Missing managed asset root: ${root}`);
    return;
  }
  for (const [key, value] of await collectFiles(root, outputPrefix, options)) manifest.set(key, value);
}

async function collectManagedAssets(paths, featureState) {
  const manifest = new Map();
  await addAssetTree(manifest, paths.workflowTemplateRoot, "", {
    required: true,
    mapTargetPath: mapGitignoreTemplate,
    render: (content) => renderWorkflowTemplate(content, featureState)
  });

  const readmePath = join(paths.packageRoot, "README.md");
  if (!(await pathTargetExists(readmePath))) throw new Error(`Missing managed asset: ${readmePath}`);
  const readmeContent = await fs.readFile(readmePath);
  manifest.set("README.md", {
    content: readmeContent,
    hash: hashBytes(readmeContent),
    sourceHash: hashBytes(readmeContent),
    mode: (await fs.stat(readmePath)).mode & 0o777,
    sourcePath: readmePath
  });

  const skillsRoot = join(paths.packageRoot, "skills");
  await addAssetTree(manifest, skillsRoot, "skills", {
    filter: shouldCopySkillPath,
    mapTargetPath: mapGitignoreTemplate
  });
  await addAssetTree(manifest, join(paths.packageRoot, "extensions"), "extensions");
  return manifest;
}

async function readManagedFiles(paths, metadata) {
  if (metadata.schemaVersion !== 2) return {};
  const managedFiles = { ...(metadata.managedFiles ?? {}) };
  for (const relativePath of Object.keys(managedFiles)) {
    await resolveManagedFilePath(paths, relativePath);
  }
  return managedFiles;
}

function recordConflict(report, relativePath) {
  report.conflicts.push(relativePath);
  report.preserved.push(relativePath);
}

async function readRegularTarget(targetPath) {
  try {
    const targetStat = await fs.lstat(targetPath);
    if (targetStat.isSymbolicLink()) {
      return {
        exists: true,
        regular: false,
        symbolicLink: true
      };
    }
    if (!targetStat.isFile()) return { exists: true, regular: false };
    const content = await fs.readFile(targetPath);
    return { exists: true, regular: true, hash: hashBytes(content) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, regular: false };
    throw error;
  }
}

async function applyManifestEntry(paths, relativePath, asset, previousHash, force, report) {
  const targetPath = await resolveManagedFilePath(paths, relativePath);
  const current = await readRegularTarget(targetPath);
  if (!current.exists) {
    await writeText(targetPath, asset.content, { backupLimit: 3, mode: asset.mode });
    report.created.push(relativePath);
    return asset.hash;
  }
  if (!current.regular) {
    if (force && current.symbolicLink) {
      await backupIfNeeded(targetPath);
      await writeText(targetPath, asset.content, { backupLimit: 3, mode: asset.mode });
      report.updated.push(relativePath);
      return asset.hash;
    }
    recordConflict(report, relativePath);
    return previousHash;
  }
  if (current.hash === asset.hash) {
    const result = await writeText(targetPath, asset.content, { backupLimit: 3, mode: asset.mode });
    report[result.status === "permission-repaired" ? "updated" : "unchanged"].push(relativePath);
    return asset.hash;
  }
  if (!previousHash && current.hash === asset.sourceHash) {
    await writeText(targetPath, asset.content, { backupLimit: 3, mode: asset.mode });
    report.updated.push(relativePath);
    return asset.hash;
  }
  if (previousHash && current.hash === previousHash || force) {
    await writeText(targetPath, asset.content, { backupLimit: 3, mode: asset.mode });
    report.updated.push(relativePath);
    return asset.hash;
  }
  recordConflict(report, relativePath);
  return previousHash;
}

async function removeStaleManagedFile(paths, relativePath, previousHash, force, report) {
  if (relativePath.endsWith(".skill-lock.json")) return;
  const targetPath = await resolveManagedFilePath(paths, relativePath);
  const current = await readRegularTarget(targetPath);
  if (!current.exists) return undefined;
  if (!current.regular) {
    recordConflict(report, relativePath);
    return undefined;
  }
  if (current.regular && current.hash === previousHash) {
    await fs.rm(targetPath, { force: true });
    report.removed.push(relativePath);
    return undefined;
  }
  if (force) {
    await backupIfNeeded(targetPath);
    report.removed.push(relativePath);
    return undefined;
  }
  recordConflict(report, relativePath);
  return previousHash;
}

async function readPackageVersion(paths) {
  const packagePath = join(paths.packageRoot, "package.json");
  const packageData = await readJsonFileSafe(packagePath);
  if (typeof packageData.version !== "string" || !packageData.version) {
    throw new Error(`Missing package version in ${packagePath}`);
  }
  return packageData.version;
}

async function syncManagedFiles({
  paths,
  featureState = {},
  force = false
}) {
  const previousMetadata = await readInstallMetadata(paths);
  const previousManagedFiles = await readManagedFiles(paths, previousMetadata);
  const manifest = await collectManagedAssets(paths, featureState);
  const report = createInstallReport();
  const managedFiles = {};

  for (const [relativePath, asset] of manifest) {
    const managedHash = await applyManifestEntry(
      paths,
      relativePath,
      asset,
      previousManagedFiles[relativePath],
      force,
      report
    );
    if (managedHash) managedFiles[relativePath] = managedHash;
  }
  for (const [relativePath, previousHash] of Object.entries(previousManagedFiles)) {
    if (!manifest.has(relativePath)) {
      const managedHash = await removeStaleManagedFile(paths, relativePath, previousHash, force, report);
      if (managedHash) managedFiles[relativePath] = managedHash;
    }
  }

  return {
    previousMetadata,
    packageVersion: await readPackageVersion(paths),
    features: featureState,
    managedFiles,
    report
  };
}

async function pathsReferToSameEntry(sourcePath, targetPath) {
  if (resolve(sourcePath) === resolve(targetPath)) return true;
  try {
    return await fs.realpath(sourcePath) === await fs.realpath(targetPath);
  } catch {
    return false;
  }
}

async function ensureManagedContainerDirectory(targetPath, sourcePath) {
  if (await pathExists(targetPath)) {
    const targetStat = await fs.lstat(targetPath);
    if (targetStat.isSymbolicLink() && await pathsReferToSameEntry(targetPath, sourcePath)) {
      await fs.unlink(targetPath);
    } else if (!targetStat.isDirectory()) {
      throw new Error(`Managed container conflict at ${targetPath}`);
    }
  }
  await fs.mkdir(targetPath, { recursive: true });
}

export {
  collectManagedAssets,
  ensureManagedContainerDirectory,
  hashBytes,
  pathsReferToSameEntry,
  readManagedFiles,
  shouldCopySkillPath,
  syncManagedFiles
};
