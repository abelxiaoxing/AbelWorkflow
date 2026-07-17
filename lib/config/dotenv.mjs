function parseDotenvAssignment(line) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
  if (!match) return null;
  let value = line.slice(match[0].length).trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key: match[1], value };
}

function parseDotenv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = parseDotenvAssignment(line);
    if (assignment && !Object.hasOwn(values, assignment.key)) {
      values[assignment.key] = assignment.value;
    }
  }
  return values;
}

function quoteEnvValue(value) {
  const text = String(value);
  if (/[\r\n]/u.test(text)) throw new Error("Environment values cannot contain newlines");
  if (/^[A-Za-z0-9_./:@-]+$/u.test(text)) return text;
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes("\"")) return `"${text}"`;
  if (text.trim() === text && !(
    (text.startsWith("'") && text.endsWith("'"))
    || (text.startsWith("\"") && text.endsWith("\""))
  )) return text;
  throw new Error("Environment value cannot be represented without changing its meaning");
}

function renderDotenv(values) {
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${quoteEnvValue(String(value))}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function getDotenvLines(content) {
  const lines = [];
  for (let start = 0; start < content.length;) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline + 1;
    const raw = content.slice(start, end);
    const lineEnding = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    lines.push({
      assignment: parseDotenvAssignment(lineEnding ? raw.slice(0, -lineEnding.length) : raw),
      lineEnding,
      raw
    });
    start = end;
  }
  return lines;
}

function updateDotenvContent(content, updates) {
  const updateMap = new Map(Object.entries(updates));
  const lines = getDotenvLines(content);
  const counts = new Map();
  for (const { assignment } of lines) {
    if (assignment && updateMap.has(assignment.key)) {
      counts.set(assignment.key, (counts.get(assignment.key) ?? 0) + 1);
    }
  }

  const seen = new Set();
  let next = "";
  for (const line of lines) {
    const key = line.assignment?.key;
    if (!key || !updateMap.has(key)) {
      next += line.raw;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const value = updateMap.get(key);
    if (value === null || value === undefined || value === "") continue;
    const desired = String(value);
    if (counts.get(key) === 1 && line.assignment.value === desired) {
      next += line.raw;
    } else {
      next += `${key}=${quoteEnvValue(desired)}${line.lineEnding}`;
    }
  }

  const missing = [...updateMap].filter(([key, value]) => (
    !seen.has(key) && value !== null && value !== undefined && value !== ""
  ));
  if (!missing.length) return next;
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  if (next && !next.endsWith("\n")) next += lineEnding;
  next += `${missing.map(([key, value]) => `${key}=${quoteEnvValue(String(value))}`).join(lineEnding)}${lineEnding}`;
  return next;
}

export { parseDotenv, quoteEnvValue, renderDotenv, updateDotenvContent };
