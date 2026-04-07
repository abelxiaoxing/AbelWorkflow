---
name: prompt-enhancer
description: |
  Rewrite a raw prompt into a clearer prompt for a coding agent. Use only when the user explicitly asks to improve, optimize, rewrite, or structure a prompt for Codex, Claude Code, Gemini CLI, or another AI agent. Triggers: "improve this prompt", "rewrite this prompt", "optimize this prompt for Codex", "make this prompt better for an AI agent".
allowed-tools: Bash(python:*), Bash(python3:*), Bash(uv:*), Read, Grep
---

# Prompt Enhancer

Rewrite raw prompts into concise, structured prompts for coding agents.

## Use When

- The input itself is a prompt or instruction for an AI agent.
- The user explicitly asks to improve, optimize, or rewrite that prompt.
- The target is a coding agent such as Codex, Claude Code, or Gemini CLI.

Do not use this for general writing edits like email, docs, or PR copy.

## Do

```bash
python "<SKILL_DIR>/scripts/prompt_enhancer_entry.py" "user's raw prompt here"
```

- Do not call `scripts/enhance.py` directly.
- Use the installed skill directory for `<SKILL_DIR>`.
- Optional setup: `cp "<SKILL_DIR>/.env.example" "<SKILL_DIR>/.env"`

## Output

- Read the enhanced prompt from `stdout`.
- Keep `stderr` for usage or optional debug output only.
- Preserve the user's intent and explicit constraints.
- Add structure and missing execution context only when it helps the agent act.
- When falling back to the local template, use placeholders for unknown context instead of inventing new requirements.

## Notes

- Local config file: `<SKILL_DIR>/.env`
- The entrypoint auto-loads `<SKILL_DIR>/.env` before bootstrap and dependency install.
- Optional debug flag: `PE_DEBUG=1`
- Bootstrap controls: `PROMPT_ENHANCER_VENV_DIR`, `PROMPT_ENHANCER_PYTHON`, `AGENTS_SKILLS_PYTHON`
- Setup and troubleshooting: [ADVANCED.md](ADVANCED.md)
- Prompt template reference: [TEMPLATE.md](TEMPLATE.md)
