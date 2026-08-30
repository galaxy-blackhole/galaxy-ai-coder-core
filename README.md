# @galaxy/ai-coder-core

Provider-neutral, platform-neutral runtime for the Galaxy AI Coder single agent.
The same core is intended for:

- `galaxy-code` v2 — deterministic Node.js CLI laboratory;
- `galaxy-vscode-extension` — VS Code host adapters;
- `galaxy-desktop` — Tauri host adapters.

## Status

The single-agent runtime, context manager, prompt assembler, tool registry,
approval policy, checkpoint format, trace protocol, lexical retrieval, and
completion gate are implemented and covered by deterministic tests.

`galaxy-code` v2 is the reference conformance host. VS Code and Desktop should
not copy runtime logic; they should implement the same ports and pass the same
host conformance fixtures first.

This package is still pre-integration (`0.1.0`, private). Optional MCP,
semantic retrieval, background terminal sessions, and subagents are outside
the current runtime baseline.

## Non-negotiable invariants

1. One AI owns the run state. There is no hidden planner/reviewer agent.
2. A model round may emit at most one correlated tool call.
3. The model sees model-facing names; every result must match the host's
   model-name-to-canonical-ID mapping.
4. Tool text is never parsed into trusted state. Only declared host effects
   can change inspection, write, validation, diff, plan, approval, or criterion
   evidence.
5. Every host effect is checked against a per-canonical-tool capability policy.
6. Every mutation uses a precondition and records non-empty before/after
   evidence. A later validation has an explicit `workspace` or `paths` scope.
7. Validation and final diff evidence must match the final serialized workspace
   fingerprint before completion.
8. A required acceptance criterion must be `satisfied`; `waived` does not close
   a required criterion.
9. Checkpoints are cloned before validation, deeply frozen after validation,
   redacted, hashed with SHA-256, and resumed only from trusted host storage (or
   an explicit `trusted_host` provenance assertion).
10. Cancellation makes an in-flight side-effect outcome `unknown` unless the
    host returns a structured result. Hosts must honor the supplied signal and
    absolute deadline.

## Runtime flow

```text
request
  -> capability + tool-policy snapshot
  -> trusted system/workspace/task envelopes
  -> bounded context assembly
  -> one streamed model round
  -> zero or one correlated tool call
  -> schema/policy/approval/host adapter
  -> bounded untrusted observation + trusted declared effects
  -> repeat
  -> final report candidate
  -> final-report persistence (when a store is configured)
  -> completion-gate trace + durable trace flush (when trace is configured)
  -> fresh workspace fingerprint
  -> deterministic completion gate
  -> completed
```

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[HOST_CONFORMANCE.md](docs/HOST_CONFORMANCE.md) for integration contracts.

## Source layout

```text
src/
├── approval/   # fail-closed approval policy
├── context/    # context budget, token ledger, checkpoints, output bounds
├── ports/      # host capability interfaces and PortResult
├── prompt/     # versioned system prompt assembly
├── retrieval/  # bounded provider-neutral lexical evidence
├── runtime/    # run controller, state machine, completion gate, trace emitter
└── tools/      # schemas, descriptors, registry and provider protocol
```

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm run verify
```

`npm run verify` runs strict TypeScript checks, all source tests, a clean build,
and a public `dist` smoke test. `npm pack --dry-run` should also be checked
before publishing or consuming the package from another repository.

The deterministic end-to-end host gate lives in `galaxy-code`:

```bash
cd ../../galaxy-code
npm run check
```
