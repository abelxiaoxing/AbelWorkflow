import argparse
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "skills" / "prompt-enhancer" / "scripts"


def load_module(module_name: str, file_name: str) -> types.ModuleType:
    file_path = SCRIPTS_DIR / file_name
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load module from {file_path}")
    module = importlib.util.module_from_spec(spec)
    original_path = list(sys.path)
    try:
        sys.path.insert(0, str(SCRIPTS_DIR))
        spec.loader.exec_module(module)
    finally:
        sys.path[:] = original_path
    return module


class PromptEnhancerConfigTests(unittest.TestCase):
    def test_shipped_dotenv_loaders_keep_the_first_empty_assignment(self) -> None:
        loader_paths = [
            SCRIPTS_DIR / "_dotenv.py",
            ROOT / "skills" / "grok-search" / "scripts" / "_dotenv.py",
        ]

        for index, loader_path in enumerate(loader_paths):
            with self.subTest(loader=loader_path):
                spec = importlib.util.spec_from_file_location(f"dotenv_loader_{index}", loader_path)
                if spec is None or spec.loader is None:
                    self.fail(f"Unable to load {loader_path}")
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)

                with tempfile.TemporaryDirectory() as directory:
                    scripts_dir = Path(directory) / "scripts"
                    scripts_dir.mkdir()
                    (Path(directory) / ".env").write_text(
                        "PE_API_KEY=\nPE_API_KEY=stale\n",
                        encoding="utf-8",
                    )
                    with mock.patch.object(module, "__file__", str(scripts_dir / "_dotenv.py")):
                        with mock.patch.dict(os.environ, {}, clear=True):
                            self.assertTrue(module.load_dotenv())
                            self.assertEqual(os.environ.get("PE_API_KEY"), "")

    def test_resolve_config_ignores_global_provider_keys(self) -> None:
        module = load_module("prompt_enhancer_enhance_global_keys", "enhance.py")
        args = argparse.Namespace(api_url=None, api_key=None, model=None, prompt=None, prompt_parts=[])

        with mock.patch.dict(
            "os.environ",
            {
                "OPENAI_API_KEY": "personal-openai",
                "ANTHROPIC_API_KEY": "personal-anthropic",
                "PE_MODEL": "gpt-4o-mini",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "url, apiKey"):
                module.resolve_config(args)

    def test_resolve_config_accepts_complete_explicit_config(self) -> None:
        module = load_module("prompt_enhancer_enhance_explicit", "enhance.py")
        args = argparse.Namespace(
            api_url="https://example.com/v1",
            api_key="secret",
            model="gpt-4o-mini",
            prompt=None,
            prompt_parts=[],
        )

        with mock.patch.dict("os.environ", {}, clear=True):
            config = module.resolve_config(args)

        self.assertEqual(config, ("https://example.com/v1", "secret", "gpt-4o-mini"))

    def test_required_modules_merges_cli_and_env_sources(self) -> None:
        module = load_module("prompt_enhancer_entry_merge", "prompt_enhancer_entry.py")

        with mock.patch.dict("os.environ", {"PE_MODEL": "gpt-4o-mini"}, clear=True):
            with mock.patch.object(
                sys,
                "argv",
                [
                    "prompt_enhancer_entry.py",
                    "--url",
                    "https://example.com/v1",
                    "--api-key",
                    "secret",
                    "rewrite this prompt",
                ],
            ):
                self.assertEqual(module.required_modules(), ["openai"])

    def test_required_modules_ignores_global_provider_keys(self) -> None:
        module = load_module("prompt_enhancer_entry_global_keys", "prompt_enhancer_entry.py")

        with mock.patch.dict(
            "os.environ",
            {
                "ANTHROPIC_API_KEY": "personal-anthropic",
                "OPENAI_API_KEY": "personal-openai",
            },
            clear=True,
        ):
            with mock.patch.object(sys, "argv", ["prompt_enhancer_entry.py", "rewrite this prompt"]):
                self.assertEqual(module.required_modules(), [])

    def test_prompt_enhancer_has_no_anthropic_runtime_dependency(self) -> None:
        requirements = (SCRIPTS_DIR.parent / "requirements.txt").read_text(encoding="utf-8")
        enhance_source = (SCRIPTS_DIR / "enhance.py").read_text(encoding="utf-8")

        self.assertNotIn("anthropic", requirements.lower())
        self.assertNotIn("enhance_with_anthropic", enhance_source)

    def test_bug_fix_template_avoids_overprescriptive_compatibility_rules(self) -> None:
        template = (SCRIPTS_DIR.parent / "TEMPLATE.md").read_text(encoding="utf-8")

        self.assertNotIn("Maintain backward compatibility", template)
        self.assertNotIn("Do not change the function signature unless necessary", template)
        self.assertNotIn("Add inline comments explaining the fix", template)


if __name__ == "__main__":
    unittest.main()
