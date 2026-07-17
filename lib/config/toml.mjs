import { parse as validateToml } from "smol-toml";

function detectLineEnding(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function updateTopLevelTomlField(content, field, value) {
  const lineEnding = detectLineEnding(content);
  if (value === null) {
    return removeTopLevelTomlField(content, field);
  }

  const document = parseTomlDocument(content);
  const entry = findTomlAssignment(document.assignments, field, null);
  const nextLine = `${field} = ${JSON.stringify(value)}`;

  if (entry) {
    return `${content.slice(0, entry.start)}${entry.indent}${nextLine}${content.slice(entry.end)}`;
  }

  const topLevel = content.slice(0, document.topLevelEnd);
  const rest = content.slice(document.topLevelEnd);
  let nextTopLevel = topLevel.trimEnd()
    ? `${topLevel.trimEnd()}${lineEnding}${nextLine}`
    : nextLine;
  if (rest && nextTopLevel) {
    nextTopLevel = `${nextTopLevel}${lineEnding}${lineEnding}`;
  }
  return `${nextTopLevel}${rest}`;
}

function removeTopLevelTomlField(content, field) {
  const document = parseTomlDocument(content);
  const entry = findTomlAssignment(document.assignments, field, null);
  if (!entry) {
    return content;
  }
  return `${content.slice(0, entry.start)}${content.slice(entry.lineEnd)}`;
}

function removeTomlSection(content, sectionName) {
  const section = findTomlSection(parseTomlDocument(content), sectionName);
  if (!section) {
    return content;
  }
  return `${content.slice(0, section.start)}${content.slice(section.end)}`;
}

function buildTomlSection(sectionName, values, lineEnding = "\n") {
  const lines = [`[${sectionName}]`];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (typeof value === "string") {
      lines.push(`${key} = ${JSON.stringify(value)}`);
    } else if (typeof value === "boolean") {
      lines.push(`${key} = ${value ? "true" : "false"}`);
    } else {
      lines.push(`${key} = ${String(value)}`);
    }
  }
  return `${lines.join(lineEnding)}${lineEnding}`;
}

function formatTomlValue(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function formatTomlKeySegment(value) {
  const segment = String(value);
  return /^[A-Za-z0-9_-]+$/u.test(segment) ? segment : JSON.stringify(segment);
}

function getTomlLines(content) {
  const lines = [];
  for (let start = 0; start < content.length;) {
    const newline = content.indexOf("\n", start);
    if (newline === -1) {
      lines.push({
        contentEnd: content.length,
        end: content.length,
        start,
        text: content.slice(start)
      });
      break;
    }

    const contentEnd = content[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({
      contentEnd,
      end: newline + 1,
      start,
      text: content.slice(start, contentEnd)
    });
    start = newline + 1;
  }
  return lines;
}

function skipTomlWhitespace(line, index) {
  while (line[index] === " " || line[index] === "\t") {
    index += 1;
  }
  return index;
}

function readTomlBasicEscape(text, index) {
  const escaped = text[index + 1];
  const simple = {
    '"': '"',
    "\\": "\\",
    b: "\b",
    e: "\u001b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t"
  };
  if (escaped in simple) {
    return { index: index + 2, value: simple[escaped] };
  }

  const length = { U: 8, u: 4, x: 2 }[escaped];
  const hex = length ? text.slice(index + 2, index + 2 + length) : "";
  if (!length || hex.length !== length || !/^[0-9A-Fa-f]+$/u.test(hex)) {
    return null;
  }
  const codePoint = Number.parseInt(hex, 16);
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return null;
  }
  return { index: index + 2 + length, value: String.fromCodePoint(codePoint) };
}

function parseTomlSimpleKey(text, index) {
  const quote = text[index];
  if (quote === `"` || quote === `'`) {
    let value = "";
    for (index += 1; index < text.length;) {
      if (text[index] === quote) {
        return { index: index + 1, value };
      }
      if (quote === `"` && text[index] === "\\") {
        const escape = readTomlBasicEscape(text, index);
        if (!escape) return null;
        value += escape.value;
        index = escape.index;
      } else {
        value += text[index];
        index += 1;
      }
    }
    return null;
  }

  const start = index;
  while (index < text.length && /[A-Za-z0-9_-]/u.test(text[index])) {
    index += 1;
  }
  return index === start ? null : { index, value: text.slice(start, index) };
}

function parseTomlKeyPath(text, index = 0) {
  const path = [];
  while (true) {
    index = skipTomlWhitespace(text, index);
    const key = parseTomlSimpleKey(text, index);
    if (!key) return null;
    path.push(key.value);
    index = skipTomlWhitespace(text, key.index);
    if (text[index] !== ".") {
      return { index, path };
    }
    index += 1;
  }
}

function parseTomlHeader(text) {
  let index = skipTomlWhitespace(text, 0);
  const arrayTable = text.startsWith("[[", index);
  if (!arrayTable && text[index] !== "[") return null;
  index += arrayTable ? 2 : 1;

  const key = parseTomlKeyPath(text, index);
  if (!key) return null;
  index = skipTomlWhitespace(text, key.index);
  const close = arrayTable ? "]]" : "]";
  if (!text.startsWith(close, index)) return null;
  index = skipTomlWhitespace(text, index + close.length);
  if (index !== text.length && text[index] !== "#") return null;
  return { arrayTable, path: key.path };
}

function parseTomlAssignmentHead(text) {
  const keyStart = skipTomlWhitespace(text, 0);
  if (text[keyStart] === "#") return null;
  const key = parseTomlKeyPath(text, keyStart);
  if (!key) return null;
  let index = skipTomlWhitespace(text, key.index);
  if (text[index] !== "=") return null;
  index = skipTomlWhitespace(text, index + 1);
  return {
    indent: text.slice(0, keyStart),
    path: key.path,
    valueIndex: index
  };
}

function closeTomlMultilineString(text, state, index, quote) {
  let end = index + 3;
  while (text[end] === quote) {
    end += 1;
  }
  if (end - index <= 5) {
    state.mode = "normal";
  }
  return end;
}

function scanTomlValueLine(text, start, state) {
  let valueEnd = text.length;
  for (let index = start; index < text.length;) {
    if (state.mode === "multiline-basic") {
      if (text[index] === "\\") {
        index += 2;
      } else if (text.startsWith(`"""`, index)) {
        index = closeTomlMultilineString(text, state, index, `"`);
      } else {
        index += 1;
      }
      continue;
    }

    if (state.mode === "multiline-literal") {
      if (text.startsWith(`'''`, index)) {
        index = closeTomlMultilineString(text, state, index, `'`);
      } else {
        index += 1;
      }
      continue;
    }

    if (state.mode === "basic") {
      if (text[index] === "\\") {
        index += 2;
      } else if (text[index] === `"`) {
        state.mode = "normal";
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (state.mode === "literal") {
      if (text[index] === `'`) {
        state.mode = "normal";
      }
      index += 1;
      continue;
    }

    if (text[index] === "#") {
      valueEnd = index;
      break;
    }
    if (text.startsWith(`"""`, index)) {
      state.mode = "multiline-basic";
      index += 3;
      continue;
    }
    if (text.startsWith(`'''`, index)) {
      state.mode = "multiline-literal";
      index += 3;
      continue;
    }
    if (text[index] === `"`) {
      state.mode = "basic";
    } else if (text[index] === `'`) {
      state.mode = "literal";
    } else if (text[index] === "[") {
      state.arrayDepth += 1;
    } else if (text[index] === "]" && state.arrayDepth > 0) {
      state.arrayDepth -= 1;
    } else if (text[index] === "{") {
      state.inlineTableDepth += 1;
    } else if (text[index] === "}" && state.inlineTableDepth > 0) {
      state.inlineTableDepth -= 1;
    }
    index += 1;
  }
  while (valueEnd > start && (text[valueEnd - 1] === " " || text[valueEnd - 1] === "\t")) {
    valueEnd -= 1;
  }
  return {
    complete: state.mode === "normal" && state.arrayDepth === 0 && state.inlineTableDepth === 0,
    invalid: state.mode === "basic" || state.mode === "literal",
    valueEnd
  };
}

function parseTomlDocument(content) {
  try {
    validateToml(content, { integersAsBigInt: true });
  } catch (error) {
    const message = error instanceof Error ? error.message.split(/\r?\n/u, 1)[0] : "Invalid TOML document";
    throw new SyntaxError(message, { cause: error });
  }

  const assignments = [];
  const lines = getTomlLines(content);
  const sections = [];
  let currentSection = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const header = parseTomlHeader(line.text);
    if (header) {
      if (currentSection) currentSection.end = line.start;
      currentSection = {
        ...header,
        end: content.length,
        start: line.start
      };
      sections.push(currentSection);
      continue;
    }

    const head = parseTomlAssignmentHead(line.text);
    if (!head) continue;
    const state = { arrayDepth: 0, inlineTableDepth: 0, mode: "normal" };
    let endLineIndex = lineIndex;
    let scan;
    for (; endLineIndex < lines.length; endLineIndex += 1) {
      const valueLine = lines[endLineIndex];
      scan = scanTomlValueLine(
        valueLine.text,
        endLineIndex === lineIndex ? head.valueIndex : 0,
        state
      );
      if (scan.invalid) {
        throw new SyntaxError(`Incomplete TOML string at offset ${valueLine.start}`);
      }
      if (scan.complete) break;
    }
    if (!scan?.complete) {
      throw new SyntaxError(`Incomplete TOML assignment at offset ${line.start}`);
    }
    if (endLineIndex >= lines.length) endLineIndex = lines.length - 1;
    const endLine = lines[endLineIndex];
    assignments.push({
      end: endLine.contentEnd,
      indent: head.indent,
      lineEnd: endLine.end,
      path: head.path,
      section: currentSection,
      start: line.start,
      valueEnd: endLine.start + scan.valueEnd,
      valueStart: line.start + head.valueIndex
    });
    lineIndex = endLineIndex;
  }

  return {
    assignments,
    sections,
    topLevelEnd: sections[0]?.start ?? content.length
  };
}

function sameTomlPath(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function parseTomlRequestedPath(value) {
  const parsed = parseTomlKeyPath(value);
  return parsed && skipTomlWhitespace(value, parsed.index) === value.length ? parsed.path : null;
}

function findTomlSection(document, sectionName) {
  const path = parseTomlRequestedPath(sectionName);
  return path
    ? document.sections.find((section) => !section.arrayTable && sameTomlPath(section.path, path))
    : null;
}

function findTomlAssignment(assignments, field, section) {
  return assignments.find((entry) => (
    entry.section === section
    && entry.path.length === 1
    && entry.path[0] === field
  ));
}

function splitTopLevelTomlContent(content) {
  const { topLevelEnd } = parseTomlDocument(content);
  return {
    topLevel: topLevelEnd === -1 ? content : content.slice(0, topLevelEnd),
    rest: topLevelEnd === -1 ? "" : content.slice(topLevelEnd)
  };
}

function extractTopLevelTomlEntries(content) {
  const document = parseTomlDocument(content);
  return document.assignments
    .filter(({ path, section }) => section === null && path.length === 1)
    .map((entry) => ({
      field: entry.path[0],
      raw: content.slice(entry.start, entry.end)
    }));
}

function mergeMissingTopLevelTomlEntries(content, entries) {
  if (!entries.length) {
    return content;
  }

  const lineEnding = detectLineEnding(content);
  const document = parseTomlDocument(content);
  const topLevel = content.slice(0, document.topLevelEnd);
  const rest = content.slice(document.topLevelEnd);
  const existingFields = new Set(
    document.assignments
      .filter(({ path, section }) => section === null && path.length === 1)
      .map(({ path }) => path[0])
  );
  const missingEntries = entries.filter(({ field }) => !existingFields.has(field));
  if (!missingEntries.length) {
    return content;
  }

  let nextTopLevel = topLevel.trimEnd();
  for (const entry of missingEntries) {
    nextTopLevel = nextTopLevel
      ? `${nextTopLevel}${lineEnding}${entry.raw}`
      : entry.raw;
  }

  nextTopLevel = nextTopLevel.trimEnd();
  if (rest && nextTopLevel) {
    nextTopLevel = `${nextTopLevel}${lineEnding}${lineEnding}`;
  }
  return `${nextTopLevel}${rest}`;
}

function applyTomlEdits(content, edits) {
  let nextContent = content;
  for (const { end, start, text } of edits.sort((left, right) => right.start - left.start)) {
    nextContent = `${nextContent.slice(0, start)}${text}${nextContent.slice(end)}`;
  }
  return nextContent;
}

function updateTomlSectionFields(content, sectionName, values) {
  const lineEnding = detectLineEnding(content);
  const document = parseTomlDocument(content);
  const section = findTomlSection(document, sectionName);

  if (!section) {
    const nextSection = buildTomlSection(sectionName, values, lineEnding).trimEnd();
    return content.trimEnd()
      ? `${content.trimEnd()}${lineEnding}${lineEnding}${nextSection}${lineEnding}`
      : `${nextSection}${lineEnding}`;
  }

  const remaining = new Map(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
  const managedFields = new Set(remaining.keys());
  const seenFields = new Set();
  const edits = [];

  for (const entry of document.assignments) {
    if (
      entry.section !== section
      || entry.path.length !== 1
      || !managedFields.has(entry.path[0])
    ) continue;
    const field = entry.path[0];
    if (seenFields.has(field)) {
      edits.push({ end: entry.lineEnd, start: entry.start, text: "" });
    } else {
      edits.push({
        end: entry.end,
        start: entry.start,
        text: `${entry.indent}${field} = ${formatTomlValue(remaining.get(field))}`
      });
      seenFields.add(field);
      remaining.delete(field);
    }
  }

  if (remaining.size) {
    const leading = section.end > 0 && content[section.end - 1] !== "\n" ? lineEnding : "";
    const lines = [...remaining].map(([field, value]) => `${field} = ${formatTomlValue(value)}`);
    edits.push({
      end: section.end,
      start: section.end,
      text: `${leading}${lines.join(lineEnding)}${lineEnding}`
    });
  }
  return applyTomlEdits(content, edits);
}

function parseTomlBasicString(value) {
  if (value[0] !== `"` || value.startsWith(`"""`)) return null;
  let parsed = "";
  for (let index = 1; index < value.length;) {
    if (value[index] === `"`) {
      return index === value.length - 1 ? parsed : null;
    }
    if (value[index] === "\\") {
      const escape = readTomlBasicEscape(value, index);
      if (!escape) return null;
      parsed += escape.value;
      index = escape.index;
    } else {
      parsed += value[index];
      index += 1;
    }
  }
  return null;
}

function parseTomlMultilineString(value, quote) {
  const delimiter = quote.repeat(3);
  if (!value.startsWith(delimiter)) return null;
  let content = value.slice(3).replace(/\r\n/gu, "\n");
  if (content.startsWith("\n")) content = content.slice(1);

  let parsed = "";
  for (let index = 0; index < content.length;) {
    if (content.startsWith(delimiter, index)) {
      let end = index + 3;
      while (content[end] === quote) end += 1;
      const quoteCount = end - index;
      return quoteCount <= 5 && end === content.length
        ? `${parsed}${quote.repeat(quoteCount - 3)}`
        : null;
    }

    if (quote === `'` || content[index] !== "\\") {
      parsed += content[index];
      index += 1;
      continue;
    }

    let continuation = index + 1;
    while (content[continuation] === " " || content[continuation] === "\t") {
      continuation += 1;
    }
    if (content[continuation] === "\n") {
      index = continuation + 1;
      while (content[index] === " " || content[index] === "\t" || content[index] === "\n") {
        index += 1;
      }
      continue;
    }

    const escape = readTomlBasicEscape(content, index);
    if (!escape) return null;
    parsed += escape.value;
    index = escape.index;
  }
  return parsed;
}

function parseTomlScalar(rawValue) {
  const multilineBasic = parseTomlMultilineString(rawValue, `"`);
  if (multilineBasic !== null) return { parsed: true, value: multilineBasic };
  const multilineLiteral = parseTomlMultilineString(rawValue, `'`);
  if (multilineLiteral !== null) return { parsed: true, value: multilineLiteral };
  const value = rawValue.trim();
  const basicString = parseTomlBasicString(value);
  if (basicString !== null) return { parsed: true, value: basicString };
  if (/^'[^']*'$/u.test(value)) return { parsed: true, value: value.slice(1, -1) };
  if (value === "true" || value === "false") {
    return { parsed: true, value: value === "true" };
  }
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) {
    return { parsed: true, value: Number(value) };
  }
  return { parsed: false, value: undefined };
}

function readTopLevelTomlString(content, field) {
  const document = parseTomlDocument(content);
  const entry = findTomlAssignment(document.assignments, field, null);
  if (!entry) return "";
  const value = parseTomlScalar(content.slice(entry.valueStart, entry.valueEnd));
  return value.parsed && typeof value.value === "string" ? value.value : "";
}

function parseTomlSection(content, sectionName) {
  const document = parseTomlDocument(content);
  const section = findTomlSection(document, sectionName);
  if (!section) return {};
  const values = {};
  for (const entry of document.assignments) {
    if (entry.section !== section || entry.path.length !== 1) continue;
    const value = parseTomlScalar(content.slice(entry.valueStart, entry.valueEnd));
    if (value.parsed) values[entry.path[0]] = value.value;
  }
  return values;
}

function getTomlSectionFieldNames(content, sectionName) {
  const document = parseTomlDocument(content);
  const section = findTomlSection(document, sectionName);
  if (!section) return [];
  return document.assignments
    .filter((entry) => entry.section === section && entry.path.length === 1)
    .map((entry) => entry.path[0]);
}


export {
  buildTomlSection,
  detectLineEnding,
  extractTopLevelTomlEntries,
  formatTomlKeySegment,
  getTomlSectionFieldNames,
  mergeMissingTopLevelTomlEntries,
  parseTomlSection,
  readTopLevelTomlString,
  removeTomlSection,
  removeTopLevelTomlField,
  splitTopLevelTomlContent,
  updateTomlSectionFields,
  updateTopLevelTomlField
};
