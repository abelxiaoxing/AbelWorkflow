---
name: OC:Plan
description: Refine approved change into a zero-decision executable plan.
category: OC
tags: [OC, plan, PBT]
argument-hint: [change_name]
---
<!-- OC:START -->
**Guardrails**
- Strictly adhere to **OpenSpec** rules when writing **standardized spec-structured projects**.
- The goal of this phase is to eliminate ALL decision points from the task flow—implementation should be pure mechanical execution.
- Do not proceed to implementation until every ambiguity is resolved and every constraint is explicitly documented.
- Every requirement must have Property-Based Testing (PBT) properties defined—focus on invariants, not just example-based tests.
- If constraints cannot be fully specified, escalate back to the user or return to the research phase rather than making assumptions.
- Refer to `openspec/AGENTS.md` for additional conventions; run `openspec update` if the file is missing.

**Skill Integration**: See `Stage Skill Matrix` (Plan column)

**FORBIDDEN**: Direct implementation code generation

**Steps**
1. Run `openspec view` to display all **Active Changes**, then confirm with the user which change folder (`<change_name>`) they wish to refine into a zero-decision plan.

2. Navigate to `openspec/changes/<change_name>/` and review existing artifacts:
   - Check `openspec status --change <change_name>` for artifact completion
   - Use `openspec instructions specs --change <change_name>` for specs guidance

3. **Implementation Analysis**: Invoke skills to perform systematic analysis to derive a plan:
   ```
   # First, invoke /sequential-think skill for systematic analysis if proposal has 3+ interconnected requirements

   /sequential-think: "Analyze change <change_name> systematically: Break down into components, identify dependencies, evaluate architectural trade-offs, and surface potential conflicts."
   
   # Then invoke /context7-auto-research skill to validate framework/library choices

   /context7-auto-research: "For each technology mentioned in change <change_name>, retrieve official documentation patterns and best practices."
   ```
   Produce a consolidated, constraint-complete plan and list any missing constraints as questions to the user.

4. **Uncertainty Elimination Audit**: Invoke skills to detect and eliminate remaining ambiguities:
   ```
   # First, use augment-context-engine to validate against existing codebase patterns
   mcp__augment-context-engine__codebase-retrieval: "Search for existing implementations similar to change <change_name>. Keywords: [key concepts from proposal]"
   # Then audit for ambiguities directly and list them explicitly
   Review change <change_name> for decision points that remain unspecified. For each: [AMBIGUITY] <description> → [REQUIRED CONSTRAINT] <what must be specified>.
   Identify implicit assumptions in change <change_name>. For each: [ASSUMPTION] <description> → [EXPLICIT CONSTRAINT NEEDED] <concrete specification>.
   ```
   
   **Anti-Pattern Detection** (flag and reject):
   - Information collection without decision boundaries (e.g., "JWT vs OAuth2 vs session—all viable")
   - Technical comparisons without selection criteria
   - Deferred decisions marked as "to be determined during implementation"
   
   **Target Pattern** (required for approval):
   - Explicit technology choices with parameters (e.g., "JWT with accessToken TTL=15min, refreshToken TTL=7days")
   - Concrete algorithm selections with configurations (e.g., "bcrypt with cost factor=12")
   - Precise behavioral rules (e.g., "Lock account for 30min after 5 failed login attempts")
   
   Iterate with user until ALL ambiguities are resolved into explicit constraints.

5. **PBT Property Extraction**: Invoke skills to derive testable invariants:
   ```
   "Extract Property-Based Testing properties from change <change_name>. For each requirement: [INVARIANT] <must always hold> → [FALSIFICATION STRATEGY] <how to generate counterexamples>."
   "Define system properties for change <change_name>: [PROPERTY] <name> | [DEFINITION] <formal description> | [BOUNDARY CONDITIONS] <edge cases> | [COUNTEREXAMPLE GENERATION] <approach>."
   ```
   
   **PBT Property Categories to Extract**:
   - **Commutativity/Associativity**: Order-independent operations
   - **Idempotency**: Repeated operations yield same result
   - **Round-trip**: Encode→Decode returns original
   - **Invariant Preservation**: State constraints maintained across operations
   - **Monotonicity**: Ordering guarantees (e.g., timestamps always increase)
   - **Bounds**: Value ranges, size limits, rate constraints

**Reference**
- Use `openspec show <change_name> --json --deltas-only` to inspect proposal structure when validation fails.
- Use `openspec list --specs` to check for conflicts with existing specifications.
- Search existing patterns with `rg -n "INVARIANT:|PROPERTY:|Constraint:" openspec/` before defining new ones.
- For complex proposals, consider running steps 2-4 iteratively on sub-components.
- Ask the user directly for ANY ambiguity—do not assume or guess.

**Exit Criteria**
A proposal is ready to exit the Plan phase only when:
- [ ] Zero ambiguities remain (verified by step 4 audit)
- [ ] All PBT properties documented with falsification strategies
- [ ] `openspec validate <change_name> --strict` returns zero issues
- [ ] User has explicitly approved all constraint decisions
<!-- OC:END -->
