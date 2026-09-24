# Galaxy Code v2 architecture

## Purpose

Galaxy Code is the smallest executable host for `@galaxy-stack/ai-coder-core`. It is
deliberately boring: fixture input goes through the same model, prompt,
registry, approval, context, runtime, port, and completion contracts that a
real host must implement. This makes architectural failures reproducible
without a network provider or UI state.

```text
JSON fixture
    |
ScriptedCodingModel
    |
AiCoderRunController ---- prompt snapshot / context / checkpoint / trace
    |
LabToolExecutor ---------- canonical registry + schema + approval policy
    |
Node host ports ---------- workspace / command / project / Git
    |
isolated fixture workspace
```

The dependency direction is one-way: Galaxy Code depends on the core. The core
does not import Node filesystem APIs, terminal UI, VS Code APIs, Desktop APIs,
or a provider SDK.

## Determinism boundary

The model decisions and call correlation are scripted. Fixtures declare every
round, call ID, tool name, argument object, expected file, expected status, and
expected tool sequence. Filesystem state starts from declared initial files and
is committed as a local Git baseline before the run.

Command output can contain tool-specific timings, so byte-for-byte stdout is
not the assertion boundary. Tests assert semantic state: ordered calls,
canonical outcomes, file hashes/content, validation status, transition path,
completion state, and final response requirements.

## Runtime invariants

1. A model sees only the active registry snapshot for the current turn.
2. An unknown or inactive model-facing tool name fails closed.
3. Tool arguments and adapter output must satisfy the descriptor schemas.
4. Host permission and approval checks run immediately before dispatch.
5. Workspace paths stay inside the real workspace root, including through
   symlinks.
6. Existing files can only change under a matching SHA-256 precondition; new
   files require `must_not_exist`.
7. Every result must match its model-name-to-canonical-ID mapping, and each
   host effect must be declared for that canonical ID.
8. Failed results cannot contribute success evidence; an explicit host denial
   may still close an approval request.
9. Every write needs a later passing validation with an explicit scope, and
   that validation must match the final workspace fingerprint.
10. A completed mutating run needs a later successful, untruncated Git diff
   review carrying a hash of the reviewed diff and final workspace state.
11. Pending approvals, running calls, incomplete trace/token ledgers, or open
    required acceptance criteria prevent completion.
12. Checkpoints and oversized-output spills are trusted host boundaries and
    always receive cancellation/deadline context.
13. Identical tool retries, varied failed mutations against one path/state,
    repeated validation failures on one workspace fingerprint, and returning
    write hashes are bounded by deterministic no-progress guards.
14. Provider token counts are checked before a model round; overflow creates a
    checkpoint, compacts, recounts, and either continues or fails with a
    resumable checkpoint. Resume re-probes capabilities and verifies both
    checkpoint integrity and current workspace state.
15. Command and validation snapshots hash raw bytes and track files,
    directories, symlinks, and special entries (including empty directories).
    If post-operation capture
    cannot establish the resulting state, the adapter throws and the core
    fails the run with an unknown side-effect outcome; it cannot continue and
    claim completion.
16. Filesystem mutations carry before/after entry kinds. Directory transitions
    may use null content hashes; symlink/special entries use deterministic entry
    hashes. Resume verifies kind as well as bytes.
17. Text reads and edits decode raw bytes with fatal UTF-8 semantics. Invalid
    text never becomes replacement characters or satisfies a write precondition.
18. Repository validation scripts are high-risk executable code. The balanced
    profile requires explicit approval; verified containment remains a separate
    host capability.
19. Once dispatch starts, an unexpected adapter throw or an output-schema
    mismatch is an unknown side-effect outcome for every tool. The run fails
    closed; it cannot downgrade the event to a retryable structured result.

## Command containment

`NodeCommandPort` has an explicit `containment` policy:

- `required` fails closed with `UNAVAILABLE` before spawning a command when no
  verified backend is active.
- `best_effort` is the backwards-compatible default and currently runs without
  containment. `containmentStatus` reports `active: false`, `verified: false`,
  `filesystemWrites: uncontained`, and `network: uncontained`; callers must not
  treat this mode as a security guarantee. The fixture lab still uses this
  default and therefore is not an OS security boundary. Its core prompt
  conservatively declares network access as allowed whenever the command port
  reports network as uncontained; prompt text never claims a denial that the
  host cannot enforce.

macOS Seatbelt via `/usr/bin/sandbox-exec` is retained only as an explicit
conformance probe. The probe proves that Node can read the installed system and
toolchain, write a disposable workspace/private temp, and that direct outside
writes and loopback TCP are denied. It also checks two less obvious invariants:

1. An outside inode hard-linked into the workspace must not be writable through
   the allowed workspace pathname.
2. A detached descendant must not survive after the wrapper process exits.

On the tested macOS host both invariants fail: the hard link changes the outside
inode, and a child that starts a new process group writes after the wrapper has
exited. Consequently the probe reports `verified: false`, the backend remains
inactive, and `required` refuses to execute. This is deliberate fail-closed
behavior; the code does not describe Seatbelt as a sandbox or containment
guarantee.

Apple marks `sandbox-exec` deprecated and directs applications toward
[App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox).
For separately privileged helpers, Apple recommends
[XPC rather than relying on a child process alone](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html).
Consequently Galaxy Code does not promote this CLI prototype to a production
macOS security boundary even if a future OS version happened to pass its probe.

Linux has an implemented `bubblewrap` backend. It uses new user/PID/network and
related namespaces, a new session, parent-death handling, dropped capabilities,
a private temporary filesystem, read-only system/toolchain mounts, and one
read-write workspace mount. Before dispatch, Galaxy Code rejects pre-existing
hard-linked workspace files. The backend activates only if a live host probe
passes system/toolchain reads, workspace/private-temp writes, direct outside
write denial, hard-link rejection, loopback network denial, and descendant
quiescence. The current macOS test host cannot execute that Linux-only gate, so
the Linux integration test is present but skipped here. Other operating systems
report `unavailable`.

## Command interpreter contract

Shell portability is an adapter contract, not a model guess. `NodeCommandPort`
resolves one immutable host environment and uses it in both places:

1. process launch uses the declared executable and argument prefix with
   `shell: false`;
2. the core-owned prompt receives the same OS, executable, shell dialect, path
   style, stdin, TTY, and interactivity fields.

The current mapping is `/bin/sh -c` with POSIX `sh` syntax on macOS/Linux and
`cmd.exe /d /s /v:off /c` with cmd batch syntax on Windows. It does not inspect
`SHELL`, `ComSpec`, Terminal.app, iTerm, Windows Terminal, VS Code's terminal
profile, or another login/terminal preference because none of those execute
the command. stdin is closed and no TTY is allocated.

Host-generated Git commands avoid shell-specific literals. Dynamic Git paths
are supplied through a deterministic process environment and expanded once
inside quotes, so spaces and metacharacter-like text remain path data. Fixture
setup and cross-platform mutation scenarios use shell-neutral executable
commands. The native conformance gate is documented in
[CROSS_PLATFORM_COMMANDS.md](CROSS_PLATFORM_COMMANDS.md).

## Adding a host adapter

An adapter is added in four independently testable steps:

1. Implement the corresponding core port without changing the core domain.
2. Add its canonical tool ID to the host's available set only when the adapter
   is actually usable.
3. Map the port result to the descriptor output schema and explicit evidence.
4. Add contract, denial, cancellation, truncation, and replay fixtures.

Do not expose a descriptor first and fill in its implementation later. Registry
availability is a statement of executable host capability.

## Route to VS Code and Desktop

`galaxy-vscode-extension` and `galaxy-desktop` should compose the same core and
replace only host ports: filesystem, command sessions, approval UI, persistence,
artifacts, preview, retrieval, and provider adapters. Their conformance suite
should reuse the same fixture semantics. Retrieval and Tree-sitter can enrich
inspection through bounded ports, but neither should be required for basic
correctness or completion.
