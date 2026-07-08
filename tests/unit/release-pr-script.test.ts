import { describe, expect, it } from "vitest";
import {
  branchNameForVersion,
  findPreviousReleaseRef,
  formatReleasePrBody,
  parseArgs,
  prTitleForVersion,
  resolveTargetVersion
} from "../../scripts/create-release-pr.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

describe("release PR script helpers", () => {
  it("resolves explicit and bumped target versions", () => {
    expect(resolveTargetVersion({ currentVersion: "0.1.11", version: "0.1.12" })).toBe("0.1.12");
    expect(resolveTargetVersion({ currentVersion: "0.1.11", bump: "patch" })).toBe("0.1.12");
    expect(resolveTargetVersion({ currentVersion: "0.1.11", bump: "minor" })).toBe("0.2.0");
    expect(resolveTargetVersion({ currentVersion: "0.1.11", bump: "major" })).toBe("1.0.0");
  });

  it("uses conventional release branch and PR names", () => {
    expect(branchNameForVersion("0.1.12")).toBe("release-0.1.12");
    expect(prTitleForVersion("0.1.12")).toBe("chore(release): bump version to 0.1.12");
  });

  it("prefers semver tags over release commits when selecting the previous release ref", () => {
    expect(
      findPreviousReleaseRef({
        tags: ["v0.1.11", "v0.1.10"],
        releaseCommits: [{ sha: "2270683", subject: "chore(release): bump version to 0.1.11" }]
      })
    ).toBe("v0.1.11");
  });

  it("falls back to the latest release commit when no semver tag exists", () => {
    expect(
      findPreviousReleaseRef({
        tags: [],
        releaseCommits: [
          { sha: "2270683", subject: "chore(release): bump version to 0.1.11" },
          { sha: "327f0db", subject: "chore(release): bump version to 0.1.10" }
        ]
      })
    ).toBe("2270683");
  });

  it("formats release notes for a pull request body", () => {
    const body = formatReleasePrBody({
      version: "0.1.12",
      previousRef: "2270683",
      commits: [
        { sha: "c1f4da8", subject: "fix: improve frontload agent reporting (#32)" },
        { sha: "c25f638", subject: "fix: improve Frontload repo binding and search relevance (#31)" }
      ]
    });

    expect(body).toContain("# Release 0.1.12");
    expect(body).toContain("Previous release ref: `2270683`");
    expect(body).toContain("- `c1f4da8` fix: improve frontload agent reporting (#32)");
    expect(body).toContain("- `c25f638` fix: improve Frontload repo binding and search relevance (#31)");
    expect(body).toContain("- [ ] Merge this PR to trigger `.github/workflows/npm-publish.yml`.");
  });

  it("rejects missing option values instead of falling back to a patch bump", () => {
    expect(() => parseArgs(["--version"])).toThrow("--version requires a value");
    expect(() => parseArgs(["--bump", "--remote", "origin"])).toThrow("--bump requires a value");
  });

  it("refreshes main before reading package.json for bump calculation", () => {
    const script = fs.readFileSync(path.resolve("scripts/create-release-pr.mjs"), "utf8");

    expect(script.indexOf('run("git", ["pull", "--ff-only", options.remote, base]')).toBeLessThan(
      script.indexOf("const packageJson = readPackageJson(repoRoot)")
    );
  });

  it("creates a release branch, commit, push, and GitHub PR from a clean repo", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-release-pr-"));
    const repo = path.join(tempRoot, "repo");
    const origin = path.join(tempRoot, "origin.git");
    const bin = path.join(tempRoot, "bin");
    const ghArgsFile = path.join(tempRoot, "gh-args.txt");
    const ghBodyFile = path.join(tempRoot, "gh-body.md");
    const script = path.resolve("scripts/create-release-pr.mjs");

    try {
      fs.mkdirSync(repo);
      fs.mkdirSync(bin);
      run("git", ["init", "--bare", origin], tempRoot);
      run("git", ["init", "-b", "main"], repo);
      run("git", ["config", "user.name", "Release Test"], repo);
      run("git", ["config", "user.email", "release-test@example.com"], repo);
      fs.writeFileSync(
        path.join(repo, "package.json"),
        `${JSON.stringify({ name: "frontload", version: "0.1.11", type: "module" }, null, 2)}\n`
      );
      run("git", ["add", "package.json"], repo);
      run("git", ["commit", "-m", "chore(release): bump version to 0.1.11"], repo);
      const previousReleaseRef = run("git", ["rev-parse", "--short", "HEAD"], repo);
      fs.writeFileSync(path.join(repo, "change.txt"), "release note candidate\n");
      run("git", ["add", "change.txt"], repo);
      run("git", ["commit", "-m", "fix: sample change"], repo);
      run("git", ["remote", "add", "origin", origin], repo);
      run("git", ["push", "-u", "origin", "main"], repo);

      fs.writeFileSync(
        path.join(bin, "gh"),
        [
          "#!/bin/sh",
          ': > "$GH_ARGS_FILE"',
          'for arg do printf "%s\\n" "$arg" >> "$GH_ARGS_FILE"; done',
          'while [ "$#" -gt 0 ]; do',
          '  if [ "$1" = "--body-file" ]; then',
          "    shift",
          '    cp "$1" "$GH_BODY_FILE"',
          "  fi",
          "  shift",
          "done"
        ].join("\n")
      );
      fs.chmodSync(path.join(bin, "gh"), 0o755);

      run(process.execPath, [script, "--bump", "patch"], repo, {
        GH_ARGS_FILE: ghArgsFile,
        GH_BODY_FILE: ghBodyFile,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`
      });

      expect(JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version).toBe("0.1.12");
      expect(run("git", ["branch", "--show-current"], repo)).toBe("release-0.1.12");
      expect(run("git", ["log", "-1", "--pretty=%s"], repo)).toBe("chore(release): bump version to 0.1.12");
      expect(run("git", ["ls-remote", "--heads", "origin", "release-0.1.12"], repo)).toContain(
        "refs/heads/release-0.1.12"
      );

      const ghArgs = fs.readFileSync(ghArgsFile, "utf8").trim().split("\n");
      expect(ghArgs).toEqual([
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        "release-0.1.12",
        "--title",
        "chore(release): bump version to 0.1.12",
        "--body-file",
        expect.stringContaining("frontload-release-pr-")
      ]);

      const body = fs.readFileSync(ghBodyFile, "utf8");
      expect(body).toContain("# Release 0.1.12");
      expect(body).toContain(`Previous release ref: \`${previousReleaseRef}\``);
      expect(body).toContain("fix: sample change");
      expect(body).toContain("- [ ] Merge this PR to trigger `.github/workflows/npm-publish.yml`.");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
