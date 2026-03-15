---
name: grok-search
description: |
  Enhanced web search and real-time content retrieval via Grok API. Use when: (1) Web search / information retrieval / fact-checking, (2) Webpage content extraction / URL parsing, (3) Breaking knowledge cutoff limits for current information, (4) Real-time news and technical documentation, (5) Multi-source information aggregation. Triggers: "search for", "find information about", "latest news", "current", "fetch webpage", "get content from URL". IMPORTANT: This skill REPLACES built-in WebSearch/WebFetch with CLI commands.
---

# Grok Search

Enhanced web search via Grok API CLI.

## CLI Commands

```bash
# Canonical entrypoint (agents + cross-platform)
# - Resolve the installed skill directory first; do not assume the current repo contains skills/grok-search
# - Prefer user-level skill directories under $HOME first, for example:
#   $HOME/.claude/skills/grok-search
#   $HOME/.codex/skills/grok-search
#   $HOME/.config/agents/skills/grok-search
# - If not found, check project-level locations:
#   .claude/skills/grok-search
#   .codex/skills/grok-search
#   .agents/skills/grok-search
# - Use system python only to bootstrap; entry.py creates/reuses repo-local .venv
# - Never invoke scripts/groksearch_cli.py directly
#
# One-time setup:
#   cp .env.example .env
python "<SKILL_DIR>/scripts/groksearch_entry.py" --help

# Environment (required): GROK_API_URL, GROK_API_KEY
# Environment (optional): GROK_MODEL, GROK_DEBUG, GROK_RETRY_*
# Environment (optional fetch/map): TAVILY_API_KEY, TAVILY_API_URL, TAVILY_ENABLED
#
# .env path:
# skills/grok-search/.env
#
# Bootstrap controls (optional):
# GROKSEARCH_VENV_DIR=/path/to/venv
# GROKSEARCH_PYTHON=3.12
# AGENTS_SKILLS_PYTHON=/abs/path/to/python

# Optional if you intentionally change into the installed skill directory first:
# cd "<SKILL_DIR>" && python scripts/groksearch_entry.py --help

# Web search
python "<SKILL_DIR>/scripts/groksearch_entry.py" web_search --query "search terms" [--platform "GitHub"] [--min-results 3] [--max-results 10] [--model "grok-4-fast"] [--extra-sources 6]

# Fetch webpage
python "<SKILL_DIR>/scripts/groksearch_entry.py" web_fetch --url "https://..." [--out file.md] [--fallback-grok]

# Map website structure (Tavily)
python "<SKILL_DIR>/scripts/groksearch_entry.py" web_map --url "https://..." [--max-depth 2] [--limit 80]

# Check config
python "<SKILL_DIR>/scripts/groksearch_entry.py" get_config_info [--no-test]

# Toggle built-in tools
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
- **Parameter Optimization**: Set `platform` for specific sources, adjust result counts

### Phase 2: Search Execution
1. Start with `web_search` for structured summaries
2. Use `web_fetch` on key URLs if summaries insufficient
3. Retry with adjusted query if first round unsatisfactory

### Phase 3: Result Synthesis
1. Cross-reference multiple sources
2. **Must annotate source and date** for time-sensitive info
3. **Must include source URLs**: `Title [<sup>1</sup>](URL)`

## Error Handling

| Error | Recovery |
|-------|----------|
| Connection Failure | Run `get_config_info`, verify API URL/Key |
| No Results | Broaden search terms |
| Fetch Timeout | Try alternative sources |

## Anti-Patterns

| Prohibited | Correct |
|------------|---------|
| No source citation | Include `Source [<sup>1</sup>](URL)` |
| Assume current repo has `skills/grok-search` | Check global skill directories under `$HOME` first, then project-level `.claude/.codex/.agents`, then call `<SKILL_DIR>/scripts/groksearch_entry.py` |
| Call `scripts/groksearch_cli.py` directly | Call `python scripts/groksearch_entry.py ...` |
| Use built-in WebSearch/WebFetch | Use GrokSearch CLI |
