import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  assertConfigurablePiProvider,
  assertSupportedPiVersion,
  buildPiModelsConfig,
  configurePiApi,
  detectPiEffectiveModel,
  parsePiRpcEffectiveModel,
  persistPiConfiguration,
  readExistingPiConfiguration,
  resolveExistingPiApiConfig,
  runPiRpcCommand
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

test("Pi API configuration warns and returns when Pi is missing or outdated", async () => {
  for (const [version, expected] of [
    [undefined, /请先安装 Pi 0\.80\.0/u],
    ["pi 0.79.9", /请先升级到 Pi 0\.80\.0/u]
  ]) {
    const warnings = [];
    await assert.doesNotReject(configurePiApi(
      {},
      async () => assert.fail("resources must not be linked"),
      undefined,
      {
        getPiVersion: () => version,
        log: { warn: (message) => warnings.push(message) }
      }
    ));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], expected);
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

test("Pi uses the runtime-selected provider instead of a stale saved default", () => {
  const config = resolveExistingPiApiConfig({
    providers: {
      htjg: {
        baseUrl: "https://saved.example/v1",
        api: "openai-completions",
        apiKey: "htjg-key",
        models: [{ id: "k3", baseUrl: "https://model.example/v1" }]
      }
    }
  }, {
    defaultProvider: "gpt",
    defaultModel: "kimi-for-coding"
  }, {
    gpt: { type: "api_key", key: "orphan-key" }
  }, {
    provider: "htjg",
    id: "k3",
    api: "openai-responses",
    baseUrl: "https://relay.example/v1"
  });

  assert.deepEqual(config, {
    providerId: "htjg",
    baseUrl: "https://relay.example/v1",
    api: "openai-responses",
    apiKey: "htjg-key",
    modelIds: ["k3"],
    defaultModel: "k3"
  });
});

test("Pi rejects a saved default that is absent from the configured models", () => {
  assert.deepEqual(resolveExistingPiApiConfig({
    providers: {
      htjg: {
        baseUrl: "https://relay.example/v1",
        api: "openai-completions",
        apiKey: "htjg-key",
        models: [{ id: "k3" }]
      }
    }
  }, {
    defaultProvider: "gpt",
    defaultModel: "kimi-for-coding"
  }, {
    gpt: { type: "api_key", key: "orphan-key" }
  }), {
    providerId: "",
    baseUrl: "",
    api: "",
    apiKey: "",
    modelIds: [],
    defaultModel: ""
  });
});

test("Pi RPC parser extracts only the successful effective model response", () => {
  const output = [
    "not-json startup output",
    JSON.stringify({ type: "event", event: { type: "agent_start" } }),
    JSON.stringify({
      id: "abelworkflow-provider",
      type: "response",
      command: "get_state",
      success: true,
      data: {
        model: {
          provider: "htjg",
          id: "k3",
          api: "openai-completions",
          baseUrl: "https://relay.example/v1"
        }
      }
    })
  ].join("\n");

  assert.deepEqual(parsePiRpcEffectiveModel(output), {
    provider: "htjg",
    id: "k3",
    api: "openai-completions",
    baseUrl: "https://relay.example/v1"
  });
  assert.equal(parsePiRpcEffectiveModel('{"type":"response","command":"get_state","success":false}'), undefined);
});

test("Pi effective-model probe runs RPC in offline no-session mode", async () => {
  let call;
  const model = await detectPiEffectiveModel(async (command, args, options) => {
    call = { command, args, options };
    return {
      status: 0,
      stdout: JSON.stringify({
        id: "abelworkflow-provider",
        type: "response",
        command: "get_state",
        success: true,
        data: {
          model: {
            provider: "relay",
            id: "relay-model",
            api: "openai-completions",
            baseUrl: "https://relay.example/v1"
          }
        }
      }),
      stderr: ""
    };
  });

  assert.equal(call.command, "pi");
  assert.deepEqual(call.args, [
    "--mode", "rpc",
    "--no-session",
    "--offline",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes"
  ]);
  assert.match(call.options.input, /"type":"get_state"/u);
  assert.equal(call.options.timeout, 20000);
  assert.deepEqual(model, {
    provider: "relay",
    id: "relay-model",
    api: "openai-completions",
    baseUrl: "https://relay.example/v1"
  });
});

test("Pi RPC runner stops a long-lived process as soon as state arrives", async () => {
  const payload = JSON.stringify({
    id: "abelworkflow-provider",
    type: "response",
    command: "get_state",
    success: true,
    data: {
      model: {
        provider: "relay",
        id: "relay-model",
        api: "openai-completions",
        baseUrl: "https://relay.example/v1"
      }
    }
  });
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  child.unref = () => {};
  const result = await runPiRpcCommand("pi", [], {
    input: "ignored\n",
    timeout: 2000,
    start: () => {
      queueMicrotask(() => child.stdout.write(`${payload}\n`));
      return child;
    }
  });

  assert.equal(result.status, 0);
  assert.equal(child.killed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.deepEqual(parsePiRpcEffectiveModel(result.stdout), {
    provider: "relay",
    id: "relay-model",
    api: "openai-completions",
    baseUrl: "https://relay.example/v1"
  });
});

test("Pi configuration accepts only models.json OpenAI-compatible providers", () => {
  const models = {
    providers: {
      relay: { models: [{ id: "relay-model" }] }
    }
  };
  assert.doesNotThrow(() => assertConfigurablePiProvider(models, {
    providerId: "relay",
    defaultModel: "relay-model",
    api: "openai-completions"
  }));
  assert.throws(
    () => assertConfigurablePiProvider(models, {
      providerId: "kimi-coding",
      defaultModel: "kimi-for-coding",
      api: "anthropic-messages"
    }),
    /models\.json/u
  );
  assert.throws(
    () => assertConfigurablePiProvider(models, {
      providerId: "relay",
      defaultModel: "relay-model",
      api: "anthropic-messages"
    }),
    /anthropic-messages/u
  );
});

test("Pi models config removes only the target Provider API key", () => {
  const next = buildPiModelsConfig({
    schemaVersion: 7,
    providers: {
      other: { apiKey: "other-key", custom: true },
      relay: {
        apiKey: "legacy-key",
        customProviderField: "keep",
        models: [{ id: "relay-test", customModelField: "keep" }]
      }
    }
  }, {
    providerId: "relay",
    baseUrl: "https://relay.example/v1",
    api: "openai-responses",
    modelIds: ["relay-test"]
  });

  assert.equal(next.schemaVersion, 7);
  assert.equal(next.providers.other.apiKey, "other-key");
  assert.equal(next.providers.relay.customProviderField, "keep");
  assert.equal(next.providers.relay.models[0].customModelField, "keep");
  assert.equal(Object.hasOwn(next.providers.relay, "apiKey"), false);
});

test("Pi models config removes stale model-level endpoint overrides", () => {
  const next = buildPiModelsConfig({
    providers: {
      relay: {
        baseUrl: "https://old.example/v1",
        api: "openai-completions",
        models: [{
          id: "relay-test",
          baseUrl: "https://model.example/v1",
          api: "openai-completions",
          customModelField: "keep"
        }]
      }
    }
  }, {
    providerId: "relay",
    baseUrl: "https://new.example/v1",
    api: "openai-responses",
    modelIds: ["relay-test"]
  });

  const [model] = next.providers.relay.models;
  assert.equal(Object.hasOwn(model, "baseUrl"), false);
  assert.equal(Object.hasOwn(model, "api"), false);
  assert.equal(model.customModelField, "keep");
});

test("Pi persists auth before models and settings", async () => {
  const calls = [];
  await persistPiConfiguration({
    piAuthPath: "auth.json",
    piModelsPath: "models.json",
    piSettingsPath: "settings.json"
  }, {
    providerId: "gpt",
    apiKey: "new-key",
    models: { providers: { gpt: {} } },
    settings: { defaultModel: "gpt-test" }
  }, {
    updateAuth: async (path, providerId, key) => calls.push(["auth", path, providerId, key]),
    writeModels: async (path) => calls.push(["models", path]),
    writeSettings: async (path) => calls.push(["settings", path])
  });

  assert.deepEqual(calls, [
    ["auth", "auth.json", "gpt", "new-key"],
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
      providerId: "gpt",
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
