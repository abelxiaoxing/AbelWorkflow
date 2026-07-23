import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildClaudeApiSettings,
  buildDefaultClaudeSettings,
  persistClaudeConfiguration
} from "../lib/providers/claude.mjs";

test("Claude defaults to bypassPermissions YOLO mode and does not inject a default timeout", () => {
  const settings = buildDefaultClaudeSettings();

  assert.equal(settings.permissions.defaultMode, "bypassPermissions");
  assert.deepEqual(settings.permissions.allow, []);
  assert.equal(Object.hasOwn(settings.env, "API_TIMEOUT_MS"), false);
});

test("Claude API update preserves unknown env, deny, hooks, timeout, and settings fields", () => {
  const current = {
    unknown: { keep: true },
    permissions: { allow: ["CustomPermission"], deny: ["CustomDeny"] },
    hooks: { Stop: [{ hooks: [] }] },
    env: {
      API_TIMEOUT_MS: "7654321",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      CUSTOM_ENV: "keep"
    }
  };
  const next = buildClaudeApiSettings(current, {
    baseUrl: "https://relay.example",
    key: "new-secret",
    model: "claude-custom"
  });

  assert.deepEqual(next.permissions, {
    ...current.permissions,
    defaultMode: "bypassPermissions"
  });
  assert.deepEqual(next.hooks, current.hooks);
  assert.deepEqual(next.unknown, { keep: true });
  assert.equal(next.env.API_TIMEOUT_MS, "7654321");
  assert.equal(next.env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(next.env.CUSTOM_ENV, "keep");
  assert.equal(next.env.ANTHROPIC_API_KEY, "new-secret");
  assert.equal(next.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("fresh Claude API settings retain safe non-permission defaults", () => {
  const result = buildClaudeApiSettings({}, {
    baseUrl: "https://relay.example",
    key: "new-secret",
    model: "claude-custom"
  });

  assert.equal(result.env.DISABLE_TELEMETRY, "1");
  assert.equal(result.env.DISABLE_ERROR_REPORTING, "1");
  assert.equal(result.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(result.language, "Chinese");
  assert.equal(result.alwaysThinkingEnabled, true);
  assert.equal(result.includeCoAuthoredBy, false);
  assert.deepEqual(result.hooks, {});
  assert.equal(result.permissions.defaultMode, "bypassPermissions");
  assert.deepEqual(result.permissions.allow, []);
  assert.equal(Object.hasOwn(result.env, "API_TIMEOUT_MS"), false);
});

test("Claude settings and meta configuration use sensitive writes", {
  skip: process.platform === "win32"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "abelworkflow-provider-claude-"));
  const paths = {
    claudeSettingsPath: join(root, ".claude", "settings.json"),
    claudeMetaConfigPath: join(root, ".claude.json")
  };
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(paths.claudeSettingsPath, "{}\n", { mode: 0o644 });
  await writeFile(paths.claudeMetaConfigPath, "{}\n", { mode: 0o644 });

  try {
    await persistClaudeConfiguration(paths, {
      settings: { env: { ANTHROPIC_API_KEY: "secret" } },
      metaConfig: { hasCompletedOnboarding: true }
    });

    assert.equal((await stat(paths.claudeSettingsPath)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.claudeMetaConfigPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(paths.claudeSettingsPath)).env.ANTHROPIC_API_KEY, "secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
