# Frontload for Claude Code

Use Frontload with Claude Code to give the agent repo dossiers, budgeted reads,
summarized command output, diff summaries, and budget reports through MCP.

## Setup

From the repository where you want Frontload enabled:

```bash
npx frontload init --agents claude
```

You can also run the interactive setup and choose Claude Code:

```bash
npx frontload init
```

Init writes the MCP server entry to project `.mcp.json` by default, or to
`~/.claude.json` with `--scope global`. It also writes Frontload hooks to the
matching Claude settings file and copies the skill to
`~/.claude/skills/frontload`.

Restart Claude Code after init. Inside Claude Code, use `/mcp` to verify the
Frontload MCP server is connected.

If `frontload` is not already installed globally, init prompts before running
`npm install -g frontload`.

## Behavior

When setup is complete, Claude Code can call Frontload MCP tools for:

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
repositories containing `.frontload/`.

## Local Plugin Development

Most users do not need this section. To test this checked-in plugin package
from a Frontload source checkout, build the project first:

```bash
pnpm install
pnpm build
claude --plugin-dir ./plugins/claude
```
