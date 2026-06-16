import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execa } from "execa";
import { budgetReport } from "../budget/events.js";
import { loadConfig } from "../config/config.js";
import { readBudgeted } from "../commands/read.js";
import { runSummary } from "../commands/run.js";
import { generateDossier, searchIndex } from "../dossier/dossier.js";
import { gitDiffSummary } from "../diff/diff.js";
import { buildIndex } from "../indexer/indexer.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export async function startMcp(repoRoot: string): Promise<void> {
  const server = new McpServer({ name: "frontload", version: "0.1.4" });
  server.tool("fl_policy", "Return current budget and command policy. Use before running costly commands; do not use for source exploration.", {}, async () => {
    const config = loadConfig(repoRoot);
    return json({ summary: "Current Frontload policy.", budgets: config.budgets, allowedCommands: config.commands.allowed, localScout: config.localScout });
  });
  server.tool("fl_repo_index", "Build or refresh the repo index. Use before dossiers/search; not needed before every read.", { force: z.boolean().optional() }, async () => json({ summary: "Repository index refreshed.", index: await buildIndex(repoRoot) }));
  server.tool("fl_repo_dossier", "Create a compact task dossier. Use before broad exploration; do not use for exact file contents.", { task: z.string(), budgetChars: z.number().default(12000), maxFiles: z.number().default(12) }, async ({ task, budgetChars, maxFiles }) => json({ summary: "Dossier generated.", ...(await generateDossier(repoRoot, task, budgetChars, maxFiles)) }));
  server.tool("fl_search", "Search indexed files by task terms and bounded literal content matches. Use instead of broad grep; not a full regex engine.", { query: z.string(), limit: z.number().default(10) }, async ({ query, limit }) => json({ summary: "Search results from index.", results: await searchIndex(repoRoot, query, limit) }));
  server.tool(
    "fl_read_budgeted",
    "Read a contiguous, bounded file excerpt. The `excerpt` field is edit-safe when `editSafe` is true; use `numberedExcerpt` for line-number display.",
    {
      path: z.string(),
      query: z.string().optional(),
      budgetChars: z.number().default(4000),
      startLine: z.number().int().positive().optional(),
      lineCount: z.number().int().positive().optional()
    },
    async (input) => json(readBudgeted(repoRoot, input.path, {
      budgetChars: input.budgetChars,
      query: input.query,
      startLine: input.startLine,
      lineCount: input.lineCount
    }))
  );
  server.tool("fl_run_summary", "Run an allowed command and return a summary. Use for tests/typechecks/lint; do not use for interactive commands.", { kind: z.enum(["test", "typecheck", "lint", "generic"]).default("generic"), command: z.string() }, async ({ kind, command }) => json(await runSummary(repoRoot, kind, command.split(/\s+/))));
  server.tool("fl_git_diff_summary", "Summarize git diff. Use instead of dumping full diffs; not for applying patches.", { staged: z.boolean().default(false) }, async ({ staged }) => json(await gitDiffSummary(repoRoot, staged)));
  server.tool("fl_budget_report", "Return budget event totals. Use before/after large work; not a profiler.", {}, async () => json(budgetReport(repoRoot)));
  server.tool("fl_local_scout", "Optional local model extension point. Use only when configured; do not expect network LLMs.", { prompt: z.string() }, async ({ prompt }) => {
    const config = loadConfig(repoRoot);
    if (!config.localScout.enabled || !config.localScout.command) return json({ enabled: false, summary: "Local scout is disabled. Configure localScout.command to enable it." });
    const result = await execa("sh", ["-lc", config.localScout.command], { cwd: repoRoot, input: prompt, timeout: config.localScout.timeoutMs, reject: false });
    const output = (result.stdout || result.stderr).slice(0, config.localScout.maxOutputChars);
    return json({ enabled: true, summary: "Local scout command completed.", exitCode: result.exitCode, output });
  });
  await server.connect(new StdioServerTransport());
}
