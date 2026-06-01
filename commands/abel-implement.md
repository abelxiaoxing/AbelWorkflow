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

**Guardrails**

- Keep changes tightly scoped to the requested outcome; enforce side-effect review before applying any modification.
- Minimize documentation—avoid unnecessary comments; prefer self-explanatory code.
- Refer to `openspec/AGENTS.md` (located inside the `openspec/` directory—run `ls openspec` or `openspec update` if you don't see it) for additional OpenSpec conventions or clarifications.

**TDD Guardrails (mandatory)**
- **Red Phase**: Generate failing tests ONLY; implementation code is FORBIDDEN.
- **Green Phase**: Write MINIMAL code to pass tests; over-engineering is FORBIDDEN.
- **Refactor Phase**: Optimize code quality while keeping ALL tests passing.
- **Mandatory**: Run tests after EVERY code change; never skip verification.
- **Test-First**: Each task MUST have a failing test before implementation begins.

**Skill Integration**: See `Stage Skill Matrix` (Implement column)

**Tool Routing**:
- **TDD Cycle**: Autonomous refactoring
- **Final Review** (after all tasks):
  - Backend refactor (subagents)
  - Frontend refactor (subagents)
- **E2E tasks** → `/dev-browser`

1. Run `openspec view` to inspect current project status and review `Active Changes`; ask the user to confirm which change folder (`<change_name>`) they want to implement.
2. Check artifact status: `openspec status --change <change_name>`
3. Get apply instructions: `openspec instructions apply --change <change_name>`
4. Detect test framework: identify project's testing setup (pytest/jest/vitest/etc.)
5. Work through tasks sequentially; for each task, execute the **TDD Cycle** below.

**TDD Cycle (per task)**

```
┌─────────────────────────────────────────────────────────┐
│ Step 0: Pre-Check                                       │
│   └─ /confidence-check → require ≥90% to proceed        │
├─────────────────────────────────────────────────────────┤
│ Step 1: 🔴 Red Phase - Generate Failing Test            │
│   ├─ Analyze task → determine test type                 │
│   │   ├─ Backend → pytest/jest                          │
│   │   ├─ Frontend → vitest/jest                         │
│   │   └─ E2E → dev-browser                              │
│   ├─ Generate test via                                  │
│   │   PROMPT: "Generate failing test for: {task}        │
│   │            Context: {code_context}                  │
│   │            Output: unified diff patch               │
│   │            FORBIDDEN: implementation code"          │
│   ├─ Apply test code (after review)                     │
│   ├─ Run test → MUST FAIL                               │
│   └─ If passes → test invalid, regenerate               │
├─────────────────────────────────────────────────────────┤
│ Step 2: 🟢 Green Phase - Minimal Implementation         │
│   ├─ Generate minimal implementation                    │
│   │   PROMPT: "Generate minimal code to pass test:      │
│   │            Test: {test_code}                        │
│   │            Context: {code_context}                  │
│   │            Output: unified diff patch               │
│   │            FORBIDDEN: over-engineering"             │
│   ├─ Apply implementation (after review & rewrite)      │
│   ├─ Run test → MUST PASS                               │
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
│   ├─ Run test → MUST STILL PASS                         │
│   └─ If fails → rollback refactoring                    │
└─────────────────────────────────────────────────────────┘
```

6. Before applying any change, perform mandatory side-effect review.

7. After TDD cycle completes for a task, mark as `- [x]` in `tasks.md`.

**Final Review & Refactor** (after all tasks complete)

8. Run all tests to ensure everything passes.

9. Execute global code review via subagents:

10. Wait for background tasks to complete; review diff patches.
11. Rewrite patches into production-grade code (per rewriting principle).
12. Apply refactoring changes.
13. Run all tests → MUST ALL PASS.
14. If any test fails → analyze root cause, fix or rollback.
15. Perform final side-effect review.
16. Run `openspec archive <change_name>` or `/opsx:archive`.

**TDD Output Format**

```
## /oc:implementation (TDD Mode)

### Task 1/N: {task_description}

📋 Confidence Check: {score}% {status}

🔴 Red Phase
├─ Generated: tests/{test_file}
├─ Run: {test_command}
└─ Result: {count} failed ✓ (expected)

🟢 Green Phase
├─ Generated: src/{impl_file}
├─ Run: {test_command}
└─ Result: {count} passed ✓

🔵 Refactor Phase (Agent autonomous)
├─ Optimized: {description}
├─ Run: {test_command}
└─ Result: {count} passed ✓

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
├─ Tests: {count} passed ✓
└─ Ready for archive

✓ Implementation complete
```
<!-- ABEL:END -->
