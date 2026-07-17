import * as p from "@clack/prompts";
import {
  pathExists,
  readJsonFileSafe,
  writeJsonFileWithBackup
} from "../config/store.mjs";
import { defaultPaths, maskSecret, pathToLabel } from "../paths.mjs";

const augmentContextEnginePermission = "mcp__augment-context-engine";
const claudePermissionProfiles = ["standard", "trusted"];
const trustedClaudePermissions = [
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
  "NotebookEdit"
];
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
    CLAUDE_CODE_SUBAGENT_MODEL: ""
  },
  includeCoAuthoredBy: false,
  permissions: {
    allow: [],
    deny: []
  },
  hooks: {},
  alwaysThinkingEnabled: true,
  language: "Chinese"
};
function buildDefaultClaudeSettings({ augmentContextEngine = false, profile = "standard" } = {}) {
  if (!claudePermissionProfiles.includes(profile)) {
    throw new Error(`Unknown Claude permission profile: ${profile}`);
  }
  const settings = {
    ...defaultClaudeSettings,
    env: { ...defaultClaudeSettings.env },
    permissions: {
      ...defaultClaudeSettings.permissions,
      allow: profile === "trusted" ? [...trustedClaudePermissions] : [],
      deny: [...defaultClaudeSettings.permissions.deny]
    },
    hooks: { ...defaultClaudeSettings.hooks }
  };

  if (augmentContextEngine && !settings.permissions.allow.includes(augmentContextEnginePermission)) {
    settings.permissions.allow.push(augmentContextEnginePermission);
  }

  return settings;
}
function mergeClaudeSettingsWithDefaults(settings, { augmentContextEngine = false } = {}) {
  const defaults = buildDefaultClaudeSettings({ augmentContextEngine });
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

function applyClaudeInsecureTlsSetting(env = {}, enabled = false) {
  const nextEnv = { ...env };
  if (enabled) {
    nextEnv.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  } else if (nextEnv.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    delete nextEnv.NODE_TLS_REJECT_UNAUTHORIZED;
  }
  return nextEnv;
}

function getPreviousManagedClaudePermissions(previousMetadata = {}) {
  return Array.isArray(previousMetadata.managedClaudePermissions)
    ? previousMetadata.managedClaudePermissions.filter((value) => typeof value === "string")
    : [];
}

function applyClaudePermissionProfile(settings, {
  profile = "standard",
  previousManagedPermissions = []
} = {}) {
  if (!claudePermissionProfiles.includes(profile)) {
    throw new Error(`Unknown Claude permission profile: ${profile}`);
  }
  const hasSettings = settings && typeof settings === "object" && !Array.isArray(settings);
  const nextSettings = hasSettings
    ? {
        ...settings,
        permissions: settings.permissions && typeof settings.permissions === "object"
          ? { ...settings.permissions }
          : {}
      }
    : buildDefaultClaudeSettings();
  const allow = Array.isArray(nextSettings.permissions.allow)
    ? [...nextSettings.permissions.allow]
    : [];
  const previousManaged = new Set(previousManagedPermissions.filter((value) => typeof value === "string"));
  const retainedManaged = [];

  for (const permission of previousManaged) {
    if (permission === augmentContextEnginePermission) {
      if (allow.includes(permission)) retainedManaged.push(permission);
      continue;
    }
    const index = allow.indexOf(permission);
    if (index !== -1) allow.splice(index, 1);
  }

  if (profile === "trusted") {
    for (const permission of trustedClaudePermissions) {
      if (allow.includes(permission)) continue;
      allow.push(permission);
      retainedManaged.push(permission);
    }
  }

  const previousAllow = Array.isArray(nextSettings.permissions.allow)
    ? nextSettings.permissions.allow
    : [];
  nextSettings.permissions.allow = allow;
  return {
    settings: nextSettings,
    changed: !hasSettings || previousAllow.length !== allow.length
      || previousAllow.some((permission, index) => permission !== allow[index]),
    managedPermissions: [...new Set(retainedManaged)]
  };
}

function applyClaudePermissionFeature(settings, {
  augmentContextEngine = false,
  previousManagedPermissions = []
} = {}) {
  const hasSettings = settings && typeof settings === "object";
  const wasManaged = previousManagedPermissions.includes(augmentContextEnginePermission);
  if (!hasSettings && !augmentContextEngine) {
    return { settings, changed: false, managedPermissions: [] };
  }

  const nextSettings = hasSettings
    ? {
        ...settings,
        permissions: settings.permissions && typeof settings.permissions === "object"
          ? { ...settings.permissions }
          : {}
      }
    : { permissions: {} };
  const permissions = nextSettings.permissions;
  const allow = Array.isArray(permissions.allow)
    ? [...permissions.allow]
    : [];
  let changed = !hasSettings;
  let isManaged = wasManaged;

  if (augmentContextEngine) {
    if (!allow.includes(augmentContextEnginePermission)) {
      allow.push(augmentContextEnginePermission);
      changed = true;
      isManaged = true;
    }
  } else if (wasManaged && allow.includes(augmentContextEnginePermission)) {
    allow.splice(allow.indexOf(augmentContextEnginePermission), 1);
    changed = true;
    isManaged = false;
  } else {
    isManaged = false;
  }

  permissions.allow = allow;
  nextSettings.permissions = permissions;

  return {
    settings: nextSettings,
    changed,
    managedPermissions: [
      ...previousManagedPermissions.filter((permission) => permission !== augmentContextEnginePermission && allow.includes(permission)),
      ...(isManaged ? [augmentContextEnginePermission] : [])
    ]
  };
}

async function ensureClaudeSettingsForFeature(paths, augmentContextEngine, previousMetadata) {
  const settingsExists = await pathExists(paths.claudeSettingsPath);
  const settings = settingsExists
    ? await readJsonFileSafe(paths.claudeSettingsPath, {}, { sensitive: true })
    : undefined;
  const result = applyClaudePermissionFeature(settings, {
    augmentContextEngine,
    previousManagedPermissions: getPreviousManagedClaudePermissions(previousMetadata)
  });

  if (result.changed && result.settings) {
    await writeJsonFileWithBackup(paths.claudeSettingsPath, result.settings, { sensitive: true });
  }

  return result.managedPermissions;
}

function getExistingClaudeApiConfig(settings) {
  const env = mergeClaudeSettingsWithDefaults(settings).env;
  return {
    baseUrl: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    authType: env.ANTHROPIC_AUTH_TOKEN ? "auth_token" : "api_key",
    key: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "",
    model: claudeModelEnvKeys.map((field) => env[field]).find(Boolean) || "",
    insecureTls: env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
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
  authType,
  baseUrl,
  key,
  model,
  insecureTls = false
}) {
  const nextSettings = mergeClaudeSettingsWithDefaults(settings);
  nextSettings.env = applyClaudeInsecureTlsSetting(
    nextSettings.env && typeof nextSettings.env === "object" ? nextSettings.env : {},
    insecureTls
  );
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
  return nextSettings;
}

async function persistClaudeConfiguration(paths, { settings, metaConfig }) {
  await writeJsonFileWithBackup(paths.claudeSettingsPath, settings, { sensitive: true });
  await writeJsonFileWithBackup(paths.claudeMetaConfigPath, metaConfig, { sensitive: true });
}

async function configureClaudeApi(paths = defaultPaths, promptApi, options = {}) {
  const {
    assertNotCancelled,
    confirmOrCancel,
    required,
    requiredUnlessExisting,
    resolvePasswordValue,
    selectOrCancel
  } = promptApi;
  const settings = await readJsonFileSafe(paths.claudeSettingsPath, {}, { sensitive: true });
  const existing = getExistingClaudeApiConfig(settings);
  const authType = await selectOrCancel({
    message: "Claude Code 第三方 API 认证方式",
    options: [
      { value: "api_key", label: "API Key" },
      { value: "auth_token", label: "Auth Token" }
    ],
    initialValue: existing.authType
  });

  const baseUrl = await p.text({
    message: "Claude Code Base URL",
    defaultValue: existing.baseUrl,
    validate: required()
  });
  assertNotCancelled(baseUrl);

  const key = await p.password({
    message: authType === "auth_token" ? "Claude Code Auth Token（输入 - 清除）" : "Claude Code API Key（输入 - 清除）",
    mask: "*",
    defaultValue: existing.key || undefined,
    validate: requiredUnlessExisting(existing.key, "API Key / Auth Token 不能为空")
  });
  assertNotCancelled(key);
  const finalKey = resolvePasswordValue(key, existing.key);

  const insecureTls = await confirmOrCancel({
    message: "是否跳过 Claude Code TLS 证书校验？仅证书无法修复时启用（会放宽该进程全部 HTTPS 请求）",
    initialValue: existing.insecureTls
  });

  const model = await p.text({
    message: "Claude Code 模型",
    defaultValue: existing.model || undefined,
    validate: required()
  });
  assertNotCancelled(model);

  const apiSettings = buildClaudeApiSettings(settings, {
    authType,
    baseUrl,
    key: finalKey,
    model,
    insecureTls
  });
  const profileResult = applyClaudePermissionProfile(apiSettings, {
    profile: options.permissionProfile ?? "standard",
    previousManagedPermissions: options.previousManagedPermissions ?? []
  });
  const metaConfig = await readJsonFileSafe(paths.claudeMetaConfigPath, {}, { sensitive: true });
  metaConfig.hasCompletedOnboarding = true;
  ensureApprovedClaudeApiKey(metaConfig, finalKey);
  await persistClaudeConfiguration(paths, {
    settings: profileResult.settings,
    metaConfig
  });

  p.log.step(`已更新 ${pathToLabel(paths.claudeSettingsPath, paths.homeDir)} (${authType}, ${baseUrl}, ${maskSecret(finalKey)}, ${options.permissionProfile ?? "standard"})`);
  return {
    managedPermissions: profileResult.managedPermissions,
    permissionProfile: options.permissionProfile ?? "standard"
  };
}


export {
  applyClaudeInsecureTlsSetting,
  applyClaudePermissionFeature,
  applyClaudePermissionProfile,
  buildClaudeApiSettings,
  buildDefaultClaudeSettings,
  configureClaudeApi,
  ensureClaudeSettingsForFeature,
  getPreviousManagedClaudePermissions,
  mergeClaudeSettingsWithDefaults,
  persistClaudeConfiguration
};
