import { lstat, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as p from "@clack/prompts";
import {
  pathExists,
  readJsonFileSafe,
  writeJson,
  writeText
} from "../config/store.mjs";
import {
  buildTomlSection,
  detectLineEnding,
  extractTopLevelTomlEntries,
  getTomlSectionFieldNames,
  formatTomlKeySegment,
  mergeMissingTopLevelTomlEntries,
  parseTomlSection,
  readTopLevelTomlString,
  removeTomlSection,
  removeTomlSectionField,
  removeTopLevelTomlField,
  updateTomlSectionFields,
  updateTopLevelTomlField
} from "../config/toml.mjs";
import { defaultPaths, maskSecret, pathToLabel } from "../paths.mjs";
import { hashBytes, isManagedCodexAgentFileEntry } from "../utils.mjs";
import { normalizeOpenAiBaseUrl } from "./pi.mjs";

const CODEX_ENV_KEY = "OPENAI_API_KEY";

const publishedCodexDeveloperInstructionHashes = new Set([
  "957adb227dd3fc298985acca38db4c22b8e018d387dab91f1ea8287db35385db"
]);

const publishedCodexAgentHashes = {
  "default.toml": new Set([
    "7add720eb7ed030871088fe9f994a7e34a2b3cae1f898fe7f97c4e302f4a1844",
    "72d3da0275f4add64ff05da94f391443e8e4b5c43b646e0f89f2d17fa4345cb4",
    "7dc002559f5d78534e70c7c4683d51a48ffe94725c199855a35f61124aead876"
  ]),
  "explorer.toml": new Set([
    "e4e9c4eed4c028dded095b4cf36cb0ac408abcd86b9ab7c139440e1c58355644",
    "a236d7b586c4e312a62bb8b36115fe9780e28502c0af160ce5cd45b67c5b8479",
    "4740f13e9a478528dcb097188997445efa7607b1b07ae64774b1dd26fcd6f853"
  ]),
  "planner.toml": new Set([
    "2b16f821b14224cdfc9dab1fe14c41b9ff2b63642b0d9b340ef84b67a753a3b7",
    "741c9dfce5085d6bdc49f6e5004475974d54c2bde95c0b589eda86a63e96e58f",
    "7fde442a5ba5e996936b4ec853b036ebbb9f06ee9baef6540124d081c7107196"
  ]),
  "reviewer.toml": new Set([
    "08dcf8f5fee281f3b6120b63559086b7c675a619be72f761de4add711543b353",
    "9455d0189f324f7c606f7ae94ca338e9bd5c468f072188ac1f18e3749c918cd1",
    "a7292a533c9146bf5a2eb292cbfe889ca47bf4808324cddc1732c3c1721d437c"
  ]),
  "worker.toml": new Set([
    "13533715464b1f58a9c311e16dc3a29e92ecb95793fd8aff69a5ca731ae46ac8",
    "ea12b5b6173eb8fcaa57a8b447b1f81b35a6ac59e75025b88198c3f85175922c",
    "bfbc214e7b582774de759b118544c3f1fb61e1284d6ffd6a61ab772d28b6eaa0"
  ])
};

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
  const currentDeveloperInstructions = readTopLevelTomlString(nextContent, "developer_instructions");
  const templateDeveloperInstructions = readTopLevelTomlString(templateContent, "developer_instructions");
  if (templateDeveloperInstructions && publishedCodexDeveloperInstructionHashes.has(
    hashBytes(currentDeveloperInstructions)
  )) {
    nextContent = updateTopLevelTomlField(
      nextContent,
      "developer_instructions",
      templateDeveloperInstructions
    );
  }

  for (const sectionName of ["agents", "features"]) {
    const templateValues = parseTomlSection(templateContent, sectionName);
    const currentFields = new Set(getTomlSectionFieldNames(nextContent, sectionName));
    const missingValues = Object.fromEntries(
      Object.entries(templateValues).filter(([field]) => !currentFields.has(field))
    );
    if (Object.keys(missingValues).length) {
      nextContent = updateTomlSectionFields(nextContent, sectionName, missingValues);
    }
  }

  return nextContent;
}

async function loadBundledCodexConfigTemplate(paths = defaultPaths) {
  return readFile(paths.codexTemplateConfigPath, "utf8");
}

async function readCodexAgentTarget(path) {
  try {
    const targetStat = await lstat(path);
    return targetStat.isFile()
      ? { exists: true, content: await readFile(path) }
      : { exists: true, content: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: null };
    throw error;
  }
}

function assertCodexAgentDirectory(targetDir, targetStat, kind) {
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`Codex agent ${kind} conflict at ${targetDir}`);
  }
}

async function ensureCodexAgentDirectory(targetDir, kind) {
  try {
    assertCodexAgentDirectory(targetDir, await lstat(targetDir), kind);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  try {
    await mkdir(targetDir);
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOTDIR") {
      throw new Error(`Codex agent ${kind} conflict at ${targetDir}`, { cause: error });
    }
    throw error;
  }
  assertCodexAgentDirectory(targetDir, await lstat(targetDir), kind);
}

async function ensureCodexAgentContainer(homeDir) {
  await mkdir(homeDir, { recursive: true });
  const codexDir = join(homeDir, ".codex");
  await ensureCodexAgentDirectory(codexDir, "ancestor");
  const targetDir = join(codexDir, "agents");
  await ensureCodexAgentDirectory(targetDir, "container");
  return targetDir;
}

function isPublishedCodexAgent(name, hash) {
  return publishedCodexAgentHashes[name]?.has(hash) ?? false;
}

async function deployBundledCodexAgents(paths = defaultPaths, previousManagedFiles = {}) {
  const targetDir = await ensureCodexAgentContainer(paths.homeDir);
  const entries = (await readdir(paths.codexTemplateAgentsPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const result = {
    managedFiles: {},
    created: [],
    updated: [],
    unchanged: [],
    conflicts: []
  };
  for (const name of entries) {
    const source = join(paths.codexTemplateAgentsPath, name);
    const target = join(targetDir, name);
    const sourceContent = await readFile(source);
    const sourceHash = hashBytes(sourceContent);
    const current = await readCodexAgentTarget(target);
    const currentHash = current.content ? hashBytes(current.content) : "";

    if (!current.exists) {
      await writeText(target, sourceContent, { backupLimit: 0 });
      result.created.push(target);
    } else if (currentHash === sourceHash) {
      result.unchanged.push(target);
    } else if (current.content && (
      previousManagedFiles?.[name] === currentHash
      || isPublishedCodexAgent(name, currentHash)
    )) {
      await writeText(target, sourceContent, { backupLimit: 0 });
      result.updated.push(target);
    } else {
      result.conflicts.push(target);
      if (isManagedCodexAgentFileEntry(name, previousManagedFiles?.[name])) {
        result.managedFiles[name] = previousManagedFiles[name];
      }
      continue;
    }
    result.managedFiles[name] = sourceHash;
  }

  const bundledNames = new Set(entries);
  const previousEntries = previousManagedFiles
    && typeof previousManagedFiles === "object"
    && !Array.isArray(previousManagedFiles)
    ? Object.entries(previousManagedFiles).sort(([left], [right]) => left.localeCompare(right))
    : [];
  for (const [name, previousHash] of previousEntries) {
    if (bundledNames.has(name) || !isManagedCodexAgentFileEntry(name, previousHash)) continue;
    const target = join(targetDir, name);
    const current = await readCodexAgentTarget(target);
    if (!current.exists) continue;
    if (current.content && hashBytes(current.content) === previousHash) {
      await unlink(target);
      continue;
    }
    result.managedFiles[name] = previousHash;
    result.conflicts.push(target);
  }
  return result;
}

function getCodexProviderSectionName(providerId) {
  return `model_providers.${formatTomlKeySegment(providerId)}`;
}

function assertCodexAuthKeyAvailable(auth, envKey) {
  if (
    auth
    && typeof auth === "object"
    && !Array.isArray(auth)
    && Object.hasOwn(auth, envKey)
    && typeof auth[envKey] !== "string"
  ) {
    throw new Error(`Environment key ${envKey} conflicts with structured Codex auth state`);
  }
}

function resolveExistingCodexApiConfig(content, auth = {}) {
  const providerId = readTopLevelTomlString(content, "model_provider") || "abelworkflow";
  const provider = parseTomlSection(content, getCodexProviderSectionName(providerId));
  const envKey = CODEX_ENV_KEY;
  assertCodexAuthKeyAvailable(auth, envKey);
  const apiKey = typeof auth[envKey] === "string" ? auth[envKey] : "";

  return {
    providerId,
    providerName: provider.name || providerId,
    baseUrl: provider.base_url || "https://api.openai.com/v1",
    envKey,
    apiKey
  };
}

async function getExistingCodexApiConfig(paths = defaultPaths) {
  const content = await pathExists(paths.codexConfigPath) ? await readFile(paths.codexConfigPath, "utf8") : "";
  const auth = await readJsonFileSafe(paths.codexAuthPath, {}, { sensitive: true });
  return resolveExistingCodexApiConfig(content, auth);
}

async function persistCodexConfiguration(paths, { content, auth }) {
  await writeText(paths.codexConfigPath, content);
  await writeJson(paths.codexAuthPath, auth, { sensitive: true });
}

async function configureCodexApi(paths = defaultPaths, promptApi, ownership = {}) {
  const {
    assertNotCancelled,
    confirmOrCancel,
    passwordOrExisting,
    required
  } = promptApi;
  const existing = await getExistingCodexApiConfig(paths);
  const providerId = existing.providerId || "abelworkflow";
  const providerName = existing.providerName || providerId;
  const baseUrlInput = await p.text({
    message: "Codex Base URL",
    initialValue: existing.baseUrl,
    validate: required()
  });
  assertNotCancelled(baseUrlInput);
  const baseUrl = normalizeOpenAiBaseUrl(baseUrlInput);

  const finalApiKey = await passwordOrExisting({
    message: "Codex 第三方 API Key",
    existingValue: existing.apiKey
  });

  const shouldDeploySubagents = await confirmOrCancel({ message: "是否部署 Codex subagents 配置？", initialValue: true });
  let managedCodexAgentFiles = { ...(ownership.managedCodexAgentFiles ?? {}) };

  const envKey = CODEX_ENV_KEY;
  const currentContent = await pathExists(paths.codexConfigPath) ? await readFile(paths.codexConfigPath, "utf8") : "";
  const templateContent = await loadBundledCodexConfigTemplate(paths);
  const content = buildCodexConfigContent(currentContent, {
    templateContent,
    mergeMissingTemplateDefaults: true,
    includeSubagentDefaults: shouldDeploySubagents,
    providerId,
    providerName,
    baseUrl
  });

  const auth = mergeCodexAuthData(
    await readJsonFileSafe(paths.codexAuthPath, {}, { sensitive: true }),
    envKey,
    finalApiKey,
    ownership.managedAuthKeys ?? []
  );
  await persistCodexConfiguration(paths, { content, auth });

  p.log.step(`已更新 ${pathToLabel(paths.codexConfigPath, paths.homeDir)} (${providerId}, ${baseUrl})`);
  p.log.step(`已更新 ${pathToLabel(paths.codexAuthPath, paths.homeDir)} (${maskSecret(finalApiKey)})`);
  if (String(baseUrl).startsWith("https://") && !process.env.CODEX_CA_CERTIFICATE && !process.env.SSL_CERT_FILE) {
    p.log.message("自签名证书需在启动 Codex 前设置 CODEX_CA_CERTIFICATE=/absolute/path/relay-ca.pem。");
  }
  if (shouldDeploySubagents) {
    const deployment = await deployBundledCodexAgents(paths, managedCodexAgentFiles);
    managedCodexAgentFiles = deployment.managedFiles;
    p.log.step(`Codex subagents 同步完成：新增 ${deployment.created.length}，更新 ${deployment.updated.length}，未变 ${deployment.unchanged.length}`);
    if (deployment.conflicts.length) {
      p.log.warn([
        `检测到 ${deployment.conflicts.length} 个 Codex subagent 冲突，已保留原文件：`,
        ...deployment.conflicts.map((path) => `- ${pathToLabel(path, paths.homeDir)}`)
      ].join("\n"));
    }
  } else {
    p.log.message("已跳过 Codex subagents 部署。");
  }
  return {
    managedAuthKeys: finalApiKey ? [envKey] : [],
    managedCodexAgentFiles
  };
}

function buildCodexConfigContent(currentContent, {
  templateContent = "",
  mergeMissingTemplateDefaults = false,
  includeSubagentDefaults = true,
  providerId,
  providerName,
  baseUrl
}) {
  const effectiveTemplateContent = includeSubagentDefaults
    ? templateContent
    : stripCodexSubagentDefaults(templateContent);
  const hasCurrentContent = Boolean(currentContent.trim());
  let content = hasCurrentContent ? currentContent : effectiveTemplateContent;
  if (hasCurrentContent && mergeMissingTemplateDefaults && effectiveTemplateContent.trim()) {
    content = mergeCodexTemplateDefaults(content, effectiveTemplateContent);
  }
  const lineEnding = detectLineEnding(content);
  if (includeSubagentDefaults && readTopLevelTomlString(content, "approvals_reviewer") === "reviewer") {
    content = updateTopLevelTomlField(content, "approvals_reviewer", "guardian_subagent");
  }
  const providerSectionName = getCodexProviderSectionName(providerId);
  content = updateTopLevelTomlField(content, "model_provider", providerId);
  content = removeTopLevelTomlField(content, "preferred_auth_method");
  content = removeTopLevelTomlField(content, "temp_env_key");
  content = removeTomlSectionField(content, providerSectionName, "temp_env_key");
  content = removeTomlSectionField(content, providerSectionName, "env_key");
  content = updateTomlSectionFields(content, providerSectionName, {
    name: providerName,
    base_url: baseUrl,
    wire_api: "responses",
    requires_openai_auth: true,
    supports_websockets: true
  });
  return `${content.trim()}${lineEnding}`;
}

function mergeCodexAuthData(auth, envKey, apiKey, managedAuthKeys = []) {
  const nextAuth = auth && typeof auth === "object" && !Array.isArray(auth) ? { ...auth } : {};
  assertCodexAuthKeyAvailable(nextAuth, envKey);
  for (const managedAuthKey of managedAuthKeys) {
    delete nextAuth[managedAuthKey];
  }
  if (apiKey) {
    nextAuth.auth_mode = "apikey";
    nextAuth[envKey] = apiKey;
  } else {
    delete nextAuth[envKey];
    if (nextAuth.auth_mode === "apikey") delete nextAuth.auth_mode;
  }
  return nextAuth;
}

export {
  buildCodexConfigContent,
  configureCodexApi,
  deployBundledCodexAgents,
  mergeCodexAuthData,
  mergeCodexTemplateDefaults,
  persistCodexConfiguration,
  resolveExistingCodexApiConfig,
  stripCodexSubagentDefaults
};
