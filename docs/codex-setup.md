# Codex Setup

Run init and choose Codex:

```bash
npx frontload init --agents codex
```

If `frontload` is not already installed globally, init prompts before running
`npm install -g frontload`. It then writes this MCP server into project
`.codex/config.toml`:

```toml
[mcp_servers.frontload]
command = "frontload"
args = ["mcp", "--repo", "/path/to/your/repo"]
```

Restart Codex after init. Codex reads MCP servers from project `.codex/config.toml`
for trusted projects, so each initialized repo can have its own Frontload MCP
entry. Init also copies the Frontload skill to `~/.codex/skills/frontload`.

Add `.codex/` to `.gitignore` unless your team intentionally wants to share
project-local Codex config. Frontload pins the MCP server to an absolute repo
path in that file.

Init also merges Frontload command hooks into `~/.codex/hooks.json`:

- `PreToolUse` rewrites supported broad or verbose Bash calls through bounded
  Frontload commands.
- `PostToolUse` bounds oversized Bash output that Codex exposes to hooks.

Open `/hooks` once after installation to review and approve the Frontload command
hooks. Codex stores trust against the exact hook definition, so a changed hook
may require review again.

Codex enforcement applies to Bash calls that the current Codex hook runtime
intercepts. Codex does not currently expose Claude-equivalent native
Read/Grep/Glob hook names, so native read and search coverage is not equivalent.
The Frontload hooks are stored globally, but their command first checks for a
`.frontload` directory from the active project upward. Repositories without
Frontload initialization exit before starting the `frontload` CLI.

Run `frontload doctor --repo .` to verify the active config. Doctor reports
whether Codex is using project or global config, whether the configured MCP
command launches, and whether it answers `fl_policy`. If doctor passes but a
running Codex session still reports `Transport closed`, restart Codex so it
reloads its MCP process. If doctor reports `legacyGlobalConflict`, an older
global `~/.codex/config.toml` Frontload entry points at another repo; prefer the
project `.codex/config.toml` entry for new work.

If your Codex version rejects `required`, `enabled_tools`, or `default_tools_approval_mode`, remove that key and keep the MCP command and args.
