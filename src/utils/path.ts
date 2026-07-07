import fs from "node:fs";
import path from "node:path";

export function resolveRepo(repo: string): string {
  return path.resolve(process.cwd(), repo);
}

export function rel(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

export function stateDir(repoRoot: string): string {
  return path.join(repoRoot, ".frontload");
}

function gitDir(repoRoot: string): string | null {
  const dotGit = path.join(repoRoot, ".git");
  if (fs.existsSync(dotGit) && fs.statSync(dotGit).isDirectory()) return dotGit;
  if (!fs.existsSync(dotGit)) return null;
  const match = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
  if (!match) return null;
  return path.resolve(repoRoot, match[1]);
}

function ensureStateDirIgnored(repoRoot: string): void {
  const dir = gitDir(repoRoot);
  if (!dir) return;
  const exclude = path.join(dir, "info", "exclude");
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (current.split(/\r?\n/).includes(".frontload/")) return;
  fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}.frontload/\n`);
}

export function stateExcludeStatus(repoRoot: string): { ignored: boolean; mechanism: ".git/info/exclude"; pattern: ".frontload/"; path: string | null } {
  const dir = gitDir(repoRoot);
  const exclude = dir ? path.join(dir, "info", "exclude") : null;
  const ignored = exclude && fs.existsSync(exclude)
    ? fs.readFileSync(exclude, "utf8").split(/\r?\n/).includes(".frontload/")
    : false;
  return { ignored: Boolean(ignored), mechanism: ".git/info/exclude", pattern: ".frontload/", path: exclude };
}

export function ensureStateDir(repoRoot: string): string {
  const dir = stateDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  ensureStateDirIgnored(repoRoot);
  return dir;
}

export function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
