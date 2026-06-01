# Configuration

## Language

- Tool/model interactions: **English**
- User-facing output: **Chinese**

## Code Style

- Concise, efficient, no redundancy
- Minimal comments/docs (only when necessary)
- Targeted changes only; never touch unrelated functionality

## Context Rules

- Use `mcp__augment-context-engine__codebase-retrieval` as the primary codebase search tool
- Rely only on project code plus `grok/context7` results
- If information is insufficient or uncertain, state it explicitly

## Workflow

```
/abel-init → /abel-research → /abel-plan → /abel-implement(TDD)
                                      ↘ /abel-diagnose (bug fix)
```

## Universal Constraints

1. Use `unified diff patch` format for proposed/applied changes
2. Require confidence ≥90% before applying changes

## Stage Skill Matrix

| Skill | Research | Plan | Implement | Diagnose | Capability & Triggers |
| --- | :---: | :---: | :---: | :---: | --- |
| /sequential-think | ✅ | ✅ | ❌ | ✅ | Multi-step reasoning, hypothesis testing. Trigger: 3+ interconnected components |
| /grok-search | ✅ | ○ | ❌ | ✅ | Deep research, concept understanding. Trigger: architectural patterns, best practices |
| /context7-auto-research | ✅ | ✅ | ✅ | ✅ | Official docs retrieval. Trigger: framework/library usage, APIs |
| /dev-browser | ○ | ○ | ✅ | ✅ | Browser automation. Trigger: E2E testing, UI verification |
| /confidence-check | ❌ | ✅ | ✅ | ✅ | Readiness verification. Trigger: before implementation/fix (≥90%) |
| /time | ○ | ✅ | ✅ | ○ | Time/timezone operations. Trigger: scheduling logic |

Legend: ✅ Primary, ○ Optional, ❌ Forbidden

OpenSpec commands: `/opsx:new` `/opsx:ff` `/opsx:archive` `openspec view` `openspec status`
