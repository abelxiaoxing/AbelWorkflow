---
name: context7-auto-research
version: 1.0.1
author: BenedictKing
description: Automatically fetches up-to-date documentation from Context7 when users ask about libraries, frameworks, APIs, or need code examples. Triggers proactively without explicit user request.
allowed-tools:
  - Bash
user-invocable: true
---

# Context7 Auto Research

Fetch current official documentation from Context7 when a user asks about a library, framework, package, or API.

## Trigger

Activate proactively when the request includes any of these:

- How to use, configure, install, migrate, or implement something in a named library/framework
- Documentation, reference, API, examples, or best practices for a library/framework
- Version-specific behavior such as `React 19`, `Next.js 15`, `Vue 3.5`
- Code generation that depends on framework or package APIs

Common cues:

- Chinese requests such as `如何实现` `怎么写` `配置` `安装` `文档` `参考` `示例`
- English requests such as `how to` `configure` `install` `docs` `reference` `example`
- Library mentions such as `React` `Next.js` `Vue` `Prisma` `Tailwind` `Express`
- Package or repository names from npm, PyPI, GitHub, or official docs sites

## Workflow

1. Run from this skill directory and use `./context7-api.cjs`.
2. Search with the full user query:

```bash
cd skills/context7-auto-research
node ./context7-api.cjs --help
node ./context7-api.cjs search '<library-name>' - <<'__C7_QUERY__'
<full user query>
__C7_QUERY__
```

3. Pick the best match in this order:
- Exact library name
- Official package over forks
- Version match when the user specified one
- Higher trust score

4. Fetch focused documentation:

```bash
node ./context7-api.cjs context '<library-id>' - <<'__C7_QUERY__'
<feature name or focused question>
__C7_QUERY__
```

5. Answer with the retrieved documentation:
- Prefer current behavior over memory
- Mention version when relevant
- Extract only the needed points
- Include concise code examples when useful
- If the CLI returns `ok: false`, treat the lookup as failed even if JSON was printed

## Fallback

- If search returns no useful match, ask for the exact package or repository name.
- If Context7 fails, say the lookup failed and label the answer as based on local knowledge.
- If multiple libraries are involved, fetch only the ones needed for the answer.

## Environment

- Preferred: `CONTEXT7_API_KEY` environment variable
- Also supported: `<skill-dir>/.env`
- CLI help: `node ./context7-api.cjs --help`

## Notes

- The helper accepts either inline query text or `-` to read the query from stdin.
- Use the full user question for search; use a narrower feature query for context when possible.
- The CLI prints structured JSON for `search` and `context`, including error cases.
- The CLI exits non-zero when the lookup or argument parsing fails.
- Requires network access and is subject to Context7 coverage and rate limits.
