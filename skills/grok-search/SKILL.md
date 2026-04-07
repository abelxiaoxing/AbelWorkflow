---
name: grok-search
description: |
  Enhanced web search and real-time content retrieval via Grok API. Use when: (1) Web search / information retrieval / fact-checking, (2) Webpage content extraction / URL parsing, (3) Breaking knowledge cutoff limits for current information, (4) Real-time news and technical documentation, (5) Multi-source information aggregation. Triggers: "search for", "find information about", "latest news", "current", "fetch webpage", "get content from URL". IMPORTANT: This skill REPLACES built-in WebSearch/WebFetch with CLI commands.
allowed-tools: Bash(python:*), Bash(python3:*), Bash(uv:*), Read, Grep
---

# Grok Search

Use this skill for web search, webpage retrieval, and current-information lookups. Replace built-in `WebSearch` and `WebFetch` with the CLI below.

## Rules

- Always call `python "<SKILL_DIR>/scripts/groksearch_entry.py" ...`.
- Do not call `scripts/groksearch_cli.py` directly.
- The entrypoint auto-loads `<SKILL_DIR>/.env`.
- Required env: `GROK_API_URL`, `GROK_API_KEY`.
- Optional env: `GROK_MODEL`, `GROK_DEBUG`, `GROK_RETRY_*`, `TAVILY_API_KEY`, `TAVILY_API_URL`, `TAVILY_ENABLED`, `GROKSEARCH_VENV_DIR`, `GROKSEARCH_PYTHON`, `AGENTS_SKILLS_PYTHON`.
- For time-sensitive answers, include source URLs and the relevant date.
- Start with `web_search`; use `web_fetch` for page content; use `web_map` for site structure.

## Commands

```bash
cp "<SKILL_DIR>/.env.example" "<SKILL_DIR>/.env"

python "<SKILL_DIR>/scripts/groksearch_entry.py" web_search --query "search terms" [--platform "GitHub"] [--min-results 3] [--max-results 10] [--model "grok-4-fast"] [--extra-sources 3]

python "<SKILL_DIR>/scripts/groksearch_entry.py" web_fetch --url "https://..." [--out file.md] [--fallback-grok]

python "<SKILL_DIR>/scripts/groksearch_entry.py" web_map --url "https://..." [--instructions "focus area"] [--max-depth 2] [--limit 80]

python "<SKILL_DIR>/scripts/groksearch_entry.py" get_config_info [--no-test]

python "<SKILL_DIR>/scripts/groksearch_entry.py" toggle_builtin_tools --action on|off|status [--root /path/to/project]
```

## Failure Recovery

- Connection or auth failure: run `get_config_info` and verify `GROK_API_URL` and `GROK_API_KEY`.
- `web_search` needs broader coverage: add `--extra-sources N`; if Tavily is unavailable, keep Grok results and note the warning.
- `web_fetch` fails on Tavily extract: retry with `--fallback-grok`.
- Hash-route/docsify pages may require the materialized markdown URL hinted by the CLI error.
