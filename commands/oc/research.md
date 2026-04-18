---
name: OC:Research
description: Transform user requirements into constraint sets via structured exploration (NO implementation)
category: OC
tags: [OC, research, constraints, exploration, subagents]
---

<!-- OC:RESEARCH:START -->

# OC:Research — Operating Mode (Constraints & Specs Only)

## Non‑Negotiable Rules (Highest Priority)
1. RESEARCH MODE ONLY.
   - You MUST NOT generate code.
2. WRITE SCOPE IS RESTRICTED.
   - You MAY create/edit files ONLY under: openspec/changes/<change-name>/** (and only after passing the confirmation gates).
   - You MUST NOT write anywhere else.
3. Output must be constraint sets + verifiable success criteria, not an information dump.

## Goal
Produce constraint sets that narrow the solution space, plus measurable success criteria.

---



## Phase 0 — Requirement Intake Gate (MANDATORY)
- **MUST** confirm the user’s requirement exists and is clear **before** any research/action.
- If missing/unclear, **MUST** ask the user directly in a concise grouped message to collect: goal, in-scope area, top scenarios, non-goals, known constraints, success signals.
- **MUST NOT** run `/opsx:new`, any codebase retrieval, spawn subagents, or generate artifacts until the user confirms a brief requirement summary.

---

## Phase 1 — Initialize OpenSpec Change Folder
1) Run: /opsx:new <change-name>
2) From now on, you may write ONLY under openspec/changes/<change-name>/**.

---

## Phase 2 — Initial Codebase Assessment (Read‑Only)
- Use `mcp__augment-context-engine__codebase-retrieval` as the primary way to locate relevant code; avoid grep/find unless unavoidable.
- If technical research needed (architectural patterns, best practices), invoke `/grok-search` skill
- If the codebase spans multiple modules/directories, dispatch parallel explore subagents by context boundary.

---

## Phase 3 — Define Exploration Boundaries (Context-Based Division Only)
- Identify natural context boundaries in the codebase (NOT functional roles).
- Example divisions:
  * Subagent 1: User domain code (user models, user services, user UI)
  * Subagent 2: Authentication & authorization code (auth middleware, session, tokens)
  * Subagent 3: Configuration & infrastructure (configs, deployments, build scripts)
- Each boundary should be self-contained: no cross-communication needed between subagents.
- Define exploration scope and expected output for each subagent.

---

## Phase 4 — Subagent Output Template (MANDATORY JSON)
All explore subagents MUST return valid JSON using this schema:
{
  "module_name": "字符串 - 所探索的上下文边界",
  "existing_structures": ["发现的关键结构/模式列表"],
  "existing_conventions": ["当前使用的约定/标准列表"],
  "constraints_discovered": ["限制解决方案空间的硬约束列表"],
  "open_questions": ["需要用户输入的歧义问题列表"],
  "dependencies": ["对其他模块/系统的依赖列表"],
  "risks": ["潜在风险或阻碍列表"],
  "success_criteria_hints": ["指示成功的可观察行为列表"]
}

---

## Phase 5 — Parallel Subagent Dispatch
- Monitor subagent execution and collect structured reports.
- For each boundary, spawn an Explore subagent with:
  - Mandatory use of `mcp__augment-context-engine__codebase-retrieval`
  - Clear scope
  - self-contained with independent output
  - Required output template (from Phase 4)
  - If boundary involves 3+ interconnected components, invoke `/sequential-think` skill
  - Clear success criteria: complete analysis of assigned boundary


---

## Phase 6 — Aggregate & Synthesize
- Collect all subagent JSON outputs.
- Merge findings into unified constraint sets:
  * **Hard constraints**: Technical limitations, existing patterns that cannot be violated.
  * **Soft constraints**: Conventions, preferences, style guides.
  * **Dependencies**: Cross-module relationships that affect implementation order.
  * **Risks**: Potential blockers that need mitigation.
- Identify **open questions** from all reports that require user clarification.
- Synthesize **success criteria** from scenario hints across all contexts.

---

## Phase 7 — User Interaction for Ambiguity Resolution
- Compile prioritized list of open questions from aggregated reports.
- Present questions directly to the user in a concise grouped message:
  * Group related questions together.
  * Provide context for each question.
  * Suggest default answers when applicable.
- Capture user responses as additional constraints.
- Update constraint sets with confirmed decisions.

---

## Phase 8 — Generate OpenSpec Artifacts
- Transform finalized constraint sets into OpenSpec proposal/specs/design/tasks.
- Every requirement MUST have a verifiable scenario and success criteria.
- Keep all writes inside openspec/changes/<change-name>/**.

## Reference
- Review existing constraints: `rg -n "Constraint:|MUST|MUST NOT" openspec/specs`
- Inspect codebase structure: `ls -R` or `mcp__augment-context-engine__codebase-retrieval` with `file list --recursive`

- Check prior research outputs: `ls openspec/changes/*/`
- OpenSpec CLI commands:
  - `openspec view` - Interactive dashboard to browse changes
  - `openspec list --changes` - List all active changes
  - `openspec status --change <name>` - Check artifact completion status
  - `openspec instructions proposal --change <name>` - Get proposal instructions
- Validate subagent outputs conform to template before aggregation.
- Ask the user directly for ANY ambiguity—do not assume or guess.
<!-- OC:RESEARCH:END -->
