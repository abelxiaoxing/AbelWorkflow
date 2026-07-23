import { pathExists } from "../config/store.mjs";
import { createPaths } from "../paths.mjs";
import { readManagedFiles, readPackageVersion, syncManagedFiles } from "./assets.mjs";
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
  return readPackageVersion(paths);
}

async function writeInstallState(paths, assetResult, linkedTargets) {
  const metadata = buildInstallMetadata({
    previousMetadata: assetResult.previousMetadata,
    packageVersion: assetResult.packageVersion,
    managedFiles: assetResult.managedFiles,
    linkedTargets
  });
  await writeInstallMetadata(paths, metadata);
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
  await writeInstallState(paths, assetResult, mergeLinkedTargets(previousLinkedTargets, linkResults));
  return mergeInstallReports(assetResult.report, reportFromLinkResults(linkResults));
}

async function installManagedWorkflow(options = {}) {
  return installWorkflow({ ...options, paths: validatedPaths(options.paths) });
}

async function ensureSkillPresent(inputPaths, skillName) {
  const paths = validatedPaths(inputPaths);
  const previousMetadata = await readInstallMetadata(paths);
  const assetResult = await syncManagedFiles({
    paths,
    force: false,
    pathPrefix: `skills/${skillName}/`
  });
  await writeInstallState(paths, assetResult, previousMetadata.linkedTargets ?? {});
  return assetResult.report;
}

async function ensurePiResourcesLinked(inputPaths) {
  const paths = validatedPaths(inputPaths);
  const previousMetadata = await readInstallMetadata(paths);
  const assetResult = await syncManagedFiles({ paths, force: false });
  const previousLinkedTargets = previousMetadata.linkedTargets ?? {};
  const piResults = await linkPi(paths, previousLinkedTargets, { force: false });
  await writeInstallState(paths, assetResult, mergeLinkedTargets(previousLinkedTargets, piResults));
  return mergeInstallReports(assetResult.report, reportFromLinkResults(piResults));
}

export {
  ensurePiResourcesLinked,
  ensureSkillPresent,
  installManagedWorkflow,
  installWorkflow,
  packageVersionFor
};
