# @galaxy-stack/ai-coder-core

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

This package is still pre-integration: only `galaxy-code` passes the full
conformance gate today. Optional MCP, semantic retrieval, background terminal
sessions, and subagents are outside the current runtime baseline.

## Versioning and release policy

All releases before `1.0.0` are development quality. Every release carries an
explicit semver pre-release tag (`x.y.z-alpha.N`) while the host conformance
gate is still running; stable-looking `x.y.z` numbers are reserved for
post-`1.0.0` releases. Publish pre-releases with a dist tag
(`npm publish --tag alpha`) so `npm install @galaxy-stack/ai-coder-core@latest`
never upgrades a consumer to an unverified alpha.

Every behavior- or API-level fix lands in [CHANGELOG.d](CHANGELOG.d/README.md)
as a dated fragment (date, time, area, before/after, regression requirement)
and is compiled into [CHANGELOG.md](CHANGELOG.md) at release time. When reading
any audit or live run, compare the recorded `packageVersion` against
[CHANGELOG.md](CHANGELOG.md) before concluding that a fixed defect recurred.

Publishing is automated through npm trusted publishing (OIDC, no stored npm
token): every push to `main` runs the conformance gate and
[.github/workflows/publish.yml](.github/workflows/publish.yml) publishes the
package only when `package.json` carries a version that npm does not have yet.
Pre-release versions publish under the `alpha` dist tag, so
`npm install @galaxy-stack/ai-coder-core@latest` never jumps to an unverified
alpha.

## Installation

Install the current development line explicitly; `latest` intentionally stays
on the last non-alpha release:

```sh
npm install @galaxy-stack/ai-coder-core@alpha
```

The package is ESM-only and requires Node.js 20 or newer. It does not bundle a
model provider, filesystem adapter, command runner, credential store, or UI.
Each host supplies those capabilities through typed ports.

## Basic usage

`AiCoderRunController` owns each run lifecycle; one controller may host
multiple distinct run IDs, while every run still has exactly one AI. A host
constructs the adapter set once, passes a complete request to `start`, observes
typed runtime events, and awaits the handle result. The same request fields
plus a trusted durable checkpoint are used by `resume`.

```ts
import {
  AiCoderRunController,
  type AiCoderRunDependencies,
  type AiCoderRunRequest,
} from "@galaxy-stack/ai-coder-core";

export async function runCoder(
  dependencies: AiCoderRunDependencies,
  request: AiCoderRunRequest,
) {
  const controller = new AiCoderRunController(dependencies);
  const handle = controller.start(request);

  // A UI may call handle.pause(), handle.cancel(), or
  // handle.resolveApproval(requestId, decision) while result is pending.
  return await handle.result;
}
```

Required dependencies are a `CodingModelAdapter` and an
`AiCoderRuntimeToolExecutor`. Production hosts should also provide a trusted
run store, trace port, workspace verifier, and output-spill adapter when their
completion requirements enable those guarantees. `galaxy-code` is the
reference implementation and conformance test host.

## Public API

| Export | Purpose |
| --- | --- |
| `AiCoderRunController` | Start, resume, pause, cancel, and resolve approvals for a run. |
| `AiCoderRunRequest` / `AiCoderRunResult` | Typed task input, budgets, completion requirements, and terminal result. |
| `AiCoderRunDependencies` | Model, tools, persistence, trace, workspace verification, clock, and event adapters. |
| `AiCoderRuntimeEvent` | Model, tool, checkpoint, retry, context-pressure, state, and completion-rejection telemetry. |
| `evaluateAiCoderCompletion` | Pure completion-evidence evaluation for tests and host diagnostics. |
| `createAiCoderRunCheckpoint` / `assertAiCoderRunCheckpoint` | Durable checkpoint creation and validation. |
| `AiCoderToolRegistry` | Canonical tool registration and model-facing registry snapshots. |

Focused subpath exports are available at `/ports`, `/tools`, `/context`,
`/prompt`, `/approval`, `/retrieval`, and `/runtime`. The API is pre-1.0:
pin an exact alpha version in production-like hosts and review
[CHANGELOG.md](CHANGELOG.md) before upgrading.

## Non-negotiable invariants

1. One AI owns the run state. There is no hidden planner/reviewer agent.
2. A model round may emit zero or more correlated tool calls. IDs must be
   non-empty and unique for the run; names may repeat with different arguments.
   The runtime preflights the complete batch, then executes it sequentially in
   emitted order.
3. The model sees model-facing names; every result must match the host's
   model-name-to-canonical-ID mapping.
4. Hosts provide structured prompt policy only. Runtime assembles and hashes
   the system prompt after capability and registry discovery, then formats the
   sole user task from `AiCoderTaskContract`. If `command.run` is active, the
   host must supply the exact concrete non-interactive interpreter contract;
   the runtime refuses missing/unknown shell metadata before a model request.
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
12. Identical retries, alternating successful tool cycles, varied failed
    mutations on one path/state, repeated validation failures on one
    fingerprint, and returning content hashes are bounded. Semantically
    identical validation, diff, and criterion evidence does not manufacture a
    new state transition; unresolved no-progress episodes pause with a
    checkpoint. Read-only observations follow the configured `noProgressPolicy`
    (`advisory` by default: escalating nudges at `observationNudgeThresholds`,
    blocked only after the final threshold; `strict` preserves the older
    first-incident accounting).
13. Provider-reported context overflow checkpoints, compacts, and recounts
    before another model request. Mandatory state is never silently dropped to
    force a round through.
14. Once a mutation has complete current validation and final-diff evidence,
    the next model turn is a bounded finalization turn with no tool definitions.
    Evidence-complete no-progress recovery uses the same boundary; ordinary
    inspect-then-edit or multi-step review work is not finalized early. A
    verified resume re-derives this boundary before its first model request.

## Runtime flow

```text
request
  -> capability + tool-policy snapshot
  -> core-owned prompt snapshot + canonical user-task contract
  -> bounded context assembly
  -> one streamed model round
  -> zero or more correlated tool calls
  -> atomic batch preflight (IDs, budget, visible registry, canonical JSON)
  -> sequential per-call schema/policy/approval/host adapter
  -> bounded untrusted observation + trusted declared effects
  -> repeat
  -> evidence-ready tool-free finalization turn
  -> final report candidate
  -> model-actionable evidence gate
  -> runtime-owned final-report persistence (when a store is configured)
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

The platform-neutral root supports Node.js 20+. Full development checks and optional SQLite adapters require Node.js 22.13+ (CI covers Node 22 and 24).

```bash
npm install
npm run verify
```

Optional fast pre-push gate:

```bash
git config core.hooksPath .githooks
```

`npm run verify` runs strict TypeScript checks, all source tests, a clean build,
and a public `dist` smoke test. `npm pack --dry-run` should also be checked
before publishing or consuming the package from another repository.

`npm test` writes [TEST_ERROR_LOG.md](TEST_ERROR_LOG.md) and per-run evidence under
`.galaxy/tests/`: timestamped assertion results, failure stacks, test counts,
commit and source fingerprint. The reporter is development-only and runs without
a galaxy-code checkout. Raw `tsx --test` invocations bypass this reporter.

The deterministic/live/replay host gate lives in the private `testing/` workspace:

```bash
cd testing
npm ci
npm run test:local
```


## Agent platform and optional adapters

The runtime also supports `prompt.agentProfile: "assistant" | "research"` alongside the default coding profile. `contextData` is bounded, snapshotted and wrapped as untrusted context; it never changes approval or validation evidence.

`@galaxy-stack/ai-coder-core/agent` exports `AgentMemoryPort`, `AgentSkillsPort`, `AgentToolExecutor`, `CompositeToolExecutor`, memory/skill tool factories and profile types. Optional `.../adapters/node/*` exports provide the shared Ollama/Node tools, MCP SDK client, directory skill loader and SQLite memory. They are not imported through the platform-neutral root. The SQLite adapter requires Node >=22.13.

The executable lab moved into [testing/](testing/README.md); it is private and excluded from the npm package. Production CLI/TUI lives in the sibling `galaxy-code` repository. See [docs/AGENT_PLATFORM.md](docs/AGENT_PLATFORM.md) for APIs, current scope, commands and rollout boundaries.
