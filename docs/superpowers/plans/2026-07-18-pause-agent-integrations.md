# Pause Agent Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every shipped Codex, Claude Code, and OpenCode integration inert while preserving Frontload's audit evidence and dormant implementation for a separately gated rewrite.

**Architecture:** A shared status module owns the pause message. CLI activation commands fail before side effects, host hook commands become silent fail-open consumers, and the OpenCode adapter/package exports no hooks. Shipped skills, manifests, plugin documentation, package metadata, and the root README describe the pause instead of advertising an active product.

**Tech Stack:** TypeScript, Commander, Vitest, Node.js 20+, JSON plugin manifests, Markdown skills and documentation.

## Global Constraints

- Disable Codex, Claude Code, and OpenCode equally.
- Do not infer that unmeasured Claude Code or OpenCode paths are beneficial.
- Do not delete lower-level filtering, indexing, MCP handler, or gate-evaluator source needed for the rewrite.
- `init`, `upgrade`, and `mcp` must fail before prompts, installation, writes, or server startup.
- Codex and Claude hook commands must consume stdin, emit nothing, and exit zero.
- OpenCode must register no hooks and its bundled plugin must not load an adapter.
- Root `README.md` must remain a very short pause notice with no setup workflow.
- Use tests first and observe the expected failure before production edits.
- Do not push or open a PR.

---

### Task 1: Block CLI Activation

**Files:**
- Create: `src/product/status.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/e2e/cli-mcp.test.ts`

**Interfaces:**
- Produces: `agentIntegrationsPaused: true`, `agentIntegrationsPauseMessage: string`, and `agentIntegrationsReportPath: string` for all runtime boundaries.
- Consumes: existing Commander actions and the existing `readStdin()` hook helper.

- [ ] **Step 1: Write failing CLI tests**

Add one e2e test that runs the built CLI for `init --agents all`, `upgrade --refresh-only`, and `mcp`. Assert that each exits `1`, includes `agent integrations are paused`, and that init creates no `.codex/config.toml`, `.mcp.json`, or `opencode.json`. Add a hook assertion that sends a rewriteable Bash payload to both host hook subcommands and expects exit `0` with empty stdout.

- [ ] **Step 2: Verify the CLI tests fail for the expected active behavior**

Run:

```bash
pnpm build
pnpm exec vitest run tests/e2e/cli-mcp.test.ts -t "keeps every agent integration paused"
```

Expected: FAIL because current init succeeds or writes integration state, hook commands emit decisions, upgrade refreshes config, and MCP starts instead of rejecting the command.

- [ ] **Step 3: Add the shared status module**

Create:

```ts
export const agentIntegrationsPaused = true;
export const agentIntegrationsReportPath = "proof/codex-net-benefit-audit.md";
export const agentIntegrationsPauseMessage =
  `Frontload agent integrations are paused after the Codex net-benefit audit found higher token use with no quality gain. See ${agentIntegrationsReportPath}.`;
```

- [ ] **Step 4: Guard the CLI boundaries**

Import the shared message and `readStdin`. Add a helper that writes the message to stderr and sets exit code `1`. Return through that helper at the beginning of `init`, `upgrade`, and `mcp` actions. Replace both host hook actions with `await readStdin()` and no output. Change the top-level Commander description to `Paused agent-integration experiment.`

- [ ] **Step 5: Verify the narrow CLI test passes**

Run the Step 2 commands again.

Expected: PASS; no integration files exist and hook stdout is empty.

- [ ] **Step 6: Commit the CLI barrier**

```bash
git add src/product/status.ts src/cli/index.ts tests/e2e/cli-mcp.test.ts
git commit -m "fix: pause agent integration entrypoints"
```

### Task 2: Make Shipped Host Adapters Inert

**Files:**
- Modify: `src/gate/adapters/opencode.ts`
- Modify: `src/plugins/opencode-gate-wrapper.ts`
- Modify: `src/plugins/validate.ts`
- Modify: `plugins/opencode/plugins/frontload-gate.js`
- Delete: `plugins/codex/hooks/hooks.json`
- Delete: `plugins/claude/hooks/hooks.json`
- Test: `tests/unit/opencode-gate.test.ts`
- Test: `tests/unit/plugins.test.ts`

**Interfaces:**
- Consumes: the shared `agentIntegrationsPaused` status.
- Produces: `FrontloadGate()` resolving to `{}` and a bundled wrapper that returns `{}` without loading any package adapter.

- [ ] **Step 1: Write failing adapter and packaging tests**

Change OpenCode adapter coverage to require an empty object for an initialized repository. Change plugin tests to require two checked files for Codex/Claude, no bundled hook file, and a bundled OpenCode wrapper containing a direct empty-object return with no adapter loader or dynamic import.

- [ ] **Step 2: Verify the adapter/package tests fail**

Run:

```bash
pnpm exec vitest run tests/unit/opencode-gate.test.ts tests/unit/plugins.test.ts
```

Expected: FAIL because OpenCode currently registers before/after hooks and bundled host packages still advertise active hook files and adapter loading.

- [ ] **Step 3: Disable OpenCode at both runtime layers**

Return `{}` immediately from `src/gate/adapters/opencode.ts` when the shared pause flag is true. Reduce `opencodeGatePluginWrapper()` and the bundled JS plugin to a static module whose `FrontloadGate` function returns `{}` and never resolves an adapter.

- [ ] **Step 4: Remove declarative host hooks and align validation**

Delete the Codex and Claude bundled hook JSON files. Remove active-hook assertions from plugin validation; validate only the manifest, paused skill, and, for OpenCode, the static paused wrapper. Rename error text from `must delegate` to `must remain paused`.

- [ ] **Step 5: Verify the adapter/package tests pass**

Run the Step 2 command again.

Expected: PASS with OpenCode inert and no bundled Codex/Claude hook files.

- [ ] **Step 6: Commit the host barriers**

```bash
git add src/gate/adapters/opencode.ts src/plugins/opencode-gate-wrapper.ts src/plugins/validate.ts plugins tests/unit/opencode-gate.test.ts tests/unit/plugins.test.ts
git commit -m "fix: make bundled agent adapters inert"
```

### Task 3: Replace Product Claims With the Pause Notice

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `plugins/codex/.codex-plugin/plugin.json`
- Modify: `plugins/claude/.claude-plugin/plugin.json`
- Modify: `plugins/codex/README.md`
- Modify: `plugins/claude/README.md`
- Modify: `plugins/opencode/README.md`
- Modify: `skills/frontload/SKILL.md`
- Modify: `plugins/codex/skills/frontload/SKILL.md`
- Modify: `plugins/claude/skills/frontload/SKILL.md`
- Modify: `plugins/opencode/skills/frontload/SKILL.md`
- Test: `tests/unit/config.test.ts`
- Test: `tests/unit/plugins.test.ts`

**Interfaces:**
- Consumes: the audit result and resume gate recorded in `proof/codex-net-benefit-audit.md`.
- Produces: short, non-operational public documentation and paused skills.

- [ ] **Step 1: Write failing documentation assertions**

Replace the obsolete README configuration test with assertions that root README is under 1,500 characters, contains `+59.96%`, `+31.85%`, `Codex`, `Claude Code`, `OpenCode`, and the audit report path, and contains neither `npx frontload init` nor `fl_repo_dossier`. Add plugin tests asserting every shipped Frontload skill contains `integration is paused` and no `fl_` tool name.

- [ ] **Step 2: Verify the documentation tests fail**

Run:

```bash
pnpm exec vitest run tests/unit/config.test.ts tests/unit/plugins.test.ts
```

Expected: FAIL because current documentation advertises setup and active tool use.

- [ ] **Step 3: Replace the documentation and metadata**

Replace root README with a pause notice containing only: status, measured reason,
disabled hosts, evidence links, existing-install warning, and resume gate. Replace
host READMEs and skills with short pointers to the root notice. Mark package and
plugin manifest descriptions as paused; remove active capability/default-prompt
claims from the Codex manifest.

- [ ] **Step 4: Verify the documentation tests pass**

Run the Step 2 command again.

Expected: PASS with no installation or active-agent workflow in shipped docs.

- [ ] **Step 5: Commit the public pause notice**

```bash
git add README.md package.json plugins skills tests/unit/config.test.ts tests/unit/plugins.test.ts
git commit -m "docs: mark Frontload integrations as paused"
```

### Task 4: Full Verification and Documentation Audit

**Files:**
- Modify only files required by verified failures in the preceding tasks.

**Interfaces:**
- Consumes: all pause commits.
- Produces: a clean, verified branch ready for user review without push or PR.

- [ ] **Step 1: Search for stale product setup claims**

Run:

```bash
rg -n "npx frontload init|fl_repo_dossier|Restart (Codex|Claude|opencode)|agent integration" README.md docs plugins skills AGENTS.md
```

Expected: active setup claims remain only in historical audit/design evidence or repository maintainer instructions, not shipped root/plugin READMEs or skills.

- [ ] **Step 2: Run the full repository verification**

Run:

```bash
pnpm lint
pnpm build
pnpm test
pnpm e2e
node dist/src/cli/index.js validate-plugins --repo .
```

Expected: all commands exit `0` with no test failures.

- [ ] **Step 3: Inspect packed contents**

Run `npm pack --dry-run` and confirm root README, paused skills/manifests, static OpenCode plugin, and no Codex/Claude bundled hook files are included.

- [ ] **Step 4: Review the complete diff and status**

Run:

```bash
git diff HEAD~3 --check
git diff HEAD~3 --stat
git status --short
```

Expected: only audit evidence, pause controls, tests, package metadata, and pause documentation changed; worktree is clean.
