import { spawn, spawnSync } from "node:child_process";
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

const minimumPiVersion = [0, 80, 0];
const piRpcRequestId = "abelworkflow-provider";
const piRpcArgs = [
  "--mode", "rpc",
  "--no-session",
  "--offline",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes"
];

function requirePiProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  if (!providerId) {
    throw new Error("未检测到 Pi 当前有效 Provider；请先在 Pi 中配置可用模型。");
  }
  return providerId;
}

async function updatePiAuthFile(path, providerId, apiKey) {
  const targetProviderId = requirePiProviderId(providerId);
  return updateLockedJson(path, (auth) => {
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
      throw new TypeError("Pi auth.json must contain a JSON object");
    }
    return buildPiAuthConfig(auth, targetProviderId, apiKey);
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
    throw new Error("无法检测 Pi 版本（可能尚未安装）；请先安装 Pi 0.80.0 或更高版本。");
  }
  for (let index = 0; index < minimumPiVersion.length; index += 1) {
    if (version[index] > minimumPiVersion[index]) return version;
    if (version[index] < minimumPiVersion[index]) {
      throw new Error(`当前 Pi ${version.join(".")} 不支持 auth-only 自定义 Provider；请先升级到 Pi 0.80.0 或更高版本。`);
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

function parsePiRpcEffectiveModel(value) {
  for (const line of String(value || "").split(/\r?\n/u)) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    const model = payload?.type === "response"
      && payload.command === "get_state"
      && payload.success === true
      ? payload.data?.model
      : undefined;
    const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!provider || !id) continue;
    return {
      provider,
      id,
      api: typeof model.api === "string" ? model.api.trim() : "",
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl.trim() : ""
    };
  }
}

function runPiRpcCommand(command, args, {
  input = "",
  maxBuffer = 1024 * 1024,
  shell = process.platform === "win32",
  start = spawn,
  timeout = 20000
} = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let settled = false;
    let timer;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      if (child?.exitCode === null && child.signalCode === null && !child.killed) child.kill();
      child?.unref();
      resolve({ status, stdout });
    };

    try {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      child = start(command, args, {
        env,
        shell,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true
      });
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => finish(null), timeout);
    child.on("error", () => finish(null));
    child.on("exit", (code) => finish(code));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxBuffer) {
        finish(null);
      } else if (parsePiRpcEffectiveModel(stdout)) {
        finish(0);
      }
    });
    child.stdin.on("error", () => finish(null));
    child.stdin.write(input, (error) => {
      if (error) finish(null);
    });
  });
}

async function detectPiEffectiveModel(run = runPiRpcCommand) {
  let result;
  try {
    result = await run("pi", piRpcArgs, {
      encoding: "utf8",
      input: `${JSON.stringify({ id: piRpcRequestId, type: "get_state" })}\n`,
      maxBuffer: 1024 * 1024,
      shell: process.platform === "win32",
      timeout: 20000
    });
  } catch {
    return undefined;
  }
  if (result?.error || result?.status !== 0) return undefined;
  return parsePiRpcEffectiveModel(result.stdout);
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

function resolveExistingPiApiConfig(modelsConfig = {}, settings = {}, auth = {}, effectiveModel) {
  const savedProviderId = typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
  const savedModelId = typeof settings.defaultModel === "string" ? settings.defaultModel.trim() : "";
  const effectiveProviderId = typeof effectiveModel?.provider === "string" ? effectiveModel.provider.trim() : "";
  const effectiveModelId = typeof effectiveModel?.id === "string" ? effectiveModel.id.trim() : "";
  const savedProvider = savedProviderId
    && modelsConfig.providers?.[savedProviderId]
    && typeof modelsConfig.providers[savedProviderId] === "object"
    ? modelsConfig.providers[savedProviderId]
    : undefined;
  const savedModels = Array.isArray(savedProvider?.models) ? savedProvider.models : [];
  const savedTargetExists = savedProviderId
    && savedModelId
    && savedModels.some((model) => model?.id === savedModelId);
  const providerId = effectiveProviderId && effectiveModelId
    ? effectiveProviderId
    : savedTargetExists ? savedProviderId : "";
  const defaultModel = effectiveProviderId && effectiveModelId
    ? effectiveModelId
    : savedTargetExists ? savedModelId : "";
  const provider = providerId
    && modelsConfig.providers?.[providerId]
    && typeof modelsConfig.providers[providerId] === "object"
    ? modelsConfig.providers[providerId]
    : {};
  const credential = providerId && auth[providerId] && typeof auth[providerId] === "object"
    ? auth[providerId]
    : {};
  const authApiKey = credential.type === "api_key" && typeof credential.key === "string"
    ? credential.key
    : "";
  const models = Array.isArray(provider.models) ? provider.models.filter((model) => model?.id) : [];
  const model = models.find((item) => item.id === defaultModel) || {};
  const runtimeMatches = Boolean(effectiveProviderId
    && effectiveModelId
    && effectiveProviderId === providerId
    && effectiveModelId === defaultModel);
  return {
    providerId,
    baseUrl: runtimeMatches && typeof effectiveModel.baseUrl === "string"
      ? effectiveModel.baseUrl
      : typeof model.baseUrl === "string" ? model.baseUrl
        : typeof provider.baseUrl === "string" ? provider.baseUrl : "",
    api: runtimeMatches && typeof effectiveModel.api === "string"
      ? effectiveModel.api
      : typeof model.api === "string" ? model.api
        : typeof provider.api === "string" ? provider.api : "",
    apiKey: authApiKey || (typeof provider.apiKey === "string" ? provider.apiKey : ""),
    modelIds: models.map((model) => model.id),
    defaultModel
  };
}

function assertConfigurablePiProvider(modelsConfig = {}, configuration = {}) {
  const { providerId, defaultModel, api } = configuration;
  const provider = modelsConfig.providers?.[providerId];
  const models = Array.isArray(provider?.models) ? provider.models : [];
  if (!provider || typeof provider !== "object" || !models.some((model) => model?.id === defaultModel)) {
    throw new Error(`Pi 当前有效 Provider ${providerId || "未知"} 不是 models.json 中的自定义 Provider；为避免覆盖内置模型，已停止配置。`);
  }
  const supportedApis = new Set(getPiApiPromptOptions().map((option) => option.value));
  if (api && !supportedApis.has(api)) {
    throw new Error(`Pi 当前有效 Provider ${providerId} 使用不受支持的 API 类型 ${api}；此配置器仅支持 OpenAI-compatible API。`);
  }
}

function buildPiModelConfig(modelId, existingModel = {}) {
  const model = { ...existingModel };
  delete model.baseUrl;
  delete model.api;
  return {
    ...model,
    id: modelId,
    name: model.name || modelId,
    reasoning: model.reasoning ?? true,
    input: Array.isArray(model.input) ? model.input : ["text", "image"],
    contextWindow: model.contextWindow ?? 262144,
    maxTokens: model.maxTokens ?? 64000
  };
}

function hasPiInsecureTlsSetting(modelsConfig = {}, providerId) {
  const headers = modelsConfig.providers?.[requirePiProviderId(providerId)]?.headers;
  return headers && typeof headers === "object"
    ? Object.keys(headers).some((key) => key.toLowerCase() === piInsecureTlsHeader)
    : false;
}

function buildPiModelsConfig(modelsConfig = {}, {
  providerId,
  baseUrl,
  api,
  modelIds,
  insecureTls = false
}) {
  const targetProviderId = requirePiProviderId(providerId);
  const providers = modelsConfig.providers && typeof modelsConfig.providers === "object" ? modelsConfig.providers : {};
  const currentProvider = providers[targetProviderId] && typeof providers[targetProviderId] === "object"
    ? providers[targetProviderId]
    : {};
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
      [targetProviderId]: provider
    }
  };
}

function buildPiAuthConfig(auth = {}, providerId, apiKey) {
  const targetProviderId = requirePiProviderId(providerId);
  const credential = auth[targetProviderId] && typeof auth[targetProviderId] === "object"
    ? auth[targetProviderId]
    : {};
  return {
    ...auth,
    [targetProviderId]: {
      ...credential,
      type: "api_key",
      key: apiKey
    }
  };
}

function buildPiSettingsConfig(settings = {}, providerId, defaultModel) {
  return {
    ...settings,
    defaultProvider: requirePiProviderId(providerId),
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
  providerId,
  apiKey,
  baseUrl,
  api,
  modelIds,
  insecureTls,
  defaultModel
}) {
  const targetProviderId = requirePiProviderId(providerId);
  return {
    providerId: targetProviderId,
    apiKey,
    auth: buildPiAuthConfig(auth, targetProviderId, apiKey),
    models: buildPiModelsConfig(models, {
      providerId: targetProviderId,
      baseUrl,
      api,
      modelIds,
      insecureTls
    }),
    settings: buildPiSettingsConfig(settings, targetProviderId, defaultModel)
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
  await updateAuth(paths.piAuthPath, configuration.providerId, configuration.apiKey);
  await writeModels(paths.piModelsPath, configuration.models);
  await writeSettings(paths.piSettingsPath, configuration.settings);
}

async function configurePiApi(paths = defaultPaths, ensurePiResourcesLinked = async () => {}, promptApi, runtime = {}) {
  const piVersion = await (runtime.getPiVersion ?? detectPiVersion)();
  try {
    assertSupportedPiVersion(piVersion);
  } catch (error) {
    (runtime.log ?? p.log).warn(error.message || String(error));
    return;
  }
  const {
    assertNotCancelled,
    confirmOrCancel,
    passwordPromptOptions,
    required,
    requiredUnlessExisting,
    resolvePasswordValue,
    selectOrCancel
  } = promptApi;
  const {
    auth,
    models: modelsConfig,
    settings
  } = await readExistingPiConfiguration(paths);
  const detectionSpinner = p.spinner();
  detectionSpinner.start("正在识别 Pi 当前有效模型");
  let effectiveModel;
  try {
    effectiveModel = await (runtime.getPiEffectiveModel ?? detectPiEffectiveModel)();
  } finally {
    detectionSpinner.stop(effectiveModel
      ? `已识别 ${effectiveModel.provider}/${effectiveModel.id}`
      : "未识别到 Pi 当前有效模型");
  }
  const existing = resolveExistingPiApiConfig(modelsConfig, settings, auth, effectiveModel);
  const providerId = requirePiProviderId(existing.providerId);
  assertConfigurablePiProvider(modelsConfig, existing);
  if (effectiveModel
    && (settings.defaultProvider !== existing.providerId || settings.defaultModel !== existing.defaultModel)) {
    p.log.warn(`Pi 保存的默认模型 ${settings.defaultProvider || "未知"}/${settings.defaultModel || "未知"} 与当前有效模型 ${existing.providerId}/${existing.defaultModel} 不同；将配置当前有效模型。`);
  }
  const providerLabel = `Pi ${providerId}`;

  const baseUrlInput = await p.text({
    message: `${providerLabel} Base URL`,
    initialValue: existing.baseUrl,
    validate: required()
  });
  assertNotCancelled(baseUrlInput);
  const inferredApi = inferPiApiFromBaseUrl(baseUrlInput);
  const baseUrl = normalizeOpenAiBaseUrl(baseUrlInput);

  const insecureTls = await confirmOrCancel({
    message: `是否仅为 ${providerLabel} 中转请求跳过 TLS 证书校验？仅证书无法修复时启用`,
    initialValue: hasPiInsecureTlsSetting(modelsConfig, providerId)
  });

  const piApiOptions = getPiApiPromptOptions();
  const initialApi = piApiOptions.some((option) => option.value === existing.api)
    ? existing.api
    : undefined;
  const api = inferredApi || await selectOrCancel({
    message: `${providerLabel} API 类型`,
    options: piApiOptions,
    ...(initialApi ? { initialValue: initialApi } : {})
  });

  const apiKey = await p.password(passwordPromptOptions(
    `${providerLabel} API Key`,
    existing.apiKey,
    requiredUnlessExisting(existing.apiKey, "API Key 不能为空")
  ));
  assertNotCancelled(apiKey);
  const finalApiKey = resolvePasswordValue(apiKey, existing.apiKey);

  const modelIdsText = await p.text({
    message: `${providerLabel} 模型 ID（多个用逗号分隔）`,
    initialValue: (existing.modelIds.length
      ? existing.modelIds
      : existing.defaultModel ? [existing.defaultModel] : []).join(","),
    validate: (value) => parsePiModelIds(value).length ? undefined : "至少需要一个模型 ID"
  });
  assertNotCancelled(modelIdsText);
  const modelIds = parsePiModelIds(modelIdsText);

  const defaultModel = await p.text({
    message: "Pi 默认模型",
    initialValue: modelIds.includes(existing.defaultModel) ? existing.defaultModel : modelIds[0],
    validate: (value) => modelIds.includes(String(value || "").trim()) ? undefined : "默认模型必须在模型 ID 列表中"
  });
  assertNotCancelled(defaultModel);

  const finalDefaultModel = String(defaultModel).trim();
  const configuration = buildPiConfiguration({ auth, models: modelsConfig, settings }, {
    providerId,
    apiKey: finalApiKey,
    baseUrl,
    api,
    modelIds,
    insecureTls,
    defaultModel: finalDefaultModel
  });
  await ensurePiResourcesLinked(paths);
  await persistPiConfiguration(paths, configuration);

  p.log.step(`已更新 ${pathToLabel(paths.piModelsPath, paths.homeDir)} (${providerId}, ${baseUrl})`);
  p.log.step(`已更新 ${pathToLabel(paths.piSettingsPath, paths.homeDir)} (默认模型: ${finalDefaultModel})`);
  p.log.step(`已更新 ${pathToLabel(paths.piAuthPath, paths.homeDir)} (${maskSecret(finalApiKey)})`);
  p.log.step(`已链接 Pi 扩展到 ${pathToLabel(join(paths.piAgentDir, "extensions"), paths.homeDir)}`);
}

export {
  assertConfigurablePiProvider,
  assertSupportedPiVersion,
  buildPiAuthConfig,
  buildPiConfiguration,
  buildPiModelsConfig,
  buildPiSettingsConfig,
  configurePiApi,
  detectPiEffectiveModel,
  getPiApiPromptOptions,
  hasPiInsecureTlsSetting,
  inferPiApiFromBaseUrl,
  normalizeOpenAiBaseUrl,
  parsePiRpcEffectiveModel,
  parsePiModelIds,
  persistPiConfiguration,
  readExistingPiConfiguration,
  resolveExistingPiApiConfig,
  runPiRpcCommand,
  updatePiAuthFile
};
