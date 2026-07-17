import test from "node:test";
import assert from "node:assert/strict";

import { resolveExistingPiApiConfig } from "../lib/providers/pi.mjs";

test("resolveExistingPiApiConfig uses an auth-only API key", () => {
  const config = resolveExistingPiApiConfig({}, {}, {
    gpt: { type: "api_key", key: "auth-only-key" }
  });

  assert.equal(config.apiKey, "auth-only-key");
});

test("resolveExistingPiApiConfig prefers auth over a stale models API key", () => {
  const config = resolveExistingPiApiConfig({
    providers: {
      gpt: { apiKey: "stale-models-key" }
    }
  }, {}, {
    gpt: { type: "api_key", key: "fresh-auth-key" }
  });

  assert.equal(config.apiKey, "fresh-auth-key");
});

test("resolveExistingPiApiConfig falls back to models for unusable auth credentials", () => {
  const modelsConfig = {
    providers: {
      gpt: { apiKey: "models-key" }
    }
  };
  const authCases = [
    { label: "invalid credential", auth: { gpt: "invalid" } },
    { label: "empty API key", auth: { gpt: { type: "api_key", key: "" } } },
    { label: "non-string API key", auth: { gpt: { type: "api_key", key: 123 } } },
    { label: "non-API-key credential", auth: { gpt: { type: "oauth", key: "oauth-key" } } }
  ];

  for (const { label, auth } of authCases) {
    assert.equal(resolveExistingPiApiConfig(modelsConfig, {}, auth).apiKey, "models-key", label);
  }
});
