import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execa } from "execa";
import { z } from "zod";
import { appendEvent, budgetReport, outputSize, outputText } from "../budget/events.js";
import { boundedOutput, fitSearchOutput, searchResultsOutput } from "../budget/output-bounds.js";
import { readBudgeted } from "../commands/read.js";
import { runSummary } from "../commands/run.js";
import { loadConfig } from "../config/config.js";
import { CompactRanked, compactRankedResults, generateDossier, searchIndexMeasured } from "../dossier/dossier.js";
import { gitDiffSummary } from "../diff/diff.js";
import { buildIndex } from "../indexer/indexer.js";
import { BaselineKind, CommandSummary } from "../types.js";
import { stateDir } from "../utils/path.js";
import { capText } from "../utils/text.js";
import { packageVersion } from "../version.js";

export type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
};

type MeasuredMcpResult = {
  data: unknown;
  baseline?: { bytes: number; kind: BaselineKind };
};

type ReadInput = {
  path: string;
  query?: string;
  budgetChars: number;
  startLine?: number;
  lineCount?: number;
};

function shellWords(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  let hasArg = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      hasArg = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      hasArg = true;
      continue;
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

function json(data: unknown): McpTextResponse {
  return { content: [{ type: "text", text: outputText(data) }] };
}

function boundedJson(repoRoot: string, operation: string, data: unknown): { response: McpTextResponse; size: { chars: number; bytes: number } } {
  const config = loadConfig(repoRoot);
  const bounded = boundedOutput(operation, config.budgets.maxToolOutputChars, data);
  return { response: json(bounded.output), size: bounded.size };
}

function fitDossierData(
  maxToolOutputChars: number,
  dossier: { markdown: string; files: CompactRanked[]; truncated: boolean }
): unknown {
  let markdown = dossier.markdown;
  let files = dossier.files;
  let omittedFileDetails = 0;
  let truncated = dossier.truncated;

  const currentData = () => ({
    summary: "Dossier generated.",
    markdown,
    files,
    truncated: truncated || omittedFileDetails > 0,
    ...(omittedFileDetails ? { omittedFileDetails } : {})
  });

  while (files.length > 0) {
    const current = currentData();
    if (outputSize(current).chars <= maxToolOutputChars) return current;
    omittedFileDetails += 1;
    files = files.slice(0, -1);
  }

  const current = currentData();
  if (outputSize(current).chars <= maxToolOutputChars) return current;

  while (markdown.length > 200) {
    const overflow = outputSize(currentData()).chars - maxToolOutputChars;
    const nextBudget = Math.max(200, markdown.length - Math.max(overflow + 100, 200));
    markdown = capText(markdown, nextBudget).text;
    truncated = true;
    const data = {
      summary: "Dossier generated.",
      markdown,
      files,
      truncated,
      ...(omittedFileDetails ? { omittedFileDetails } : {})
    };
    if (outputSize(data).chars <= maxToolOutputChars) return data;
  }

  return {
    summary: "Dossier generated.",
    markdown: capText(markdown, 200).text,
    files: [],
    truncated: true,
    ...(omittedFileDetails ? { omittedFileDetails } : {})
  };
}

async function measuredMcp<TInput>(
  repoRoot: string,
  operation: string,
  input: TInput,
  fn: () => Promise<MeasuredMcpResult> | MeasuredMcpResult
): Promise<McpTextResponse> {
  const start = Date.now();
  let success = false;
  let outputChars = 0;
  let outputBytes = 0;
  let baseline: MeasuredMcpResult["baseline"];
  try {
    const result = await fn();
    const { response, size } = boundedJson(repoRoot, operation, result.data);
    success = true;
    outputChars = size.chars;
    outputBytes = size.bytes;
    baseline = result.baseline;
    return response;
  } finally {
    try {
      const durationMs = Date.now() - start;
      const memory = durationMs >= 500 ? process.memoryUsage() : undefined;
      if (!(operation === "policy" && process.env.FRONTLOAD_DOCTOR_PROBE === "1")) {
        appendEvent(repoRoot, {
          source: "mcp",
          operation,
          inputChars: JSON.stringify(input).length,
          outputChars,
          outputBytes,
          ...(baseline ? { baselineBytes: baseline.bytes, baselineKind: baseline.kind } : {}),
          durationMs,
          ...(memory ? { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed } : {}),
          success
        });
      }
    } catch {
      // Fail open: accounting must never block the tool response or mask the original error.
    }
  }
}

export function createMcpHandlers(repoRoot: string) {
  return {
    policy: async (_input: Record<string, never>): Promise<McpTextResponse> =>
      measuredMcp(repoRoot, "policy", {}, () => {
        const config = loadConfig(repoRoot);
        return {
          data: {
            summary: "Current Frontload policy.",
            budgets: config.budgets,
            allowedCommands: config.commands.allowed,
            localScout: config.localScout
          }
        };
      }),

    index: async (input: { force?: boolean }): Promise<McpTextResponse> =>
      measuredMcp(repoRoot, "index", input, async () => {
        const index = await buildIndex(repoRoot);
        return {
          data: {
            summary: "Repository index refreshed.",
            indexPath: path.join(stateDir(repoRoot), "index.json"),
            stats: index.stats,
            edgeCount: index.edges.length
          }
        };
      }),

    dossier: async (input: { task: string; budgetChars: number; maxFiles: number }): Promise<McpTextResponse> =>
      measuredMcp(repoRoot, "dossier", input, async () => {
        const config = loadConfig(repoRoot);
        const dossier = await generateDossier(repoRoot, input.task, input.budgetChars, input.maxFiles);
        return {
          data: fitDossierData(config.budgets.maxToolOutputChars, {
            markdown: dossier.markdown,
            files: compactRankedResults(dossier.ranked),
            truncated: dossier.truncated
          })
        };
      }),

    search: async (input: { query: string; limit: number }): Promise<McpTextResponse> =>
      measuredMcp(repoRoot, "search", input, async () => {
        const measured = await searchIndexMeasured(repoRoot, input.query, input.limit);
        const config = loadConfig(repoRoot);
        const data = fitSearchOutput(config.budgets.maxToolOutputChars, compactRankedResults(measured.results));
        return {
          data,
          baseline: {
            bytes: outputSize(searchResultsOutput(compactRankedResults(measured.unboundedResults))).bytes,
            kind: "unbounded-search-results"
          }
        };
      }),

    read: async (input: ReadInput): Promise<McpTextResponse> =>
      measuredMcp(repoRoot, "read", input, () => {
        const config = loadConfig(repoRoot);
        const data = readBudgeted(repoRoot, input.path, {
          budgetChars: input.budgetChars,
          query: input.query,
          startLine: input.startLine,
          lineCount: input.lineCount,
          maxSerializedChars: config.budgets.maxToolOutputChars
        });
        return { data, baseline: { bytes: data.fileSize, kind: "full-file" } };
      }),

    run: async (input: { kind: CommandSummary["kind"]; command: string }): Promise<McpTextResponse> =>
      measuredMcp(repoRoot, "run", input, async () => {
        const commandParts = shellWords(input.command);
        const config = loadConfig(repoRoot);
        const normalizedConfig = {
          ...config,
          commands: {
            ...config.commands,
            allowed: config.commands.allowed.map((cmd) => shellWords(cmd).join(" "))
          }
        };
        const data = await runSummary(repoRoot, input.kind, commandParts, false, normalizedConfig);
        return { data, baseline: { bytes: data.rawOutputBytes, kind: "raw-command-output" } };
      }),

    diff: async (input: { staged: boolean; trackedOnly?: boolean }): Promise<McpTextResponse> =>
      measuredMcp(repoRoot, "diff", input, async () => {
        const data = await gitDiffSummary(repoRoot, { staged: input.staged, trackedOnly: input.trackedOnly ?? false });
        return { data, baseline: { bytes: data.rawDiffBytes, kind: "raw-diff" } };
      }),

    budget: async (_input: Record<string, never>): Promise<McpTextResponse> => boundedJson(repoRoot, "budget", budgetReport(repoRoot)).response,

    localScout: async (input: { prompt: string }): Promise<McpTextResponse> =>
      measuredMcp(repoRoot, "local-scout", input, async () => {
        const config = loadConfig(repoRoot);
        if (!config.localScout.enabled || !config.localScout.command) {
          return { data: { enabled: false, summary: "Local scout is disabled. Configure localScout.command to enable it." } };
        }
        const result = await execa("sh", ["-lc", config.localScout.command], {
          cwd: repoRoot,
          input: input.prompt,
          timeout: config.localScout.timeoutMs,
          all: true,
          stripFinalNewline: false,
          reject: false
        });
        const rawOutput = result.all ?? "";
        return {
          data: {
            enabled: true,
            summary: "Local scout command completed.",
            exitCode: result.exitCode,
            output: rawOutput.slice(0, config.localScout.maxOutputChars)
          },
          baseline: { bytes: Buffer.byteLength(rawOutput), kind: "raw-local-scout-output" }
        };
      })
  };
}

export async function startMcp(repoRoot: string): Promise<void> {
  const server = new McpServer({ name: "frontload", version: packageVersion });
  const handlers = createMcpHandlers(repoRoot);
  const config = loadConfig(repoRoot);
  const defaultDossierChars = config.budgets.defaultDossierChars;
  server.tool("fl_policy", "Return current budget and command policy. Use before running costly commands; do not use for source exploration.", {}, handlers.policy);
  server.tool("fl_repo_index", "Build or refresh the repo index. Use before dossiers/search; not needed before every read.", { force: z.boolean().optional() }, handlers.index);
  server.tool("fl_repo_dossier", "Create a compact task dossier. Use before broad exploration; do not use for exact file contents.", { task: z.string(), budgetChars: z.number().default(defaultDossierChars), maxFiles: z.number().default(12) }, handlers.dossier);
  server.tool("fl_search", "Search indexed files by task terms and bounded literal content matches. Use instead of broad grep; not a full regex engine.", { query: z.string(), limit: z.number().default(10) }, handlers.search);
  server.tool(
    "fl_read_budgeted",
    "Read a contiguous, bounded file excerpt. The `excerpt` field is edit-safe when `editSafe` is true; use optional `numberedExcerpt` for line-number display when present.",
    {
      path: z.string(),
      query: z.string().optional(),
      budgetChars: z.number().int().positive().default(4000),
      startLine: z.number().int().positive().optional(),
      lineCount: z.number().int().positive().optional()
    },
    handlers.read
  );
  server.tool("fl_run_summary", "Run an allowed command and return a summary. Use for tests/typechecks/lint; do not use for interactive commands.", { kind: z.enum(["test", "typecheck", "lint", "generic"]).default("generic"), command: z.string() }, handlers.run);
  server.tool("fl_git_diff_summary", "Summarize git diff. Use instead of dumping full diffs; not for applying patches.", { staged: z.boolean().default(false), trackedOnly: z.boolean().default(false) }, handlers.diff);
  server.tool("fl_budget_report", "Return budget event totals. Use before/after large work; not a profiler.", {}, handlers.budget);
  server.tool("fl_local_scout", "Optional local model extension point. Use only when configured; do not expect network LLMs.", { prompt: z.string() }, handlers.localScout);
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async (exitCode?: number): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    if (exitCode !== undefined) process.exit(exitCode);
  };
  process.stdin.on("close", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close(0);
  });
  process.once("SIGINT", () => {
    void close(0);
  });
  await server.connect(transport);
}
