# Frontload Uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an idempotent `frontload uninstall` command that removes every Frontload artifact initialized for a repository and user environment, then removes all supported global package installations.

**Architecture:** A focused `src/install/uninstall.ts` module owns removal discovery, surgical shared-config edits, fixed-path cleanup, and injectable package-manager execution. The existing CLI delegates to that module and a small formatter, while tests exercise real temporary filesystem layouts and mock only the external package-manager boundary.

**Tech Stack:** TypeScript, Node.js filesystem/child-process APIs, Commander, jsonc-parser, Vitest, execa.

## Global Constraints

- Preserve unrelated MCP servers, hooks, comments, and settings.
- Delete shared config files or parent directories only when Frontload removal leaves no meaningful content.
- Never overwrite malformed shared config; report it and continue independent cleanup.
- Missing artifacts, package managers, and package installations are harmless.
- Support npm, pnpm, Yarn, and Bun global removals.
- Do not scan the filesystem for other initialized repositories.
- The default removes the global package; `--keep-package` defers only that final phase.
- Follow red-green-refactor for every production behavior.

---

### Task 1: Repository and agent artifact removal

**Files:**
- Create: `src/install/uninstall.ts`
- Modify: `src/utils/path.ts`
- Create: `tests/unit/uninstall.test.ts`

**Interfaces:**
- Consumes: `mcpConfigAdapters`, `AgentName`, `ConfigScope`, `stateExcludeStatus`, Node filesystem APIs, and `jsonc-parser` parsing/edit primitives.
- Produces: `RemovalRecord`, `UninstallArtifactsResult`, `removeStateDirIgnore(repoRoot)`, and `uninstallArtifacts(repoRoot, homeDir)`.

- [ ] **Step 1: Write failing repository cleanup tests**

Create temporary Git repositories containing `frontload.config.json`, `.frontload/`, `.frontload/` in the local exclude file, all three project MCP formats, Claude project hooks, and unrelated config values. Assert that:

```ts
const result = uninstallArtifacts(repo, home);
expect(result.failures).toEqual([]);
expect(fs.existsSync(path.join(repo, "frontload.config.json"))).toBe(false);
expect(fs.existsSync(path.join(repo, ".frontload"))).toBe(false);
expect(stateExcludeStatus(repo).ignored).toBe(false);
expect(remainingConfig).toEqual(unrelatedConfig);
```

Add a second invocation assertion requiring every record to be `absent` or a preserved shared-config update and no failure.

- [ ] **Step 2: Run the repository tests and verify RED**

Run: `pnpm exec vitest run tests/unit/uninstall.test.ts -t "removes repository artifacts"`

Expected: FAIL because `src/install/uninstall.ts` and `uninstallArtifacts` do not exist.

- [ ] **Step 3: Add local Git exclude removal**

Export this focused inverse beside `ensureStateDirIgnored`:

```ts
export function removeStateDirIgnore(repoRoot: string): boolean {
  const exclude = gitExcludePath(repoRoot);
  if (!exclude || !fs.existsSync(exclude)) return false;
  const current = fs.readFileSync(exclude, "utf8");
  const lines = current.split(/\r?\n/);
  const next = lines.filter((line) => line !== ".frontload/").join("\n");
  if (next === current) return false;
  fs.writeFileSync(exclude, next);
  return true;
}
```

Preserve the original newline style where practical and do not touch non-Frontload patterns.

- [ ] **Step 4: Implement repository cleanup**

Create public result types and an isolated action runner:

```ts
export type RemovalRecord = {
  category: "repository" | "agent" | "package";
  target: string;
  status: "removed" | "absent" | "failed";
  error?: string;
};

export type UninstallArtifactsResult = {
  repoRoot: string;
  homeDir: string;
  records: RemovalRecord[];
  failures: RemovalRecord[];
};

export function uninstallArtifacts(repoRoot: string, homeDir = os.homedir()): UninstallArtifactsResult;
```

Remove fixed repository paths, call each project MCP adapter's `remove`, remove Frontload hook entries from `.claude/settings.json`, remove empty JSON/TOML configs only when no comments or unrelated values remain, and collect rather than throw per-target failures.

- [ ] **Step 5: Run repository cleanup tests and verify GREEN**

Run: `pnpm exec vitest run tests/unit/uninstall.test.ts -t "removes repository artifacts"`

Expected: PASS.

- [ ] **Step 6: Write failing user-environment tests**

Create global Codex, Claude Code, and OpenCode MCP configs; Codex and Claude hook files with mixed Frontload/unrelated hooks; all three skill directories; and the OpenCode plugin. Assert all Frontload entries and fixed paths disappear while unrelated values remain.

- [ ] **Step 7: Run user-environment tests and verify RED**

Run: `pnpm exec vitest run tests/unit/uninstall.test.ts -t "removes global agent artifacts"`

Expected: FAIL because `uninstallArtifacts` does not yet clean global host state.

- [ ] **Step 8: Implement user-environment cleanup**

Extend `uninstallArtifacts` with these exact targets:

```ts
const skillPaths = [
  path.join(homeDir, ".codex/skills/frontload"),
  path.join(homeDir, ".claude/skills/frontload"),
  path.join(homeDir, ".config/opencode/skills/frontload"),
];
const pluginPath = path.join(homeDir, ".config/opencode/plugins/frontload-gate.js");
```

Remove global MCP entries through `mcpConfigAdapters`, and strip hooks from `~/.codex/hooks.json` and `~/.claude/settings.json`. Delete only empty Frontload-owned directories.

- [ ] **Step 9: Add malformed-config and idempotency coverage**

Write tests that place invalid JSON/JSONC/TOML in shared files. Verify each malformed file is byte-for-byte unchanged, its record is `failed`, independent fixed paths are still removed, and rerunning a clean uninstall succeeds with absent records.

- [ ] **Step 10: Run all core uninstall tests**

Run: `pnpm exec vitest run tests/unit/uninstall.test.ts`

Expected: PASS with repository, global-agent, malformed-config, empty-file, preservation, and idempotency cases covered.

- [ ] **Step 11: Commit the core cleanup**

```bash
git add src/install/uninstall.ts src/utils/path.ts tests/unit/uninstall.test.ts
git commit -m "feat: remove initialized Frontload artifacts"
```

### Task 2: Global package removal

**Files:**
- Modify: `src/install/uninstall.ts`
- Modify: `tests/unit/uninstall.test.ts`

**Interfaces:**
- Consumes: `RemovalRecord` and an injected `PackageRemovalRunner` external-process boundary.
- Produces: `globalUninstallCommands()`, `uninstallGlobalPackages(runner)`, and `uninstallFrontload(repoRoot, homeDir, options)`.

- [ ] **Step 1: Write failing package-removal tests**

Use an injected runner and assert the exact supported commands:

```ts
expect(globalUninstallCommands()).toEqual([
  { packageManager: "npm", command: "npm", args: ["uninstall", "-g", "frontload"] },
  { packageManager: "pnpm", command: "pnpm", args: ["remove", "-g", "frontload"] },
  { packageManager: "yarn", command: "yarn", args: ["global", "remove", "frontload"] },
  { packageManager: "bun", command: "bun", args: ["remove", "-g", "frontload"] },
]);
```

Cover success, missing executable (`ENOENT`), known package-not-installed messages, real errors, continuation after failure, and `keepPackage: true` avoiding all runner calls.

- [ ] **Step 2: Run package tests and verify RED**

Run: `pnpm exec vitest run tests/unit/uninstall.test.ts -t "global package"`

Expected: FAIL because package-removal exports do not exist.

- [ ] **Step 3: Implement injectable package removal**

Add:

```ts
export type PackageRemovalRunner = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; stdio: ["ignore", "pipe", "pipe"]; shell?: boolean },
) => unknown;

export function uninstallFrontload(
  repoRoot: string,
  homeDir = os.homedir(),
  options: { keepPackage?: boolean; runner?: PackageRemovalRunner } = {},
): UninstallResult;
```

Run every supported manager, classify `ENOENT` and explicit not-installed diagnostics as `absent`, retain other errors as `failed`, and append package records to the artifact result.

- [ ] **Step 4: Run package tests and verify GREEN**

Run: `pnpm exec vitest run tests/unit/uninstall.test.ts -t "global package"`

Expected: PASS.

- [ ] **Step 5: Run all uninstall unit tests**

Run: `pnpm exec vitest run tests/unit/uninstall.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit package removal**

```bash
git add src/install/uninstall.ts tests/unit/uninstall.test.ts
git commit -m "feat: remove global Frontload packages"
```

### Task 3: Public CLI and output

**Files:**
- Create: `src/cli/uninstall-output.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/unit/cli-uninstall-output.test.ts`
- Modify: `tests/e2e/cli-mcp.test.ts`

**Interfaces:**
- Consumes: `uninstallFrontload`, `UninstallResult`, `resolveRepo`, `--repo`, `--home`, and `--keep-package`.
- Produces: `formatUninstallOutput(result)` and public `frontload uninstall` behavior.

- [ ] **Step 1: Write failing formatter tests**

Assert grouped output includes `Frontload uninstall complete`, `[removed]`, `[absent]`, and, for failures, `Frontload uninstall incomplete` plus `[failed]` and the error detail.

- [ ] **Step 2: Run formatter tests and verify RED**

Run: `pnpm exec vitest run tests/unit/cli-uninstall-output.test.ts`

Expected: FAIL because the formatter does not exist.

- [ ] **Step 3: Implement the minimal formatter**

Render repository, agent, and package records in stable order, using home-relative display paths where applicable. Do not emit raw JSON.

- [ ] **Step 4: Run formatter tests and verify GREEN**

Run: `pnpm exec vitest run tests/unit/cli-uninstall-output.test.ts`

Expected: PASS.

- [ ] **Step 5: Write a failing end-to-end CLI test**

Build first, then run `dist/src/cli/index.js uninstall` against temporary repo/home fixtures with a fake PATH containing package-manager scripts. Assert cleanup, unrelated-config preservation, readable output, zero exit on success, nonzero exit on a real package-manager failure, and no package-manager calls under `--keep-package`.

- [ ] **Step 6: Run the CLI test and verify RED**

Run: `pnpm build && pnpm exec vitest run tests/e2e/cli-mcp.test.ts -t "uninstalls every initialized Frontload artifact"`

Expected: FAIL with Commander reporting unknown command `uninstall`.

- [ ] **Step 7: Register the public command**

Import `uninstallFrontload` and `formatUninstallOutput`, then register:

```ts
program.command("uninstall")
  .option("--repo <repo>", "repository root", ".")
  .option("--home <dir>", "home directory for agent configuration cleanup")
  .option("--keep-package", "remove initialized artifacts but keep the global package")
  .action((opts) => {
    const result = uninstallFrontload(
      resolveRepo(opts.repo),
      opts.home ? path.resolve(opts.home) : os.homedir(),
      { keepPackage: !!opts.keepPackage },
    );
    process.stdout.write(formatUninstallOutput(result));
    if (result.failures.length > 0) process.exitCode = 1;
  });
```

The shutdown pause guard must not block uninstall.

- [ ] **Step 8: Run CLI and formatter tests and verify GREEN**

Run: `pnpm build && pnpm exec vitest run tests/unit/cli-uninstall-output.test.ts tests/e2e/cli-mcp.test.ts -t "uninstall"`

Expected: PASS.

- [ ] **Step 9: Commit the CLI**

```bash
git add src/cli/uninstall-output.ts src/cli/index.ts tests/unit/cli-uninstall-output.test.ts tests/e2e/cli-mcp.test.ts
git commit -m "feat: add Frontload uninstall command"
```

### Task 4: Shutdown documentation and verification

**Files:**
- Modify: `README.md`
- Check: `docs/`, `AGENTS.md`, `plugins/*/README.md`, `skills/frontload/SKILL.md`, `plugins/*/skills/frontload/SKILL.md`

**Interfaces:**
- Consumes: final CLI syntax and the no-registry limitation.
- Produces: concise uninstall instructions for one or multiple initialized repositories.

- [ ] **Step 1: Write a failing documentation assertion**

Extend the existing root README test to require `frontload uninstall`, `--keep-package`, and the instruction to run cleanup once per initialized repository.

- [ ] **Step 2: Run the documentation test and verify RED**

Run: `pnpm exec vitest run tests/unit/config.test.ts -t "README"`

Expected: FAIL because the shutdown README has no uninstall instructions.

- [ ] **Step 3: Add concise README instructions**

Document the default one-repository command and multiple-repository sequence:

```bash
frontload uninstall --repo /path/to/first --keep-package
frontload uninstall --repo /path/to/final
```

State that the final command removes the global package and that unrelated agent settings are preserved.

- [ ] **Step 4: Audit all required documentation locations**

Run:

```bash
rg -n "init|install|upgrade|uninstall|Frontload" README.md docs AGENTS.md plugins/*/README.md skills/frontload/SKILL.md plugins/*/skills/frontload/SKILL.md
```

Update only stale user-facing shutdown/removal guidance.

- [ ] **Step 5: Run documentation and uninstall tests**

Run: `pnpm exec vitest run tests/unit/config.test.ts tests/unit/uninstall.test.ts tests/unit/cli-uninstall-output.test.ts`

Expected: PASS.

- [ ] **Step 6: Run the full repository verification**

Run in order through Frontload summaries where supported:

```bash
pnpm lint
pnpm build
pnpm test
pnpm e2e
node dist/src/cli/index.js validate-plugins --repo .
pnpm proof
```

Expected: every command exits 0 with the existing intentional paused-test skips only.

- [ ] **Step 7: Review the final diff and requirement coverage**

Run `frontload diff --repo .`, `git diff --check`, and `git status --short`. Compare the result line by line with `docs/superpowers/specs/2026-07-18-uninstall-frontload-design.md` and remove any dead code or undocumented behavior.

- [ ] **Step 8: Commit documentation and final corrections**

```bash
git add README.md tests/unit/config.test.ts docs/superpowers/plans/2026-07-18-uninstall-frontload.md
git commit -m "docs: explain complete Frontload removal"
```

- [ ] **Step 9: Push the PR branch**

```bash
git push origin pause-agent-integrations
```

Confirm PR #62 points at the pushed HEAD and inspect `gh pr checks 62` without claiming CI is green until every reported check succeeds.
