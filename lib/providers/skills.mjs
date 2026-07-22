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

async function configureGrokSearchEnv(paths, ensureSkillPresent = async () => {}, promptApi) {
  const {
    assertNotCancelled,
    confirmOrCancel,
    passwordPromptOptions,
    required,
    requiredUnlessExisting,
    resolvePasswordValue
  } = promptApi;
  await ensureSkillPresent(paths);
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

  const tavilyUrl = useTavily
    ? await p.text({
        message: "Tavily API URL",
        initialValue: existing.TAVILY_API_URL || "https://api.tavily.com",
        validate: required()
      })
    : null;
  if (useTavily) assertNotCancelled(tavilyUrl);

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
    TAVILY_API_URL: tavilyUrl,
    TAVILY_API_KEY: finalTavilyKey,
    TAVILY_ENABLED: useTavily ? "true" : null
  });

  p.log.step(`已写入 ${pathToLabel(envPath)}`);
}

async function configureContext7Env(paths, ensureSkillPresent = async () => {}, promptApi) {
  const { assertNotCancelled, passwordPromptOptions, resolvePasswordValue } = promptApi;
  await ensureSkillPresent(paths);
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

export {
  configureContext7Env,
  configureGrokSearchEnv,
  grokDefaults,
  readSkillEnvFile,
  updateSkillEnvFile
};
