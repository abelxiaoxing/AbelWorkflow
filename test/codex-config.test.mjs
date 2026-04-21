import test from "node:test";
import assert from "node:assert/strict";
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
