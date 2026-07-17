function stripJsonComments(content) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < content.length && content[i] !== "\n") i += 1;
      if (i < content.length) output += content[i];
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
        output += content[i] === "\n" ? "\n" : "";
        i += 1;
      }
      if (i >= content.length) {
        throw new SyntaxError("Unterminated block comment");
      }
      i += 1;
      continue;
    }
    output += char;
  }
  return stripJsonTrailingCommas(output);
}

function stripJsonTrailingCommas(content) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }
    if (char === ",") {
      let nextIndex = i + 1;
      while (nextIndex < content.length && /\s/u.test(content[nextIndex])) nextIndex += 1;
      if (content[nextIndex] === "}" || content[nextIndex] === "]") continue;
    }
    output += char;
  }
  return output;
}

export { stripJsonComments, stripJsonTrailingCommas };
