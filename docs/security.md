# Security

Frontload is local-first. It does not upload source code, call paid LLM APIs, or
make runtime network calls.

Historical Frontload runs stored raw command logs under `.frontload/logs/` and
redacted obvious tokens, API keys, secrets, and passwords with simple pattern
matching. Development is halted indefinitely, and all agent hooks, MCP servers,
and command-rewrite paths are inert in the updated release. Older installations
remain active until updated or uninstalled. Use `frontload uninstall` to remove
generated state and installed integration files while preserving unrelated
agent configuration.
