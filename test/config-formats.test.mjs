import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("parsePiModelIds normalizes comma and newline separated model ids", () => {
  assert.deepEqual(parsePiModelIds(" gpt-5.5,\ngpt-5.3-codex-spark,,gpt-5.5 "), [
    "gpt-5.5",
    "gpt-5.3-codex-spark"
  ]);
  assert.deepEqual(parsePiModelIds(""), []);
});

test("normalizeOpenAiBaseUrl appends /v1 and keeps an existing /v1 stable", () => {
  const cases = [
    ["https://relay.example", "https://relay.example/v1"],
    ["https://relay.example/", "https://relay.example/v1"],
    ["https://relay.example/v1", "https://relay.example/v1"]
  ];

  for (const [value, expected] of cases) {
    assert.equal(normalizeOpenAiBaseUrl(value), expected);
  }
});

test("normalizeOpenAiBaseUrl reduces complete OpenAI endpoints to /v1", () => {
  const cases = [
    ["https://relay.example/v1/chat/completions", "https://relay.example/v1"],
    ["https://relay.example/v1/chat/completions/", "https://relay.example/v1"],
    [
      "https://relay.example/v1/chat/completions?api-version=2026-01-01",
      "https://relay.example/v1?api-version=2026-01-01"
    ],
    ["https://relay.example/v1/responses", "https://relay.example/v1"],
    ["https://relay.example/v1/responses/", "https://relay.example/v1"],
    [
      "https://relay.example/v1/responses?api-version=2026-01-01",
      "https://relay.example/v1?api-version=2026-01-01"
    ]
  ];

  for (const [value, expected] of cases) {
    assert.equal(normalizeOpenAiBaseUrl(value), expected);
  }
});

test("inferPiApiFromBaseUrl recognizes complete endpoint paths", () => {
  const cases = [
    ["https://relay.example/v1/chat/completions", "openai-completions"],
    ["https://relay.example/v1/chat/completions/?api-version=2026-01-01", "openai-completions"],
    ["https://relay.example/v1/responses", "openai-responses"],
    ["https://relay.example/v1/responses/?api-version=2026-01-01", "openai-responses"]
  ];

  for (const [value, expected] of cases) {
    assert.equal(inferPiApiFromBaseUrl(value), expected);
  }
});

test("inferPiApiFromBaseUrl ignores ordinary URLs and endpoint text in queries", () => {
  const cases = [
    "https://relay.example",
    "https://relay.example/v1",
    "https://relay.example/v1?endpoint=/v1/chat/completions",
    "https://relay.example/v1?endpoint=/v1/responses"
  ];

  for (const value of cases) {
    assert.equal(inferPiApiFromBaseUrl(value), null);
  }
});

test("getPiApiPromptOptions recommends Chat Completions before Responses", () => {
  assert.deepEqual(getPiApiPromptOptions(), [
    { value: "openai-completions", label: "OpenAI Chat Completions（推荐）" },
    { value: "openai-responses", label: "OpenAI Responses API" }
  ]);
  assert.equal(resolveExistingPiApiConfig().api, "openai-completions");
  assert.equal(resolveExistingPiApiConfig({
    providers: { gpt: { api: "openai-responses" } }
  }).api, "openai-responses");
});

test("stripJsonComments preserves string URLs and removes line comments", () => {
  const parsed = JSON.parse(stripJsonComments(`{
    "baseUrl": "https://example.com/v1", // keep URL
    "apiKey": "sk//literal"
  }`));
  assert.deepEqual(parsed, {
    baseUrl: "https://example.com/v1",
    apiKey: "sk//literal"
  });
});

test("stripJsonComments removes JSONC trailing commas outside strings", () => {
  const parsed = JSON.parse(stripJsonComments(`{
    "providers": {
      "gpt": {
        "baseUrl": "https://example.com/a,b",
        "models": [
          { "id": "gpt-5.5", }, // Pi JSONC allows this
        ],
      },
    },
  }`));
  assert.deepEqual(parsed, {
    providers: {
      gpt: {
        baseUrl: "https://example.com/a,b",
        models: [{ id: "gpt-5.5" }]
      }
    }
  });
});

test("stripJsonComments rejects unterminated block comments", () => {
  assert.throws(
    () => stripJsonComments(`{"stable": true}\n/* unterminated`),
    (error) => error instanceof SyntaxError && /unterminated block comment/iu.test(error.message)
  );
});

