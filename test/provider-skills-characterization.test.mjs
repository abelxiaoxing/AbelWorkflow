import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("hasPromptEnhancerApiConfig requires complete OpenAI-compatible config", () => {
  const cases = [
    {
      value: {
        PE_API_URL: "https://example.com/v1",
        PE_API_KEY: "secret",
        PE_MODEL: "gpt-4o-mini"
      },
      expected: true
    },
    {
      value: {
        PE_API_URL: "https://example.com/v1",
        PE_API_KEY: "secret"
      },
      expected: false
    },
    {
      value: {
        PE_API_URL: "",
        PE_API_KEY: "secret",
        PE_MODEL: "gpt-4o-mini"
      },
      expected: false
    }
  ];

  for (const testCase of cases) {
    assert.equal(hasPromptEnhancerApiConfig(testCase.value), testCase.expected);
  }
});

test("resolvePromptEnhancerMode prefers OpenAI-compatible config and otherwise falls back to current agent mode", () => {
  const cases = [
    {
      existing: {
        PE_API_URL: "https://example.com/v1",
        PE_API_KEY: "secret",
        PE_MODEL: "gpt-4o-mini"
      },
      expected: "openai-compatible"
    },
    {
      existing: {
        OPENAI_API_KEY: "legacy-secret",
        PE_MODEL: "gpt-4o"
      },
      expected: "agent"
    },
    {
      existing: {
        ANTHROPIC_API_KEY: "legacy-anthropic"
      },
      expected: "agent"
    }
  ];

  for (const testCase of cases) {
    assert.equal(resolvePromptEnhancerMode(testCase.existing), testCase.expected);
  }
});


