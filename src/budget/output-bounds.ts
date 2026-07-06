import { outputSize } from "./events.js";
import type { CompactRanked } from "../dossier/dossier.js";
import type { CommandSummary } from "../types.js";

type VisibleChars = (data: unknown) => number;

export function cliSerializedOutput(data: unknown): string {
  return typeof data === "string" ? `${data}\n` : `${JSON.stringify(data, null, 2)}\n`;
}

export function cliVisibleChars(data: unknown): number {
  return outputSize(cliSerializedOutput(data)).chars;
}

function modelVisibleChars(data: unknown): number {
  return outputSize(data).chars;
}

export function searchResultsOutput(results: CompactRanked[]): unknown {
  return {
    summary: "Search results from index.",
    results
  };
}

function compactRunOutput(data: unknown, maxToolOutputChars: number, visibleChars: VisibleChars): unknown | undefined {
  const run = data as Partial<CommandSummary>;
  if (typeof run !== "object" || run === null || typeof run.exitCode === "undefined" || !Array.isArray(run.findings)) return undefined;
  const findings = run.findings.slice(0, 3).map((finding) => ({
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    title: finding.title
  }));
  const compact = {
    summary: "Run output exceeded maxToolOutputChars and was compacted.",
    truncated: true,
    operation: "run",
    exitCode: run.exitCode,
    signal: run.signal,
    fullLogPath: run.fullLogPath,
    findings
  };
  if (visibleChars(compact) <= maxToolOutputChars) return compact;

  const singleFinding = { ...compact, findings: findings.slice(0, 1) };
  if (visibleChars(singleFinding) <= maxToolOutputChars) return singleFinding;

  const noFindings = { ...compact, findings: [] };
  if (visibleChars(noFindings) <= maxToolOutputChars) return noFindings;

  return undefined;
}

export function withheldOutput(
  operation: string,
  maxToolOutputChars: number,
  original: { chars: number; bytes: number },
  data?: unknown,
  visibleChars: VisibleChars = modelVisibleChars
): unknown {
  if (operation === "run") {
    const compact = compactRunOutput(data, maxToolOutputChars, visibleChars);
    if (compact) return compact;
  }

  const detailed = {
    summary: "Tool output exceeded maxToolOutputChars and was withheld.",
    truncated: true,
    operation,
    maxToolOutputChars,
    originalOutputChars: original.chars,
    originalOutputBytes: original.bytes,
    hint: "Narrow the request or use a budgeted tool for a smaller excerpt."
  };
  if (visibleChars(detailed) <= maxToolOutputChars) return detailed;

  const compact = { summary: "Tool output withheld.", truncated: true, operation };
  if (visibleChars(compact) <= maxToolOutputChars) return compact;

  const minimal = { summary: "Tool output withheld.", truncated: true };
  if (visibleChars(minimal) <= maxToolOutputChars) return minimal;

  return { truncated: true };
}

export function boundedOutput(
  operation: string,
  maxToolOutputChars: number,
  data: unknown,
  visibleChars: VisibleChars = modelVisibleChars
): { output: unknown; size: { chars: number; bytes: number } } {
  const original = outputSize(data);
  const originalChars = visibleChars(data);
  const bounded = originalChars > maxToolOutputChars
    ? withheldOutput(operation, maxToolOutputChars, { ...original, chars: originalChars }, data, visibleChars)
    : data;
  return { output: bounded, size: outputSize(bounded) };
}

export function fitSearchOutput(
  maxToolOutputChars: number,
  compactResults: CompactRanked[],
  visibleChars: VisibleChars = modelVisibleChars
): unknown {
  const unbounded = searchResultsOutput(compactResults);
  const unboundedSize = outputSize(unbounded);
  const unboundedVisibleSize = { ...unboundedSize, chars: visibleChars(unbounded) };
  if (!compactResults.length) return visibleChars(unbounded) <= maxToolOutputChars
    ? unbounded
    : withheldOutput("search", maxToolOutputChars, unboundedVisibleSize, unbounded, visibleChars);
  let visible = compactResults;
  let omittedResults = 0;
  while (visible.length > 0) {
    const data = {
      summary: "Search results from index.",
      results: visible,
      ...(omittedResults ? { truncated: true, omittedResults } : {})
    };
    if (visibleChars(data) <= maxToolOutputChars) return data;
    omittedResults += 1;
    visible = visible.slice(0, -1);
  }
  return withheldOutput("search", maxToolOutputChars, unboundedVisibleSize, unbounded, visibleChars);
}
