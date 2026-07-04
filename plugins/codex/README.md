# Frontload for Codex

Use Frontload with Codex to give the agent repo dossiers, budgeted reads,
summarized command output, diff summaries, and budget reports through MCP.

## Setup

From the repository where you want Frontload enabled:

```bash
npx frontload init --agents codex
```

You can also run the interactive setup and choose Codex:

```bash
npx frontload init
```

Init merges the Frontload MCP server into `~/.codex/config.toml`, copies the
Frontload skill to `~/.codex/skills/frontload`, and points MCP at the installed
`frontload` CLI. It also merges PreToolUse and PostToolUse Bash hooks into
`~/.codex/hooks.json`.

Restart Codex after init. Open `/hooks` once to review and approve the command
hooks.

If `frontload` is not already installed globally, init prompts before running
the matching global install command for your package manager.

## Behavior

When setup is complete, Codex can call Frontload MCP tools for:

- repo indexing
- task dossiers
- indexed search
- budgeted reads
- summarized command output
- diff summaries
- budget reports

The skill tells Codex to prefer those tools before broad raw exploration.

The hooks enforce Frontload rewrites and output caps for interceptable Bash
calls in initialized repositories. They are inert outside repositories
containing `.frontload/`.

Codex does not currently expose Claude-equivalent native Read/Grep/Glob hook
names, so native read and search coverage is not equivalent.

## Local Plugin Development

Most users do not need this section. To test this checked-in plugin package
from a Frontload source checkout, build the project first and then point Codex
at this plugin folder.
