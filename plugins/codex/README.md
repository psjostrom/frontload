# Frontload for Codex

This folder packages Frontload as a Codex plugin.

It bundles:

- a Codex plugin manifest
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

Choose Codex when prompted. Init merges the Frontload MCP server into the
expected Codex config, copies the skill to `~/.codex/skills/frontload`, and
points MCP at the installed `frontload` CLI.

For local development, build the repo and point Codex at this plugin folder.

The MCP config calls the global `frontload` binary directly.

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
