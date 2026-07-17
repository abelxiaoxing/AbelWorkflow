import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSupportedPiVersion,
  buildPiModelsConfig,
  persistPiConfiguration,
  readExistingPiConfiguration
} from "../lib/providers/pi.mjs";

test("Pi requires auth-only custom provider support from version 0.80.0", () => {
  for (const version of ["0.80.0", "pi 0.80.0", "v0.81.2", "1.0.0-beta.1"]) {
    assert.doesNotThrow(() => assertSupportedPiVersion(version), version);
  }
  for (const version of ["0.79.9", "pi 0.7.0", "unknown", undefined]) {
    assert.throws(
      () => assertSupportedPiVersion(version),
      /Pi 0\.80\.0|无法检测 Pi 版本/u,
      String(version)
    );
  }
});

test("Pi reads auth before models and settings", async () => {
  const calls = [];
  const paths = {
    piAuthPath: "auth.json",
    piModelsPath: "models.json",
    piSettingsPath: "settings.json"
  };
  const result = await readExistingPiConfiguration(paths, {
    readAuth: async (path) => {
      calls.push(path);
      return { gpt: { type: "api_key", key: "auth-key" } };
    },
    readModels: async (path) => {
      calls.push(path);
      return { providers: { gpt: { apiKey: "legacy-key" } } };
    },
    readSettings: async (path) => {
      calls.push(path);
      return { defaultModel: "gpt-test" };
    }
  });

  assert.deepEqual(calls, ["auth.json", "models.json", "settings.json"]);
  assert.equal(result.auth.gpt.key, "auth-key");
});

test("Pi models config removes only the managed GPT API key", () => {
  const next = buildPiModelsConfig({
    schemaVersion: 7,
    providers: {
      other: { apiKey: "other-key", custom: true },
      gpt: {
        apiKey: "legacy-key",
        customProviderField: "keep",
        models: [{ id: "gpt-test", customModelField: "keep" }]
      }
    }
  }, {
    baseUrl: "https://relay.example/v1",
    api: "openai-responses",
    modelIds: ["gpt-test"]
  });

  assert.equal(next.schemaVersion, 7);
  assert.equal(next.providers.other.apiKey, "other-key");
  assert.equal(next.providers.gpt.customProviderField, "keep");
  assert.equal(next.providers.gpt.models[0].customModelField, "keep");
  assert.equal(Object.hasOwn(next.providers.gpt, "apiKey"), false);
});

test("Pi persists auth before models and settings", async () => {
  const calls = [];
  await persistPiConfiguration({
    piAuthPath: "auth.json",
    piModelsPath: "models.json",
    piSettingsPath: "settings.json"
  }, {
    apiKey: "new-key",
    models: { providers: { gpt: {} } },
    settings: { defaultModel: "gpt-test" }
  }, {
    updateAuth: async (path, key) => calls.push(["auth", path, key]),
    writeModels: async (path) => calls.push(["models", path]),
    writeSettings: async (path) => calls.push(["settings", path])
  });

  assert.deepEqual(calls, [
    ["auth", "auth.json", "new-key"],
    ["models", "models.json"],
    ["settings", "settings.json"]
  ]);
});

test("Pi migration keeps a credential when the models write fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "abelworkflow-provider-pi-"));
  const agentDir = join(root, ".pi", "agent");
  const paths = {
    piAuthPath: join(agentDir, "auth.json"),
    piModelsPath: join(agentDir, "models.json"),
    piSettingsPath: join(agentDir, "settings.json")
  };
  await mkdir(agentDir, { recursive: true });
  await writeFile(paths.piModelsPath, JSON.stringify({
    providers: { gpt: { apiKey: "legacy-key", models: [] } }
  }));

  try {
    await assert.rejects(persistPiConfiguration(paths, {
      apiKey: "legacy-key",
      models: { providers: { gpt: { models: [] } } },
      settings: {}
    }, {
      writeModels: async () => {
        throw new Error("simulated models failure");
      }
    }), /simulated models failure/u);

    assert.equal(JSON.parse(await readFile(paths.piAuthPath, "utf8")).gpt.key, "legacy-key");
    assert.equal(JSON.parse(await readFile(paths.piModelsPath, "utf8")).providers.gpt.apiKey, "legacy-key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

