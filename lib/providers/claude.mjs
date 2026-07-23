import * as p from "@clack/prompts";
import { readJsonFileSafe, writeJson } from "../config/store.mjs";
import { defaultPaths, maskSecret, pathToLabel } from "../paths.mjs";

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
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  },
  includeCoAuthoredBy: false,
  permissions: {
    allow: [],
    deny: [],
    defaultMode: "bypassPermissions"
  },
  hooks: {},
  alwaysThinkingEnabled: true,
  language: "Chinese"
};
function buildDefaultClaudeSettings() {
  return {
    ...defaultClaudeSettings,
    env: { ...defaultClaudeSettings.env },
    permissions: {
      ...defaultClaudeSettings.permissions,
      allow: [...defaultClaudeSettings.permissions.allow],
      deny: [...defaultClaudeSettings.permissions.deny]
    },
    hooks: { ...defaultClaudeSettings.hooks }
  };
}
function mergeClaudeSettingsWithDefaults(settings) {
  const defaults = buildDefaultClaudeSettings();
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

function getExistingClaudeApiConfig(settings) {
  const env = mergeClaudeSettingsWithDefaults(settings).env;
  return {
    baseUrl: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    key: env.ANTHROPIC_API_KEY || "",
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

function buildClaudeApiSettings(settings, {
  baseUrl,
  key,
  model
}) {
  const nextSettings = mergeClaudeSettingsWithDefaults(settings);
  nextSettings.env.ANTHROPIC_BASE_URL = baseUrl;
  nextSettings.env.ANTHROPIC_API_KEY = key;
  delete nextSettings.env.ANTHROPIC_AUTH_TOKEN;
  for (const field of claudeModelEnvKeys) {
    nextSettings.env[field] = model;
  }
  return nextSettings;
}

async function persistClaudeConfiguration(paths, { settings, metaConfig }) {
  await writeJson(paths.claudeSettingsPath, settings, { sensitive: true });
  await writeJson(paths.claudeMetaConfigPath, metaConfig, { sensitive: true });
}

async function configureClaudeApi(paths = defaultPaths, promptApi) {
  const { assertNotCancelled, passwordOrExisting, required } = promptApi;
  const settings = await readJsonFileSafe(paths.claudeSettingsPath, {}, { sensitive: true });
  const existing = getExistingClaudeApiConfig(settings);

  const baseUrl = await p.text({
    message: "Claude Code Base URL",
    initialValue: existing.baseUrl,
    validate: required()
  });
  assertNotCancelled(baseUrl);

  const finalKey = await passwordOrExisting({
    message: "Claude Code API Key",
    existingValue: existing.key
  });

  const model = await p.text({
    message: "Claude Code 模型",
    initialValue: existing.model || undefined,
    validate: required()
  });
  assertNotCancelled(model);

  const apiSettings = buildClaudeApiSettings(settings, {
    baseUrl,
    key: finalKey,
    model
  });
  const metaConfig = await readJsonFileSafe(paths.claudeMetaConfigPath, {}, { sensitive: true });
  metaConfig.hasCompletedOnboarding = true;
  ensureApprovedClaudeApiKey(metaConfig, finalKey);
  await persistClaudeConfiguration(paths, {
    settings: apiSettings,
    metaConfig
  });

  p.log.step(`已更新 ${pathToLabel(paths.claudeSettingsPath, paths.homeDir)} (${baseUrl}, ${maskSecret(finalKey)})`);
}

export {
  buildClaudeApiSettings,
  buildDefaultClaudeSettings,
  configureClaudeApi,
  mergeClaudeSettingsWithDefaults,
  persistClaudeConfiguration
};
