"""Shared .env loader for Prompt Enhancer scripts."""

import os
from pathlib import Path


def load_dotenv() -> bool:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return False
    try:
        seen_keys = set()
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip()
                if (value.startswith('"') and value.endswith('"')) or (
                    value.startswith("'") and value.endswith("'")
                ):
                    value = value[1:-1]
                if not key or key in seen_keys:
                    continue
                seen_keys.add(key)
                if not os.environ.get(key):
                    os.environ[key] = value
        return True
    except IOError:
        return False
