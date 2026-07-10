# Frontload for opencode

Use Frontload with opencode to give the agent repo dossiers, budgeted reads,
summarized command output, diff summaries, and budget reports through MCP.

## Setup

From the repository where you want Frontload enabled:

```bash
npx frontload init --agents opencode
```

You can also run the interactive setup and choose opencode:

```bash
npx frontload init
```

Init writes the Frontload MCP server entry to project `opencode.json` by
default, or to `~/.config/opencode/opencode.json` with `--scope global`. If
`opencode.jsonc` already exists, init writes to that instead and preserves
comments. It also copies the Frontload skill to
`~/.config/opencode/skills/frontload`.

Restart opencode after init so it loads the MCP server and skill.

After that, use opencode normally. The installed Frontload skill tells the
agent to use MCP dossiers, search, budgeted reads, command summaries, diff
summaries, and budget reports before broad raw exploration.

If `frontload` is not already installed globally, init prompts before running
`npm install -g frontload`.

## Behavior

When setup is complete, opencode can call Frontload MCP tools for:

- repo indexing
- task dossiers
- indexed search
- budgeted reads
- summarized command output
- diff summaries
- budget reports

opencode does not need a manual `frontload index` step before each task. The
MCP dossier and search tools build the repo index when it is missing and
refresh changed files automatically.

Init also installs a gate plugin (`frontload-gate.js`) to
`~/.config/opencode/plugins/`. The gate intercepts `bash` tool calls through
opencode's `tool.execute.before` and `tool.execute.after` plugin hooks,
applying the same budget policy as the Codex and Claude Code hooks: broad
shell commands are rewritten through Frontload summaries, noisy output is
compacted to the configured budget cap.

## Config Scope

Init writes the MCP entry to project `opencode.json` (or existing
`opencode.jsonc`) by default. Frontload pins the MCP server to an absolute repo
path in that file, so if your team shares it in git, either add it to
`.gitignore` or use `--scope global` to write to
`~/.config/opencode/opencode.json` instead. opencode merges project
and global config, so a global entry still applies when you open the repo.

## Local Plugin Development

Most users do not need this section. To test this checked-in plugin package
from a Frontload source checkout, build the project first and then copy the
skill manually:

```bash
pnpm install
pnpm build
cp -r plugins/opencode/skills/frontload ~/.config/opencode/skills/frontload
```
