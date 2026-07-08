# Security

Frontload is local-first. It does not upload source code, call paid LLM APIs, or
make runtime network calls.

Command execution is allowlisted by `frontload.config.json` unless `--allow-unconfigured` is passed. Raw command logs are written under `.frontload/logs/`; Frontload adds `.frontload/` to the repository's local `.git/info/exclude` when it creates generated state. Output summaries redact obvious tokens, API keys, secrets, and passwords with simple pattern matching.

Hooks can deny broad context dumps and rewrite test/typecheck/lint commands through `frontload run`.
