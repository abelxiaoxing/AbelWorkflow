# Configuration

## Language

- Tool/model interactions: **English**
- User-facing output: **Chinese**

## Code Style

- Concise, efficient, no redundancy
- Minimal comments/docs (only when necessary)
- Targeted changes only; never touch unrelated functionality

## Development Context

Development context: work is currently in the development phase, and this is a development repository.
Do not retain runtime user state in the repository or shipped artifacts, and do not preserve compatibility layers for unreleased behavior.
Prefer deleting obsolete code paths; keep code and prompts concise and avoid over-engineering.
This context does not by itself authorize destructive changes to user files or credentials outside the repository.

## Context Rules

- {{CODEBASE_RETRIEVAL_POLICY}}
- Rely only on project code plus `grok/context7` results
- If information is insufficient or uncertain, state it explicitly

## Workflow

```
/abel-init → /abel-research → /abel-plan → /abel-implement(TDD)
                                      ↘ /abel-diagnose (bug fix)
```

## Universal Constraints

1. Use `unified diff patch` format for proposed/applied changes
2. Before applying changes, state assumptions and unknowns explicitly; stop and ask the user on any critical unknown

## Stage Skill Matrix

| Skill | Research | Plan | Implement | Diagnose | Capability & Triggers |
| --- | :---: | :---: | :---: | :---: | --- |
| /grok-search | ✅ | ○ | ❌ | ✅ | Deep research, concept understanding. Trigger: architectural patterns, best practices |
| /context7-auto-research | ✅ | ✅ | ✅ | ✅ | Official docs retrieval. Trigger: framework/library usage, APIs |
| /dev-browser | ○ | ○ | ✅ | ✅ | Browser automation. Trigger: E2E testing, UI verification |
| /time | ○ | ✅ | ✅ | ○ | Time/timezone operations. Trigger: scheduling logic |

Legend: ✅ Primary, ○ Optional, ❌ Forbidden

OpenSpec commands: `/opsx:new` `/opsx:ff` `/opsx:archive` `openspec view` `openspec status`
