# Security

Frontload is local-first. It does not upload source code, call paid LLM APIs, or
make runtime network calls.

Historical Frontload runs stored raw command logs under `.frontload/logs/` and
redacted obvious tokens, API keys, secrets, and passwords with simple pattern
matching. All agent hooks, MCP servers, and command-rewrite paths are now inert.
Use `frontload uninstall` to remove generated state and installed integration
files while preserving unrelated agent configuration.
