import fs from "node:fs";
import path from "node:path";
import { buildIndex, loadIndex } from "../indexer/indexer.js";
import { IndexedFile, RepoIndex } from "../types.js";
import { fileCategory } from "../diff/diff.js";
import { capText, words } from "../utils/text.js";

type SearchMatch = { line: number; text: string };
type Ranked = { file: IndexedFile; score: number; why: string[]; relatedTests: string[]; matches?: SearchMatch[] };

const genericTaskWords = new Set([
  "app",
  "data",
  "file",
  "fix",
  "from",
  "run",
  "runs",
  "test",
  "tests",
  "spec",
  "src",
  "lib",
  "main",
  "java",
  "settings",
  "config",
  "story",
  "screen",
  "component",
  "components",
  "route",
  "routes",
  "utils",
  "types",
  "constants"
]);

function taskTerms(task: string): string[] {
  return words(task).filter((w) => !genericTaskWords.has(w));
}

function exactTermMatches(value: string, taskWords: string[]): number {
  const normalized = words(value);
  return taskWords.filter((w) => normalized.includes(w)).length;
}

function categoryPenalty(file: IndexedFile, taskWords: string[]): { penalty: number; reason?: string } {
  const category = fileCategory(file.path);
  const docsRequested = taskWords.some((w) => ["doc", "docs", "documentation", "spec", "guide"].includes(w));
  if (category === "docs" && !docsRequested) return { penalty: -18, reason: "docs downweighted" };
  if (category === "generated") return { penalty: -28, reason: "generated/fixture downweighted" };
  if (category === "lockfile") return { penalty: -35, reason: "lockfile downweighted" };
  if (file.size > 50000) return { penalty: -8, reason: "large file downweighted" };
  return { penalty: 0 };
}

function relatedTestsFor(file: IndexedFile, index: RepoIndex): string[] {
  return index.files
    .filter((f) => f.isTest && (f.path.includes(file.path.replace(/\.[^.]+$/, "")) || f.path.includes(file.path.split("/").at(-1)!.replace(/\.[^.]+$/, ""))))
    .map((f) => f.path);
}

function scoreFile(file: IndexedFile, taskWords: string[], index: RepoIndex): Ranked {
  let score = 0;
  const why: string[] = [];
  const pathWords = words(file.path);
  const symbolWords = words(file.symbols.join(" "));
  const importWords = words([...file.imports, ...file.exports].join(" "));
  const pathMatches = taskWords.filter((w) => pathWords.includes(w)).length;
  const symbolMatches = taskWords.filter((w) => symbolWords.includes(w)).length;
  const importMatches = taskWords.filter((w) => importWords.includes(w)).length;
  const basenameMatches = exactTermMatches(file.path.split("/").at(-1) ?? file.path, taskWords);
  if (pathMatches) {
    score += pathMatches * 14;
    why.push("path match");
  }
  if (basenameMatches) {
    score += basenameMatches * 18;
    why.push("basename match");
  }
  if (symbolMatches) {
    score += symbolMatches * 18;
    why.push("symbol match");
  }
  if (importMatches) {
    score += importMatches * 8;
    why.push("import/export match");
  }
  if (file.isTest) score += taskWords.some((w) => ["test", "tests", "failing", "failure"].includes(w)) ? 8 : -4;
  const relatedTests = relatedTestsFor(file, index);
  if (relatedTests.length) {
    score += 10;
    why.push("related test");
  }
  const connected = index.edges.filter((e) => e.from === file.path || e.to === file.path).length;
  if (connected) {
    score += Math.min(connected * 2, 10);
    why.push("dependency edge");
  }
  const penalty = categoryPenalty(file, taskWords);
  score += penalty.penalty;
  if (penalty.reason) why.push(penalty.reason);
  if (/billing|unrelated/i.test(file.path)) score -= 15;
  return { file, score, why, relatedTests };
}

function contentSignals(repoRoot: string, file: IndexedFile, query: string, queryWords: string[], maxMatches = 3): { score: number; why: string[]; matches: SearchMatch[] } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { score: 0, why: [], matches: [] };
  const abs = path.resolve(repoRoot, file.path);
  if (!fs.existsSync(abs)) return { score: 0, why: [], matches: [] };
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return { score: 0, why: [], matches: [] };
  }
  let score = 0;
  const matches: SearchMatch[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const lower = line.toLowerCase();
    const exact = needle.length > 1 && lower.includes(needle);
    const termHits = queryWords.filter((word) => lower.includes(word)).length;
    if (!exact && termHits === 0) return;
    score += exact ? 30 : Math.min(termHits * 8, 20);
    if (matches.length < maxMatches) {
      matches.push({ line: i + 1, text: capText(line.trim(), 240).text });
    }
  });
  return { score, why: matches.length ? ["content match"] : [], matches };
}

function inventorySearch(index: RepoIndex, query: string, limit: number): Ranked[] {
  const pathQuery = query.trim().replace(/^\.\//, "").replace(/\/$/, "");
  const normalized = pathQuery === "." ? "" : pathQuery.toLowerCase();
  return index.files
    .filter((file) => !normalized || file.path.toLowerCase().includes(normalized))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((file) => ({ file, score: 1, why: ["repo inventory"], relatedTests: relatedTestsFor(file, index) }));
}

function noiseNotes(ranked: Ranked[]): string[] {
  if (!ranked.length) return ["No strong lexical matches found; use `fl_search` with more specific domain terms."];
  const top = ranked.slice(0, 8);
  const docs = top.filter((r) => fileCategory(r.file.path) === "docs").length;
  const generated = top.filter((r) => fileCategory(r.file.path) === "generated").length;
  const tests = top.filter((r) => r.file.isTest).length;
  const weak = top.filter((r) => r.score < 20).length;
  const notes: string[] = [];
  if (docs >= 3) notes.push("Top matches include many docs/spec files; add implementation-specific names or pass a docs-focused task only if documentation is intended.");
  if (generated > 0) notes.push("Generated, demo, fixture, or snapshot files appeared near the top; inspect them only after source files unless the task is fixture-specific.");
  if (tests >= 5) notes.push("Top matches are mostly tests; run or inspect them after identifying the production surface.");
  if (weak >= 4) notes.push("Several top matches are weak; use `fl_search` with concrete symbols, filenames, API names, or error text.");
  return notes.length ? notes : ["Ranking confidence looks reasonable; start with the suggested read order."];
}

export async function generateDossier(repoRoot: string, task: string, budgetChars = 12000, maxFiles = 12): Promise<{ markdown: string; ranked: Ranked[]; truncated: boolean }> {
  const index = loadIndex(repoRoot) ?? (await buildIndex(repoRoot));
  const taskWords = taskTerms(task);
  const ranked = index.files
    .map((file) => scoreFile(file, taskWords, index))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .slice(0, maxFiles);
  const suggested = ranked.map((r) => r.file.path);
  const testFiles = ranked.flatMap((r) => (r.file.isTest ? [r.file.path] : r.relatedTests)).filter((v, i, arr) => arr.indexOf(v) === i);
  const lines = [
    "# Frontload Dossier",
    "",
    "## Task",
    "",
    task,
    "",
    "## Budget",
    "",
    `- Requested budget: ${budgetChars} chars`,
    `- Estimated token equivalent: ${Math.ceil(budgetChars / 4)}`,
    `- Generated at: ${new Date().toISOString()}`,
    "",
    "## Ranking confidence",
    "",
    ...noiseNotes(ranked).map((note) => `- ${note}`),
    "",
    "## Related tests / commands",
    "",
    ...testFiles.map((p) => `- \`pnpm test ${p.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? ""}\``),
    "- `pnpm tsc --noEmit`",
    "",
    "## Most relevant files",
    "",
    ...ranked.flatMap((r, i) => [
      `${i + 1}. \`${r.file.path}\``,
      `   - score: ${Math.round(r.score)}`,
      `   - why: ${r.why.join(", ") || "weak lexical match"}`,
      `   - symbols: ${r.file.symbols.slice(0, 8).join(", ") || "none"}`,
      `   - related tests: ${r.relatedTests.join(", ") || "none"}`
    ]),
    "",
    "## Suggested read order",
    "",
    ...suggested.map((p, i) => `${i + 1}. \`${p}\``),
    "",
    "## Dependency notes",
    "",
    ...index.edges
      .filter((e) => suggested.includes(e.from) || suggested.includes(e.to))
      .slice(0, 20)
      .map((e) => `- \`${e.from}\` imports \`${e.to}\``),
    "",
    "## Context limits",
    "",
    "This dossier intentionally omits raw file contents. Use `fl_read_budgeted` for targeted reads."
  ];
  const capped = capText(lines.join("\n"), Math.floor(budgetChars * 1.1));
  return { markdown: capped.text, ranked, truncated: capped.truncated };
}

export async function searchIndex(repoRoot: string, query: string, limit = 10): Promise<Ranked[]> {
  const index = loadIndex(repoRoot) ?? (await buildIndex(repoRoot));
  const queryWords = taskTerms(query);
  if (!queryWords.length && /^[\w./-]+$/.test(query.trim())) return inventorySearch(index, query, limit);
  return index.files
    .map((file) => {
      const ranked = scoreFile(file, queryWords, index);
      const content = contentSignals(repoRoot, file, query, queryWords);
      return {
        ...ranked,
        score: ranked.score + content.score,
        why: [...ranked.why, ...content.why],
        ...(content.matches.length ? { matches: content.matches } : {})
      };
    })
    .filter((ranked) => ranked.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .slice(0, limit);
}
