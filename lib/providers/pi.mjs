import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { piInsecureTlsHeader } from "../../extensions/pi-gpt-responses-compat/tls-fetch.mjs";
import {
  readJsonFileSafe,
  readJsoncFileSafe,
  updateLockedJson,
  writeJsonFileWithBackup,
  writeText
} from "../config/store.mjs";
import { defaultPaths, maskSecret, pathToLabel } from "../paths.mjs";

const piProviderId = "gpt";
const piDefaultApi = "openai-completions";
const piDefaultBaseUrl = "https://api.openai.com/v1";
const piDefaultModel = "gpt-5.5";
const minimumPiVersion = [0, 80, 0];

async function updatePiAuthFile(path, apiKey) {
  return updateLockedJson(path, (auth) => {
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
      throw new TypeError("Pi auth.json must contain a JSON object");
    }
    return buildPiAuthConfig(auth, apiKey);
  }, {
    sensitive: true,
    retries: {
      retries: 10,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 10000,
      randomize: true
    }
  });
}

function parsePiVersion(value) {
  const match = String(value || "").match(/(?:^|\D)v?(\d+)\.(\d+)\.(\d+)(?:\D|$)/u);
  return match ? match.slice(1).map(Number) : null;
}

function assertSupportedPiVersion(value) {
  const version = parsePiVersion(value);
  if (!version) {
    throw new Error("无法检测 Pi 版本；配置自定义 Provider 需要 Pi 0.80.0 或更高版本。");
  }
  for (let index = 0; index < minimumPiVersion.length; index += 1) {
    if (version[index] > minimumPiVersion[index]) return version;
    if (version[index] < minimumPiVersion[index]) {
      throw new Error(`当前 Pi ${version.join(".")} 不支持 auth-only 自定义 Provider；请升级到 Pi 0.80.0 或更高版本。`);
    }
  }
  return version;
}

function detectPiVersion() {
  const result = spawnSync("pi", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0 ? `${result.stdout || ""} ${result.stderr || ""}`.trim() : undefined;
}

function parsePiModelIds(value) {
  return [...new Set(String(value || "")
    .split(/[\n,]+/u)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function getOpenAiUrlPathname(value) {
  const input = String(value || "").trim();
  try {
    return new URL(input).pathname.replace(/\/+$/u, "");
  } catch {
    return input.split(/[?#]/u)[0].replace(/\/+$/u, "");
  }
}

function inferPiApiFromBaseUrl(value) {
  const pathname = getOpenAiUrlPathname(value);
  if (pathname.endsWith("/v1/chat/completions")) {
    return "openai-completions";
  }
  if (pathname.endsWith("/v1/responses")) {
    return "openai-responses";
  }
  return null;
}

function normalizeOpenAiBaseUrl(value) {
  const input = String(value || "").trim();
  try {
    const url = new URL(input);
    let pathname = url.pathname.replace(/\/+$/u, "")
      .replace(/\/v1\/(?:chat\/completions|responses)$/u, "/v1");
    if (!pathname.endsWith("/v1")) {
      pathname = `${pathname}/v1`;
    }
    url.pathname = pathname;
    return url.toString();
  } catch {
    const baseUrl = input.replace(/\/+$/u, "")
      .replace(/\/v1\/(?:chat\/completions|responses)$/u, "/v1");
    return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  }
}

function getPiApiPromptOptions() {
  return [
    { value: "openai-completions", label: "OpenAI Chat Completions（推荐）" },
    { value: "openai-responses", label: "OpenAI Responses API" }
  ];
}

function resolveExistingPiApiConfig(modelsConfig = {}, settings = {}, auth = {}) {
  const provider = modelsConfig.providers?.[piProviderId] && typeof modelsConfig.providers[piProviderId] === "object"
    ? modelsConfig.providers[piProviderId]
    : {};
  const credential = auth[piProviderId] && typeof auth[piProviderId] === "object"
    ? auth[piProviderId]
    : {};
  const authApiKey = credential.type === "api_key" && typeof credential.key === "string"
    ? credential.key
    : "";
  const models = Array.isArray(provider.models) ? provider.models.filter((model) => model?.id) : [];
  return {
    baseUrl: provider.baseUrl || piDefaultBaseUrl,
    api: provider.api || piDefaultApi,
    apiKey: authApiKey || provider.apiKey || "",
    modelIds: models.map((model) => model.id),
    defaultModel: settings.defaultProvider === piProviderId && settings.defaultModel
      ? settings.defaultModel
      : models[0]?.id || piDefaultModel
  };
}

function buildPiModelConfig(modelId, existingModel = {}) {
  return {
    ...existingModel,
    id: modelId,
    name: existingModel.name || modelId,
    reasoning: existingModel.reasoning ?? true,
    input: Array.isArray(existingModel.input) ? existingModel.input : ["text", "image"],
    contextWindow: existingModel.contextWindow ?? 262144,
    maxTokens: existingModel.maxTokens ?? 64000
  };
}

function hasPiInsecureTlsSetting(modelsConfig = {}) {
  const headers = modelsConfig.providers?.[piProviderId]?.headers;
  return headers && typeof headers === "object"
    ? Object.keys(headers).some((key) => key.toLowerCase() === piInsecureTlsHeader)
    : false;
}

function buildPiModelsConfig(modelsConfig = {}, { baseUrl, api, modelIds, insecureTls = false }) {
  const providers = modelsConfig.providers && typeof modelsConfig.providers === "object" ? modelsConfig.providers : {};
  const currentProvider = providers[piProviderId] && typeof providers[piProviderId] === "object" ? providers[piProviderId] : {};
  const headers = currentProvider.headers && typeof currentProvider.headers === "object"
    ? { ...currentProvider.headers }
    : {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === piInsecureTlsHeader) {
      delete headers[key];
    }
  }
  if (insecureTls) {
    headers[piInsecureTlsHeader] = new URL(baseUrl).origin;
  }
  const existingModels = new Map(
    (Array.isArray(currentProvider.models) ? currentProvider.models : [])
      .filter((model) => model?.id)
      .map((model) => [model.id, model])
  );

  const provider = {
    ...currentProvider,
    baseUrl,
    api,
    compat: {
      ...(currentProvider.compat && typeof currentProvider.compat === "object" ? currentProvider.compat : {}),
      supportsDeveloperRole: false
    },
    models: modelIds.map((modelId) => buildPiModelConfig(modelId, existingModels.get(modelId)))
  };
  delete provider.apiKey;
  if (Object.keys(headers).length) {
    provider.headers = headers;
  } else {
    delete provider.headers;
  }

  return {
    ...modelsConfig,
    providers: {
      ...providers,
      [piProviderId]: provider
    }
  };
}

function buildPiAuthConfig(auth = {}, apiKey) {
  const credential = auth[piProviderId] && typeof auth[piProviderId] === "object" ? auth[piProviderId] : {};
  return {
    ...auth,
    [piProviderId]: {
      ...credential,
      type: "api_key",
      key: apiKey
    }
  };
}

function buildPiSettingsConfig(settings = {}, defaultModel) {
  return {
    ...settings,
    defaultProvider: piProviderId,
    defaultModel,
    defaultThinkingLevel: settings.defaultThinkingLevel || "high",
    enableSkillCommands: settings.enableSkillCommands ?? true
  };
}

async function readExistingPiConfiguration(paths, operations = {}) {
  const readAuth = operations.readAuth ?? ((path) => readJsonFileSafe(path, {}, { sensitive: true }));
  const readModels = operations.readModels ?? ((path) => readJsoncFileSafe(path, {}, { sensitive: true }));
  const readSettings = operations.readSettings ?? ((path) => readJsonFileSafe(path, {}));
  const auth = await readAuth(paths.piAuthPath);
  const models = await readModels(paths.piModelsPath);
  const settings = await readSettings(paths.piSettingsPath);
  return { auth, models, settings };
}

function buildPiConfiguration({ auth, models, settings }, {
  apiKey,
  baseUrl,
  api,
  modelIds,
  insecureTls,
  defaultModel
}) {
  return {
    apiKey,
    auth: buildPiAuthConfig(auth, apiKey),
    models: buildPiModelsConfig(models, { baseUrl, api, modelIds, insecureTls }),
    settings: buildPiSettingsConfig(settings, defaultModel)
  };
}

async function persistPiConfiguration(paths, configuration, operations = {}) {
  const updateAuth = operations.updateAuth ?? updatePiAuthFile;
  const writeModels = operations.writeModels ?? ((path, value) => writeText(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    { sensitive: true }
  ));
  const writeSettings = operations.writeSettings ?? ((path, value) => writeJsonFileWithBackup(path, value));
  await updateAuth(paths.piAuthPath, configuration.apiKey);
  await writeModels(paths.piModelsPath, configuration.models);
  await writeSettings(paths.piSettingsPath, configuration.settings);
}

async function configurePiApi(paths = defaultPaths, ensurePiResourcesLinked = async () => {}, promptApi, runtime = {}) {
  const {
    assertNotCancelled,
    confirmOrCancel,
    required,
    requiredUnlessExisting,
    resolvePasswordValue,
    selectOrCancel
  } = promptApi;
  assertSupportedPiVersion(await (runtime.getPiVersion ?? detectPiVersion)());
  const {
    auth,
    models: modelsConfig,
    settings
  } = await readExistingPiConfiguration(paths);
  const existing = resolveExistingPiApiConfig(modelsConfig, settings, auth);

  const baseUrlInput = await p.text({
    message: "Pi gpt Base URL",
    defaultValue: existing.baseUrl,
    validate: required()
  });
  assertNotCancelled(baseUrlInput);
  const inferredApi = inferPiApiFromBaseUrl(baseUrlInput);
  const baseUrl = normalizeOpenAiBaseUrl(baseUrlInput);

  const insecureTls = await confirmOrCancel({
    message: "是否仅为 Pi gpt 中转请求跳过 TLS 证书校验？仅证书无法修复时启用",
    initialValue: hasPiInsecureTlsSetting(modelsConfig)
  });

  const piApiOptions = getPiApiPromptOptions();
  const api = inferredApi || await selectOrCancel({
    message: "Pi gpt API 类型",
    options: piApiOptions,
    initialValue: piApiOptions.some((option) => option.value === existing.api) ? existing.api : piDefaultApi
  });

  const apiKey = await p.password({
    message: "Pi gpt API Key（输入 - 清除）",
    mask: "*",
    defaultValue: existing.apiKey || undefined,
    validate: requiredUnlessExisting(existing.apiKey, "API Key 不能为空")
  });
  assertNotCancelled(apiKey);
  const finalApiKey = resolvePasswordValue(apiKey, existing.apiKey);

  const modelIdsText = await p.text({
    message: "Pi gpt 模型 ID（多个用逗号分隔）",
    defaultValue: (existing.modelIds.length ? existing.modelIds : [existing.defaultModel]).join(","),
    validate: (value) => parsePiModelIds(value).length ? undefined : "至少需要一个模型 ID"
  });
  assertNotCancelled(modelIdsText);
  const modelIds = parsePiModelIds(modelIdsText);

  const defaultModel = await p.text({
    message: "Pi 默认模型",
    defaultValue: modelIds.includes(existing.defaultModel) ? existing.defaultModel : modelIds[0],
    validate: (value) => modelIds.includes(String(value || "").trim()) ? undefined : "默认模型必须在模型 ID 列表中"
  });
  assertNotCancelled(defaultModel);

  const finalDefaultModel = String(defaultModel).trim();
  const configuration = buildPiConfiguration({ auth, models: modelsConfig, settings }, {
    apiKey: finalApiKey,
    baseUrl,
    api,
    modelIds,
    insecureTls,
    defaultModel: finalDefaultModel
  });
  await ensurePiResourcesLinked(paths);
  await persistPiConfiguration(paths, configuration);

  p.log.step(`已更新 ${pathToLabel(paths.piModelsPath, paths.homeDir)} (${piProviderId}, ${baseUrl})`);
  p.log.step(`已更新 ${pathToLabel(paths.piSettingsPath, paths.homeDir)} (默认模型: ${finalDefaultModel})`);
  p.log.step(`已更新 ${pathToLabel(paths.piAuthPath, paths.homeDir)} (${maskSecret(finalApiKey)})`);
  p.log.step(`已链接 Pi 扩展到 ${pathToLabel(join(paths.piAgentDir, "extensions"), paths.homeDir)}`);
}

export {
  assertSupportedPiVersion,
  buildPiAuthConfig,
  buildPiConfiguration,
  buildPiModelsConfig,
  buildPiSettingsConfig,
  configurePiApi,
  getPiApiPromptOptions,
  hasPiInsecureTlsSetting,
  inferPiApiFromBaseUrl,
  normalizeOpenAiBaseUrl,
  parsePiModelIds,
  persistPiConfiguration,
  readExistingPiConfiguration,
  resolveExistingPiApiConfig,
  updatePiAuthFile
};
