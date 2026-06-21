# Host Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce Frontload budgets through Claude native-tool hooks and Codex interceptable Bash hooks while documenting the exact host capability boundary.

**Architecture:** Keep rewrite and compaction policy in `src/gate/gate.ts`. Use explicit host adapters in `src/gate/entry.ts`, and merge host-native hook configuration from `src/install/install.ts`. Claude uses updated native input/output; Codex uses Bash rewrite plus supported post-command output replacement.

**Tech Stack:** TypeScript, Node.js, Commander, Zod, Vitest, Claude Code hooks JSON, Codex hooks JSON.

---

## File Structure

- Modify `src/config/config.ts` and `frontload.config.example.json`
  - Add `gate.maxReadLines`.
- Modify `src/gate/gate.ts`
  - Bound Read input, add safe `rg`/`fd` rewrites, and expose output compaction.
- Modify `src/gate/entry.ts`
  - Add explicit host handling and PostToolUse serialization.
- Modify `src/cli/index.ts`
  - Add `--host` to both hook commands.
- Modify `hooks/pre-tool-use.ts` and create `hooks/post-tool-use.ts`
  - Keep packaged standalone wrappers aligned with the explicit host API.
- Modify `src/install/install.ts`
  - Merge Claude pre/post hooks and Codex global pre/post hooks.
- Modify `plugins/claude/hooks/hooks.json` and `plugins/codex/hooks/hooks.json`
  - Keep bundled templates aligned with init-generated hooks.
- Modify tests under `tests/unit`
  - Lock policy, entry, config, and installer behavior.
- Modify `README.md`, `docs/codex-setup.md`, and plugin READMEs
  - Publish the host capability matrix and trust step.

## Task 1: Shared Gate Policy

**Files:**
- Modify: `tests/unit/config.test.ts`
- Modify: `tests/unit/gate.test.ts`
- Modify: `src/config/config.ts`
- Modify: `src/gate/gate.ts`
- Modify: `frontload.config.example.json`

- [ ] **Step 1: Write failing configuration and policy tests**

Add assertions equivalent to:

```ts
expect(loadConfig(process.cwd()).gate.maxReadLines).toBe(200);

const bounded = evaluate(
  { tool_name: "Read", tool_input: { file_path: "src/gate/gate.ts", offset: 40, limit: 500 } },
  defaultConfig
);
expect(bounded?.hookSpecificOutput.updatedInput).toEqual({
  file_path: "src/gate/gate.ts",
  offset: 40,
  limit: 200
});

expect(evaluate(
  { tool_name: "Bash", tool_input: { command: "rg --files" } },
  defaultConfig
)?.hookSpecificOutput.updatedInput?.command).toBe("frontload search '.' --limit 50");

expect(evaluate(
  { tool_name: "Bash", tool_input: { command: "rg -F 'needle' src" } },
  defaultConfig
)?.hookSpecificOutput.updatedInput?.command).toBe("frontload search 'needle' --limit 20");

expect(evaluate(
  { tool_name: "Bash", tool_input: { command: "rg 'needle.*value' src" } },
  defaultConfig
)).toBeNull();
```

Add compaction tests:

```ts
expect(compactToolOutput("0123456789", 8)).toEqual({
  output: "012\n[Frontload truncated 7 chars]",
  originalChars: 10,
  outputChars: 35,
  truncated: true
});

expect(compactToolOutput(["alpha", "beta", "gamma"], 12).output).toEqual([
  "alpha",
  "[Frontload truncated 2 results]"
]);

const structured = compactToolOutput({
  filenames: Array.from({ length: 100 }, (_, i) => `src/file-${i}.ts`),
  durationMs: 12,
  numFiles: 100,
  truncated: false
}, 500);
expect(structured.output).toMatchObject({
  durationMs: 12,
  numFiles: 100,
  truncated: true
});
expect(Array.isArray((structured.output as { filenames: unknown }).filenames)).toBe(true);
```

The implementation may choose a marker whose own length exceeds tiny synthetic
budgets, but must keep normal configured outputs at or below the budget. Tests
should use realistic limits for the final length assertion.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm vitest run tests/unit/config.test.ts tests/unit/gate.test.ts
```

Expected: failures for missing `maxReadLines`, missing Read rewrite, missing
`rg`/`fd` rewrites, and missing `compactToolOutput`.

- [ ] **Step 3: Implement the minimal shared policy**

Add:

```ts
gate: z.object({
  enabled: z.boolean().default(true),
  rewriteCommands: z.boolean().default(true),
  blockBroadShell: z.boolean().default(true),
  blockNoisyReads: z.boolean().default(true),
  maxReadLines: z.number().int().positive().default(200)
})
```

Require `budgets.maxToolOutputChars >= 64`, because structured PostToolUse
replacement needs a usable minimum JSON representation.

In `evaluate`, keep noisy-read denial first, then return `allow` with:

```ts
updatedInput: {
  ...input,
  limit: Math.min(
    typeof input.limit === "number" && input.limit > 0 ? input.limit : config.gate.maxReadLines,
    config.gate.maxReadLines
  )
}
```

Implement `rg` and `fd` parsing with `shellWords`. Rewrite only the
whole-repository forms described by the design; path-scoped forms pass through.
Export:

```ts
export type CompactedToolOutput = {
  output: unknown;
  originalChars: number;
  outputChars: number;
  fitsBudget: boolean;
  truncated: boolean;
};

export function compactToolOutput(value: unknown, maxChars: number): CompactedToolOutput;
```

Strings remain strings. Arrays remain arrays. Plain objects retain their keys
and scalar field types while oversized string leaves or trailing result entries
are reduced. If a compacted object has a boolean `truncated` property, set it
to `true`. Numeric fields remain unchanged while array/string reduction is
enough; if metadata alone exceeds the cap, oversized numeric metadata may be
reduced to zero as a final same-type fallback. If the minimized native schema
still does not fit, return `fitsBudget: false` so the host adapter fails open
instead of emitting an invalid replacement. Unknown non-JSON values are
returned unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/unit/config.test.ts tests/unit/gate.test.ts
```

Expected: all focused tests pass.

## Task 2: Host Hook Entry Points

**Files:**
- Create: `tests/unit/hook-entry.test.ts`
- Modify: `src/gate/entry.ts`
- Modify: `src/cli/index.ts`
- Modify: `hooks/pre-tool-use.ts`
- Create: `hooks/post-tool-use.ts`

- [ ] **Step 1: Write failing host adapter tests**

Use a temporary initialized repo and explicit raw payloads:

```ts
const claude = await runPostToolUseHook("claude", JSON.stringify({
  cwd: repo,
  tool_name: "Grep",
  tool_response: "x".repeat(9000)
}));
expect(JSON.parse(claude!).hookSpecificOutput.hookEventName).toBe("PostToolUse");
expect(JSON.parse(claude!).hookSpecificOutput.updatedToolOutput.length).toBeLessThanOrEqual(8000);

const codex = await runPostToolUseHook("codex", JSON.stringify({
  cwd: repo,
  tool_name: "Bash",
  tool_response: "x".repeat(9000)
}));
expect(JSON.parse(codex!)).toMatchObject({ decision: "block" });
expect(JSON.parse(codex!).reason.length).toBeLessThanOrEqual(8000);
```

Also assert:

- no output for a repo without `.frontload`;
- no output for malformed JSON;
- no output when the response already fits;
- PreToolUse still produces the shared rewrite for both hosts.

- [ ] **Step 2: Run the entry tests and verify RED**

Run:

```bash
pnpm vitest run tests/unit/hook-entry.test.ts
```

Expected: import/type failures because `HookHost` and `runPostToolUseHook` do not
exist.

- [ ] **Step 3: Implement host-aware entry serialization**

Export:

```ts
export type HookHost = "claude" | "codex";
export async function runPreToolUseHook(host: HookHost, rawInput?: string): Promise<string | null>;
export async function runPostToolUseHook(host: HookHost, rawInput?: string): Promise<string | null>;
```

The post hook reads `tool_response`, calls `compactToolOutput` with
`config.budgets.maxToolOutputChars`, and emits:

```ts
host === "claude"
  ? { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: compacted.output } }
  : { decision: "block", reason: compacted.output };
```

Codex post processing only accepts string responses. Claude accepts strings and
string arrays. Both functions catch all errors and return `null`.

Wire Commander:

```ts
program.command("hook").command("pre-tool-use")
  .requiredOption("--host <host>")
  .action(async ({ host }) => writeHook(await runPreToolUseHook(parseHookHost(host))));

program.command("hook").command("post-tool-use")
  .requiredOption("--host <host>")
  .action(async ({ host }) => writeHook(await runPostToolUseHook(parseHookHost(host))));
```

Update `hooks/pre-tool-use.ts` to call the explicit Claude adapter and add a
matching standalone post hook:

```ts
const output = await runPostToolUseHook("claude");
if (output) process.stdout.write(output);
```

- [ ] **Step 4: Run entry and CLI tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/unit/hook-entry.test.ts tests/unit/cli-options.test.ts
```

Expected: all focused tests pass.

## Task 3: Merge-Aware Host Installation

**Files:**
- Modify: `tests/unit/install.test.ts`
- Modify: `src/install/install.ts`
- Modify: `plugins/claude/hooks/hooks.json`
- Modify: `plugins/codex/hooks/hooks.json`

- [ ] **Step 1: Write failing installer tests**

Update Codex expectations to include `.codex/hooks.json`. Assert it contains:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "^Bash$",
      "hooks": [{
        "type": "command",
        "command": "frontload hook pre-tool-use --host codex",
        "timeout": 10
      }]
    }],
    "PostToolUse": [{
      "matcher": "^Bash$",
      "hooks": [{
        "type": "command",
        "command": "frontload hook post-tool-use --host codex",
        "timeout": 10
      }]
    }]
  }
}
```

Update Claude expectations to use:

```json
{"command":"frontload","args":["hook","pre-tool-use","--host","claude"]}
{"command":"frontload","args":["hook","post-tool-use","--host","claude"]}
```

Add merge tests with unrelated hooks and stale Frontload hooks in both host
files. Assert unrelated entries remain and exactly one current Frontload group
exists per event.

- [ ] **Step 2: Run installer tests and verify RED**

Run:

```bash
pnpm vitest run tests/unit/install.test.ts
```

Expected: failures because Codex hooks and Claude PostToolUse are not installed.

- [ ] **Step 3: Implement generic JSON hook upsert**

Define host hook constants and a helper with this contract:

```ts
function upsertHookGroups(
  file: string,
  definitions: Array<{ event: "PreToolUse" | "PostToolUse"; matcher: string; hook: JsonObject }>,
  force: boolean
): WriteResult;
```

Treat a hook as Frontload-owned when:

```ts
typeof hook.command === "string" &&
(
  hook.command.includes("frontload hook pre-tool-use") ||
  hook.command.includes("frontload hook post-tool-use") ||
  (
    hook.command === "frontload" &&
    Array.isArray(hook.args) &&
    hook.args[0] === "hook" &&
    ["pre-tool-use", "post-tool-use"].includes(String(hook.args[1]))
  )
)
```

Use `~/.codex/hooks.json` for Codex. Preserve the existing MCP config and skill
installation. Add a Codex note requiring `/hooks` trust.

Update both checked-in plugin hook templates to the same pre/post groups and
explicit host arguments/commands produced by init.

- [ ] **Step 4: Run installer tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/unit/install.test.ts
```

Expected: all installer tests pass.

## Task 4: Capability Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/codex-setup.md`
- Modify: `plugins/codex/README.md`
- Modify: `plugins/claude/README.md`
- Test: `tests/unit/install.test.ts`

- [ ] **Step 1: Add failing documentation assertions**

Read the generated install notes and checked-in docs. Assert they contain:

- Codex `/hooks`;
- "interceptable Bash" or equivalent precise scope;
- no statement that Codex setup is only advisory;
- Claude `Grep|Glob` PostToolUse coverage.

- [ ] **Step 2: Run installer tests and verify RED**

Run:

```bash
pnpm vitest run tests/unit/install.test.ts
```

Expected: documentation assertions fail on current advisory-only wording.

- [ ] **Step 3: Update user-facing documentation**

Document the matrix:

| Host | PreToolUse | PostToolUse | Limitation |
| --- | --- | --- | --- |
| Claude Code | Read and Bash | Grep and Glob | Native output shape must be string or string array to compact |
| Codex | Interceptable Bash | Interceptable Bash | No native Read/Grep/Glob parity; hook coverage follows Codex support |

State that hooks are inert without `.frontload` and Codex requires one `/hooks`
trust confirmation.

- [ ] **Step 4: Run documentation assertions and verify GREEN**

Run:

```bash
pnpm vitest run tests/unit/install.test.ts
```

Expected: all installer/documentation assertions pass.

## Task 5: Integration Verification

**Files:**
- Modify only if a failing integration test identifies a defect.

- [ ] **Step 1: Run build and all unit tests**

Run:

```bash
pnpm build
pnpm test
```

Expected: zero TypeScript errors and all unit tests pass.

- [ ] **Step 2: Run end-to-end tests**

Run:

```bash
pnpm e2e
```

Expected: all end-to-end tests pass.

- [ ] **Step 3: Inspect the complete diff**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Expected: no whitespace errors, only host-enforcement files changed, and no
generated or temporary files tracked.
