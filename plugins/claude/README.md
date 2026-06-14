# Frontload for Claude Code

This folder packages Frontload as a Claude Code plugin.

It bundles:

- a Claude plugin manifest
- a Frontload skill
- an MCP server configuration

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
It also copies the skill to `~/.claude/skills/frontload`.

For local development, test the repo plugin with Claude Code:

```bash
claude --plugin-dir ./plugins/claude
```

The MCP config calls the global `frontload` binary directly.

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
