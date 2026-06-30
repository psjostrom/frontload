# Frontload for Codex

This folder packages Frontload as a Codex plugin.

It bundles:

- a Codex plugin manifest
- a Frontload skill
- a Frontload hook template

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

Choose Codex when prompted. Init merges the Frontload MCP server into the
expected Codex config, copies the skill to `~/.codex/skills/frontload`, and
points MCP at the installed `frontload` CLI. It also merges PreToolUse and
PostToolUse Bash hooks into `~/.codex/hooks.json`. Open `/hooks` once to review
and approve those command hooks.

For local development, build the repo and point Codex at this plugin folder.

## Behavior

When the plugin is enabled, Codex can call Frontload MCP tools for:

- repo indexing
- task dossiers
- indexed search
- budgeted reads
- summarized command output
- diff summaries
- budget reports

The skill tells Codex to prefer those tools before broad raw exploration.
The hooks enforce Frontload rewrites and output caps for interceptable Bash
calls in initialized repositories. Codex does not currently expose
Claude-equivalent native Read/Grep/Glob hook names, so native read and search
coverage is not equivalent.
