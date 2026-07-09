/** Split a command string into argv-style tokens, respecting quotes and escapes. */
export function shellWords(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  let hasArg = false;
  const isWin = process.platform === "win32";

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) {
      current += char;
      escaped = false;
      hasArg = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = command[i + 1];
      // On Windows, only escape before quotes or whitespace to preserve path backslashes
      if (!isWin || next === '"' || next === "'" || (next !== undefined && /\s/.test(next))) {
        escaped = true;
        hasArg = true;
        continue;
      }
    }
    if ((char === "'" || char === "\"") && (!quote || quote === char)) {
      quote = quote ? undefined : char;
      hasArg = true;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current || hasArg) {
        parts.push(current);
        current = "";
        hasArg = false;
      }
      continue;
    }
    current += char;
  }

  if (escaped) {
    current += "\\";
    hasArg = true;
  }
  if (current || hasArg) parts.push(current);
  return parts;
}
