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

Codex setup is currently advisory: Codex gets the MCP tools and skill guidance,
but `frontload init --agents codex` does not install a hard PreToolUse gate.

If your Codex version rejects `required`, `enabled_tools`, or `default_tools_approval_mode`, remove that key and keep the MCP command and args.
