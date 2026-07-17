import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("augment-context-engine feature resolution defaults false and preserves previous metadata", () => {
  assert.equal(resolveAugmentContextEngineFeature({}, {}), false);
  assert.equal(resolveAugmentContextEngineFeature({ augmentContextEngine: true }, {}), true);
  assert.equal(resolveAugmentContextEngineFeature({ augmentContextEngine: false }, {
    features: { augmentContextEngine: true }
  }), false);
  assert.equal(resolveAugmentContextEngineFeature({}, {
    features: { augmentContextEngine: true }
  }), true);
  assert.equal(resolveAugmentContextEngineFeature({}, {
    features: { augmentContextEngine: false }
  }), false);
});

test("renderWorkflowTemplate renders enabled and lite retrieval policies", () => {
  const agentsTemplate = readFileSync(new URL("lib/templates/workflow/AGENTS.md", repoRoot), "utf8");
  const enabledAgents = renderWorkflowTemplate(agentsTemplate, { augmentContextEngine: true });
  const liteAgents = renderWorkflowTemplate(agentsTemplate, { augmentContextEngine: false });

  assert.match(enabledAgents, /mcp__augment-context-engine__codebase-retrieval/u);
  assert.doesNotMatch(enabledAgents, /CODEBASE_RETRIEVAL_POLICY/u);
  assert.match(liteAgents, /Use local codebase retrieval with `rg`, `rg --files`, `git grep`, and direct file reads/u);
  assert.doesNotMatch(liteAgents, /mcp__augment-context-engine__codebase-retrieval/u);
  assert.doesNotMatch(liteAgents, /CODEBASE_RETRIEVAL_POLICY/u);
});

test("renderWorkflowTemplate removes mandatory augment MCP wording from lite commands", () => {
  const commandNames = ["abel-init.md", "abel-research.md", "abel-plan.md", "abel-diagnose.md"];
  for (const commandName of commandNames) {
    const template = readFileSync(new URL(`lib/templates/workflow/commands/${commandName}`, repoRoot), "utf8");
    const content = renderWorkflowTemplate(template, { augmentContextEngine: false });
    assert.doesNotMatch(content, /mcp__augment-context-engine__codebase-retrieval/u, commandName);
    assert.doesNotMatch(content, /Mandatory use of `mcp__augment-context-engine__codebase-retrieval`/u, commandName);
    assert.doesNotMatch(content, /\{\{[A-Z_]+\}\}/u, commandName);
  }
});


