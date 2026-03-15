#!/usr/bin/env python3
"""Cross-platform bootstrap entrypoint for GrokSearch CLI."""

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional


ROOT_DIR = Path(__file__).resolve().parent.parent
VENV_DIR = Path(os.environ.get("GROKSEARCH_VENV_DIR", str(ROOT_DIR / ".venv")))
REQ_FILE = ROOT_DIR / "requirements.txt"
CLI_PY = ROOT_DIR / "scripts" / "groksearch_cli.py"


def venv_python() -> Optional[Path]:
    candidates = []
    if sys.platform == "win32":
        candidates.extend(
            [
                VENV_DIR / "Scripts" / "python.exe",
                VENV_DIR / "Scripts" / "python",
            ]
        )
    candidates.append(VENV_DIR / "bin" / "python")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def python_spec() -> Optional[str]:
    for name in ("GROKSEARCH_PYTHON", "AGENTS_SKILLS_PYTHON"):
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
    if has_uv():
        command = ["uv", "venv"]
        spec = python_spec()
        if spec:
            command.extend(["--python", spec])
        command.append(str(VENV_DIR))
        subprocess.run(command, check=True)
        return
    python_bin = find_system_python()
    if not python_bin:
        print("Error: No usable uv or python found. Cannot create virtual environment.", file=sys.stderr)
        sys.exit(1)
    subprocess.run([python_bin, "-m", "venv", str(VENV_DIR)], check=True)


def install_deps(python_bin: Path) -> None:
    check = subprocess.run(
        [str(python_bin), "-c", "import httpx, tenacity"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if check.returncode == 0:
        return
    if has_uv() and REQ_FILE.is_file():
        subprocess.run(["uv", "pip", "install", "--python", str(python_bin), "-r", str(REQ_FILE)], check=True)
        return
    if REQ_FILE.is_file():
        subprocess.run([str(python_bin), "-m", "pip", "install", "-r", str(REQ_FILE)], check=True)
        return
    subprocess.run([str(python_bin), "-m", "pip", "install", "httpx", "tenacity"], check=True)


def validate_venv_dir() -> None:
    if VENV_DIR.exists() and not VENV_DIR.is_dir():
        print(f"Error: {VENV_DIR} exists but is not a directory.", file=sys.stderr)
        sys.exit(1)
    if VENV_DIR.is_dir() and not (VENV_DIR / "pyvenv.cfg").exists() and venv_python() is None:
        print(f"Error: {VENV_DIR} exists but is not a valid venv.", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    validate_venv_dir()
    python_bin = venv_python()
    if python_bin is None:
        create_venv()
        python_bin = venv_python()
        if python_bin is None:
            print("Error: Failed to locate python in venv after creation.", file=sys.stderr)
            sys.exit(1)
    install_deps(python_bin)
    result = subprocess.run([str(python_bin), str(CLI_PY)] + sys.argv[1:])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
