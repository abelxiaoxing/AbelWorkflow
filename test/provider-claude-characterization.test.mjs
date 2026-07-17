import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("Claude default permissions include augment MCP only when feature is enabled", () => {
  const enabledSettings = buildDefaultClaudeSettings({ augmentContextEngine: true });
  const liteSettings = buildDefaultClaudeSettings({ augmentContextEngine: false });

  assert.ok(enabledSettings.permissions.allow.includes("mcp__augment-context-engine"));
  assert.ok(!liteSettings.permissions.allow.includes("mcp__augment-context-engine"));

  assert.ok(mergeClaudeSettingsWithDefaults({}, { augmentContextEngine: true })
    .permissions.allow.includes("mcp__augment-context-engine"));
  assert.ok(!mergeClaudeSettingsWithDefaults({}, { augmentContextEngine: false })
    .permissions.allow.includes("mcp__augment-context-engine"));
  assert.ok(!("NODE_TLS_REJECT_UNAUTHORIZED" in enabledSettings.env));
  assert.ok(!("NODE_TLS_REJECT_UNAUTHORIZED" in mergeClaudeSettingsWithDefaults({}).env));
  assert.equal(mergeClaudeSettingsWithDefaults({
    env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" }
  }).env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
});

test("Claude insecure TLS setting requires explicit opt-in and is reversible", () => {
  const env = { HTTPS_PROXY: "http://127.0.0.1:7890" };
  assert.deepEqual(applyClaudeInsecureTlsSetting(env, false), env);
  assert.deepEqual(applyClaudeInsecureTlsSetting(env, true), {
    ...env,
    NODE_TLS_REJECT_UNAUTHORIZED: "0"
  });
  assert.deepEqual(applyClaudeInsecureTlsSetting({
    ...env,
    NODE_TLS_REJECT_UNAUTHORIZED: "0"
  }, false), env);
});

test("applyClaudePermissionFeature only removes augment MCP permission when previously managed", () => {
  const userManaged = applyClaudePermissionFeature({
    permissions: { allow: ["Read", "mcp__augment-context-engine"], deny: [] }
  }, {
    augmentContextEngine: false,
    previousManagedPermissions: []
  });
  assert.deepEqual(userManaged.settings.permissions.allow, ["Read", "mcp__augment-context-engine"]);
  assert.deepEqual(userManaged.managedPermissions, []);
  assert.equal(userManaged.changed, false);

  const abelManaged = applyClaudePermissionFeature({
    permissions: { allow: ["Read", "mcp__augment-context-engine"], deny: [] }
  }, {
    augmentContextEngine: false,
    previousManagedPermissions: ["mcp__augment-context-engine"]
  });
  assert.deepEqual(abelManaged.settings.permissions.allow, ["Read"]);
  assert.deepEqual(abelManaged.managedPermissions, []);
  assert.equal(abelManaged.changed, true);
});


