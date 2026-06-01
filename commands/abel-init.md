---
name: abel-init
description: Initialize OpenSpec environment and validate required tooling.
category: abel
tags: [openspec, init, setup]
---

<!-- ABEL:START -->
**Guardrails**
- Complete steps in order; stop on failure
- Preserve existing config; do not overwrite without confirmation
- Provide actionable remediation when a step fails

**Steps**
1. Detect OS and adapt command style (Unix/PowerShell).
2. Verify `openspec` availability via `openspec --version`.
3. If missing, `npm install -g @fission-ai/openspec@latest`, then re-check version.
4. Run `openspec init` (or `openspec update` for existing projects).
5. {{AUGMENT_CONTEXT_ENGINE_VALIDATION}}
6. Verify required skills:
   - Skills: `/dev-browser` `/sequential-think` `/context7-auto-research` `/grok-search` `/confidence-check`
7. Output summary with ✓/✗:
   - OpenSpec installation
   - Project initialization
   - MCP availability if enabled
   - Required skills availability
<!-- ABEL:END -->
