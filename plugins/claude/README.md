# Frontload for Claude Code

This folder packages Frontload as a Claude Code plugin.

It bundles:

- a Claude plugin manifest
- a Frontload skill
- Frontload PreToolUse and PostToolUse hook templates

## Local Development

From the repository root:

```bash
pnpm install
pnpm build
```

User setup:

```bash
npx frontload init
```

Choose Claude Code when prompted. Init writes the MCP server entry to
project `.mcp.json` by default, or `~/.claude.json` with `--scope global`.
It also writes the gate hook to Claude settings and copies the skill to
`~/.claude/skills/frontload`.

For local development, test the repo plugin with Claude Code:

```bash
claude --plugin-dir ./plugins/claude
```

Inside Claude Code, use `/mcp` to verify the Frontload MCP server is connected.

## Behavior

When the plugin is enabled, Claude Code can call Frontload MCP tools for:

- repo indexing
- task dossiers
- indexed search
- budgeted reads
- summarized command output
- diff summaries
- budget reports

The skill tells Claude to prefer those tools before broad raw exploration.
The PreToolUse hook rewrites configured test/lint/typecheck and broad shell
commands through Frontload, caps native Read windows, and blocks configured
noisy reads. The PostToolUse hook bounds native Grep and Glob output while
preserving each tool's response schema. Both hooks are inert outside
repositories containing `.frontload`.
