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

Init writes the Frontload MCP server into project `.codex/config.toml`, copies
the Frontload skill to `~/.codex/skills/frontload`, and points MCP at the
installed `frontload` CLI. It also merges PreToolUse and PostToolUse Bash hooks
into `~/.codex/hooks.json`.

Restart Codex after init. Open `/hooks` once to review and approve the command
hooks.

Add `.codex/` to `.gitignore` unless your team intentionally wants to share
project-local Codex config. Frontload pins the MCP server to an absolute repo
path in that file.

If `frontload` is not already installed globally, init prompts before running
`npm install -g frontload`.

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
calls in initialized repositories. They are stored globally, but their command
checks for `.frontload/` and exits before starting `frontload` outside
initialized repositories.

Because MCP config is project-local, running init in another repo does not
replace this repo's Frontload MCP entry. If `frontload doctor --repo .` passes
but a running Codex session still reports `Transport closed`, restart Codex so it
reloads the MCP process.

Codex does not currently expose Claude-equivalent native Read/Grep/Glob hook
names, so native read and search coverage is not equivalent.

## Local Plugin Development

Most users do not need this section. To test this checked-in plugin package
from a Frontload source checkout, build the project first and then point Codex
at this plugin folder.
