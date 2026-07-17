import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  buildCodexConfigContent,
  mergeCodexTemplateDefaults
} from "../lib/providers/codex.mjs";

const templateContent = `personality = "pragmatic"
approvals_reviewer = "guardian_subagent"
`;

test("Codex template merge preserves present non-decimal TOML fields", () => {
  const template = `[agents]
max_threads = 10
max_depth = 1
job_max_runtime_seconds = 2400
`;
  for (const value of ["0x10", "+16", "1_000"]) {
    const current = `[agents]
max_threads = ${value}
`;
    const merged = mergeCodexTemplateDefaults(current, template);
    assert.match(merged, new RegExp(`^max_threads = ${value.replace(/[+]/gu, "\\+")}$`, "mu"));
    assert.equal(merged.match(/^max_threads\s*=/gmu)?.length, 1);
    assert.match(merged, /^max_depth = 1$/mu);
  }
});

test("buildCodexConfigContent keeps guardian_subagent defaults for fresh config", () => {
  const content = buildCodexConfigContent("", {
    templateContent,
    includeSubagentDefaults: true,
    providerId: "abelworkflow",
    providerName: "abelworkflow",
    baseUrl: "https://example.com/v1",
    envKey: "OPENAI_API_KEY"
  });

  assert.match(content, /approvals_reviewer = "guardian_subagent"/u);
  assert.doesNotMatch(content, /approvals_reviewer = "reviewer"/u);
});

test("buildCodexConfigContent migrates legacy reviewer to guardian_subagent", () => {
  const content = buildCodexConfigContent("approvals_reviewer = \"reviewer\"\n", {
    templateContent,
    mergeMissingTemplateDefaults: true,
    includeSubagentDefaults: true,
    providerId: "abelworkflow",
    providerName: "abelworkflow",
    baseUrl: "https://example.com/v1",
    envKey: "OPENAI_API_KEY"
  });

  assert.match(content, /approvals_reviewer = "guardian_subagent"/u);
  assert.doesNotMatch(content, /approvals_reviewer = "reviewer"/u);
});

test("buildCodexConfigContent preserves existing guardian_subagent", () => {
  const content = buildCodexConfigContent("approvals_reviewer = \"guardian_subagent\"\n", {
    templateContent,
    mergeMissingTemplateDefaults: true,
    includeSubagentDefaults: true,
    providerId: "abelworkflow",
    providerName: "abelworkflow",
    baseUrl: "https://example.com/v1",
    envKey: "OPENAI_API_KEY"
  });

  assert.match(content, /approvals_reviewer = "guardian_subagent"/u);
  assert.doesNotMatch(content, /approvals_reviewer = "reviewer"/u);
});

test("bundled Codex config does not disable Node TLS verification", () => {
  const bundledTemplate = readFileSync(new URL("../lib/templates/codex/config-base.toml", import.meta.url), "utf8");

  assert.doesNotMatch(bundledTemplate, /NODE_TLS_REJECT_UNAUTHORIZED/u);
  assert.doesNotMatch(bundledTemplate, /^\[shell_environment_policy\.set\]$/mu);
});

test("buildCodexConfigContent does not inject Node TLS settings", () => {
  const bundledTemplate = readFileSync(new URL("../lib/templates/codex/config-base.toml", import.meta.url), "utf8");
  const content = buildCodexConfigContent("model = \"custom-model\"\n", {
    templateContent: bundledTemplate,
    mergeMissingTemplateDefaults: true,
    includeSubagentDefaults: true,
    providerId: "abelworkflow",
    providerName: "abelworkflow",
    baseUrl: "https://example.com/v1",
    envKey: "OPENAI_API_KEY"
  });

  assert.doesNotMatch(content, /NODE_TLS_REJECT_UNAUTHORIZED/u);
  assert.doesNotMatch(content, /^\[shell_environment_policy\.set\]$/mu);
});

test("buildCodexConfigContent preserves an inline shell environment map without TLS injection", () => {
  const bundledTemplate = readFileSync(new URL("../lib/templates/codex/config-base.toml", import.meta.url), "utf8");
  const options = {
    templateContent: bundledTemplate,
    mergeMissingTemplateDefaults: true,
    includeSubagentDefaults: true,
    providerId: "abelworkflow",
    providerName: "abelworkflow",
    baseUrl: "https://example.com/v1",
    envKey: "OPENAI_API_KEY"
  };
  const content = buildCodexConfigContent(`[shell_environment_policy]
set = { HTTPS_PROXY = "http://127.0.0.1:7890" }
`, options);

  assert.match(content, /^set = \{ HTTPS_PROXY = "http:\/\/127\.0\.0\.1:7890" \}$/mu);
  assert.doesNotMatch(content, /NODE_TLS_REJECT_UNAUTHORIZED/u);
  assert.doesNotMatch(content, /^\[shell_environment_policy\.set\]$/mu);
});

test("bundled Codex subagent templates use the base default model", () => {
  const baseConfig = readFileSync(new URL("../lib/templates/codex/config-base.toml", import.meta.url), "utf8");
  const baseModel = baseConfig.match(/^model\s*=\s*"([^"]+)"/mu)?.[1];
  assert.ok(baseModel, "base Codex model must be configured");

  const agentsDir = new URL("../lib/templates/codex/agents/", import.meta.url);
  const agentTemplates = readdirSync(agentsDir).filter((name) => name.endsWith(".toml"));
  assert.ok(agentTemplates.length > 0, "Codex subagent templates must exist");

  for (const templateName of agentTemplates) {
    const content = readFileSync(new URL(templateName, agentsDir), "utf8");
    assert.match(content, new RegExp(`^model\\s*=\\s*"${baseModel}"`, "mu"), templateName);
  }
});
