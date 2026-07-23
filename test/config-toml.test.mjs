import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTopLevelTomlEntries,
  parseTomlSection,
  readTopLevelTomlString,
  removeTomlSection,
  removeTopLevelTomlField,
  updateTomlSectionFields,
  updateTopLevelTomlField
} from "../lib/config/toml.mjs";
import {
  buildCodexConfigContent,
  resolveExistingCodexApiConfig
} from "../lib/providers/codex.mjs";

test("top-level updates preserve nested multiline array rows", () => {
  const current = `matrix = [
  [1, 2],
  [3, 4]
]

[existing]
keep = true
`;

  assert.equal(updateTopLevelTomlField(current, "model_provider", "custom"), `matrix = [
  [1, 2],
  [3, 4]
]
model_provider = "custom"

[existing]
keep = true
`);
});

test("top-level updates ignore header-like lines in legal multiline strings", () => {
  const current = `"quoted-key" = """
[inside.quoted]
"""
group.value = '''
[[inside.dotted]]
'''
hyphen-key = """
[inside.hyphenated]
"""

[existing]
keep = true
`;
  const next = updateTopLevelTomlField(current, "model_provider", "custom");

  assert.match(next, /"quoted-key" = """\n\[inside\.quoted\]\n"""/u);
  assert.match(next, /group\.value = '''\n\[\[inside\.dotted\]\]\n'''/u);
  assert.match(next, /hyphen-key = """\n\[inside\.hyphenated\]\n"""/u);
  assert.ok(next.indexOf("model_provider = \"custom\"") > next.indexOf("hyphen-key"));
  assert.ok(next.indexOf("model_provider = \"custom\"") < next.indexOf("[existing]"));
});

test("escaped triple quotes do not close multiline basic strings", () => {
  const current = `message = """
before \\"""
[inside.message]
after
"""

[existing]
keep = true
`;
  const next = updateTopLevelTomlField(current, "model_provider", "custom");

  assert.match(next, /before \\"""\n\[inside\.message\]\nafter\n"""/u);
  assert.ok(next.indexOf("model_provider = \"custom\"") > next.indexOf("after\n\"\"\""));
  assert.ok(next.indexOf("model_provider = \"custom\"") < next.indexOf("[existing]"));
});

test("legal quote runs close multiline strings without hiding later sections", () => {
  for (const current of [
    `message = """
ends with one quote""""

[existing]
keep = true
`,
    `message = '''
ends with one quote''''

[existing]
keep = true
`
  ]) {
    const next = updateTopLevelTomlField(current, "model_provider", "custom");
    assert.ok(next.indexOf("model_provider = \"custom\"") < next.indexOf("[existing]"));
  }
});

test("targeted section updates preserve multiline arrays and strings", () => {
  const current = `[model_providers.old]
matrix = [
  [1, 2],
  [3, 4]
]
"quoted-key" = """
[inside.quoted]
"""
group.value = '''
[[inside.dotted]]
'''
hyphen-key = """
[inside.hyphenated]
"""
base_url = "https://old.example/v1"

[unrelated]
keep = true
`;
  const next = updateTomlSectionFields(current, "model_providers.old", {
    name: "Updated"
  });

  assert.match(next, /matrix = \[\n  \[1, 2\],\n  \[3, 4\]\n\]/u);
  assert.match(next, /"quoted-key" = """\n\[inside\.quoted\]\n"""/u);
  assert.match(next, /group\.value = '''\n\[\[inside\.dotted\]\]\n'''/u);
  assert.match(next, /hyphen-key = """\n\[inside\.hyphenated\]\n"""/u);
  assert.ok(next.indexOf("name = \"Updated\"") > next.indexOf("base_url"));
  assert.ok(next.indexOf("name = \"Updated\"") < next.indexOf("[unrelated]"));
});

test("targeted section lookup ignores matching headers inside multiline values", () => {
  const current = `description = """
[model_providers.old]
this is string content
"""

[model_providers.old]
base_url = "https://old.example/v1"

[unrelated]
keep = true
`;
  const next = updateTomlSectionFields(current, "model_providers.old", {
    name: "Updated"
  });

  assert.match(next, /description = """\n\[model_providers\.old\]\nthis is string content\n"""/u);
  assert.match(next, /\[model_providers\.old\]\nbase_url = "https:\/\/old\.example\/v1"\n\nname = "Updated"/u);
});

test("targeted section lookup accepts legal whitespace in dotted headers", () => {
  const current = `[ model_providers . old ] # keep spacing
base_url = "https://old.example/v1"

[unrelated]
keep = true
`;
  const next = updateTomlSectionFields(current, "model_providers.old", {
    name: "Updated"
  });

  assert.equal(next.match(/model_providers/gu)?.length, 1);
  assert.ok(next.indexOf("name = \"Updated\"") < next.indexOf("[unrelated]"));
});

test("section detection accepts normal and array table keys containing brackets", () => {
  for (const header of [`[servers."region]east"]`, `[[servers."region]east"]]`]) {
    const next = updateTopLevelTomlField(`root = true

${header}
enabled = true
`, "added", "x");
    assert.equal(next, `root = true
added = "x"

${header}
enabled = true
`);
  }
});

test("Codex updates equivalent quoted provider key paths in place", () => {
  for (const header of [
    `[model_providers."old"]`,
    `[model_providers.'old']`,
    `[model_providers."ol\\u0064"]`
  ]) {
    const next = buildCodexConfigContent(`model_provider = "old"

${header}
name = "Old"
base_url = "https://old.example/v1"
`, {
      templateContent: "",
      includeSubagentDefaults: false,
      providerId: "old",
      providerName: "Updated",
      baseUrl: "https://new.example/v1",
      envKey: "OPENAI_API_KEY"
    });

    assert.equal(next.match(/^\[model_providers/gmu)?.length, 1, header);
    assert.match(next, /^name = "Updated"$/mu, header);
    assert.match(next, /^base_url = "https:\/\/new\.example\/v1"$/mu, header);
  }

  const bracketed = updateTomlSectionFields(`[servers."region\\u005Deast"]
enabled = true
`, `servers."region]east"`, { enabled: false });
  assert.equal(bracketed.match(/^\[servers/gmu)?.length, 1);
  assert.match(bracketed, /^enabled = false$/mu);
});

test("targeted updates replace complete multiline managed assignments", () => {
  for (const oldValue of [
    `"""
old-marker
"""`,
    `'''
old-marker
'''`,
    `[
  "old-marker"
]`,
    `{
  value = "old-marker",
}`
  ]) {
    const next = updateTomlSectionFields(`[model_providers.old]
name = ${oldValue}
base_url = "https://old.example/v1"
`, "model_providers.old", { name: "Updated" });

    assert.equal(next.match(/^name\s*=/gmu)?.length, 1);
    assert.match(next, /^name = "Updated"$/mu);
    assert.doesNotMatch(next, /old-marker/u);
  }
});

test("targeted updates ignore assignment-looking multiline and inline-table content", () => {
  const current = `[model_providers.old]
description = """
name = "string content"
"""
metadata = {
  name = "inline content",
}
name = "actual"
`;
  const next = updateTomlSectionFields(current, "model_providers.old", {
    name: "Updated"
  });

  assert.match(next, /description = """\nname = "string content"\n"""/u);
  assert.match(next, /metadata = \{\n  name = "inline content",\n\}/u);
  assert.equal(next.match(/^name\s*=/gmu)?.length, 2);
  assert.match(next, /^name = "Updated"$/mu);
});

test("section parsing ignores assignment-looking nested value content", () => {
  const values = parseTomlSection(`[model_providers.old]
name = "actual"
description = """
name = "string content"
"""
metadata = {
  name = "inline content",
}
`, "model_providers.old");

  assert.equal(values.name, "actual");
});

test("top-level operations share complete assignment spans", () => {
  const current = `description = """
before \\"""
model_provider = "string content"
after
""""
model_provider = "actual"

[unrelated]
keep = true
`;
  const entries = extractTopLevelTomlEntries(current);

  assert.deepEqual(entries.map(({ field }) => field), ["description", "model_provider"]);
  assert.equal(entries[0].raw, `description = """
before \\"""
model_provider = "string content"
after
""""`);
  assert.equal(readTopLevelTomlString(current, "model_provider"), "actual");

  const updated = updateTopLevelTomlField(current, "model_provider", "updated");
  assert.match(updated, /description = """[\s\S]*model_provider = "string content"[\s\S]*""""/u);
  assert.equal(updated.match(/^model_provider\s*=/gmu)?.length, 2);
  assert.match(updated, /^model_provider = "updated"$/mu);

  const removed = removeTopLevelTomlField(current, "model_provider");
  assert.match(removed, /description = """[\s\S]*model_provider = "string content"[\s\S]*""""/u);
  assert.equal(removed.match(/^model_provider\s*=/gmu)?.length, 1);
});

test("mixed line endings use exact section offsets and preserve later bytes", () => {
  const cases = [
    {
      content: "[features]\nmulti_agent = true\n[unrelated]\r\nkeep = true\r\n",
      prefix: "[features]\n",
      suffix: "[unrelated]\r\nkeep = true\r\n"
    },
    {
      content: "[features]\r\nmulti_agent = true\r\n[unrelated]\nkeep = true\n",
      prefix: "[features]\r\n",
      suffix: "[unrelated]\nkeep = true\n"
    }
  ];

  for (const { content, prefix, suffix } of cases) {
    assert.equal(parseTomlSection(content, "features").multi_agent, true);

    const updated = updateTomlSectionFields(content, "features", { multi_agent: false });
    assert.ok(updated.startsWith(prefix));
    assert.ok(updated.endsWith(suffix));
    assert.match(updated, /^multi_agent = false$/mu);

    assert.equal(removeTomlSection(content, "features"), suffix);
  }
});

test("Codex treats dynamic provider ids as one TOML key segment", () => {
  const current = `model_provider = "foo.bar"

[model_providers."foo.bar"]
name = "Old"
base_url = "https://old.example/v1"
`;
  const existing = resolveExistingCodexApiConfig(current, { OPENAI_API_KEY: "secret" });
  assert.equal(existing.providerId, "foo.bar");
  assert.equal(existing.providerName, "Old");
  assert.equal(existing.baseUrl, "https://old.example/v1");
  assert.equal(existing.envKey, "OPENAI_API_KEY");
  assert.equal(existing.apiKey, "secret");

  const updated = buildCodexConfigContent(current, {
    templateContent: "",
    includeSubagentDefaults: false,
    providerId: "foo.bar",
    providerName: "Updated",
    baseUrl: "https://new.example/v1",
    envKey: "FOO_BAR_API_KEY"
  });
  assert.equal(updated.match(/^\[model_providers/gmu)?.length, 1);
  assert.match(updated, /^\[model_providers\."foo\.bar"\]$/mu);
  assert.match(updated, /^name = "Updated"$/mu);

  for (const providerId of ["team west", "region]east", "名字", `say"hi`]) {
    const content = buildCodexConfigContent("", {
      templateContent: "",
      includeSubagentDefaults: false,
      providerId,
      providerName: "Special",
      baseUrl: "https://special.example/v1",
      envKey: "SPECIAL_API_KEY"
    });
    assert.ok(content.includes(`[model_providers.${JSON.stringify(providerId)}]`), providerId);
    assert.deepEqual(resolveExistingCodexApiConfig(content), {
      providerId,
      providerName: "Special",
      baseUrl: "https://special.example/v1",
      envKey: "OPENAI_API_KEY",
      apiKey: ""
    });
  }

});

test("Codex always uses OPENAI_API_KEY for every provider", () => {
  for (const providerId of ["openai", "abelworkflow", "名字", "foo.bar", "openai!"]) {
    const content = `model_provider = ${JSON.stringify(providerId)}

[model_providers.${JSON.stringify(providerId)}]
name = "Provider"
temp_env_key = "EXPLICIT_KEY"
`;
    const existing = resolveExistingCodexApiConfig(content, {
      EXPLICIT_KEY: "legacy-secret",
      OPENAI_API_KEY: "openai-secret"
    });
    assert.equal(existing.envKey, "OPENAI_API_KEY");
    assert.equal(existing.apiKey, "openai-secret");
  }
});

test("structurally incomplete assignments fail closed", () => {
  const suffix = `
[user]
keep = true
`;
  const invalidDocuments = [
    `model_provider = "unterminated${suffix}`,
    `model_provider = "unterminated
# "${suffix}`,
    `model_provider = 'unterminated
# '${suffix}`,
    `model_provider = """
unterminated${suffix}`,
    `model_provider = '''
unterminated${suffix}`,
    `items = [
  "unterminated"${suffix}`,
    `metadata = {
  key = "unterminated"${suffix}`
  ];

  for (const content of invalidDocuments) {
    assert.throws(
      () => updateTopLevelTomlField(content, "model_provider", "updated"),
      SyntaxError
    );
    assert.throws(() => removeTopLevelTomlField(content, "model_provider"), SyntaxError);
    assert.throws(() => readTopLevelTomlString(content, "model_provider"), SyntaxError);
    assert.throws(() => resolveExistingCodexApiConfig(content), SyntaxError);
    assert.throws(() => removeTomlSection(content, "user"), SyntaxError);
  }

  const incompleteSection = `[model_providers.old]
name = [
  "unterminated"
[next]
keep = true
`;
  assert.throws(
    () => updateTomlSectionFields(incompleteSection, "model_providers.old", { name: "Updated" }),
    SyntaxError
  );
  assert.throws(() => parseTomlSection(incompleteSection, "model_providers.old"), SyntaxError);
  assert.throws(() => removeTomlSection(incompleteSection, "next"), SyntaxError);
});

test("balanced but invalid TOML fails full-document validation", () => {
  const invalidDocuments = [
    `model_provider = [
[user]
]
[next]
keep = true`,
    `model_provider = {
[user]
}
[next]
keep = true`,
    `model_provider = """
unterminated
[user]
description = """
orphan
[next]
keep = true`,
    `model_provider = """valid"""
"""
[next]
keep = true`,
    `model_provider = """
valid
"""
orphan text
[next]
keep = true`
  ];

  for (const [index, content] of invalidDocuments.entries()) {
    const original = content;
    assert.throws(
      () => updateTopLevelTomlField(content, "model_provider", "updated"),
      index === 0
        ? (error) => (
          error instanceof SyntaxError
          && /^Invalid TOML/iu.test(error.message)
          && error.cause instanceof Error
        )
        : SyntaxError
    );
    assert.throws(() => removeTopLevelTomlField(content, "model_provider"), SyntaxError);
    assert.throws(() => readTopLevelTomlString(content, "model_provider"), SyntaxError);
    assert.throws(
      () => updateTomlSectionFields(content, "next", { keep: false }),
      SyntaxError
    );
    assert.throws(() => removeTomlSection(content, "next"), SyntaxError);
    assert.equal(content, original);
  }
});

test("validity gate accepts TOML signed 64-bit integers", () => {
  const content = `counter = 9223372036854775807

[next]
keep = true
`;
  const updated = updateTopLevelTomlField(content, "model_provider", "custom");
  assert.match(updated, /^counter = 9223372036854775807$/mu);
  assert.match(updated, /^model_provider = "custom"$/mu);
});

test("TOML readers decode valid multiline string scalars", () => {
  const escapedSixQuotes = `"""abc${"\\"}${`"`.repeat(6)}`;
  const cases = [
    [`model_provider = """foo"""`, "foo"],
    [`model_provider = '''foo'''`, "foo"],
    [`model_provider = """
foo"""`, "foo"],
    [`model_provider = '''
foo'''`, "foo"],
    ["model_provider = \"\"\"\r\nfoo\r\nbar\"\"\"", "foo\nbar"],
    ["model_provider = '''\r\nfoo\r\nbar'''", "foo\nbar"],
    [`model_provider = """say \\"""hi"""""`, `say """hi""`],
    [`model_provider = """end""""`, `end"`],
    [`model_provider = """end"""""`, `end""`],
    [`model_provider = '''end''''`, `end'`],
    [`model_provider = '''end'''''`, `end''`],
    [`model_provider = ${escapedSixQuotes}`, `abc"""`],
    [`model_provider = """
foo\\
  bar"""`, "foobar"]
  ];

  for (const [content, expected] of cases) {
    assert.equal(readTopLevelTomlString(content, "model_provider"), expected, content);
  }
});

test("Codex resolves provider fields stored as multiline strings", () => {
  const content = `model_provider = """
foo.bar"""

[model_providers."foo.bar"]
name = '''Team West'''
base_url = """
https://west.example/v1"""
temp_env_key = '''WEST_API_KEY'''
`;

  assert.deepEqual(resolveExistingCodexApiConfig(content, { OPENAI_API_KEY: "secret" }), {
    providerId: "foo.bar",
    providerName: "Team West",
    baseUrl: "https://west.example/v1",
    envKey: "OPENAI_API_KEY",
    apiKey: "secret"
  });
});
