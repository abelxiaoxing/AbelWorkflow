# Advanced Usage

## Using the Python Script Directly

Use the bootstrap entrypoint from the installed skill directory:

```bash
# Basic usage
python "<SKILL_DIR>/scripts/prompt_enhancer_entry.py" "your prompt here"

# With custom model
PE_MODEL=claude-sonnet-4-20250514 python "<SKILL_DIR>/scripts/prompt_enhancer_entry.py" "your prompt"
```

`prompt_enhancer_entry.py` is the canonical entrypoint. It creates or reuses a skill-local virtual environment and then runs `scripts/enhance.py`.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude | - |
| `OPENAI_API_KEY` | OpenAI API key (fallback) | - |
| `PE_MODEL` | Model to use | `claude-sonnet-4-20250514` |
| `PE_DEBUG` | Print bootstrap and fallback diagnostics to `stderr` | `0` |
| `PROMPT_ENHANCER_VENV_DIR` | Override the skill-local venv path | `skills/prompt-enhancer/.venv` |
| `PROMPT_ENHANCER_PYTHON` | Python version/spec for `uv venv --python` | - |
| `AGENTS_SKILLS_PYTHON` | Absolute path to fallback/bootstrap Python | - |

## Local `.env`

The CLI loads `<SKILL_DIR>/.env` automatically if present:

```bash
cp "<SKILL_DIR>/.env.example" "<SKILL_DIR>/.env"
python "<SKILL_DIR>/scripts/prompt_enhancer_entry.py" "your prompt here"
```

## Integration with Other Tools

The enhanced prompt is written to `stdout`. Usage or debug diagnostics stay on `stderr`, and bootstrap/fallback diagnostics are only emitted when `PE_DEBUG=1`.

### Piping Output

```bash
# Pipe to clipboard (macOS)
python "<SKILL_DIR>/scripts/prompt_enhancer_entry.py" "my prompt" | pbcopy

# Pipe to file
python "<SKILL_DIR>/scripts/prompt_enhancer_entry.py" "my prompt" > enhanced.md

# Chain with other commands
python "<SKILL_DIR>/scripts/prompt_enhancer_entry.py" "my prompt" | claude -p
```

### In Shell Scripts

```bash
#!/bin/bash
ENHANCED=$(python "$HOME/.agents/skills/prompt-enhancer/scripts/prompt_enhancer_entry.py" "$1")
echo "$ENHANCED"
```

## Manual Enhancement (No API)

If no API key is available, you can manually apply the enhancement principles:

1. Read the user's prompt
2. Apply the template from [TEMPLATE.md](TEMPLATE.md)
3. Preserve every explicit user constraint
4. Use placeholders for unknown context instead of inventing requirements
5. Structure the output with:
   - Context section
   - Objective section
   - Step-by-step instructions
   - Constraints

## Troubleshooting

### Script Not Found
Verify the canonical entrypoint exists:
```bash
ls "$HOME/.agents/skills/prompt-enhancer/scripts/prompt_enhancer_entry.py"
```

### Permission Denied
Run it through Python instead of executing the file directly:
```bash
python "$HOME/.agents/skills/prompt-enhancer/scripts/prompt_enhancer_entry.py" "your prompt here"
```

### Show Usage
Run the entrypoint without a prompt to print usage information:
```bash
python "$HOME/.agents/skills/prompt-enhancer/scripts/prompt_enhancer_entry.py"
```

### No API Key
The script will fall back to a local template-based enhancement if no API key is found.

### Debug Fallbacks
Set `PE_DEBUG=1` to show dependency-install, provider, or fallback diagnostics on `stderr`.
