# Troubleshooting

## Command is not allowed

Add a safe prefix to `commands.allowed` in `frontload.config.json`, or use `--allow-unconfigured` for a trusted one-off local run.

## Dossier is empty

Use more concrete file, domain, symbol, or error words. Dossier and search calls
build or refresh the index automatically. If results stay empty, run
`frontload doctor --repo .` to verify setup.

## Codex config key rejected

Codex config schemas vary by version. Keep the MCP `command` and `args`, then remove optional keys such as `required` or `enabled_tools`.

## MCP server missing after init

Restart the editor after `frontload init`. MCP clients load server config at startup.

If `/mcp` still does not show Frontload, confirm that `frontload --version` works in your shell. If it does not, run the manual global install command printed by init, such as `npm install -g frontload`.
