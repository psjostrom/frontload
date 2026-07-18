# Frontload

## Development halted indefinitely

Frontload is halted indefinitely. Do not install or use it.

A paired Codex audit found that Frontload 0.3.1 used **+59.96% tokens** and
**+31.85% wall time** for the same verified correctness as plain Codex. It also
exposed critical reliability failures. We did not measure Claude Code or
OpenCode, and have no evidence that those paths are better, so all three agent
integrations are disabled.

We recommend [RTK](https://github.com/rtk-ai/rtk) instead. RTK already owns the
command-output filtering problem Frontload duplicated, and future Codex
integration improvements belong upstream there rather than in a second product.

Existing 0.3.1 installations remain active until updated or removed. This
revision blocks setup and MCP startup; packaged hooks and plugins are inert. The
repository remains available as an evidence and audit archive, not as an active
product.

## Remove existing installations

Run `frontload uninstall` in each initialized repository. For multiple repos,
keep the command until the final cleanup:

```sh
frontload uninstall --repo /path/to/first --keep-package
frontload uninstall --repo /path/to/final
```

The final command removes the global package with one package-manager command
(`npm uninstall -g frontload` by default). Unrelated agent settings and files
remain.

- [Full decision and evidence](proof/codex-net-benefit-audit.md)
- [Issue log](proof/frontload-audit-issues.md)
