# Host Enforcement Design

## Goal

Make Frontload actively bound expensive native tool use in Claude Code and the
parts of Codex that its hook API can intercept, without claiming unsupported
parity between the hosts.

## Scope

This slice implements item #3 from the implementation brief:

- Claude Code source reads are line-bounded before execution.
- Claude Code native Grep and Glob output is compacted after execution.
- Claude Code Bash commands continue to use the shared rewrite policy.
- Codex installs global Bash hooks that use the same rewrite policy and cap
  oversized command output.
- Both hook adapters are inert outside repositories containing `.frontload`.
- Existing unrelated hooks are preserved when Frontload is installed again.

Real savings accounting is a separate slice because it changes event and report
contracts across CLI, MCP, and hooks.

## Capability Model

### Shared policy

`src/gate/gate.ts` owns host-neutral decisions:

- rewrite test, typecheck, and lint commands through `frontload run`;
- rewrite safe broad search/inventory commands through `frontload search`;
- rewrite lockfile `cat` through `frontload read`;
- cap Claude Read requests to a configured line limit;
- compact observed textual or string-array tool output to the configured output
  character budget.

Policy reasons say "the agent", not a host name.

### Claude Code

Claude supports the required native-tool lifecycle:

- `PreToolUse` for `Read|Bash` returns `updatedInput`;
- Read keeps `file_path`, `offset`, and other fields, while setting `limit` to
  `min(existingLimit, maxReadLines)` or `maxReadLines`;
- noisy generated and lockfile reads are still denied in favor of Frontload's
  budgeted read;
- `PostToolUse` for `Grep|Glob` returns `updatedToolOutput`;
- output compaction preserves the native response schema. Strings remain
  strings, arrays remain arrays, and object keys/scalar types remain intact.
  Trailing result entries and known payload fields are reduced; enum, count,
  duration, and other scalar metadata remain unchanged. An existing boolean
  `truncated` field is set to `true`. If the native response's minimum schema
  cannot fit the configured budget, the hook fails open rather than emitting an
  invalid replacement that Claude would ignore.

### Codex

Codex currently exposes hooks for supported shell-like tool calls, apply_patch,
and MCP tools. It does not expose Claude-equivalent native Read/Grep/Glob hook
names. Frontload therefore installs:

- `~/.codex/hooks.json` `PreToolUse` matcher `^Bash$`, invoking
  `frontload hook pre-tool-use --host codex`;
- `~/.codex/hooks.json` `PostToolUse` matcher `^Bash$`, invoking
  `frontload hook post-tool-use --host codex`.

PreToolUse uses the shared rewrite policy. PostToolUse replaces an oversized
observed Bash response using Codex's supported top-level `decision: "block"`
and bounded `reason` response. Documentation must describe this as enforcement
for interceptable Bash calls, not complete native-tool parity. The user must
approve the installed command hook once with Codex `/hooks`.

## Configuration

The existing `budgets.maxToolOutputChars` controls PostToolUse output
compaction and must be at least 64 characters so structured JSON has a usable
minimum representation. Add one gate setting:

```json
{
  "gate": {
    "enabled": true,
    "rewriteCommands": true,
    "blockBroadShell": true,
    "blockNoisyReads": true,
    "maxReadLines": 200
  }
}
```

No backward-compatibility migration is required. Normal schema defaults fill
the field for existing partial config files.

## Host Adapters

The CLI accepts an explicit host so output serialization is never inferred from
ambiguous payload fields:

```text
frontload hook pre-tool-use --host claude
frontload hook pre-tool-use --host codex
frontload hook post-tool-use --host claude
frontload hook post-tool-use --host codex
```

`runPreToolUseHook` emits the shared `hookSpecificOutput` shape accepted by both
hosts. `runPostToolUseHook` emits:

- Claude: `hookSpecificOutput.updatedToolOutput`;
- Codex: top-level `decision: "block"` and `reason`.

All entry points fail open on malformed input or runtime errors.

## Shell Rewrite Expansion

Codex commonly uses ripgrep and fd, but Frontload's index intentionally excludes
configured extensions, oversized files, and ignored paths. Rewriting `rg` or
`fd` through that index would therefore change which files and matches exist.
Leave all `rg` and `fd` commands unchanged and rely on PostToolUse output
bounding when the host exposes that hook.

## Installation

Claude settings contain one Frontload PreToolUse group and one Frontload
PostToolUse group. Codex global hooks contain one of each. An upsert:

1. removes stale Frontload hook commands from the event;
2. preserves every unrelated group and hook;
3. appends the current Frontload group;
4. writes only when content changed unless `--force` is used.

Frontload hook identity is based on a command invoking `frontload hook
pre-tool-use` or `frontload hook post-tool-use`, not an exact old argument
array, so stale versions are replaced.

The checked-in `plugins/claude/hooks/hooks.json`,
`plugins/codex/hooks/hooks.json`, and standalone hook wrappers use the same
explicit `--host` commands as init-generated configuration. Plugin validation
therefore tests the configuration users actually receive.

`src/hooks/definitions.ts` is the canonical source for host hook commands,
matchers, timeouts, arguments, and status messages. Installation consumes those
definitions directly, while validation checks bundled hook JSON against them.

## Documentation Contract

The README, Codex setup, and plugin READMEs must state:

- Claude has Read/Bash pre-hooks and Grep/Glob post-hooks.
- Codex has best-effort hard enforcement for hook-interceptable Bash calls.
- Codex native read/search coverage is not currently equivalent to Claude.
- Codex users run `/hooks` once to trust the command hook.
- Hook logic is inert outside initialized repositories.

## Verification

Unit tests cover:

- bounded Claude Read input;
- noisy-read denial remains intact;
- complete `rg` and `fd` pass-through without index-based semantic loss;
- shape-preserving Claude output compaction for string, array, and structured
  native-tool fixtures;
- Codex oversized-output replacement;
- fail-open behavior and `.frontload` scoping;
- merge-aware Claude and Codex hook installation;
- exact install notes and capability documentation.

The final verification is `pnpm build`, `pnpm test`, and `pnpm e2e`.
