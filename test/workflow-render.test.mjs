import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { renderWorkflowTemplate } from "../lib/installer/render.mjs";

const repoRoot = new URL("../", import.meta.url);
const workflowTemplateRoot = new URL("../lib/templates/workflow/", import.meta.url);

function read(path, root = workflowTemplateRoot) {
  return readFileSync(new URL(path, root), "utf8");
}

test("repository rules and deployable workflow templates are isolated", () => {
  const repositoryAgents = read("AGENTS.md", repoRoot);
  const workflowAgents = read("AGENTS.md");
  const commandNames = readdirSync(new URL("commands/", workflowTemplateRoot)).sort();

  assert.doesNotMatch(repositoryAgents, /\{\{[^{}]+\}\}/u);
  assert.match(workflowAgents, /\{\{CODEBASE_RETRIEVAL_POLICY\}\}/u);
  assert.deepEqual(commandNames, [
    "abel-design.md",
    "abel-diagnose.md",
    "abel-implement.md",
    "abel-init.md"
  ]);
  assert.match(read("gitignore.template"), /\*\.env/u);
  for (const commandName of commandNames) {
    assert.match(read(`commands/${commandName}`), /^---\n/u);
  }
});

test("renderWorkflowTemplate renders every workflow template in memory for both feature states", () => {
  const templateNames = [
    "AGENTS.md",
    ...readdirSync(new URL("commands/", workflowTemplateRoot)).map((name) => `commands/${name}`),
    "gitignore.template"
  ];

  for (const augmentContextEngine of [false, true]) {
    for (const templateName of templateNames) {
      const source = read(templateName);
      const rendered = renderWorkflowTemplate(source, { augmentContextEngine });

      assert.doesNotMatch(rendered, /\{\{[^{}]+\}\}/u, `${templateName}: ${augmentContextEngine}`);
      assert.equal(read(templateName), source, `${templateName} source changed`);
    }
  }

  const agentsTemplate = read("AGENTS.md");
  assert.doesNotMatch(
    renderWorkflowTemplate(agentsTemplate, { augmentContextEngine: false }),
    /mcp__augment-context-engine__codebase-retrieval/u
  );
  assert.match(
    renderWorkflowTemplate(agentsTemplate, { augmentContextEngine: true }),
    /mcp__augment-context-engine__codebase-retrieval/u
  );
});

test("pattern audit targets the current requirement before change creation", () => {
  const template = "{{CODEBASE_RETRIEVAL_PATTERN_AUDIT}}";
  const lite = renderWorkflowTemplate(template, { augmentContextEngine: false });
  const enabled = renderWorkflowTemplate(template, { augmentContextEngine: true });

  for (const content of [lite, enabled]) {
    assert.doesNotMatch(content, /<change_name>|proposal/iu);
  }
  assert.match(enabled, /current requirement/u);
  assert.match(enabled, /key concepts from the requirement/u);
});

test("renderWorkflowTemplate rejects unresolved placeholders", () => {
  assert.throws(
    () => renderWorkflowTemplate("before {{UNKNOWN_WORKFLOW_VALUE}} after", {}),
    /未解析占位符/u
  );
  assert.throws(() => renderWorkflowTemplate("{{}}", {}), /未解析占位符/u);
  assert.throws(() => renderWorkflowTemplate("{{UNKNOWN_{VALUE}}}", {}), /未解析占位符/u);
});
