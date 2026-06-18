const secretPatterns = [
  /(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+/gi,
  /(sk-[A-Za-z0-9_-]{20,})/g,
  /(ghp_[A-Za-z0-9_]{20,})/g
];

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function redactSecrets(input: string): { text: string; redactions: number } {
  let redactions = 0;
  let text = input;
  for (const pattern of secretPatterns) {
    text = text.replace(pattern, (match) => {
      redactions += 1;
      const eq = match.match(/^([^:=]+[:=])/);
      return eq ? `${eq[1]}[REDACTED]` : "[REDACTED_SECRET]";
    });
  }
  return { text, redactions };
}

export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const suffix = `\n\n[truncated ${text.length - maxChars} chars]`;
  return { text: text.slice(0, Math.max(0, maxChars - suffix.length)) + suffix, truncated: true };
}

export function words(input: string): string[] {
  return Array.from(
    new Set(
      input
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((w) => w.length > 1)
    )
  );
}

export function lineNumbered(text: string, startLine = 1): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "" && /\r?\n$/.test(text)) lines.pop();
  return lines
    .map((line, i) => `${String(startLine + i).padStart(4, " ")} | ${line}`)
    .join("\n");
}
