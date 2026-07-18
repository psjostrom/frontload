# Argent-Style Frontload Uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `frontload uninstall` remove exactly Frontload's installed content and invoke one detected package manager for global removal.

**Architecture:** Treat the package's bundled skill and plugin trees as the installed-content manifest, following Argent. Shared config is cleaned semantically, copied files are removed by exact relative path with empty-directory pruning, and package removal uses the same invocation-based package-manager detection as init with npm as the fallback.

**Tech Stack:** TypeScript, Node.js filesystem and child-process APIs, Vitest, pnpm.

## Global Constraints

- Keep all agent entrypoints inert.
- Preserve unrelated configuration and files.
- Do not add runtime network calls, telemetry, or source upload.
- Keep `--keep-package` for multi-repository cleanup.
- Use test-first development for each behavior change.

---

### Task 1: Exact bundled-content cleanup

**Files:**
- Modify: `tests/unit/uninstall.test.ts`
- Modify: `src/install/uninstall.ts`
- Modify: `src/install/install.ts`

**Interfaces:**
- Consumes: the packaged directories `plugins/{codex,claude,opencode}/skills/frontload` and the generated OpenCode wrapper.
- Produces: a cleanup helper that deletes exact bundled relative files and prunes only empty directories.

- [ ] Add a unit test containing an installed Frontload skill plus an unrelated file in the same target directory.
- [ ] Run `pnpm vitest run tests/unit/uninstall.test.ts` and confirm recursive target deletion fails the new assertion.
- [ ] Export package-root lookup as needed and implement exact bundled-file removal with bottom-up empty-directory pruning.
- [ ] Run the focused test and confirm the Frontload files disappear while unrelated files remain.

### Task 2: Valid quoted Codex TOML cleanup

**Files:**
- Modify: `tests/unit/uninstall.test.ts`
- Modify: `src/install/uninstall.ts`

**Interfaces:**
- Consumes: a parsed managed Codex MCP server and the original TOML text.
- Produces: removal of quoted or unquoted Frontload table headers and their nested tables without touching other tables.

- [ ] Add a unit test for `[mcp_servers."frontload_repo"]` with an unrelated server.
- [ ] Run the focused unit test and confirm the quoted Frontload table remains before the fix.
- [ ] Normalize TOML dotted table keys before matching managed parsed keys.
- [ ] Run the focused unit test and confirm only the managed table is removed.

### Task 3: Detected global package removal

**Files:**
- Modify: `tests/unit/uninstall.test.ts`
- Modify: `src/install/uninstall.ts`

**Interfaces:**
- Consumes: the active Frontload package root and supported package-manager global roots.
- Produces: zero or one `GlobalUninstallCommand`, followed by a single package removal record.

- [ ] Replace the four-manager test with cases proving npm, pnpm, Yarn, Bun, and absent detection.
- [ ] Run the focused unit test and confirm the existing four-command implementation fails.
- [ ] Implement package ownership detection and select only the matching uninstall command.
- [ ] Run the focused unit test and confirm one matching command or an absent record.

### Task 4: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `docs/security.md`
- Modify: `docs/superpowers/specs/2026-07-18-uninstall-frontload-design.md`
- Modify: uninstall-related tests as required by integration behavior.

**Interfaces:**
- Consumes: the completed uninstall behavior.
- Produces: accurate shutdown instructions and a verified PR branch.

- [ ] Update docs to describe detected package removal and remove active hook-gating claims.
- [ ] Run `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm e2e`, `node dist/src/cli/index.js validate-plugins --repo .`, and `pnpm proof`.
- [ ] Review `git diff --check` and the final diff for unrelated changes.
- [ ] Commit with a conventional title and push `pause-agent-integrations` to PR #62.
