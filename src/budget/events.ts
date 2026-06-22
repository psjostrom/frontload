import fs from "node:fs";
import path from "node:path";
import { BaselineKind, BudgetEvent } from "../types.js";
import { estimateTokens } from "../utils/text.js";
import { stateDir } from "../utils/path.js";

export type OperationBudget = {
  outputChars: number;
  outputBytes: number;
  estimatedTokens: number;
  count: number;
  measuredCount: number;
  unmeasuredCount: number;
  baselineBytes: number;
  measuredOutputBytes: number;
  netSavedBytes: number;
  baselineKinds: BaselineKind[];
};

export type BudgetReport = {
  summary: string;
  operations: number;
  measuredOperations: number;
  unmeasuredOperations: number;
  totalBaselineBytes: number;
  totalMeasuredOutputBytes: number;
  netSavedBytes: number;
  estimatedTokensSaved: number;
  baselineKinds: BaselineKind[];
  byOperation: Record<string, OperationBudget>;
  largest: BudgetEvent[];
  last20: BudgetEvent[];
};

export function outputText(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2) ?? String(data);
}

export function outputSize(data: unknown): { chars: number; bytes: number } {
  const text = outputText(data);
  return { chars: text.length, bytes: Buffer.byteLength(text) };
}

export function appendEvent(
  repoRoot: string,
  event: Omit<BudgetEvent, "timestamp" | "estimatedInputTokens" | "estimatedOutputTokens" | "netSavedBytes">
): void {
  const hasBaselineBytes = event.baselineBytes !== undefined;
  const hasBaselineKind = event.baselineKind !== undefined;
  if (hasBaselineBytes !== hasBaselineKind) {
    throw new Error("Measured budget events require both baselineBytes and baselineKind.");
  }
  const dir = stateDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const full: BudgetEvent = {
    timestamp: new Date().toISOString(),
    estimatedInputTokens: estimateTokens(event.inputChars),
    estimatedOutputTokens: estimateTokens(event.outputChars),
    ...event,
    ...(hasBaselineBytes ? { netSavedBytes: event.baselineBytes! - event.outputBytes } : {})
  };
  fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(full)}\n`);
}

export function readEvents(repoRoot: string): BudgetEvent[] {
  const file = path.join(stateDir(repoRoot), "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BudgetEvent);
}

function emptyOperationBudget(): OperationBudget {
  return {
    outputChars: 0,
    outputBytes: 0,
    estimatedTokens: 0,
    count: 0,
    measuredCount: 0,
    unmeasuredCount: 0,
    baselineBytes: 0,
    measuredOutputBytes: 0,
    netSavedBytes: 0,
    baselineKinds: []
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function budgetReport(repoRoot: string): BudgetReport {
  const events = readEvents(repoRoot);
  const byOperation: Record<string, OperationBudget> = {};
  let measuredOperations = 0;
  let totalBaselineBytes = 0;
  let totalMeasuredOutputBytes = 0;
  let netSavedBytes = 0;
  const baselineKinds: BaselineKind[] = [];

  for (const event of events) {
    const operation = byOperation[event.operation] ??= emptyOperationBudget();
    operation.outputChars += event.outputChars;
    operation.outputBytes += event.outputBytes;
    operation.estimatedTokens += event.estimatedOutputTokens;
    operation.count += 1;
    if (event.baselineBytes !== undefined && event.baselineKind !== undefined) {
      const saved = event.netSavedBytes ?? event.baselineBytes - event.outputBytes;
      measuredOperations += 1;
      totalBaselineBytes += event.baselineBytes;
      totalMeasuredOutputBytes += event.outputBytes;
      netSavedBytes += saved;
      operation.measuredCount += 1;
      operation.baselineBytes += event.baselineBytes;
      operation.measuredOutputBytes += event.outputBytes;
      operation.netSavedBytes += saved;
      if (!operation.baselineKinds.includes(event.baselineKind)) operation.baselineKinds.push(event.baselineKind);
      if (!baselineKinds.includes(event.baselineKind)) baselineKinds.push(event.baselineKind);
    } else {
      operation.unmeasuredCount += 1;
    }
  }

  const unmeasuredOperations = events.length - measuredOperations;
  const measuredSummary = measuredOperations === 0
    ? "No operations have an exact before/after baseline."
    : netSavedBytes >= 0
      ? `${plural(measuredOperations, "measured operation")} saved ${netSavedBytes} bytes versus baseline.`
      : `${plural(measuredOperations, "measured operation")} used extra bytes versus baseline (${Math.abs(netSavedBytes)} bytes).`;
  const largest = [...events].sort((a, b) => b.outputBytes - a.outputBytes).slice(0, 10);
  return {
    summary: `${measuredSummary} ${plural(unmeasuredOperations, "unmeasured operation")}. Token counts are estimated as chars / 4.`,
    operations: events.length,
    measuredOperations,
    unmeasuredOperations,
    totalBaselineBytes,
    totalMeasuredOutputBytes,
    netSavedBytes,
    estimatedTokensSaved: Math.round(netSavedBytes / 4),
    baselineKinds,
    byOperation,
    largest,
    last20: events.slice(-20)
  };
}
