# Frontload

## Paused

Frontload is paused and should not be installed or used.

A paired Codex audit found that Frontload 0.3.1 used **+59.96% tokens** and
**+31.85% wall time** for the same verified correctness as plain Codex. It also
exposed critical reliability failures. We did not measure Claude Code or
OpenCode, and have no evidence that those paths are better, so all three agent
integrations are disabled.

Existing 0.3.1 installations remain active until updated or removed. This paused
revision blocks setup and MCP startup; packaged hooks and plugins are inert.

Development resumes only if a replacement passes the audit's strict net-token,
correctness, reliability, and latency gates.

- [Full audit](proof/codex-net-benefit-audit.md)
- [Issue log](proof/frontload-audit-issues.md)
