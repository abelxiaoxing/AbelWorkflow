import test from "node:test";
import assert from "node:assert/strict";

import { resolveExistingPiApiConfig } from "../lib/providers/pi.mjs";

const target = {
  provider: "relay",
  id: "relay-model",
  api: "openai-completions",
  baseUrl: "https://relay.example/v1"
};
const settings = { defaultProvider: "relay", defaultModel: "relay-model" };

test("resolveExistingPiApiConfig uses an auth-only API key", () => {
  const config = resolveExistingPiApiConfig({
    providers: { relay: { models: [{ id: "relay-model" }] } }
  }, settings, {
    relay: { type: "api_key", key: "auth-only-key" }
  }, target);

  assert.equal(config.apiKey, "auth-only-key");
});

test("resolveExistingPiApiConfig prefers auth over a stale models API key", () => {
  const config = resolveExistingPiApiConfig({
    providers: {
      relay: { apiKey: "stale-models-key", models: [{ id: "relay-model" }] }
    }
  }, settings, {
    relay: { type: "api_key", key: "fresh-auth-key" }
  }, target);

  assert.equal(config.apiKey, "fresh-auth-key");
});

test("resolveExistingPiApiConfig falls back to models for unusable auth credentials", () => {
  const modelsConfig = {
    providers: {
      relay: { apiKey: "models-key", models: [{ id: "relay-model" }] }
    }
  };
  const authCases = [
    { label: "invalid credential", auth: { relay: "invalid" } },
    { label: "empty API key", auth: { relay: { type: "api_key", key: "" } } },
    { label: "non-string API key", auth: { relay: { type: "api_key", key: 123 } } },
    { label: "non-API-key credential", auth: { relay: { type: "oauth", key: "oauth-key" } } }
  ];

  for (const { label, auth } of authCases) {
    assert.equal(
      resolveExistingPiApiConfig(modelsConfig, settings, auth, target).apiKey,
      "models-key",
      label
    );
  }
});
