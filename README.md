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
4. Hosts provide structured prompt policy only. Runtime assembles and hashes
   the system prompt after capability and registry discovery, then formats the
   sole user task from `AiCoderTaskContract`.
5. Tool text is never parsed into trusted state. Only declared host effects
   can change inspection, write, validation, diff, plan, approval, or criterion
   evidence.
6. Every host effect is checked against a per-canonical-tool capability policy.
   Built-in hosts derive that policy from the exported versioned core profile;
   divergent local copies are rejected at runtime startup.
7. Every mutation uses a precondition and records distinct before/after state:
   create has a null `beforeHash`, delete has a null `afterHash`, and at least
   one hash is non-null. Later validation has explicit workspace/path scope.
8. Validation and final diff evidence must match the final serialized workspace
   fingerprint before completion.
9. A required acceptance criterion must be `satisfied`; `waived` does not close
   a required criterion.
10. Checkpoints are cloned before validation, deeply frozen after validation,
   redacted, hashed with SHA-256, and resumed only from trusted host storage (or
   an explicit `trusted_host` provenance assertion).
11. Cancellation makes an in-flight side-effect outcome `unknown` unless the
   host returns a structured result. Hosts must honor the supplied signal and
   absolute deadline.
12. Identical retries, varied failed mutations on one path/state, repeated
    validation failures on one fingerprint, and returning content hashes are
    bounded; unresolved no-progress episodes pause with a checkpoint.
13. Provider-reported context overflow checkpoints, compacts, and recounts
    before another model request. Mandatory state is never silently dropped to
    force a round through.

## Runtime flow

```text
request
  -> capability + tool-policy snapshot
  -> core-owned prompt snapshot + canonical user-task contract
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

See [ARCHITECTURE.md](docs/ARCHITECTURE.md),
[PROMPT_CONTRACT.md](docs/PROMPT_CONTRACT.md),
[TOOL_EFFECT_PROFILE.md](docs/TOOL_EFFECT_PROFILE.md), and
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
