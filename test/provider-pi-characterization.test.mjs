import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("Pi current-provider config builder preserves existing model overrides and settings defaults", () => {
  const existing = {
    providers: {
      other: { baseUrl: "https://other.example/v1" },
      relay: {
        baseUrl: "https://old.example/v1",
        api: "openai-responses",
        apiKey: "old-key",
        compat: { supportsUsageInStreaming: false },
        models: [
          {
            id: "relay-a",
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
    providerId: "relay",
    baseUrl: "https://new.example/v1",
    api: "openai-responses",
    modelIds: ["relay-a", "relay-new"]
  });

  assert.equal(nextModels.providers.other.baseUrl, "https://other.example/v1");
  assert.equal(nextModels.providers.relay.baseUrl, "https://new.example/v1");
  assert.equal(Object.hasOwn(nextModels.providers.relay, "apiKey"), false);
  assert.equal(nextModels.providers.relay.compat.supportsUsageInStreaming, false);
  assert.equal(nextModels.providers.relay.compat.supportsDeveloperRole, false);
  assert.deepEqual(nextModels.providers.relay.models[0], {
    id: "relay-a",
    name: "GPT Custom",
    reasoning: false,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 2000,
    compat: { maxTokensField: "max_tokens" }
  });
  assert.deepEqual(nextModels.providers.relay.models[1], {
    id: "relay-new",
    name: "relay-new",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 64000
  });

  assert.deepEqual(buildPiSettingsConfig({}, "relay", "relay-a"), {
    defaultProvider: "relay",
    defaultModel: "relay-a",
    defaultThinkingLevel: "high",
    enableSkillCommands: true
  });
});

test("Pi auth config preserves provider environment settings", () => {
  assert.deepEqual(buildPiAuthConfig({
    other: { type: "api_key", key: "other-key" },
    relay: {
      type: "api_key",
      key: "old-key",
      env: { HTTPS_PROXY: "http://127.0.0.1:7890" }
    }
  }, "relay", "new-key"), {
    other: { type: "api_key", key: "other-key" },
    relay: {
      type: "api_key",
      key: "new-key",
      env: {
        HTTPS_PROXY: "http://127.0.0.1:7890"
      }
    }
  });
});

test("Pi extension only applies Responses API payload compatibility", () => {
  const content = readFileSync(new URL("../extensions/pi-gpt-responses-compat/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(content, /globalThis\.fetch|dispatcher|rejectUnauthorized/u);
});

test("Pi Responses compatibility follows the model API instead of its Provider ID", () => {
  const content = readFileSync(new URL("../extensions/pi-gpt-responses-compat/index.ts", import.meta.url), "utf8");
  assert.match(content, /ctx\.model\?\.api !== "openai-responses"/u);
  assert.doesNotMatch(content, /ctx\.model\?\.provider !== "gpt"/u);
});

test("resolveExistingPiApiConfig reads the current default provider URL and API key", () => {
  const config = resolveExistingPiApiConfig({
    providers: {
      ignored: { baseUrl: "https://ignored.example/v1", apiKey: "ignored-key" },
      relay: {
        baseUrl: "https://example.com/v1",
        api: "openai-completions",
        apiKey: "stale-key",
        models: [{ id: "relay-a" }, { id: "relay-b" }]
      }
    }
  }, {
    defaultProvider: "relay",
    defaultModel: "relay-b"
  }, {
    ignored: { type: "api_key", key: "ignored-auth-key" },
    relay: { type: "api_key", key: "relay-auth-key" }
  });

  assert.deepEqual(config, {
    providerId: "relay",
    baseUrl: "https://example.com/v1",
    api: "openai-completions",
    apiKey: "relay-auth-key",
    modelIds: ["relay-a", "relay-b"],
    defaultModel: "relay-b"
  });
});

test("resolveExistingPiApiConfig leaves unrecognized current-provider fields empty", () => {
  assert.deepEqual(resolveExistingPiApiConfig({
    providers: {
      other: {
        baseUrl: "https://other.example/v1",
        api: "openai-responses",
        apiKey: "other-key",
        models: [{ id: "other-model" }]
      }
    }
  }, {
    defaultProvider: "missing"
  }), {
    providerId: "",
    baseUrl: "",
    api: "",
    apiKey: "",
    modelIds: [],
    defaultModel: ""
  });
});
