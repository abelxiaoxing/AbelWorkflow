import { join } from "node:path";
import { pathExists, readJsonFileSafe } from "../config/store.mjs";
import { createPaths, defaultPaths } from "../paths.mjs";
import { readManagedFiles, syncManagedFiles } from "./assets.mjs";
import { linkClaude, linkCodex, linkPi } from "./links.mjs";
import {
  buildInstallMetadata,
  createInstallReport,
  mergeInstallReports,
  mergeLinkedTargets,
  readInstallMetadata,
  writeInstallMetadata
} from "./state.mjs";

function validatedPaths(paths) {
  if (!paths || typeof paths !== "object" || [
    paths.homeDir,
    paths.packageRoot,
    paths.agentsDir
  ].some((path) => typeof path !== "string")) {
    throw new TypeError("Expected a canonical Paths object");
  }
  return createPaths({
    homeDir: paths.homeDir,
    packageRoot: paths.packageRoot,
    agentsDir: paths.agentsDir
  });
}

function resolveInstallPaths(options = {}) {
  if (options.paths) return validatedPaths(options.paths);
  return createPaths({
    homeDir: options.homeDir ?? defaultPaths.homeDir,
    packageRoot: options.packageRoot ?? defaultPaths.packageRoot,
    agentsDir: options.agentsDir ?? defaultPaths.agentsDir
  });
}

function reportFromLinkResults(results) {
  const report = createInstallReport();
  for (const result of results) {
    if (result.status === "linked" || result.status === "copied") report.linked.push(result.targetPath);
    else if (result.status === "unchanged") report.unchanged.push(result.targetPath);
    else if (result.status === "removed") report.removed.push(result.targetPath);
    else if (result.status === "conflict") {
      report.conflicts.push(result.targetPath);
      report.preserved.push(result.targetPath);
    } else if (result.status === "skipped") {
      report.preserved.push(result.targetPath);
    }
  }
  return report;
}

async function packageVersionFor(paths, previousMetadata) {
  if (previousMetadata.schemaVersion === 2
    && typeof previousMetadata.packageVersion === "string"
    && previousMetadata.packageVersion) {
    return previousMetadata.packageVersion;
  }
  const packagePath = join(paths.packageRoot, "package.json");
  const packageData = await readJsonFileSafe(packagePath);
  if (typeof packageData.version !== "string" || !packageData.version) {
    throw new Error(`Missing package version in ${packagePath}`);
  }
  return packageData.version;
}

async function installWorkflow(options) {
  const paths = validatedPaths(options.paths);
  const previousMetadata = await readInstallMetadata(paths);
  let assetResult;

  if (options.relinkOnly) {
    if (!(await pathExists(paths.agentsDir))) {
      throw new Error(`${paths.agentsDir} does not exist; remove --link-only or install first`);
    }
    assetResult = {
      previousMetadata,
      packageVersion: await packageVersionFor(paths, previousMetadata),
      managedFiles: await readManagedFiles(paths, previousMetadata),
      report: createInstallReport()
    };
  } else {
    assetResult = await syncManagedFiles({
      paths,
      force: options.force ?? false
    });
  }

  const previousLinkedTargets = previousMetadata.linkedTargets ?? {};
  const linkOptions = { force: options.force ?? false };
  const claudeResults = await linkClaude(paths, previousLinkedTargets, linkOptions);
  const codexResults = await linkCodex(paths, previousLinkedTargets, linkOptions);
  const piResults = await linkPi(paths, previousLinkedTargets, linkOptions);
  const linkResults = [...claudeResults, ...codexResults, ...piResults];
  const linkedTargets = mergeLinkedTargets(previousLinkedTargets, linkResults);

  const metadata = buildInstallMetadata({
    previousMetadata,
    packageVersion: assetResult.packageVersion,
    managedFiles: assetResult.managedFiles,
    linkedTargets
  });
  await writeInstallMetadata(paths, metadata);
  return mergeInstallReports(assetResult.report, reportFromLinkResults(linkResults));
}

async function installManagedWorkflow(options = {}) {
  return installWorkflow({ ...options, paths: resolveInstallPaths(options) });
}

async function ensureSkillPresent(inputPaths, skillName) {
  const paths = validatedPaths(inputPaths);
  const previousMetadata = await readInstallMetadata(paths);
  const assetResult = await syncManagedFiles({
    paths,
    force: false,
    pathPrefix: `skills/${skillName}/`
  });
  const metadata = buildInstallMetadata({
    previousMetadata,
    packageVersion: assetResult.packageVersion,
    managedFiles: assetResult.managedFiles,
    linkedTargets: previousMetadata.linkedTargets ?? {}
  });
  await writeInstallMetadata(paths, metadata);
  return assetResult.report;
}

async function ensurePiResourcesLinked(inputPaths) {
  const paths = validatedPaths(inputPaths);
  const previousMetadata = await readInstallMetadata(paths);
  const assetResult = await syncManagedFiles({ paths, force: false });
  const previousLinkedTargets = previousMetadata.linkedTargets ?? {};
  const piResults = await linkPi(paths, previousLinkedTargets, { force: false });
  const metadata = buildInstallMetadata({
    previousMetadata,
    packageVersion: assetResult.packageVersion,
    managedFiles: assetResult.managedFiles,
    linkedTargets: mergeLinkedTargets(previousLinkedTargets, piResults)
  });
  await writeInstallMetadata(paths, metadata);
  return mergeInstallReports(assetResult.report, reportFromLinkResults(piResults));
}

export {
  ensurePiResourcesLinked,
  ensureSkillPresent,
  installManagedWorkflow,
  installWorkflow,
  packageVersionFor
};
