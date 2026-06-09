import { execa } from "execa";
import { budgetReport } from "../budget/events.js";
import { capText } from "../utils/text.js";

export function fileCategory(file: string): string {
  if (/lock|pnpm-lock|package-lock|yarn.lock/.test(file)) return "lockfile";
  if (/(^|\/)(__snapshots__|fixtures?|generated|demo\/fixtures)|\.(snap|golden)\./.test(file)) return "generated";
  if (/(^|\/)(test|tests|__tests__)\/|(\.|-)(test|spec)\.[^.]+$/.test(file)) return "test";
  if (/README|docs\/|\.md$/.test(file)) return "docs";
  if (/config|\.json|\.toml|\.ya?ml|env/.test(file)) return "config";
  if (/dist|generated|build/.test(file)) return "generated";
  return "source";
}

export async function gitDiffSummary(repoRoot: string, staged = false): Promise<{ summary: string; changedFiles: Array<{ path: string; added: number; removed: number; category: string; risky: boolean }>; riskyChanges: string[]; truncated: boolean }> {
  const args = ["diff", "--numstat", ...(staged ? ["--staged"] : [])];
  const num = await execa("git", args, { cwd: repoRoot, reject: false });
  const changedFiles = num.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [a, r, file] = line.split(/\s+/);
      const cat = fileCategory(file);
      const risky = cat === "lockfile" || /package\.json|auth|security|secret|env/.test(file);
      return { path: file, added: Number(a) || 0, removed: Number(r) || 0, category: cat, risky };
    });
  const riskyChanges = changedFiles.filter((f) => f.risky).map((f) => f.path);
  const names = changedFiles.map((f) => `- ${f.path}: +${f.added}/-${f.removed}, ${f.category}${f.risky ? ", risky" : ""}`).join("\n");
  const capped = capText(`Changed files: ${changedFiles.length}\n${names || "No diff."}\n\nRisky changes:\n${riskyChanges.map((r) => `- ${r}`).join("\n") || "- none"}`, 8000);
  return { summary: capped.text, changedFiles, riskyChanges, truncated: capped.truncated };
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd: repoRoot, reject: false, maxBuffer: 50 * 1024 * 1024 });
  return result.stdout;
}

function tokenCount(chars: number): number {
  return Math.ceil(chars / 4);
}

export type CostComparison = {
  summary: string;
  range: { base: string; head: string };
  changedFiles: Array<{ path: string; status: string; added: number; removed: number; category: string; fullFileChars: number }>;
  baselines: {
    patchChars: number;
    patchTokens: number;
    changedFileChars: number;
    changedFileTokens: number;
  };
  agentBudget: {
    operations: number;
    outputTokensExcludingIndex: number;
    outputTokensIncludingIndex: number;
    byOperation: Record<string, { outputChars: number; estimatedTokens: number; count: number }>;
  };
  savings: {
    versusFullFilesExcludingIndex: number | null;
    versusFullFilesIncludingIndex: number | null;
    versusPatchExcludingIndex: number | null;
  };
};

export async function compareCost(repoRoot: string, base = "HEAD~1", head = "HEAD"): Promise<CostComparison> {
  const patch = await git(repoRoot, ["diff", "--patch", base, head]);
  const numstat = await git(repoRoot, ["diff", "--numstat", base, head]);
  const names = await git(repoRoot, ["diff", "--name-status", base, head]);
  const stats = new Map(
    numstat
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [added, removed, file] = line.split(/\t/);
        return [file, { added: Number(added) || 0, removed: Number(removed) || 0 }];
      })
  );
  const changedFiles: CostComparison["changedFiles"] = [];
  let changedFileChars = 0;
  for (const line of names.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split(/\t/);
    const status = parts[0];
    const file = parts.at(-1)!;
    let text = "";
    if (!status.startsWith("D")) {
      text = await git(repoRoot, ["show", `${head}:${file}`]);
    } else {
      text = await git(repoRoot, ["show", `${base}:${file}`]);
    }
    const fullFileChars = Buffer.byteLength(text);
    changedFileChars += fullFileChars;
    const stat = stats.get(file) ?? { added: 0, removed: 0 };
    changedFiles.push({ path: file, status, added: stat.added, removed: stat.removed, category: fileCategory(file), fullFileChars });
  }
  const report = budgetReport(repoRoot);
  const outputTokensIncludingIndex = Object.values(report.byOperation).reduce((sum, op) => sum + op.estimatedTokens, 0);
  const outputTokensExcludingIndex = Object.entries(report.byOperation)
    .filter(([operation]) => operation !== "index")
    .reduce((sum, [, op]) => sum + op.estimatedTokens, 0);
  const patchChars = Buffer.byteLength(patch);
  const changedFileTokens = tokenCount(changedFileChars);
  const patchTokens = tokenCount(patchChars);
  const saving = (withTokens: number, withoutTokens: number): number | null =>
    withoutTokens > 0 ? Number(((withoutTokens - withTokens) / withoutTokens).toFixed(4)) : null;

  const summary = [
    `Changed files: ${changedFiles.length}`,
    `Full changed-file baseline: ${changedFileTokens} tokens`,
    `Patch baseline: ${patchTokens} tokens`,
    `Agent Budget logged output: ${outputTokensExcludingIndex} tokens excluding index, ${outputTokensIncludingIndex} including index`
  ].join("\n");

  return {
    summary,
    range: { base, head },
    changedFiles,
    baselines: { patchChars, patchTokens, changedFileChars, changedFileTokens },
    agentBudget: { operations: report.operations, outputTokensExcludingIndex, outputTokensIncludingIndex, byOperation: report.byOperation },
    savings: {
      versusFullFilesExcludingIndex: saving(outputTokensExcludingIndex, changedFileTokens),
      versusFullFilesIncludingIndex: saving(outputTokensIncludingIndex, changedFileTokens),
      versusPatchExcludingIndex: saving(outputTokensExcludingIndex, patchTokens)
    }
  };
}
