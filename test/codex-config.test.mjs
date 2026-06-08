import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { buildCodexConfigContent } from "../lib/cli.mjs";

const templateContent = `personality = "pragmatic"
approvals_reviewer = "guardian_subagent"
`;

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
