export type BaselineKind =
  | "raw-command-output"
  | "full-file"
  | "raw-diff"
  | "unbounded-search-results"
  | "raw-local-scout-output"
  | "observed-tool-output";

export type BudgetEvent = {
  timestamp: string;
  source: "cli" | "mcp" | "hook";
  operation: string;
  inputChars: number;
  outputChars: number;
  outputBytes: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  durationMs: number;
  success: boolean;
  baselineBytes?: number;
  baselineKind?: BaselineKind;
  netSavedBytes?: number;
};

export type IndexedFile = {
  path: string;
  extension: string;
  size: number;
  mtimeMs: number;
  hash: string;
  lineCount: number;
  isTest: boolean;
  keywords: string[];
  imports: string[];
  exports: string[];
  functions: string[];
  classes: string[];
  types: string[];
  components: string[];
  hooks: string[];
  symbols: string[];
};

export type DependencyEdge = {
  from: string;
  to: string;
  importPath: string;
};

export type RepoIndex = {
  version: 1;
  generatedAt: string;
  repoRoot: string;
  files: IndexedFile[];
  edges: DependencyEdge[];
  stats: {
    fileCount: number;
    indexedBytes: number;
    ignoredCount: number;
  };
};

export type Finding = {
  severity: "error" | "warning" | "info";
  file?: string;
  line?: number;
  column?: number;
  title: string;
  detail?: string;
  stack?: string[];
};

export type CommandSummary = {
  kind: "test" | "typecheck" | "lint" | "generic";
  command: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  rawOutputBytes: number;
  summaryChars: number;
  compressionRatio: number;
  fullLogPath: string;
  redactions: number;
  findings: Finding[];
  truncated: boolean;
  summary: string;
};
