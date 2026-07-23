import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("Claude defaults stay free of MCP permissions and TLS overrides", () => {
  const settings = buildDefaultClaudeSettings();

  assert.deepEqual(settings.permissions.allow, []);
  assert.equal(settings.permissions.defaultMode, "bypassPermissions");
  assert.ok(!("NODE_TLS_REJECT_UNAUTHORIZED" in settings.env));
  assert.ok(!("NODE_TLS_REJECT_UNAUTHORIZED" in mergeClaudeSettingsWithDefaults({}).env));
});
