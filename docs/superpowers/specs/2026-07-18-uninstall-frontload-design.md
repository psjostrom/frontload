# Frontload Uninstall Design

## Goal

Provide a single `frontload uninstall` command that reverses everything the
Frontload initialization flow installed for the selected repository and the
user's agent environment. The shutdown release must leave no active Frontload
integration or generated repository state behind.

## Command

`frontload uninstall` accepts the same `--repo <repo>` and `--home <dir>`
location overrides used by initialization. Invoking the command is explicit
authorization to remove Frontload-managed state; it does not require a second
confirmation prompt.

The command is idempotent. Missing artifacts are reported as already absent and
do not make the command fail.

## Repository Cleanup

For the selected repository, uninstall removes:

- `frontload.config.json`
- the complete `.frontload/` generated-state directory
- Frontload's `.frontload/` entry from the repository's local Git exclude file
- every Frontload MCP entry in project Codex, Claude Code, and OpenCode config
- Frontload hooks in project-scoped Claude Code settings

Config edits are surgical. Unrelated MCP servers, hooks, comments, and settings
remain untouched. A config file or now-empty parent directory is deleted only
when removing Frontload leaves it with no meaningful content.

## User Environment Cleanup

Under the selected home directory, uninstall removes:

- every Frontload MCP entry from global Codex, Claude Code, and OpenCode config
- Frontload hooks from global Codex and Claude Code hook/settings files
- the Codex, Claude Code, and OpenCode `frontload` skill directories
- the OpenCode `frontload-gate.js` plugin

Frontload follows Argent's bundled-content cleanup model. The package's bundled
skill and plugin files are the source of truth: uninstall removes those exact
relative file paths from each target and removes directories only after they
become empty. It never recursively deletes a shared target directory. Shared
configuration files are edited rather than replaced, preserving unrelated user
configuration.

## Global Package Removal

After repository and agent cleanup, the command uses the same package-manager
detection as initialization and runs that manager's single uninstall operation,
falling back to npm. An npm invocation therefore runs
`npm uninstall -g frontload`; pnpm, Yarn, and Bun installations use their
equivalent command. If no matching global installation is detected, package
removal is reported as absent instead of running destructive commands through
every package manager.

If a package manager reports a real uninstall failure, the command reports the
failure, completes all other cleanup attempts, and exits nonzero so the user is
not told that uninstall fully succeeded.

## Scope Limitation

Frontload 0.3.1 did not retain a safe registry of initialized repositories.
Uninstall therefore cleans the selected repository plus all known global agent
artifacts, but it does not scan the filesystem for other repositories. The
shutdown documentation tells users with multiple initialized repositories to
run the command once in each repository, leaving the final invocation to remove
the global package.

Because removing the package on the first invocation would prevent later
invocations, the command supports `--keep-package`. This option performs the
complete repository and agent cleanup but defers global package removal. It is
documented only for cleaning multiple initialized repositories; the default
remains full removal.

## Result and Errors

The CLI prints a concise summary grouped into repository artifacts, agent
artifacts, and global package removals. Each item is marked removed, absent, or
failed. Filesystem or config parsing failures are isolated per artifact so the
command can continue removing independent state, then exits nonzero if any
required removal failed.

Malformed shared config is never overwritten or deleted. It is reported as a
failure requiring manual cleanup.

## Testing

Unit tests create temporary repositories and home directories containing a mix
of Frontload-managed and unrelated configuration. They verify complete removal,
preservation of unrelated content, exact bundled-file cleanup, cleanup of empty
files/directories, quoted Codex TOML tables, malformed config handling,
idempotency, Git exclude cleanup, all three agent integrations, and detected
package-manager behavior.

An end-to-end CLI test runs the built command against temporary repository,
home, and executable paths. It verifies the human-readable summary, exit status,
artifact removal, preservation of unrelated settings, `--keep-package`, and
package-manager failure reporting without touching the developer's real global
installation.

The README gains the shortest safe shutdown instructions, including the
multiple-repository sequence.
