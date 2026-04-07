#!/usr/bin/env python3
"""Cross-platform bootstrap entrypoint for Prompt Enhancer."""

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

from _dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parent.parent
REQ_FILE = ROOT_DIR / "requirements.txt"
CLI_PY = ROOT_DIR / "scripts" / "enhance.py"


def debug_enabled() -> bool:
    value = os.environ.get("PE_DEBUG", "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def venv_dir() -> Path:
    configured = os.environ.get("PROMPT_ENHANCER_VENV_DIR")
    if not configured:
        return ROOT_DIR / ".venv"
    dir_path = Path(configured).expanduser()
    if dir_path.is_absolute():
        return dir_path
    return ROOT_DIR / dir_path


def venv_python() -> Optional[Path]:
    dir_path = venv_dir()
    candidates = []
    if sys.platform == "win32":
        candidates.extend(
            [
                dir_path / "Scripts" / "python.exe",
                dir_path / "Scripts" / "python",
            ]
        )
    candidates.append(dir_path / "bin" / "python")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def python_spec() -> Optional[str]:
    for name in ("PROMPT_ENHANCER_PYTHON", "AGENTS_SKILLS_PYTHON"):
        value = os.environ.get(name)
        if value:
            return value
    return None


def has_uv() -> bool:
    return shutil.which("uv") is not None


def find_system_python() -> Optional[str]:
    env_python = os.environ.get("AGENTS_SKILLS_PYTHON")
    if env_python and Path(env_python).is_file():
        return env_python
    if sys.executable and Path(sys.executable).is_file():
        return sys.executable
    for command in ("python3", "python"):
        found = shutil.which(command)
        if found:
            return found
    return None


def create_venv() -> None:
    dir_path = venv_dir()
    if has_uv():
        command = ["uv", "venv"]
        spec = python_spec()
        if spec:
            command.extend(["--python", spec])
        command.append(str(dir_path))
        subprocess.run(command, check=True)
        return
    python_bin = find_system_python()
    if not python_bin:
        print("Error: No usable uv or python found. Cannot create virtual environment.", file=sys.stderr)
        sys.exit(1)
    subprocess.run([python_bin, "-m", "venv", str(dir_path)], check=True)


def required_modules() -> List[str]:
    modules = []
    if os.environ.get("ANTHROPIC_API_KEY"):
        modules.append("anthropic")
    if os.environ.get("OPENAI_API_KEY"):
        modules.append("openai")
    return modules


def install_targets(modules: List[str]) -> List[str]:
    if not REQ_FILE.is_file():
        return modules

    requirements = {}
    for raw_line in REQ_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        package = re.split(r"[<>=!~\\[; ]", line, maxsplit=1)[0].strip().lower()
        if package:
            requirements[package] = line

    return [requirements.get(module.lower(), module) for module in modules]


def has_required_modules(python_bin: str, modules: List[str]) -> bool:
    if not modules:
        return True
    check = subprocess.run(
        [python_bin, "-c", "; ".join(f"import {module}" for module in modules)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return check.returncode == 0


def install_deps(python_bin: Path, modules: Optional[List[str]] = None) -> None:
    modules = required_modules() if modules is None else modules
    if not modules:
        return
    targets = install_targets(modules)
    if has_required_modules(str(python_bin), modules):
        return
    try:
        kwargs = {
            "check": True,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.PIPE,
            "text": True,
        }
        if has_uv():
            subprocess.run(["uv", "pip", "install", "--python", str(python_bin), *targets], **kwargs)
            return
        subprocess.run([str(python_bin), "-m", "pip", "install", *targets], **kwargs)
    except subprocess.CalledProcessError as exc:
        if debug_enabled():
            details = (exc.stderr or "").strip()
            if details:
                print(details, file=sys.stderr)
            print(
                "Warning: Failed to install prompt enhancer dependencies; continuing with existing environment.",
                file=sys.stderr,
            )


def validate_venv_dir() -> None:
    dir_path = venv_dir()
    if dir_path.exists() and not dir_path.is_dir():
        print(f"Error: {dir_path} exists but is not a directory.", file=sys.stderr)
        sys.exit(1)
    if dir_path.is_dir() and not (dir_path / "pyvenv.cfg").exists() and venv_python() is None:
        print(f"Error: {dir_path} exists but is not a valid venv.", file=sys.stderr)
        sys.exit(1)


def should_passthrough_cli() -> bool:
    return len(sys.argv) < 2


def passthrough_python() -> Optional[str]:
    if sys.executable and Path(sys.executable).is_file():
        return sys.executable
    return find_system_python()


def runtime_python() -> str:
    modules = required_modules()
    current_python = passthrough_python()
    if current_python and has_required_modules(current_python, modules):
        return current_python

    validate_venv_dir()
    python_bin = venv_python()
    if python_bin is None:
        create_venv()
        python_bin = venv_python()
        if python_bin is None:
            print("Error: Failed to locate python in venv after creation.", file=sys.stderr)
            sys.exit(1)
    install_deps(python_bin, modules)
    return str(python_bin)


def main() -> None:
    if should_passthrough_cli():
        python_bin = passthrough_python()
        if not python_bin:
            print("Error: No usable python found for CLI usage output.", file=sys.stderr)
            sys.exit(1)
        result = subprocess.run([python_bin, str(CLI_PY)] + sys.argv[1:])
        sys.exit(result.returncode)
    load_dotenv()
    python_bin = runtime_python()
    result = subprocess.run([python_bin, str(CLI_PY)] + sys.argv[1:])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
