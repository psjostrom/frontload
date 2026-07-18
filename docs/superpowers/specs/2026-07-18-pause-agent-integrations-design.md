# Pause Agent Integrations Design

Date: 2026-07-18

## Decision

Pause every Frontload agent integration: Codex, Claude Code, and OpenCode.
Frontload 0.3.1 is net negative in the completed Codex audit, and there is no
measured evidence that the untested Claude Code or OpenCode paths reverse the
same architectural costs. The project must not continue presenting any of these
paths as ready for use.

The pause is a reversible runtime kill switch. It preserves the implementation,
tests for lower-level filtering primitives, audit evidence, and plugin fixtures
needed for a possible rewrite. It does not delete the repository or pretend the
existing architecture is viable.

## Alternatives Considered

### Documentation-only pause

Rejected. Existing setup commands and runtime adapters would remain usable, so
the product would still incur the costs and reliability failures documented by
the audit.

### Delete all integration source and plugin fixtures

Rejected. Deletion would create a large, hard-to-review diff and discard useful
test and cleanup knowledge without making the pause safer than entrypoint guards.

### Reversible runtime kill switch

Selected. Block every user-facing activation boundary while leaving dormant
internals available for the separately gated rewrite.

## Required Behavior

### CLI activation

- `frontload init` exits non-zero before prompts, global installation, or writes.
- `frontload upgrade` exits non-zero before global installation or config refresh.
- `frontload mcp` exits non-zero before creating or advertising a server.
- All three commands emit the same concise pause reason and report path.
- Non-integration developer commands remain available for maintaining and
  evaluating the repository; they are not documented as a supported product.

### Existing host hooks

- Codex and Claude hook subcommands consume stdin, emit no decision or replacement,
  and exit zero. This is fail-open: the host's original command/output proceeds.
- OpenCode's exported adapter returns an empty hook object before inspecting the
  repository or registering callbacks.
- Existing 0.3.1 installations cannot be changed remotely. After the paused
  revision is installed, their dynamic CLI/adapter entrypoints become inert;
  users may still need to remove copied config and skill files manually.

### Status and documentation

- A small shared status module owns the pause flag, reason, and report path so
  entrypoints cannot drift.
- Root `README.md` is replaced with a very short pause notice. It includes the
  measured `+59.96%` token and `+31.85%` wall-time regressions, equal correctness,
  the disabled host list, links to the audit and issue log, and the hard resume
  condition.
- Package and CLI descriptions must say the project is paused rather than claim
  it is a working context/cost gateway.
- Host-specific READMEs and shipped skills must not advertise installation or
  instruct agents to invoke Frontload while the runtime is paused. Each becomes
  a short pointer to the root pause notice.

## Testing

- Add CLI integration coverage that verifies `init`, `upgrade`, and `mcp` fail
  with the shared message and create no integration files.
- Add hook coverage that verifies Codex and Claude CLI hooks return no output and
  exit zero for a payload that would previously have been rewritten.
- Change OpenCode adapter coverage to require an empty hook object even in an
  initialized repository.
- Add documentation assertions for the short root notice and absence of setup
  commands or active-workflow claims in shipped READMEs and skills.
- Run lint, build, unit, e2e, plugin validation, and package-content inspection.

## Resume Gate

The integrations remain paused until a replacement architecture passes the audit
report's fixed gate: at least 10% lower aggregate Codex total tokens after setup,
no task class more than 5% worse, equal correctness, zero integration failures,
no aggregate wall-time regression, and a positive result excluding cached input.
