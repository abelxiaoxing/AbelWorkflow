import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildInstallMetadata } from "../lib/installer/state.mjs";
import {
  applyClaudePermissionFeature,
  applyClaudePermissionProfile,
  buildClaudeApiSettings,
  buildDefaultClaudeSettings,
  persistClaudeConfiguration
} from "../lib/providers/claude.mjs";

const broadPermissions = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"];

test("Claude standard is the safe default and does not inject a default timeout", () => {
  const settings = buildDefaultClaudeSettings();

  for (const permission of broadPermissions) {
    assert.equal(settings.permissions.allow.includes(permission), false, permission);
  }
  assert.equal(Object.hasOwn(settings.env, "API_TIMEOUT_MS"), false);
});

test("Claude trusted permissions require an explicit profile selection", () => {
  const standard = applyClaudePermissionProfile(undefined, { profile: "standard" });
  const trusted = applyClaudePermissionProfile(undefined, { profile: "trusted" });

  for (const permission of broadPermissions) {
    assert.equal(standard.settings.permissions.allow.includes(permission), false, permission);
    assert.equal(trusted.settings.permissions.allow.includes(permission), true, permission);
    assert.equal(trusted.managedPermissions.includes(permission), true, permission);
  }
});

test("Claude profile switching removes only metadata-owned permissions", () => {
  const current = {
    unknown: { keep: true },
    apiTimeoutMs: 4321,
    permissions: {
      allow: ["Bash", "Write", "CustomPermission"],
      deny: ["Bash(rm:*)", "CustomDeny"]
    },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] }
  };
  const switched = applyClaudePermissionProfile(current, {
    profile: "standard",
    previousManagedPermissions: ["Bash"]
  });

  assert.deepEqual(switched.settings.permissions.allow, ["Write", "CustomPermission"]);
  assert.deepEqual(switched.settings.permissions.deny, current.permissions.deny);
  assert.deepEqual(switched.settings.hooks, current.hooks);
  assert.deepEqual(switched.settings.unknown, { keep: true });
  assert.equal(switched.settings.apiTimeoutMs, 4321);
  assert.deepEqual(switched.managedPermissions, []);
});

test("Claude standard never removes a broad user permission without ownership", () => {
  const result = applyClaudePermissionProfile({
    permissions: { allow: ["Bash", "Write", "CustomPermission"], deny: [] }
  }, {
    profile: "standard",
    previousManagedPermissions: []
  });

  assert.deepEqual(result.settings.permissions.allow, ["Bash", "Write", "CustomPermission"]);
  assert.equal(result.changed, false);
});

test("Claude augment changes only its own permission and preserves profile ownership", () => {
  const fresh = applyClaudePermissionFeature(undefined, { augmentContextEngine: true });
  assert.deepEqual(fresh.settings, {
    permissions: { allow: ["mcp__augment-context-engine"] }
  });

  const enabled = applyClaudePermissionFeature({
    permissions: { allow: ["Bash", "CustomPermission"], deny: ["CustomDeny"] }
  }, {
    augmentContextEngine: true,
    previousManagedPermissions: ["Bash"]
  });
  assert.deepEqual(enabled.settings.permissions.allow, [
    "Bash",
    "CustomPermission",
    "mcp__augment-context-engine"
  ]);
  assert.deepEqual(enabled.settings.permissions.deny, ["CustomDeny"]);
  assert.deepEqual(enabled.managedPermissions, ["Bash", "mcp__augment-context-engine"]);

  const disabled = applyClaudePermissionFeature(enabled.settings, {
    augmentContextEngine: false,
    previousManagedPermissions: enabled.managedPermissions
  });
  assert.deepEqual(disabled.settings.permissions.allow, ["Bash", "CustomPermission"]);
  assert.deepEqual(disabled.managedPermissions, ["Bash"]);
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
    authType: "api_key",
    baseUrl: "https://relay.example",
    key: "new-secret",
    model: "claude-custom",
    insecureTls: false
  });

  assert.deepEqual(next.permissions, current.permissions);
  assert.deepEqual(next.hooks, current.hooks);
  assert.deepEqual(next.unknown, { keep: true });
  assert.equal(next.env.API_TIMEOUT_MS, "7654321");
  assert.equal(next.env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(next.env.CUSTOM_ENV, "keep");
  assert.equal(next.env.ANTHROPIC_API_KEY, "new-secret");
  assert.equal(next.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("fresh Claude API settings retain safe non-permission defaults", () => {
  const apiSettings = buildClaudeApiSettings({}, {
    authType: "api_key",
    baseUrl: "https://relay.example",
    key: "new-secret",
    model: "claude-custom",
    insecureTls: false
  });
  const result = applyClaudePermissionProfile(apiSettings, { profile: "standard" });

  assert.equal(result.settings.env.DISABLE_TELEMETRY, "1");
  assert.equal(result.settings.env.DISABLE_ERROR_REPORTING, "1");
  assert.equal(result.settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(result.settings.language, "Chinese");
  assert.equal(result.settings.alwaysThinkingEnabled, true);
  assert.equal(result.settings.includeCoAuthoredBy, false);
  assert.deepEqual(result.settings.hooks, {});
  assert.deepEqual(result.settings.permissions.allow, []);
  assert.equal(Object.hasOwn(result.settings.env, "API_TIMEOUT_MS"), false);
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

test("Claude profile and permission ownership survive installer force-style metadata rebuilds", () => {
  const metadata = buildInstallMetadata({
    previousMetadata: {
      schemaVersion: 2,
      claudePermissionProfile: "trusted",
      managedClaudePermissions: ["Bash", "Write"]
    },
    packageVersion: "1.0.0",
    managedClaudePermissions: ["Bash", "Write"]
  });

  assert.equal(metadata.claudePermissionProfile, "trusted");
  assert.deepEqual(metadata.managedClaudePermissions, ["Bash", "Write"]);
});
