import { join } from "node:path";
import { readJsonFileSafe, writeJson } from "../config/store.mjs";

function metadataPathFor(paths) {
  return join(paths.agentsDir, paths.installMetadataName);
}

function sortObject(value = {}) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function isMetadataV2(previousMetadata) {
  return previousMetadata?.schemaVersion === 2;
}

function objectField(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function getPreviousManagedCodexAuthKeys(previousMetadata = {}) {
  return isMetadataV2(previousMetadata)
    ? stringArray(previousMetadata.managedCodexAuthKeys)
    : [];
}

function normalizeManagedCodexAgentFiles(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return sortObject(Object.fromEntries(Object.entries(value).filter(([name, hash]) => (
    name.endsWith(".toml")
    && !name.includes("/")
    && !name.includes("\\")
    && typeof hash === "string"
    && /^[a-f0-9]{64}$/u.test(hash)
  ))));
}

function getPreviousManagedCodexAgentFiles(previousMetadata = {}) {
  if (!isMetadataV2(previousMetadata)) return {};
  return normalizeManagedCodexAgentFiles(previousMetadata.managedCodexAgentFiles);
}

async function readInstallMetadata(paths) {
  const metadata = await readJsonFileSafe(metadataPathFor(paths), {});
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError(`Install metadata in ${metadataPathFor(paths)} must contain a JSON object`);
  }
  return metadata;
}

async function writeInstallMetadata(paths, metadata) {
  return writeJson(metadataPathFor(paths), metadata, { backupLimit: 0 });
}

function buildInstallMetadata({
  previousMetadata = {},
  packageVersion,
  managedFiles = {},
  managedCodexAuthKeys = getPreviousManagedCodexAuthKeys(previousMetadata),
  managedCodexAgentFiles = getPreviousManagedCodexAgentFiles(previousMetadata),
  linkedTargets = {}
}) {
  const metadata = {
    schemaVersion: 2,
    packageVersion,
    managedFiles: sortObject(managedFiles),
    managedCodexAuthKeys: [...new Set(managedCodexAuthKeys)].sort(),
    managedCodexAgentFiles: normalizeManagedCodexAgentFiles(managedCodexAgentFiles),
    linkedTargets: sortObject(linkedTargets)
  };
  if (typeof previousMetadata.installedAt === "string") {
    metadata.installedAt = previousMetadata.installedAt;
  }
  return metadata;
}

function finalizeProviderInstallMetadata({
  previousMetadata = {},
  packageVersion,
  overrides = {}
}) {
  const isV2 = isMetadataV2(previousMetadata);
  return buildInstallMetadata({
    previousMetadata: isV2 ? previousMetadata : {},
    packageVersion: isV2
      && typeof previousMetadata.packageVersion === "string"
      && previousMetadata.packageVersion
      ? previousMetadata.packageVersion
      : packageVersion,
    managedFiles: isV2 ? objectField(previousMetadata.managedFiles) : {},
    managedCodexAuthKeys: stringArray(
      overrides.managedCodexAuthKeys ?? getPreviousManagedCodexAuthKeys(previousMetadata)
    ),
    managedCodexAgentFiles: overrides.managedCodexAgentFiles
      ?? getPreviousManagedCodexAgentFiles(previousMetadata),
    linkedTargets: objectField(previousMetadata.linkedTargets)
  });
}

function linkedTargetsFromResults(results) {
  return Object.fromEntries(results
    .filter((result) => result.sourcePath)
    .map((result) => [result.targetPath, {
      sourcePath: result.sourcePath,
      kind: result.kind,
      mode: result.mode,
      ...(result.targetHash ? { targetHash: result.targetHash } : {})
    }]));
}

function mergeLinkedTargets(previousLinkedTargets = {}, results = []) {
  const nextLinkedTargets = { ...previousLinkedTargets };
  for (const result of results) {
    if (result.sourcePath) {
      nextLinkedTargets[result.targetPath] = {
        sourcePath: result.sourcePath,
        kind: result.kind,
        mode: result.mode,
        ...(result.targetHash ? { targetHash: result.targetHash } : {})
      };
    } else if (result.status === "removed") {
      delete nextLinkedTargets[result.targetPath];
    }
  }
  return sortObject(nextLinkedTargets);
}

function createInstallReport() {
  return {
    created: [],
    updated: [],
    unchanged: [],
    preserved: [],
    conflicts: [],
    removed: [],
    linked: []
  };
}

function mergeInstallReports(...reports) {
  const merged = createInstallReport();
  for (const report of reports) {
    for (const key of Object.keys(merged)) merged[key].push(...(report?.[key] ?? []));
  }
  return merged;
}

export {
  buildInstallMetadata,
  createInstallReport,
  finalizeProviderInstallMetadata,
  getPreviousManagedCodexAgentFiles,
  getPreviousManagedCodexAuthKeys,
  linkedTargetsFromResults,
  mergeInstallReports,
  mergeLinkedTargets,
  metadataPathFor,
  readInstallMetadata,
  writeInstallMetadata
};
