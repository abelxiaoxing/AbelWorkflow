---
name: abel-implement
description: Implement approved changes with mandatory TDD.
category: abel
tags: [abel, implementation, TDD]
argument-hint: [change_name]
---

<!-- ABEL:START -->
**Arguments**
- Requested: `<change_name>`

**Guardrails**

- Keep changes tightly scoped to the requested outcome; enforce side-effect review before applying any modification.
- Minimize documentation—avoid unnecessary comments; prefer self-explanatory code.
- Refer to `openspec/AGENTS.md` (located inside the `openspec/` directory—run `ls openspec` or `openspec update` if you don't see it) for additional OpenSpec conventions or clarifications.

**TDD Guardrails (mandatory)**
- **Red Phase**: Create or execute the task's failing executable verification ONLY; implementation code is FORBIDDEN.
- **Green Phase**: Write MINIMAL code to satisfy the verification; over-engineering is FORBIDDEN.
- **Refactor Phase**: Optimize code quality while keeping target and affected verification green and introducing no new full-suite failures.
- **Mandatory**: Run the task's executable verification after EVERY code change; never skip verification.
- **Test-First**: Each task MUST have a failing executable verification before implementation begins.

**Skill Integration**: See `Stage Skill Matrix` (Implement column)

**Readiness Preflight (before any code or test write)**

1. Explicit argument takes precedence. Resolve it directly; ask only when the argument is missing or cannot be resolved uniquely. Never require unconditional `openspec view` confirmation.
2. Run `openspec status --change <change-name> --json`; read `schemaName`, `changeRoot`, `artifactPaths`, `applyRequires`, and `artifacts`.
3. Run `openspec schema which <schemaName> --json`, read the resolved `schema.yaml`, and extract `apply.tracks`. Resolve `apply.tracks` relative to `changeRoot`; it must name one concrete existing regular file inside `changeRoot`. Missing, null, non-concrete, or escaping paths fail closed; do not infer the tracking path from apply-instruction `contextFiles` or `tasks`.
4. Every artifact id in `applyRequires` must have status `done`; array presence or a general completion flag is insufficient.
5. Run `openspec validate <change-name> --strict --type change`; require zero issues.
6. Read every planning artifact reported by `artifactPaths`, then run `openspec instructions apply --change <change-name> --json` and follow the returned apply contract.
7. Verify stable Requirement and Scenario references, the Requirement → Scenario → Verification → Task chain, and every task verification contract. Rebuild the Gate A and Gate B summaries; if approval cannot be proven in the current conversation, show the summaries and require explicit user confirmation.
8. Run and record affected baseline tests and the full test suite before any write. Record each command, exit status, and normalized failure identities/reasons. Keep existing failures from the full suite separate from the target Red; an existing failure never counts as Red.
9. If any preflight item fails, STOP and return `/abel-design --change <change-name>`. Do not invent or repair product, behavior, or architecture decisions here.

**Tool Routing**:
- **TDD Cycle**: Autonomous refactoring
- **Final Review** (after all tasks):
  - Backend refactor (subagents)
  - Frontend refactor (subagents)
- **E2E tasks** → `/dev-browser`

After preflight, detect the project's verification tooling and work through the tracked tasks sequentially.

**TDD Cycle (per task)**

Consume these ordinary indented bullets from the task verification contract, never Markdown checkboxes:
- verification type: property | example | E2E | static
- Red command and expected failure reason
- Green expected behavior
- affected-suite command
- target scope/files

- Red must fail because of the target defect described by the contract.
- If the failure reason differs or the command is invalid, STOP and return `/abel-design --change <change-name>`; do not improvise a replacement contract.
- A non-behavior-change task starts with its specified failing executable static verification.
- A manual-only task is not implementation-ready; STOP and return `/abel-design --change <change-name>`.

```
┌─────────────────────────────────────────────────────────┐
│ Step 1: 🔴 Red Phase - Execute Contract Verification    │
│   ├─ Use the contract's verification type and scope     │
│   ├─ Generate the required failing verification via     │
│   │   PROMPT: "Generate failing verification for: {task}│
│   │            Context: {code_context}                  │
│   │            Output: unified diff patch               │
│   │            FORBIDDEN: implementation code"          │
│   ├─ Apply verification code (after review)             │
│   ├─ Run Red command → MUST FAIL for expected reason    │
│   └─ If it passes or fails differently → STOP           │
├─────────────────────────────────────────────────────────┤
│ Step 2: 🟢 Green Phase - Minimal Implementation         │
│   ├─ Generate minimal implementation                    │
│   │   PROMPT: "Generate minimal code for verification:  │
│   │            Verification: {verification_context}     │
│   │            Context: {code_context}                  │
│   │            Output: unified diff patch               │
│   │            FORBIDDEN: over-engineering"             │
│   ├─ Apply implementation (after review & rewrite)      │
│   ├─ Run Red command → MUST PASS                        │
│   └─ If fails → analyze error, fix, retry               │
├─────────────────────────────────────────────────────────┤
│ Step 3: 🔵 Refactor Phase                               │
│   ├─ Analyzes code quality                              │
│   ├─ Apply standard refactoring techniques:             │
│   │   ├─ Eliminate code duplication                     │
│   │   ├─ Improve naming and structure                   │
│   │   ├─ Enhance readability                            │
│   │   └─ Simplify logic where possible                  │
│   ├─ Apply refactoring changes                          │
│   ├─ Run affected-suite command → MUST STILL PASS       │
│   └─ If fails → rollback refactoring                    │
└─────────────────────────────────────────────────────────┘
```

Before applying any change, perform mandatory side-effect review.

After a task's TDD cycle completes, locate the task ID's checkbox in the concrete tracking file resolved from schema `apply.tracks`; require exactly one match and update only it. Zero or multiple matches must STOP and return `/abel-design --change <change-name>`. Never hardcode an artifact filename or infer the tracking path from apply instructions.

**Final Review & Refactor** (after all tasks complete)

1. Require all target tests to be green, then run the affected suites.
2. Re-run the same full-suite command (the full test suite), compare normalized failure identities with the recorded full-suite baseline, and require no new failures.

3. Execute global code review via subagents:

4. Wait for background tasks to complete; review diff patches.
5. Rewrite patches into production-grade code (per rewriting principle).
6. Apply refactoring changes.
7. Re-run target, affected, and full-suite verification against the baseline.
8. If a target test fails or the full suite has a new failure, analyze the root cause and fix or roll back.
9. Perform final side-effect review.
10. Report that the change is ready for archive; do not archive until the user explicitly authorizes `/opsx:archive`.

**TDD Output Format**

```
## /abel-implement (TDD Mode)

### Task 1/N: {task_description}

🔴 Red Phase
├─ Type: {verification_type}
├─ Generated: {verification_files_or_none}
├─ Run: {red_command}
└─ Result: failed for {expected_failure_reason} ✓

🟢 Green Phase
├─ Generated: {implementation_files}
├─ Run: {red_command}
└─ Result: {green_expected_behavior} ✓

🔵 Refactor Phase (Agent autonomous)
├─ Optimized: {description}
├─ Run: {affected_suite_command}
└─ Result: target verification green ✓

✓ Task complete → Next task

---

### All Tasks Complete

🔍 Final Review & Refactor

Backend Review
├─ Files: {backend_files}
├─ Status: Running in background...
└─ Task ID: {task_id}

Frontend Review
├─ Files: {frontend_files}
├─ Status: Running in background...
└─ Task ID: {task_id}

[Waiting for completion...]

✓ Reviews complete
├─ Applied: {refactoring_summary}
├─ Target tests: green ✓
├─ Full suite: no failures beyond baseline ✓
└─ Ready for user-authorized archive

✓ Implementation complete
```
<!-- ABEL:END -->
