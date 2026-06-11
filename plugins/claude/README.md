# Agent Budget for Claude Code

This folder packages Agent Budget as a Claude Code plugin.

It bundles:

- a Claude plugin manifest
- an Agent Budget skill
- an MCP server configuration
- a launcher that starts the shared Agent Budget CLI MCP server

## Local Development

From the repository root:

```bash
pnpm install
pnpm build
```

Recommended user install:

```bash
agent-budget install claude
```

This copies the Claude Code adapter to `~/.claude/plugins/agent-budget`.

Then start Claude Code with:

```bash
claude --plugin-dir ~/.claude/plugins/agent-budget
```

For local development, test the repo plugin with Claude Code:

```bash
claude --plugin-dir ./plugins/claude
```

When the adapter is copied away from this repository, the launchers call the
installed `agent-budget` binary. If the host cannot find it on `PATH`, set:

```bash
AGENT_BUDGET_CLI=/absolute/path/to/agent-budget
```

Inside Claude Code, use `/mcp` to verify the Agent Budget MCP server is connected.

## Behavior

When the plugin is enabled, Claude Code can call Agent Budget MCP tools for:

- repo indexing
- task dossiers
- indexed search
- budgeted reads
- summarized command output
- diff summaries
- budget reports

The skill tells Claude to prefer those tools before broad raw exploration.
