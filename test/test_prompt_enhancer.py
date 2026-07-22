import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_ROOT = ROOT / "skills" / "prompt-enhancer"


class PromptEnhancerTemplateTests(unittest.TestCase):
    def test_bug_fix_template_avoids_overprescriptive_compatibility_rules(self) -> None:
        template = (SKILL_ROOT / "TEMPLATE.md").read_text(encoding="utf-8")

        self.assertNotIn("Maintain backward compatibility", template)
        self.assertNotIn("Do not change the function signature unless necessary", template)
        self.assertNotIn("Add inline comments explaining the fix", template)

    def test_skill_has_no_runtime_dependencies(self) -> None:
        self.assertFalse((SKILL_ROOT / "scripts").exists())
        self.assertFalse((SKILL_ROOT / "requirements.txt").exists())
        self.assertFalse((SKILL_ROOT / ".env.example").exists())


if __name__ == "__main__":
    unittest.main()
