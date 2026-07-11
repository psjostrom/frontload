import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { runtimeRepoFromCwd } from "../../src/gate/runtime.js";

async function gitRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-gate-runtime-"));
  await execa("git", ["init"], { cwd: repo });
  await execa("git", ["config", "user.email", "frontload@example.invalid"], { cwd: repo });
  await execa("git", ["config", "user.name", "Frontload Tests"], { cwd: repo });
  return repo;
}

describe("gate runtime repository resolution", () => {
  it("preserves an initialized repository nested inside the current Git worktree", async () => {
    const repo = await gitRepo();
    const initialized = path.join(repo, "packages/app");
    const nested = path.join(initialized, "src");
    fs.mkdirSync(path.join(initialized, ".frontload"), { recursive: true });
    fs.mkdirSync(nested);

    expect(fs.realpathSync(runtimeRepoFromCwd(nested))).toBe(fs.realpathSync(initialized));
  });

  it("does not escape a linked worktree when the Git lookup fails", async () => {
    const repo = await gitRepo();
    const worktree = path.join(repo, ".worktrees/linked");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
    await execa("git", ["add", ".gitignore", "tracked.txt"], { cwd: repo });
    await execa("git", ["commit", "-m", "test fixture"], { cwd: repo });
    await execa("git", ["worktree", "add", "-b", "linked-test", worktree], { cwd: repo });
    fs.mkdirSync(path.join(repo, ".frontload"));
    const previousPath = process.env.PATH;

    try {
      process.env.PATH = "";
      expect(fs.realpathSync(runtimeRepoFromCwd(worktree))).toBe(fs.realpathSync(worktree));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await execa("git", ["worktree", "remove", "--force", worktree], { cwd: repo, reject: false });
    }
  });
});
