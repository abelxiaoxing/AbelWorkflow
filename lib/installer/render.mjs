const augmentContextEngineRetrievalTool = "mcp__augment-context-engine__codebase-retrieval";
const localCodebaseRetrievalPolicy = "Use local codebase retrieval with `rg`, `rg --files`, `git grep`, and direct file reads. Do not require augment-context-engine MCP.";
const augmentCodebaseRetrievalPolicy = `Use \`${augmentContextEngineRetrievalTool}\` as the primary codebase search tool.`;

function resolveAugmentContextEngineFeature(options = {}, previousMetadata = {}) {
  if (typeof options.augmentContextEngine === "boolean") return options.augmentContextEngine;
  if (typeof previousMetadata?.features?.augmentContextEngine === "boolean") {
    return previousMetadata.features.augmentContextEngine;
  }
  return false;
}

function getWorkflowRenderValues(augmentContextEngine) {
  return {
    CODEBASE_RETRIEVAL_POLICY: augmentContextEngine ? augmentCodebaseRetrievalPolicy : localCodebaseRetrievalPolicy,
    AUGMENT_CONTEXT_ENGINE_VALIDATION: augmentContextEngine
      ? `Verify MCP availability:\n   - \`${augmentContextEngineRetrievalTool}\``
      : "Skip augment-context-engine MCP validation; use local retrieval tools.",
    CODEBASE_RETRIEVAL_MANDATORY_RULE: augmentContextEngine
      ? `Mandatory use of \`${augmentContextEngineRetrievalTool}\``
      : "Mandatory use of configured codebase retrieval policy.",
    CODEBASE_RETRIEVAL_STRUCTURE_REFERENCE: augmentContextEngine
      ? `Inspect codebase structure: \`${augmentContextEngineRetrievalTool}\` with \`file list --recursive\`.`
      : "Inspect codebase structure with `rg --files`, `git grep`, and direct file reads.",
    CODEBASE_RETRIEVAL_PATTERN_AUDIT: augmentContextEngine
      ? `Use augment-context-engine to validate against existing codebase patterns.\n   ${augmentContextEngineRetrievalTool}: "Search for existing implementations similar to the current requirement. Keywords: [key concepts from the requirement]"`
      : "Use `rg`, `rg --files`, `git grep`, and direct file reads to validate against existing codebase patterns."
  };
}

function renderWorkflowTemplate(content, { augmentContextEngine = false } = {}) {
  let nextContent = content;
  for (const [key, value] of Object.entries(getWorkflowRenderValues(augmentContextEngine))) {
    nextContent = nextContent.replaceAll(`{{${key}}}`, value);
  }
  if (nextContent.includes("{{") || nextContent.includes("}}")) {
    throw new Error("工作流模板包含未解析占位符");
  }
  return nextContent;
}

export {
  getWorkflowRenderValues,
  renderWorkflowTemplate,
  resolveAugmentContextEngineFeature
};
