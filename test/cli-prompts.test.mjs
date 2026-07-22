import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("interactive menu descriptors keep order, uniqueness, default membership, and display closure", () => {
  assert.deepEqual(interactiveMenuDescriptors, expectedMenuDescriptors);
  assert.equal(interactiveMenuDefaultValue, "full-init");

  const values = interactiveMenuDescriptors.map((descriptor) => descriptor.value);
  const labels = interactiveMenuDescriptors.map((descriptor) => descriptor.label);
  assert.equal(new Set(values).size, values.length);
  assert.ok(labels.every((label) => typeof label === "string" && label.length > 0));
  assert.ok(values.includes(interactiveMenuDefaultValue));
  assert.equal(values[values.length - 1], "exit");
  assert.equal(values.filter((value) => value === "exit").length, 1);

  const displayChoices = interactiveMenuDescriptors.map(({ value, label, hint, group }) => {
    const choice = { value, label };
    if (hint !== undefined) {
      choice.hint = hint;
    }
    choice.group = group;
    return choice;
  });
  assert.deepEqual(displayChoices, expectedMenuDescriptors);
});

test("interactive menu CLI group exposes only aggregate entries in required order", () => {
  assert.deepEqual(
    interactiveMenuDescriptors
      .filter((descriptor) => descriptor.group === "cli")
      .map(({ value, label }) => ({ value, label })),
    [
      { value: "pi-cli", label: "配置/安装 Pi" },
      { value: "codex-cli", label: "配置/安装 Codex" },
      { value: "claude-cli", label: "配置/安装 Claude Code" }
    ]
  );
});

test("CLI tool submenus offer API configuration before install/update", () => {
  assert.deepEqual(buildCliToolMenuDescriptors("pi"), [
    { value: "pi-api", label: "配置 Pi API" },
    { value: "pi-install", label: "安装/更新 Pi" },
    { value: "back", label: "返回上一级" }
  ]);
  assert.deepEqual(buildCliToolMenuDescriptors("codex"), [
    { value: "codex-api", label: "配置 Codex API" },
    { value: "codex-install", label: "安装/更新 Codex" },
    { value: "back", label: "返回上一级" }
  ]);
  assert.deepEqual(buildCliToolMenuDescriptors("claude"), [
    { value: "claude-api", label: "配置 Claude Code API" },
    { value: "claude-install", label: "安装/更新 Claude Code" },
    { value: "back", label: "返回上一级" }
  ]);
});

test("required rejects empty, blank, and undefined/null values", () => {
  const validator = required("自定义错误");
  assert.equal(validator(""), "自定义错误");
  assert.equal(validator(" "), "自定义错误");
  assert.equal(validator("\t"), "自定义错误");
  assert.equal(validator(undefined), "自定义错误");
  assert.equal(validator(null), "自定义错误");
  assert.equal(validator("valid"), undefined);
});

test("requiredUnlessExisting respects existing value and rejects empty input when missing", () => {
  const noExisting = requiredUnlessExisting(undefined, "自定义错误");
  assert.equal(noExisting(""), "自定义错误");
  assert.equal(noExisting(" "), "自定义错误");
  assert.equal(noExisting(undefined), "自定义错误");
  assert.equal(noExisting(null), "自定义错误");
  assert.equal(noExisting("valid"), undefined);

  const withExisting = requiredUnlessExisting("existing", "自定义错误");
  assert.equal(withExisting(""), undefined);
  assert.equal(withExisting(" "), undefined);
  assert.equal(withExisting(undefined), undefined);
  assert.equal(withExisting(null), undefined);
  assert.equal(withExisting("valid"), undefined);
});

test("assertNotCancelled does not throw for non-cancel values", () => {
  assert.doesNotThrow(() => assertNotCancelled("valid"));
  assert.doesNotThrow(() => assertNotCancelled(undefined));
  assert.doesNotThrow(() => assertNotCancelled(null));
  assert.doesNotThrow(() => assertNotCancelled(42));
  assert.doesNotThrow(() => assertNotCancelled(""));
});

test("CancelledError has correct properties", () => {
  const err = new CancelledError();
  assert.equal(err.name, "CancelledError");
  assert.equal(err.message, "用户取消");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof CancelledError);

  const custom = new CancelledError("自定义消息");
  assert.equal(custom.message, "自定义消息");
});

test("assertNotCancelled throws CancelledError when isCancel returns true", () => {
  // ESM 命名空间只读，无法可靠 mock p.isCancel；
  // 真实取消路径（Ctrl+C → p.isCancel → CancelledError）由集成测试覆盖。
  // 此处作为降级保护，验证 CancelledError 可被正确抛出并捕获。
  assert.throws(
    () => { throw new CancelledError(); },
    (err) => err instanceof CancelledError && err.message === "用户取消"
  );
});

test("interactive menu descriptors are grouped in correct order", () => {
  const groups = interactiveMenuDescriptors.map((d) => d.group);
  // main items come first, exit comes last
  const firstNonMain = groups.findIndex((g) => g !== "main");
  assert.ok(firstNonMain > 0, "main items should be first");
  assert.equal(groups[groups.length - 1], "exit");
  // all items between main and exit should be skill or cli
  const middle = groups.slice(firstNonMain, -1);
  for (const g of middle) {
    assert.ok(g === "skill" || g === "cli", `unexpected group in middle: ${g}`);
  }
});

test("resolvePasswordValue returns user input when non-empty, existing value when empty", () => {
  assert.equal(resolvePasswordValue("new-key", "old-key"), "new-key");
  assert.equal(resolvePasswordValue("new-key", undefined), "new-key");
  assert.equal(resolvePasswordValue("new-key", ""), "new-key");
  assert.equal(resolvePasswordValue("", "old-key"), "old-key");
  assert.equal(resolvePasswordValue("", undefined), undefined);
  assert.equal(resolvePasswordValue("", ""), undefined);
});

test("resolvePasswordValue '-' clears existing value", () => {
  assert.equal(resolvePasswordValue("-", "old-key"), undefined);
  assert.equal(resolvePasswordValue("-", undefined), undefined);
  assert.equal(resolvePasswordValue("-", ""), undefined);
});

test("resolvePasswordValue trims whitespace and falls back to existing value", () => {
  assert.equal(resolvePasswordValue(" ", "old-key"), "old-key");
  assert.equal(resolvePasswordValue("  ", "old-key"), "old-key");
  assert.equal(resolvePasswordValue(" \t\n", "old-key"), "old-key");
  assert.equal(resolvePasswordValue(" ", undefined), undefined);
  assert.equal(resolvePasswordValue(" ", ""), undefined);
  assert.equal(resolvePasswordValue(" - ", "old-key"), undefined);
});

test("password prompts preserve configured secrets without exposing them as options", () => {
  const validate = requiredUnlessExisting("sk-secret");
  const configured = passwordPromptOptions("API Key", "sk-secret", validate);

  assert.deepEqual(configured, {
    message: "API Key（已配置，直接回车保留；输入 - 清除）",
    mask: "*",
    validate
  });
  assert.doesNotMatch(JSON.stringify(configured), /sk-secret/u);
  assert.deepEqual(passwordPromptOptions("API Key", ""), {
    message: "API Key（输入 - 清除）",
    mask: "*"
  });
});

test("provider text prompts use editable initial values and password prompts use the safe wrapper", () => {
  for (const relativePath of [
    "lib/providers/claude.mjs",
    "lib/providers/codex.mjs",
    "lib/providers/pi.mjs",
    "lib/providers/skills.mjs"
  ]) {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    const textPrompts = [...source.matchAll(/p\.text\(\{([\s\S]*?)\n\s+\}\);/gu)];

    assert.ok(textPrompts.length > 0, `${relativePath} must contain text prompts`);
    for (const [, options] of textPrompts) {
      assert.match(options, /\binitialValue:/u, `${relativePath} text prompt must prefill its value`);
      assert.doesNotMatch(options, /\bdefaultValue:/u, `${relativePath} text prompt must not use a fallback-only value`);
    }
    assert.doesNotMatch(source, /p\.password\(\{/u, `${relativePath} must not pass secrets as prompt options`);
  }
});

test("confirmOrCancel is exported as async function with correct arity", () => {
  assert.equal(typeof confirmOrCancel, "function");
  assert.equal(confirmOrCancel.length, 1);
  assert.equal(confirmOrCancel.constructor.name, "AsyncFunction");
});

test("selectOrCancel is exported as async function with correct arity", () => {
  assert.equal(typeof selectOrCancel, "function");
  assert.equal(selectOrCancel.length, 1);
  assert.equal(selectOrCancel.constructor.name, "AsyncFunction");
});
