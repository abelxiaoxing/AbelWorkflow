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

python "<SKILL_DIR>/scripts/groksearch_entry.py" web_search --query "search terms" [--platform "GitHub"] [--min-results 3] [--max-results 10] [--model "grok-4.20-auto"] [--extra-sources 3]

python "<SKILL_DIR>/scripts/groksearch_entry.py" web_fetch --url "https://..." [--out file.md] [--fallback-grok]

python "<SKILL_DIR>/scripts/groksearch_entry.py" web_map --url "https://..." [--instructions "focus area"] [--max-depth 2] [--limit 80]

python "<SKILL_DIR>/scripts/groksearch_entry.py" get_config_info [--no-test]

python "<SKILL_DIR>/scripts/groksearch_entry.py" toggle_builtin_tools --action on|off|status [--root /path/to/project]
```

## Tool Routing Policy
### Forced Replacement Rules

| Scenario | Disabled | Use Instead |
|----------|----------|-------------|
| Web Search | `WebSearch` | CLI `web_search` via `groksearch_entry.py` |
| Web Fetch | `WebFetch` | CLI `web_fetch` via `groksearch_entry.py` |

### Tool Capability Matrix

| Tool | Parameters | Output |
|------|------------|--------|
| `web_search` | `query`(required), `platform`/`min_results`/`max_results`/`model`/`extra_sources`(optional) | `[{title,url,description}]` |
| `web_fetch` | `url`(required), `out`/`fallback_grok`(optional) | Structured Markdown |
| `web_map` | `url`(required), `instructions`/`max_depth`/`max_breadth`/`limit`/`timeout`(optional) | JSON string |
| `get_config_info` | `no_test`(optional) | `{api_url,status,connection_test}` |
| `toggle_builtin_tools` | `action`(on/off/status), `root`(optional) | `{blocked,deny_list}` |

## Search Workflow

### Phase 1: Query Construction
- **Intent Recognition**: Broad search → `web_search` | Deep retrieval → `web_fetch`
- **Parameter Optimization**: Set `platform` for specific sources, adjust result counts; if you need broader source coverage, consider adding `--extra-sources 3`

### Phase 2: Search Execution
1. Start with `web_search` for structured summaries
2. Use `web_fetch` on key URLs if summaries insufficient
3. Retry with adjusted query if first round unsatisfactory

### Phase 3: Result Synthesis
1. Cross-reference multiple sources
2. **Must annotate source and date** for time-sensitive info
3. **Must include source URLs**: `Title [1](URL)`

## Error Handling

| Error | Recovery |
|-------|----------|
| Connection Failure | Run `get_config_info`, verify API URL/Key |
| No Results | Broaden search terms |
| Fetch Timeout | Try alternative sources |
| Tavily unavailable while using `--extra-sources` | Command keeps Grok results and prints a Tavily warning to stderr |
| Tavily extract failure | Use `--fallback-grok`, or inspect the Tavily warning/error message |

## Anti-Patterns

| Prohibited | Correct |
|------------|---------|
| No source citation | Include `Source [1](URL)` |
| Assume current repo has `skills/grok-search` | Check global skill directories under `$HOME` first, then project-level `.claude/.codex/.agents`, then call `<SKILL_DIR>/scripts/groksearch_entry.py` |
| Call `scripts/groksearch_cli.py` directly | Call `python scripts/groksearch_entry.py ...` |
| Use built-in WebSearch/WebFetch | Use GrokSearch CLI |
