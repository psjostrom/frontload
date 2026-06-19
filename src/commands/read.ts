import fs from "node:fs";
import path from "node:path";
import { loadIndex } from "../indexer/indexer.js";
import { lineNumbered, redactSecrets, words } from "../utils/text.js";

export type ReadBudgetedOptions = {
  budgetChars?: number;
  query?: string;
  startLine?: number;
  lineCount?: number;
};

export type ReadBudgetedResult = {
  summary: string;
  path: string;
  fileSize: number;
  totalLines: number;
  requestedBudget: number;
  startLine: number;
  endLine: number;
  excerpt: string;
  numberedExcerpt: string;
  truncated: boolean;
  editSafe: boolean;
  nextRead?: string;
  previousRead?: string;
  suggestedNextReads: string[];
  redactions: number;
};

type LineBound = {
  start: number;
  end: number;
  contentEnd: number;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function lineBounds(text: string): LineBound[] {
  if (text.length === 0) return [{ start: 0, end: 0, contentEnd: 0 }];
  const bounds: LineBound[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "\n") continue;
    bounds.push({ start, end: i + 1, contentEnd: text[i - 1] === "\r" ? i - 1 : i });
    start = i + 1;
  }
  if (start < text.length) bounds.push({ start, end: text.length, contentEnd: text.length });
  return bounds;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function firstQueryLine(text: string, bounds: LineBound[], query?: string): number | null {
  const terms = words(query ?? "");
  const literal = query?.trim().toLowerCase();
  if (!literal && terms.length === 0) return null;

  for (let i = 0; i < bounds.length; i += 1) {
    const line = text.slice(bounds[i].start, bounds[i].contentEnd).toLowerCase();
    if ((literal && line.includes(literal)) || terms.some((term) => line.includes(term))) return i + 1;
  }
  return null;
}

function endLineForBudget(text: string, bounds: LineBound[], startLine: number, budgetChars: number, requestedLineCount?: number): number {
  const maxEndLine = requestedLineCount === undefined
    ? bounds.length
    : clamp(startLine + requestedLineCount - 1, startLine, bounds.length);
  let endLine = startLine;
  for (let line = startLine; line <= maxEndLine; line += 1) {
    const next = text.slice(bounds[startLine - 1].start, bounds[line - 1].end);
    if (next.length > budgetChars && line > startLine) break;
    endLine = line;
    if (next.length >= budgetChars) break;
  }
  return endLine;
}

function queryWindowStartLine(text: string, bounds: LineBound[], queryLine: number, budgetChars: number, lineCount?: number): number {
  let startLine = queryLine;
  for (let line = queryLine; line >= 1; line -= 1) {
    const next = text.slice(bounds[line - 1].start, bounds[queryLine - 1].end);
    if (next.length > budgetChars && line < queryLine) break;
    startLine = line;
  }
  const lineCountStart = lineCount === undefined ? 1 : queryLine - lineCount + 1;
  return Math.max(startLine, queryLine - 6, lineCountStart);
}

function readCommand(filePath: string, startLine: number, budgetChars: number, lineCount?: number): string {
  return [
    "frontload read",
    shellQuote(filePath),
    `--start-line ${startLine}`,
    `--budget ${budgetChars}`,
    lineCount === undefined ? "" : `--line-count ${lineCount}`
  ].filter(Boolean).join(" ");
}

export function readBudgeted(repoRoot: string, filePath: string, options: ReadBudgetedOptions = {}): ReadBudgetedResult {
  const budgetChars = positiveInteger(options.budgetChars ?? 4000, "budgetChars");
  const requestedLineCount = options.lineCount === undefined ? undefined : positiveInteger(options.lineCount, "lineCount");
  const explicitStartLine = options.startLine === undefined ? undefined : positiveInteger(options.startLine, "startLine");
  const abs = path.resolve(repoRoot, filePath);
  const textRaw = fs.readFileSync(abs, "utf8");
  const bounds = lineBounds(textRaw);
  const totalLines = bounds.length;
  const queryLine = firstQueryLine(textRaw, bounds, options.query);
  const requestedStartLine = explicitStartLine ?? (queryLine ? queryWindowStartLine(textRaw, bounds, queryLine, budgetChars, requestedLineCount) : 1);
  const startLine = clamp(Math.trunc(requestedStartLine), 1, totalLines);
  const endLine = endLineForBudget(textRaw, bounds, startLine, budgetChars, requestedLineCount);
  const rawExcerpt = textRaw.slice(bounds[startLine - 1].start, bounds[endLine - 1].end);
  const redacted = redactSecrets(rawExcerpt);
  const index = loadIndex(repoRoot);
  const suggestedNextReads = index?.edges.filter((e) => e.from === filePath).map((e) => e.to).slice(0, 5) ?? [];
  const nextRead = endLine < totalLines ? readCommand(filePath, endLine + 1, budgetChars, requestedLineCount) : undefined;
  const windowSize = Math.max(1, endLine - startLine + 1);
  const previousStart = requestedLineCount ? Math.max(1, startLine - requestedLineCount) : Math.max(1, startLine - windowSize);
  const previousRead = startLine > 1 ? readCommand(filePath, previousStart, budgetChars, requestedLineCount) : undefined;
  const truncated = startLine > 1 || endLine < totalLines;
  return {
    summary: truncated
      ? `Returned contiguous lines ${startLine}-${endLine} for ${filePath}; full file is ${textRaw.length} chars.`
      : `Returned full file ${filePath}.`,
    path: filePath,
    fileSize: Buffer.byteLength(textRaw),
    totalLines,
    requestedBudget: budgetChars,
    excerpt: redacted.text,
    numberedExcerpt: lineNumbered(redacted.text, startLine),
    startLine,
    endLine,
    truncated,
    editSafe: redacted.redactions === 0,
    ...(nextRead ? { nextRead } : {}),
    ...(previousRead ? { previousRead } : {}),
    suggestedNextReads,
    redactions: redacted.redactions
  };
}
