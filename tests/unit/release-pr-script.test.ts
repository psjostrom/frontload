import { describe, expect, it } from "vitest";
import {
  branchNameForVersion,
  findPreviousReleaseRef,
  formatReleasePrBody,
  parseArgs,
  prTitleForVersion,
  resolveTargetVersion
} from "../../scripts/create-release-pr.mjs";
import fs from "node:fs";
import path from "node:path";

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
});
