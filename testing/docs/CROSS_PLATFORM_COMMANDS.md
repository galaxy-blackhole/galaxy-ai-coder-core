# Cross-platform command conformance

`run_command` is supported only when the adapter and model share one exact
command-execution contract. An operating-system name alone is insufficient.

## Interpreter mapping

| Host OS | Executed argv | Model dialect | Path style inside command strings |
| --- | --- | --- | --- |
| macOS | `/bin/sh`, `-c`, `<command>` | POSIX `sh` | POSIX |
| Linux | `/bin/sh`, `-c`, `<command>` | POSIX `sh` | POSIX |
| Windows | `cmd.exe`, `/d`, `/s`, `/v:off`, `/c`, `<command>` | cmd batch | Windows |

The child is spawned with `shell: false`, closed stdin, piped stdout/stderr, no
TTY, and a bounded environment. `/v:off` prevents delayed `!NAME!` expansion
from corrupting command/path data. The user's login shell and terminal emulator
are deliberately irrelevant.

This baseline chooses `cmd.exe` on Windows because it is universally available
and keeps the adapter contract deterministic. A future PowerShell adapter must
change both the actual executable/argv and the prompt dialect atomically; it
must not merely tell the model to write PowerShell while still spawning cmd.

## Native gate

Use the same sibling layout as local development, install both projects, then
run on a real host of each supported operating system:

```sh
cd galaxy-ai-coder-core
npm ci
npm run verify

cd testing
npm ci
npm run test:command-conformance
npm run check
```

The command gate covers:

- deterministic OS-to-interpreter mapping;
- actual dialect variables, chaining, redirection, environment inheritance,
  Unicode/space paths, closed stdin, and no TTY;
- output caps, timeout, cancellation, process-tree cleanup, invalid input, and
  workspace-scoped cwd;
- Git diff paths containing spaces and metacharacter-like text without shell
  evaluation;
- required containment activation or fail-closed behavior.

## Certification status

Updated 2026-09-05:

| Host | Contract/unit tests | Native command gate | Security containment |
| --- | --- | --- | --- |
| macOS arm64 | pass | pass | unavailable; `required` fails closed |
| Linux | pass | not run on a Linux host | activates only after the live bubblewrap probe passes |
| Windows | pass | not run on a Windows host | unavailable; `required` fails closed |

“Contract/unit pass” verifies mapping and prompt generation, not OS behavior.
Only a native command-gate result certifies the adapter on that OS.

## CI topology requirement

`galaxy-code` currently consumes `@galaxy-stack/ai-coder-core` through the sibling
path `file:..`, while the core checkout has no configured
Git remote. Therefore a standalone `galaxy-code` GitHub Actions checkout cannot
currently install its dependency, and adding a green-looking workflow would be
misleading.

Before enabling the macOS/Linux/Windows Actions matrix, make the core source
available to CI through one explicit strategy: a pinned core repository/tag, a
published package version, or a monorepo/workspace containing both directories.
The matrix should then execute the native gate above on `macos-latest`,
`ubuntu-latest`, and `windows-latest`; no OS row should be marked supported
until that row passes.
