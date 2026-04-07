#!/usr/bin/env python3
"""Prompt Enhancer CLI."""

import os
import sys

from _dotenv import load_dotenv

load_dotenv()


SYSTEM_PROMPT = """
You are an expert Prompt Engineer for Coding Agents (Claude Code, Codex, Gemini CLI).
Your goal is to rewrite the user's raw input into a structured, high-context prompt that maximizes the agent's effectiveness.

Guidelines:
1. Structure: Use a clear Markdown structure with headers.
2. Chain of Thought: Explicitly ask the agent to "Think step-by-step" or "Analyze the file structure first".
3. Context: If the user's prompt is vague, add placeholders like "[Insert relevant file(s)]" or "[Specify tech stack]" in the rewritten prompt, or simply infer them if obvious.
4. Format:
   - Context: What is the current state? What files are involved?
   - Objective: What exactly should be done?
   - Constraints: specific libraries, coding styles, or "no placeholders".
   - Response Format: e.g., "Return only the code block" or "Explain step-by-step".

Output Template:

# Context
[Refined context description]

# Objective
[Precise task definition]

# Step-by-Step Instructions
1. [Step 1]
2. [Step 2]
...

# Constraints
- [Constraint 1]
- [Constraint 2]
"""


def debug_enabled() -> bool:
    """Return True when debug logging is explicitly enabled."""
    value = os.environ.get("PE_DEBUG", "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def get_env_or_default(name: str, default: str) -> str:
    """Return default when an env var is missing or blank."""
    value = os.environ.get(name)
    if value is None:
        return default

    value = value.strip()
    return value or default


def enhance_with_anthropic(prompt: str, api_key: str) -> str:
    """Enhance prompt using Anthropic API."""
    try:
        import anthropic
    except ImportError:
        raise RuntimeError(
            "Missing dependency: anthropic. Install dependencies for the configured provider."
        ) from None

    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model=get_env_or_default("PE_MODEL", "claude-sonnet-4-20250514"),
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}]
    )
    return message.content[0].text


def enhance_with_openai(prompt: str, api_key: str) -> str:
    """Enhance prompt using OpenAI API."""
    try:
        import openai
    except ImportError:
        raise RuntimeError(
            "Missing dependency: openai. Install dependencies for the configured provider."
        ) from None

    client = openai.OpenAI(api_key=api_key)
    response = client.chat.completions.create(
        model=get_env_or_default("PE_MODEL", "gpt-4o"),
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt}
        ]
    )
    return response.choices[0].message.content


def enhance_locally(prompt: str) -> str:
    """Enhance prompt using local template (no API)."""
    return f"""# Context
[Add only the known repo, file, stack, or runtime context. If unknown, use placeholders like [files], [stack], or [environment].]

# Objective
{prompt}

# Step-by-Step Instructions
1. Restate the task precisely without changing the user's intent.
2. Carry forward every explicit constraint from the original prompt.
3. Add only the minimum missing execution context needed to act.
4. If important details are unknown, leave placeholders instead of inventing requirements.
5. Return the rewritten prompt in this structure.

# Constraints
- Preserve the user's intent and explicit constraints.
- Do not invent product, compatibility, or implementation requirements.
- Keep the result concise, specific, and actionable for a coding agent.
"""


def main():
    if len(sys.argv) < 2:
        print("Usage: prompt_enhancer_entry.py <prompt>", file=sys.stderr)
        print("Example: prompt_enhancer_entry.py 'Write a login component'", file=sys.stderr)
        print("Environment: ANTHROPIC_API_KEY | OPENAI_API_KEY | PE_MODEL", file=sys.stderr)
        sys.exit(1)

    prompt = " ".join(sys.argv[1:])

    # Try Anthropic first, then OpenAI, then local
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY")

    try:
        if anthropic_key:
            result = enhance_with_anthropic(prompt, anthropic_key)
        elif openai_key:
            result = enhance_with_openai(prompt, openai_key)
        else:
            result = enhance_locally(prompt)

        print(result)
    except Exception as e:
        if debug_enabled():
            print(f"Error: {e}", file=sys.stderr)
            print("\nFalling back to local template...", file=sys.stderr)
        print(enhance_locally(prompt))


if __name__ == "__main__":
    main()
