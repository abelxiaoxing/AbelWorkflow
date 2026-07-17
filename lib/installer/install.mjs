import { join } from "node:path";
import { pathExists, readJsonFileSafe } from "../config/store.mjs";
import { createPaths, defaultPaths } from "../paths.mjs";
import {
  ensureClaudeSettingsForFeature,
  getPreviousManagedClaudePermissions
} from "../providers/claude.mjs";
import { readManagedFiles, syncManagedFiles } from "./assets.mjs";
import { linkClaude, linkCodex, linkPi } from "./links.mjs";
import { resolveAugmentContextEngineFeature } from "./render.mjs";
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

function resolveFeatureState(options, previousMetadata) {
  const overrides = {
    ...(options.featureOverrides ?? {})
  };
  return {
    ...(previousMetadata.features && typeof previousMetadata.features === "object"
      ? previousMetadata.features
      : {}),
    augmentContextEngine: resolveAugmentContextEngineFeature(overrides, previousMetadata)
  };
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
  const featureState = resolveFeatureState(options, previousMetadata);
  let assetResult;

  if (options.relinkOnly) {
    if (!(await pathExists(paths.agentsDir))) {
      throw new Error(`${paths.agentsDir} does not exist; remove --link-only or install first`);
    }
    assetResult = {
      previousMetadata,
      packageVersion: await packageVersionFor(paths, previousMetadata),
      features: featureState,
      managedFiles: await readManagedFiles(paths, previousMetadata),
      report: createInstallReport()
    };
  } else {
    assetResult = await syncManagedFiles({
      paths,
      featureState,
      force: options.force ?? false
    });
  }

  const previousLinkedTargets = previousMetadata.linkedTargets ?? {};
  const linkOptions = { force: options.force ?? false };
  const claudeResults = await linkClaude(paths, previousLinkedTargets, linkOptions);
  const codexResults = await linkCodex(paths, previousLinkedTargets, linkOptions);
  const piResults = await linkPi(paths, previousLinkedTargets, linkOptions);
  const linkResults = [...claudeResults, ...codexResults, ...piResults];
  const ensureClaudeSettings = options.ensureClaudeSettings ?? ensureClaudeSettingsForFeature;
  const managedClaudePermissions = await ensureClaudeSettings(paths, featureState.augmentContextEngine, previousMetadata);
  const linkedTargets = mergeLinkedTargets(previousLinkedTargets, linkResults);

  const metadata = buildInstallMetadata({
    previousMetadata,
    packageVersion: assetResult.packageVersion,
    features: featureState,
    managedFiles: assetResult.managedFiles,
    managedClaudePermissions,
    linkedTargets
  });
  await writeInstallMetadata(paths, metadata);
  return mergeInstallReports(assetResult.report, reportFromLinkResults(linkResults));
}

async function installManagedWorkflow(options = {}) {
  return installWorkflow({ ...options, paths: resolveInstallPaths(options) });
}

async function ensureWorkflowPresent(inputPaths) {
  const paths = validatedPaths(inputPaths);
  return installWorkflow({ paths, force: false, relinkOnly: false });
}

async function ensurePiResourcesLinked(inputPaths) {
  const paths = validatedPaths(inputPaths);
  const previousMetadata = await readInstallMetadata(paths);
  const featureState = resolveFeatureState({}, previousMetadata);
  const assetResult = await syncManagedFiles({ paths, featureState, force: false });
  const previousLinkedTargets = previousMetadata.linkedTargets ?? {};
  const piResults = await linkPi(paths, previousLinkedTargets, { force: false });
  const metadata = buildInstallMetadata({
    previousMetadata,
    packageVersion: assetResult.packageVersion,
    features: featureState,
    managedFiles: assetResult.managedFiles,
    managedClaudePermissions: getPreviousManagedClaudePermissions(previousMetadata),
    linkedTargets: mergeLinkedTargets(previousLinkedTargets, piResults)
  });
  await writeInstallMetadata(paths, metadata);
  return piResults;
}

export {
  ensurePiResourcesLinked,
  ensureWorkflowPresent,
  installManagedWorkflow,
  installWorkflow,
  packageVersionFor
};
