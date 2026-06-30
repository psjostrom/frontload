# Codex Setup

Run init and choose Codex:

```bash
npx frontload init --agents codex
```

If `frontload` is not already installed globally, init prompts before running the matching global install command for your package manager. It then merges this MCP server into `~/.codex/config.toml`:

```toml
[mcp_servers.frontload]
command = "frontload"
args = ["mcp", "--repo", "."]
```

Restart Codex after init. Codex reads MCP servers from its global config at startup.
Init also copies the Frontload skill to `~/.codex/skills/frontload`.

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
The Frontload hooks remain inert in repositories that do not contain a
`.frontload` directory.

If your Codex version rejects `required`, `enabled_tools`, or `default_tools_approval_mode`, remove that key and keep the MCP command and args.
