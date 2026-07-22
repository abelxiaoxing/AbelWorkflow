import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("Claude defaults stay free of MCP permissions and insecure TLS", () => {
  const settings = buildDefaultClaudeSettings();

  assert.deepEqual(settings.permissions.allow, []);
  assert.equal(settings.permissions.defaultMode, "bypassPermissions");
  assert.ok(!("NODE_TLS_REJECT_UNAUTHORIZED" in settings.env));
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
