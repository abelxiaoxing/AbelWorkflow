import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { readDotenvFile, updateDotenvFile } from "../config/store.mjs";
import { pathToLabel } from "../paths.mjs";

const grokDefaults = Object.freeze(JSON.parse(readFileSync(
  new URL("../../skills/grok-search/defaults.json", import.meta.url),
  "utf8"
)));

function readSkillEnvFile(path) {
  return readDotenvFile(path, { sensitive: true });
}

async function updateSkillEnvFile(path, updates) {
  return updateDotenvFile(path, updates, { sensitive: true });
}

async function configureGrokSearchEnv(paths, ensureWorkflowPresent = async () => {}, promptApi) {
  const {
    assertNotCancelled,
    confirmOrCancel,
    passwordPromptOptions,
    required,
    requiredUnlessExisting,
    resolvePasswordValue
  } = promptApi;
  await ensureWorkflowPresent(paths);
  const envPath = join(paths.agentsDir, "skills", "grok-search", ".env");
  const existing = await readSkillEnvFile(envPath);
  const baseUrl = await p.text({
    message: "Grok API URL",
    initialValue: existing.GROK_API_URL || "https://api.x.ai/v1",
    validate: required()
  });
  assertNotCancelled(baseUrl);

  const apiKey = await p.password(passwordPromptOptions(
    "Grok API Key",
    existing.GROK_API_KEY,
    requiredUnlessExisting(existing.GROK_API_KEY, "Grok API Key 不能为空")
  ));
  assertNotCancelled(apiKey);
  const finalApiKey = resolvePasswordValue(apiKey, existing.GROK_API_KEY);

  const model = await p.text({
    message: "Grok 默认模型",
    initialValue: existing.GROK_MODEL || grokDefaults.model,
    validate: required()
  });
  assertNotCancelled(model);

  const useTavily = await confirmOrCancel({
    message: "是否同时配置 Tavily 作为额外搜索源？",
    initialValue: Boolean(existing.TAVILY_API_KEY)
  });

  const tavilyKey = useTavily
    ? await p.password(passwordPromptOptions(
        "Tavily API Key",
        existing.TAVILY_API_KEY,
        requiredUnlessExisting(existing.TAVILY_API_KEY, "Tavily API Key 不能为空")
      ))
    : "";
  if (useTavily) assertNotCancelled(tavilyKey);
  const finalTavilyKey = useTavily ? resolvePasswordValue(tavilyKey, existing.TAVILY_API_KEY) : null;

  await updateSkillEnvFile(envPath, {
    GROK_API_URL: baseUrl,
    GROK_API_KEY: finalApiKey,
    GROK_MODEL: model,
    TAVILY_API_KEY: finalTavilyKey,
    TAVILY_ENABLED: useTavily ? "true" : null
  });

  p.log.step(`已写入 ${pathToLabel(envPath)}`);
}

async function configureContext7Env(paths, ensureWorkflowPresent = async () => {}, promptApi) {
  const { assertNotCancelled, passwordPromptOptions, resolvePasswordValue } = promptApi;
  await ensureWorkflowPresent(paths);
  const envPath = join(paths.agentsDir, "skills", "context7-auto-research", ".env");
  const existing = await readSkillEnvFile(envPath);
  const apiKey = await p.password(passwordPromptOptions(
    "Context7 API Key（可选）",
    existing.CONTEXT7_API_KEY
  ));
  assertNotCancelled(apiKey);
  const finalApiKey = resolvePasswordValue(apiKey, existing.CONTEXT7_API_KEY);

  await updateSkillEnvFile(envPath, {
    CONTEXT7_API_KEY: finalApiKey
  });

  p.log.step(`已写入 ${pathToLabel(envPath)}`);
}

function hasPromptEnhancerApiConfig(config) {
  return [config.PE_API_URL, config.PE_API_KEY, config.PE_MODEL]
    .every((value) => typeof value === "string" && value.trim() !== "");
}

function resolvePromptEnhancerMode(existing) {
  return hasPromptEnhancerApiConfig(existing) ? "openai-compatible" : "agent";
}

function buildPromptEnhancerEnvUpdates(apiUrl = null, apiKey = null, model = null) {
  return { PE_API_URL: apiUrl, PE_API_KEY: apiKey, PE_MODEL: model };
}

async function configurePromptEnhancerEnv(paths, ensureWorkflowPresent = async () => {}, promptApi) {
  const {
    assertNotCancelled,
    passwordPromptOptions,
    required,
    requiredUnlessExisting,
    resolvePasswordValue,
    selectOrCancel
  } = promptApi;
  await ensureWorkflowPresent(paths);
  const envPath = join(paths.agentsDir, "skills", "prompt-enhancer", ".env");
  const existing = await readSkillEnvFile(envPath);
  const mode = await selectOrCancel({
    message: "请选择 prompt-enhancer 的运行方式",
    options: [
      { value: "openai-compatible", label: "第三方 OpenAI 兼容接口" },
      { value: "agent", label: "直接使用当前 Agent" }
    ],
    initialValue: resolvePromptEnhancerMode(existing)
  });

  if (mode === "openai-compatible") {
    const apiUrl = await p.text({
      message: "PE_API_URL",
      initialValue: existing.PE_API_URL || undefined,
      validate: required()
    });
    assertNotCancelled(apiUrl);

    const apiKey = await p.password(passwordPromptOptions(
      "PE_API_KEY",
      existing.PE_API_KEY,
      requiredUnlessExisting(existing.PE_API_KEY, "PE_API_KEY 不能为空")
    ));
    assertNotCancelled(apiKey);
    const finalApiKey = resolvePasswordValue(apiKey, existing.PE_API_KEY);

    const model = await p.text({
      message: "PE_MODEL",
      initialValue: existing.PE_MODEL || undefined,
      validate: required()
    });
    assertNotCancelled(model);

    await updateSkillEnvFile(envPath, buildPromptEnhancerEnvUpdates(apiUrl, finalApiKey, model));
  } else {
    await updateSkillEnvFile(envPath, buildPromptEnhancerEnvUpdates());
  }

  p.log.step(`已写入 ${pathToLabel(envPath)}`);
}

export {
  buildPromptEnhancerEnvUpdates,
  configureContext7Env,
  configureGrokSearchEnv,
  configurePromptEnhancerEnv,
  grokDefaults,
  hasPromptEnhancerApiConfig,
  readSkillEnvFile,
  resolvePromptEnhancerMode,
  updateSkillEnvFile
};
