---
name: abel-diagnose
description: Parallel diagnosis with batch fix reporting via systematic root cause analysis.
category: abel
tags: [abel, diagnosis, bugfix]
argument-hint: <problem-description>
---
<!-- ABEL:START -->
**Arguments**
- Required: `<problem-description>` (one or more bug descriptions; comma-separated supported)

**Guardrails**
- Root cause first; never fix symptoms only
- Verify root cause hypothesis with evidence before fix
- Only fixes with evidence-verified root cause may be applied
- Every fix must include a regression test
- Keep changes minimal and scoped
- If verification fails, rollback and iterate

**Execution Model** 
- Run detection and root-cause analysis for all issues in parallel
- Infer scope automatically from problem text, traces, and retrieved code context
- Build dependency/conflict order before any fix application
- Same file: force sequential fix order; same symbol: merge when compatible, otherwise sequential
- Independent scopes: parallel-safe
- Fix generation for READY issues runs fully in parallel via subagents with forked/minimal context; main agent only aggregates and resolves conflicts
- Patch application and final verification must run strictly sequential by dependency order
- Always output one consolidated batch report

**Skill Integration**: See `Stage Skill Matrix` (Diagnose column)

**Steps**
1. Parse input, infer scope, and split into issue list (single or multiple).
2. For each issue in parallel: collect logs/traces and locate code via the configured codebase retrieval policy.
3. For each issue in parallel: perform root cause analysis; for multi-component chains, decompose the failure chain step by step with evidence.
4. Build dependency/conflict graph across issues and compute safe fix order.
5. Verify each issue's root cause against collected evidence; only issues with a verified root cause can move to fix generation.
6. Spawn one subagent per READY issue to generate `unified diff patch` and regression test with minimal scoped context.
7. Main agent reviews/merges subagent outputs by dependency order and outputs one batch report with all issue statuses and patches.
8. Apply merged patches strictly sequentially by dependency order.
9. Run final verification strictly sequentially by the same dependency order and output verification matrix.

**Batch Output**
```text
## /abel-diagnose Batch Report

### Batch Summary
Total: {n} | ReadyToFix: {n_ready} | Blocked: {n_blocked}

### Issue Results
- [{id}] Classification: {category}/{severity} | Root Cause: {summary} | Verified: {yes|no} | Subagent: {agent_id|none} | Status: {READY|BLOCKED}

### Patch Queue (dependency order)
1. [{id}] [subagent:{agent_id}] {file_list}
{unified_diff_patch}

### Verification Matrix
- [{id}] Regression: {passed|failed} | Affected Suite: {passed|failed}

### Final Status
{FIXED|PARTIAL|NEEDS_REVIEW|BLOCKED}
```
<!-- ABEL:END -->
