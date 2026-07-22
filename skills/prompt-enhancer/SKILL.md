---
name: prompt-enhancer
description: |
  Rewrite a raw prompt into a clearer prompt for a coding agent. Use only when the user explicitly asks to improve, optimize, rewrite, or structure a prompt for Codex, Claude Code, Gemini CLI, or another AI agent. Triggers: "improve this prompt", "rewrite this prompt", "optimize this prompt for Codex", "make this prompt better for an AI agent".
---

# Prompt Enhancer

Rewrite raw prompts into concise, structured prompts for coding agents.

## Use When

- The input itself is a prompt or instruction for an AI agent.
- The user explicitly asks to improve, optimize, or rewrite that prompt.
- The target is a coding agent such as Codex, Claude Code, or Gemini CLI.

Do not use this for general writing edits like email, docs, or PR copy.

## Do

- Rewrite the prompt directly with the current agent, following the structure from [TEMPLATE.md](TEMPLATE.md).
- Preserve the user's intent and explicit constraints.
- Add structure and missing execution context only when it helps the agent act.
- Use placeholders for unknown context instead of inventing new requirements.
