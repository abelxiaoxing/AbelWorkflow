import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
GROK_ROOT = ROOT / "skills" / "grok-search"


def load_grok_module() -> types.ModuleType:
    httpx = types.ModuleType("httpx")
    for name in ("TimeoutException", "NetworkError", "ConnectError", "RemoteProtocolError", "HTTPStatusError"):
        setattr(httpx, name, type(name, (Exception,), {}))
    httpx.Response = type("Response", (), {})
    httpx.AsyncClient = type("AsyncClient", (), {})
    httpx.Timeout = lambda **kwargs: kwargs
    httpx.Limits = lambda **kwargs: kwargs

    tenacity = types.ModuleType("tenacity")
    tenacity.AsyncRetrying = type("AsyncRetrying", (), {})
    tenacity.retry_if_exception = lambda value: value
    tenacity.stop_after_attempt = lambda value: value
    tenacity.wait_random_exponential = lambda **kwargs: lambda state: 0
    tenacity_wait = types.ModuleType("tenacity.wait")
    tenacity_wait.wait_base = type("wait_base", (), {})

    script = GROK_ROOT / "scripts" / "groksearch_cli.py"
    spec = importlib.util.spec_from_file_location("groksearch_cli_defaults_test", script)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {script}")
    module = importlib.util.module_from_spec(spec)
    original_path = list(sys.path)
    try:
        sys.path.insert(0, str(script.parent))
        with mock.patch.dict(
            sys.modules,
            {"httpx": httpx, "tenacity": tenacity, "tenacity.wait": tenacity_wait},
        ):
            spec.loader.exec_module(module)
    finally:
        sys.path[:] = original_path
    return module


class GrokDefaultsTests(unittest.TestCase):
    def test_runtime_dotenv_loader_keeps_first_empty_and_external_env(self) -> None:
        module = load_grok_module()

        with tempfile.TemporaryDirectory() as directory:
            scripts_dir = Path(directory) / "scripts"
            scripts_dir.mkdir()
            (Path(directory) / ".env").write_text(
                "GROK_API_KEY=\nGROK_API_KEY=stale-secret\n",
                encoding="utf-8",
            )
            with mock.patch.dict(
                module.load_dotenv.__globals__,
                {"__file__": str(scripts_dir / "groksearch_cli.py")},
            ):
                with mock.patch.dict(os.environ, {}, clear=True):
                    self.assertTrue(module.load_dotenv())
                    self.assertEqual(os.environ.get("GROK_API_KEY"), "")

                with mock.patch.dict(
                    os.environ,
                    {"GROK_API_KEY": "external-secret"},
                    clear=True,
                ):
                    self.assertTrue(module.load_dotenv())
                    self.assertEqual(os.environ.get("GROK_API_KEY"), "external-secret")

    def test_runtime_reads_default_model_from_defaults_json(self) -> None:
        defaults = json.loads((GROK_ROOT / "defaults.json").read_text(encoding="utf-8"))
        module = load_grok_module()
        module.Config._instance = None

        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(module.Config().grok_model, defaults["model"])

        self.assertEqual(defaults["model"], "grok-4.20-auto")


if __name__ == "__main__":
    unittest.main()
