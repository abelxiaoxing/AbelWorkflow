import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("mergeCodexAuthData preserves unowned auth data and replaces managed auth keys", () => {
  const authCases = [
    {
      auth: {},
      envKey: "OPENAI_API_KEY",
      apiKey: "new-secret",
      managedAuthKeys: [],
      expected: { OPENAI_API_KEY: "new-secret" }
    },
    {
      auth: {
        OPENAI_API_KEY: "old-secret",
        OPENAI_BASE_URL: "https://example.com/v1",
        LEGACY_ONE: "legacy-1",
        LEGACY_TWO: "legacy-2"
      },
      envKey: "OPENAI_API_KEY",
      apiKey: "new-secret",
      managedAuthKeys: ["LEGACY_ONE", "LEGACY_TWO"],
      expected: {
        OPENAI_API_KEY: "new-secret",
        OPENAI_BASE_URL: "https://example.com/v1"
      }
    },
    {
      auth: {
        CUSTOM_KEY: "keep-me",
        OPENAI_API_KEY: "old-secret",
        tokens: {
          id_token: "gpt-login-token",
          refresh_token: "gpt-refresh-token"
        },
        last_refresh: 123
      },
      envKey: "OPENAI_API_KEY",
      apiKey: "fresh-secret",
      managedAuthKeys: ["OPENAI_API_KEY", "UNUSED_LEGACY"],
      expected: {
        CUSTOM_KEY: "keep-me",
        OPENAI_API_KEY: "fresh-secret",
        tokens: {
          id_token: "gpt-login-token",
          refresh_token: "gpt-refresh-token"
        },
        last_refresh: 123
      }
    }
  ];

  for (const testCase of authCases) {
    assert.deepEqual(
      mergeCodexAuthData(testCase.auth, testCase.envKey, testCase.apiKey, testCase.managedAuthKeys),
      testCase.expected
    );
  }
});

test("resolveExistingCodexApiConfig reads only the resolved provider env key", () => {
  const content = `model_provider = "custom"

[model_providers.custom]
name = "Custom"
base_url = "https://custom.example/v1"
temp_env_key = "CUSTOM_API_KEY"
`;

  assert.deepEqual(resolveExistingCodexApiConfig(content, {
    OPENAI_API_KEY: "personal-secret"
  }), {
    providerId: "custom",
    providerName: "Custom",
    baseUrl: "https://custom.example/v1",
    envKey: "CUSTOM_API_KEY",
    apiKey: ""
  });
});

