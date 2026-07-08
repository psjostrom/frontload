import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function resolveRepo(repo: string): string {
  return path.resolve(process.cwd(), repo);
}

export function rel(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

export function stateDir(repoRoot: string): string {
  return path.join(repoRoot, ".frontload");
}

function gitExcludePath(repoRoot: string): string | null {
  try {
    const root = execFileSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (fs.realpathSync.native(root) !== fs.realpathSync.native(repoRoot)) return null;
    const gitPath = execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return path.isAbsolute(gitPath) ? gitPath : path.resolve(repoRoot, gitPath);
  } catch {
    return null;
  }
}

function ensureStateDirIgnored(repoRoot: string): void {
  const exclude = gitExcludePath(repoRoot);
  if (!exclude) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (current.split(/\r?\n/).includes(".frontload/")) return;
  fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}.frontload/\n`);
}

export function stateExcludeStatus(repoRoot: string): { ignored: boolean; mechanism: ".git/info/exclude"; pattern: ".frontload/"; path: string | null } {
  const exclude = gitExcludePath(repoRoot);
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
