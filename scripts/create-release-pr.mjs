#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const isDirectRun = path.resolve(process.argv[1] ?? "") === scriptPath;

function usage() {
  return `Usage:
  pnpm release:pr -- --version 0.1.12
  pnpm release:pr -- --bump patch

Options:
  --version <x.y.z>  Create a release PR for an explicit version.
  --bump <kind>      Bump the current package version by patch, minor, or major. Defaults to patch.
  --remote <name>    Git remote to fetch and push. Defaults to origin.
  --prepare          CI mode: bump package.json and write outputs to \$GITHUB_OUTPUT; skip git operations.
  --help             Show this help text.`;
}

export function parseArgs(argv) {
  const options = { bump: "patch", remote: "origin" };
  let explicitBump = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--version") {
      options.version = optionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--bump") {
      options.bump = optionValue(argv, i, arg);
      explicitBump = true;
      i += 1;
      continue;
    }
    if (arg === "--remote") {
      options.remote = optionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--prepare") {
      options.prepare = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.version && explicitBump) {
    throw new Error("Use either --version or --bump, not both.");
  }
  return options;
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

export function resolveTargetVersion({ currentVersion, version, bump = "patch" }) {
  if (version) {
    if (!isSemver(version)) throw new Error(`Invalid release version: ${version}`);
    return version;
  }

  if (!["patch", "minor", "major"].includes(bump)) {
    throw new Error(`Invalid bump kind: ${bump}`);
  }
  if (!isSemver(currentVersion)) throw new Error(`Invalid current package version: ${currentVersion}`);

  const [major, minor, patch] = currentVersion.split(".").map((part) => Number.parseInt(part, 10));
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function branchNameForVersion(version) {
  return `release-${version}`;
}

export function prTitleForVersion(version) {
  return `chore(release): bump version to ${version}`;
}

export function findPreviousReleaseRef({ tags, releaseCommits }) {
  const semverTag = tags.find((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  if (semverTag) return semverTag;
  return releaseCommits[0]?.sha ?? null;
}

export function formatReleasePrBody({ version, previousRef, commits }) {
  const releaseLines = commits.length
    ? commits.map((commit) => `- \`${commit.sha}\` ${commit.subject}`).join("\n")
    : "- No commits found since the previous release ref.";

  return `# Release ${version}

## Summary

This PR bumps the npm package version to \`${version}\`.

## Release Notes

Previous release ref: \`${previousRef ?? "none"}\`

${releaseLines}

## Checklist

- [ ] Version bump is the only package metadata change.
- [ ] CI is green.
- [ ] Merge this PR to trigger \`.github/workflows/npm-publish.yml\`.
`;
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+$/.test(value ?? "");
}

function readPackageJson(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options }).trim();
}

function releaseCommitsFromLog(log) {
  if (!log) return [];
  return log.split("\n").map((line) => {
    const [sha, ...subjectParts] = line.split("\t");
    return { sha, subject: subjectParts.join("\t") };
  });
}

function ensureCleanWorktree(repoRoot) {
  const status = capture("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (status) {
    throw new Error("Working tree is not clean. Commit, stash, or discard local changes before creating a release PR.");
  }
}

function gitLog(repoRoot, range) {
  const args = ["log"];
  if (range) args.push(range);
  args.push("--pretty=format:%h%x09%s");
  return releaseCommitsFromLog(capture("git", args, { cwd: repoRoot }));
}

function previousReleaseCommits(repoRoot, base) {
  const log = capture(
    "git",
    ["log", base, "--pretty=format:%h%x09%s", "--grep=Release", "--grep=chore(release)"],
    { cwd: repoRoot }
  );
  return releaseCommitsFromLog(log);
}

function semverTags(repoRoot) {
  const output = capture("git", ["tag", "--list", "v*", "--sort=-version:refname"], { cwd: repoRoot });
  return output ? output.split("\n") : [];
}

function writeBodyFile(body) {
  const file = path.join(os.tmpdir(), `frontload-release-pr-${Date.now()}.md`);
  fs.writeFileSync(file, body);
  return file;
}

function writeGithubOutput(version, branch, title, bodyFile) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) throw new Error("GITHUB_OUTPUT is not set. --prepare requires a GitHub Actions environment.");
  fs.appendFileSync(outputFile, `version=${version}\nbranch=${branch}\ntitle=${title}\nbody_file=${bodyFile}\n`);
  console.log(`Wrote release metadata to $GITHUB_OUTPUT: version=${version} branch=${branch}`);
}

export function createReleasePr({ repoRoot = process.cwd(), argv = process.argv.slice(2) } = {}) {
  const options = parseArgs(argv);
  const base = "main";
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.prepare) {
    ensureCleanWorktree(repoRoot);
    run("git", ["fetch", options.remote, base, "--prune"], { cwd: repoRoot });
    run("git", ["switch", base], { cwd: repoRoot });
    run("git", ["pull", "--ff-only", options.remote, base], { cwd: repoRoot });
  }

  const packageJson = readPackageJson(repoRoot);
  const version = resolveTargetVersion({
    currentVersion: packageJson.version,
    version: options.version,
    bump: options.bump
  });
  const branch = branchNameForVersion(version);
  const title = prTitleForVersion(version);

  if (!options.prepare) {
    run("git", ["switch", "-c", branch], { cwd: repoRoot });
  }

  run("npm", ["version", version, "--no-git-tag-version"], { cwd: repoRoot });

  const previousRef = findPreviousReleaseRef({
    tags: semverTags(repoRoot),
    releaseCommits: previousReleaseCommits(repoRoot, base)
  });
  const commits = previousRef ? gitLog(repoRoot, `${previousRef}..${base}`) : gitLog(repoRoot, base);
  const body = formatReleasePrBody({ version, previousRef, commits });
  const bodyFile = writeBodyFile(body);

  if (options.prepare) {
    writeGithubOutput(version, branch, title, bodyFile);
    return;
  }

  run("git", ["add", "package.json"], { cwd: repoRoot });
  run("git", ["commit", "-m", title], { cwd: repoRoot });
  run("git", ["push", "-u", options.remote, branch], { cwd: repoRoot });
  run("gh", ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body-file", bodyFile], {
    cwd: repoRoot
  });
}

if (isDirectRun) {
  try {
    createReleasePr();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
