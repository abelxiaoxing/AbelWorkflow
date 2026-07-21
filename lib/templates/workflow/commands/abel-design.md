---
name: abel-design
description: Transform requirements into implementation-ready, traceable specs via gated clarification.
category: abel
tags: [abel, design, constraints, PBT, subagents]
argument-hint: [requirement | --change <change_name>]
---

<!-- ABEL:START -->

# abel-design — Gated Design Mode (Specs Only, No Implementation)

## Non-Negotiable Rules (Highest Priority)
1. DESIGN MODE ONLY — you MUST NOT generate implementation code.
2. WRITE SCOPE:
   - Before Gate A: strictly read-only; persist nothing.
   - After Gate A: write ONLY inside the resolved `changeRoot`. Create only ready artifacts; edit a done artifact only when an approved loop-back/consistency repair explicitly targets it.
3. NEVER assume or guess — every blocking decision goes to the user (see Decision Model).
4. Final output: a schema-valid, fully traceable OpenSpec change with BLOCKING_DECISIONS = 0, READY_TO_IMPLEMENT.

**Skill Integration**: See `Stage Skill Matrix` (Design column)

---

## Decision Model
- Maintain an in-session Decision Ledger with: `id`, `class`, `question`, `evidence`, `options`, `recommendation`, `resolution`, `status`, `affected_artifacts`.
- `BLOCKING_DECISIONS` is the count of unresolved, non-mechanical decisions in that ledger.
- Behavior decisions answer WHAT: observable outcomes, scope/non-goals, scenarios, failure behavior, data/security/privacy/compatibility policies and success criteria.
- Technical decisions answer HOW: interfaces, data flow, dependencies, storage/algorithms, implementation error mechanisms and key technical parameters.
- MUST be approved by the user: goal, scope, non-goals and observable success behavior; data, security, privacy, compatibility and migration rules; new dependencies, cross-module architecture, irreversible changes; any technical choice with substantive trade-offs, including key parameters.
- MAY be decided mechanically by the agent: naming, file locations and local structure uniquely determined by existing repo conventions; easily reversible details with no external behavior change; test placement and execution order derived directly from the approved design.
- Record mechanical decisions and never re-ask them. Two or more viable options with substantive differences → escalate to a blocking decision.
- Do NOT create a runtime ledger or approval-state file. Materialize approved decisions only in schema artifacts.

## Phase 0 — Entry, Mode & Readiness (read-only)
- Verify an initialized OpenSpec root and the required CLI capabilities: `new change`, `list --json`, `schemas --json`, `schema which --json`, `schema validate --json`, `templates --json`, `status --json`, `instructions --json`, and `validate --strict`. If unavailable, STOP with actionable `/abel-init` remediation; do not initialize or update from this command.
- Resolve mode:
  - Explicit `--change <name>` → Resume. If that change does not exist, STOP and ask the user to correct the name or choose New mode.
  - Otherwise, an exact existing-change match → Resume.
  - Otherwise → New mode; do not silently interpret an explicit/resume-like typo as a requirement.
- Resolve the effective schema by precedence: explicit schema choice, existing change metadata, project config, then `spec-driven`; verify it appears in `openspec schemas --json`.
- Before creating a change, run `openspec schema which <schema> --json` and `openspec schema validate <schema> --json`, inspect its definition and `openspec templates --schema <schema> --json`, and perform a preliminary behavior/technical/mixed dependency check. Implementation compatibility also requires a non-empty concrete `apply.tracks` that matches exactly one artifact's `generates`. An incompatible schema must fail closed before creation.
- New mode minimum intake before ANY exploration:
  - Problem/goal statement, AND
  - Scope anchor (which module/directory is involved).
- If either intake item is missing, ask the user concisely before proceeding.
- Generate a provisional kebab-case change name and check `openspec list --changes --json`. Recompute and confirm it from the final Gate A scope before creation. Persist nothing yet.

## Phase 1 — Evidence Exploration (read-only)
- {{CODEBASE_RETRIEVAL_POLICY}}
- Single context boundary → main agent explores directly.
- Multiple independent context boundaries, when the platform permits → dispatch parallel Explore subagents:
  - Divide by context boundary (NOT functional role); each boundary self-contained.
  - Each subagent receives: {{CODEBASE_RETRIEVAL_MANDATORY_RULE}}, a clear scope, and the mandatory JSON output schema:
{
  "module_name": "所探索的上下文边界",
  "existing_structures": ["关键结构/模式"],
  "existing_conventions": ["约定/标准"],
  "constraints_discovered": ["硬约束"],
  "open_questions": ["需用户输入的歧义"],
  "dependencies": ["跨模块依赖"],
  "risks": ["风险/阻碍"],
  "success_criteria_hints": ["可观察的成功行为"]
}
- Validate every subagent JSON before aggregation; aggregate constraints, dependencies, risks, conflicts and questions into the Decision Ledger.
- Audit existing codebase patterns:
  {{CODEBASE_RETRIEVAL_PATTERN_AUDIT}}
- On-demand /context7-auto-research: verify candidate libraries/APIs against official contracts.
- On-demand /grok-search: architectural patterns and best practices for candidate directions.
- PBT boundary screening: probe empty input, idempotency, ordering, size/value bounds, state-transition legality → feed the question list for Phase 2.
- Reference: {{CODEBASE_RETRIEVAL_STRUCTURE_REFERENCE}}

## Phase 2 — Behavior Clarification Loop (multiple rounds allowed)
- Cover WHAT only: goal, scope, non-goals, observable scenarios/success criteria, failure behavior, and data/security/privacy/compatibility policies.
- Do not choose libraries, protocols, algorithms, storage, topology or implementation parameters in this phase; route them to Phase 4.
- Each round asks ONLY the current highest-impact blocking questions, grouped concisely, each with evidence, impact and a recommended default.
- Anti-patterns (flag and reject):
  - Observable behavior deferred to implementation ("error behavior decided while coding")
  - Technical mechanisms smuggled in as product requirements
- Target behavior patterns:
  - "Lock the account for 30 minutes after 5 consecutive failed logins."
  - "Retain audit records for 30 days and never expose secrets in responses."
  - "For an empty query, return an empty result within the approved latency bound."
- An answer that widens modules, scenarios or data boundaries → return to Phase 1 for INCREMENTAL exploration only.
- Loop until unresolved behavior decisions = 0.

## ⛔ Gate A — Approve Behavior Contract
- Present the behavior contract and affected Decision Ledger entries; the user explicitly approves goal, scope/non-goals, scenarios/success criteria and policies.
- Recompute the change name from the approved scope and recheck duplicates.
- New mode: ONLY NOW create the change with `openspec new change <change-name>` (add `--schema <schema>` only for an explicit non-default choice).
- Build the Artifact Plan, then materialize only behavior-class artifacts that are safe and ready.

## Artifact Plan & Write Protocol
- Before New-mode creation, build a preliminary compatibility map from the resolved schema definition/templates. After creation or in Resume mode, build the final Artifact Plan from `status --json` and available `instructions --json`. Record the schema's `apply.tracks`; for every artifact record capture id/output paths, dependencies/status, substantive decision class (`behavior|technical|mixed`), write Gate, and affected decisions. Mechanical impact information alone does not make an artifact mixed.
- Classify by the decisions the artifact carries, never by a hardcoded artifact name:
  - behavior → Gate A
  - technical or mixed → Gate B
  - behavior depending on a Gate B artifact → defer until after Gate B and then follow the DAG
- If the schema requires a write before Gate A, a write outside `changeRoot`, or an unapproved technical decision to unlock behavior, STOP before New-mode creation and ask the user to select a compatible schema/mapping. Schema order never overrides decision approval.
- Mandatory loop for EVERY artifact write:
  1. Run `openspec status --change <change-name> --json`; verify `schemaName`, `changeRoot`, `artifactPaths`, status/dependencies and `applyRequires`. `existingOutputPaths` may be empty and is not a new-file target.
  2. Run `openspec instructions <artifact-id> --change <change-name> --json`; follow its template/rules/dependencies.
  3. Read dependencies and existing outputs; check consistency in both directions.
  4. Prepare content in memory and show the decision summary or unified diff before the corresponding Gate. If materialization reveals a new substantive decision, return to the relevant loop and re-approve it.
  5. After Gate approval, create exactly one ready artifact, or edit one done artifact explicitly targeted by an approved loop-back/consistency repair. Rerun status after every write and process newly unlocked artifacts topologically.

## Phase 3 — Technical Derivation
- Derive the technical design from the Gate A contract, existing codebase patterns and official API contracts.
- Mechanical decisions → record directly in the design. Substantive trade-offs → Phase 4.

## Phase 4 — Technical Decision & Verification Loop
- Cover HOW: interfaces, data flow, implementation error mechanisms, dependencies/algorithms and key parameters. Examples include JWT vs session design and an approved bcrypt cost factor.
- Apply the same evidence/options/recommendation format to every substantive technical decision; update the Decision Ledger.
- PBT applicability rule (screen with the six categories: commutativity/associativity, idempotency, round-trip, invariant preservation, monotonicity, bounds):
  - Behavior with invariants, round-trips, idempotency, ordering, bounds or state transitions → MUST extract a property + falsification strategy.
  - Behavior unsuited to PBT → use example/E2E/static verification and record why PBT does not apply. Do NOT force every requirement through every category.
- Give every scenario a stable reference: `<spec-path>#<requirement-heading>/<scenario-heading>` and require those headings to be unique within the spec; maintain Requirement → Scenario → Verification → Task.
- Every task has exactly one schema checkbox and a verification contract using ordinary indented bullets, NEVER nested `- [ ]`/`- [x]` lines:
  - Task ID / dependencies
  - Requirement + stable Scenario reference
  - Verification type: property | example | E2E | static
  - Red command + expected failure reason
  - Green expected behavior
  - Affected-suite verification command
  - Target scope/files
- For a non-behavior-change task, the Red command is a pre-change executable static verification. Manual-only verification is not implementation-ready and MUST NOT pass Gate B or Exit; reshape the task until it has executable property/example/E2E/static verification.
- Loop until unresolved technical decisions = 0; prepare proposed remaining artifact contents/unified diffs in memory.

## ⛔ Gate B — Approve Implementation Contract
- Verify Phase 3/4 faithfully expand the Gate A contract; no unapproved new decisions introduced.
- Present substantive technical decisions, task/verification mapping and artifact materialization preview.
- The user explicitly approves that implementation contract.
- Write the remaining ready artifacts one at a time per the Artifact Plan & Write Protocol.

## Loop-Back Rules
- A user answer widens modules, scenarios or data boundaries → return to Phase 1.
- Technical analysis overturns the behavior contract → return to Phase 2; re-approve ONLY the affected decisions and synchronize all affected artifacts.
- Gate B finds the materialization unfaithful → return to Phase 3/4; unaffected Gate A decisions remain approved.
- Strict validation, verification-contract or traceability failure → return to the earliest phase that introduced the inconsistency.
- Never hide a late-discovered blocking question.

## Resume Rules
- Never infer user approval from artifact existence: `status` reporting `done` proves file completion only, not Gate approval.
- Never resume by fixed file names or file existence alone; the active schema decides.
- Algorithm:
  1. Run `openspec status --change <change-name> --json`.
  2. Use its `schemaName`, `changeRoot`, `artifactPaths` and statuses; read all `existingOutputPaths` and dependencies.
  3. Check `openspec validate <change-name> --strict --type change`, template completeness, cross-artifact consistency, traceability and verification contracts.
  4. Rebuild Gate A/B summaries and the Artifact Plan. Re-confirm every Gate approval that cannot be proven in the current conversation.
  5. Choose the next step:
     - Explicit Resume change not found (`change_error`) → STOP for spelling/New-mode confirmation; never create silently.
     - Artifacts incomplete → repair/confirm the nearest safe Gate, then handle the artifacts the schema reports ready.
     - Artifacts complete but validation/traceability fails → earliest inconsistent phase.
     - Every artifact id listed in `applyRequires` is `done` → re-confirm any unproven Gate, then run the Exit audit.
     - Only in-session, un-persisted analysis exists → no mid-loop resume; re-run the read-only analysis.
- Do NOT create runtime approval-state files; re-confirming the Gate summary IS the resume mechanism.

## Exit Criteria
- [ ] `openspec validate <change-name> --strict --type change` returns zero issues
- [ ] Every artifact id in `applyRequires` has status `done`
- [ ] Schema `apply.tracks` resolves to the generated task artifact inside `changeRoot`
- [ ] Artifacts are consistent and traceable; every task has a valid verification contract
- [ ] Every task has executable property/example/E2E/static verification; no task is manual-only
- [ ] BLOCKING_DECISIONS = 0
- [ ] User has explicitly approved the reconstructed/current Gate A and Gate B summaries in this conversation
- [ ] Status: READY_TO_IMPLEMENT

## Reference
- `openspec context --json` / `openspec schemas --json`
- `openspec view` / `openspec list --changes --json` / `openspec list --specs` (conflicts with existing specs)
- `openspec status --change <change-name> --json` / `openspec instructions <artifact-id> --change <change-name> --json`
- `openspec new change <change-name>` (Gate A only)
- `openspec show <change-name> --json --deltas-only` when validation fails
- `rg -n "Constraint:|MUST|MUST NOT|INVARIANT:|PROPERTY:" openspec/` before defining new ones
<!-- ABEL:END -->
