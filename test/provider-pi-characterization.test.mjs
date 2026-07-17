import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("Pi gpt config builder preserves existing model overrides and settings defaults", () => {
  const existing = {
    providers: {
      other: { baseUrl: "https://other.example/v1" },
      gpt: {
        baseUrl: "https://old.example/v1",
        api: "openai-responses",
        apiKey: "old-key",
        compat: { supportsUsageInStreaming: false },
        models: [
          {
            id: "gpt-5.5",
            name: "GPT Custom",
            reasoning: false,
            input: ["text"],
            contextWindow: 1000,
            maxTokens: 2000,
            compat: { maxTokensField: "max_tokens" }
          }
        ]
      }
    }
  };

  const nextModels = buildPiModelsConfig(existing, {
    baseUrl: "https://new.example/v1",
    api: "openai-responses",
    apiKey: "new-key",
    modelIds: ["gpt-5.5", "gpt-new"]
  });

  assert.equal(nextModels.providers.other.baseUrl, "https://other.example/v1");
  assert.equal(nextModels.providers.gpt.baseUrl, "https://new.example/v1");
  assert.equal(Object.hasOwn(nextModels.providers.gpt, "apiKey"), false);
  assert.equal(nextModels.providers.gpt.compat.supportsUsageInStreaming, false);
  assert.equal(nextModels.providers.gpt.compat.supportsDeveloperRole, false);
  assert.deepEqual(nextModels.providers.gpt.models[0], {
    id: "gpt-5.5",
    name: "GPT Custom",
    reasoning: false,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 2000,
    compat: { maxTokensField: "max_tokens" }
  });
  assert.deepEqual(nextModels.providers.gpt.models[1], {
    id: "gpt-new",
    name: "gpt-new",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 64000
  });

  assert.deepEqual(buildPiSettingsConfig({}, "gpt-5.5"), {
    defaultProvider: "gpt",
    defaultModel: "gpt-5.5",
    defaultThinkingLevel: "high",
    enableSkillCommands: true
  });
});

test("Pi auth config preserves provider environment settings", () => {
  assert.deepEqual(buildPiAuthConfig({
    other: { type: "api_key", key: "other-key" },
    gpt: {
      type: "api_key",
      key: "old-key",
      env: { HTTPS_PROXY: "http://127.0.0.1:7890" }
    }
  }, "new-key"), {
    other: { type: "api_key", key: "other-key" },
    gpt: {
      type: "api_key",
      key: "new-key",
      env: {
        HTTPS_PROXY: "http://127.0.0.1:7890"
      }
    }
  });
});

test("Pi extension does not disable TLS verification for the process", () => {
  const content = readFileSync(new URL("../extensions/pi-gpt-responses-compat/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(content, /NODE_TLS_REJECT_UNAUTHORIZED/u);
});

test("Pi gpt config toggles only the managed insecure TLS request marker", () => {
  const existing = {
    providers: {
      gpt: {
        headers: {
          "x-existing": "keep",
          [piInsecureTlsHeader]: "https://old.example"
        }
      }
    }
  };
  const options = {
    baseUrl: "https://relay.example/v1",
    api: "openai-responses",
    apiKey: "secret",
    modelIds: ["gpt-test"]
  };

  const strict = buildPiModelsConfig(existing, { ...options, insecureTls: false });
  assert.deepEqual(strict.providers.gpt.headers, { "x-existing": "keep" });

  const insecure = buildPiModelsConfig(existing, { ...options, insecureTls: true });
  assert.equal(insecure.providers.gpt.headers[piInsecureTlsHeader], "https://relay.example");
  assert.equal(insecure.providers.gpt.headers["x-existing"], "keep");
});

test("resolveExistingPiApiConfig reads gpt provider and default model", () => {
  const config = resolveExistingPiApiConfig({
    providers: {
      gpt: {
        baseUrl: "https://example.com/v1",
        api: "openai-completions",
        apiKey: "secret",
        models: [{ id: "gpt-a" }, { id: "gpt-b" }]
      }
    }
  }, {
    defaultProvider: "gpt",
    defaultModel: "gpt-b"
  });

  assert.deepEqual(config, {
    baseUrl: "https://example.com/v1",
    api: "openai-completions",
    apiKey: "secret",
    modelIds: ["gpt-a", "gpt-b"],
    defaultModel: "gpt-b"
  });
});


