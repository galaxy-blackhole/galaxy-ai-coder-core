# Galaxy Agent Lab

Private test workspace owned by `galaxy-ai-coder-core`. Not an npm release package.

```sh
# From galaxy-ai-coder-core
npm ci
npm run build
cd testing
npm ci
npm run typecheck:local
npm run test:local
npm run dev -- run --fixture fixtures/write-and-validate.json --json
npm run dev -- health --live --scenario live/scenarios/01-write-and-validate.json --json
```

Live commands use the configured provider and make real model requests. Unit/integration/E2E include deterministic models, recorded replay and local HTTP protocol fixtures. They must not be reported as live model certification.

- Production host/provider/tool implementations: `../src/adapters/node/`.
- Laboratory compatibility imports: `src/host`, `src/provider`, `src/lab/tool-executor.ts`.
- Deterministic contract doubles: `src/lab/deterministic-contract-tools.ts` (not published).
- Scenarios: `fixtures/`, `live/scenarios/`, `campaigns/`.
- Independent CLI entrypoint: `src/cli.ts`; production `galaxy-code` is not a dependency.
- Test runbook: [docs/TEST_RUNBOOK.md](docs/TEST_RUNBOOK.md).
- Architecture and current implementation: [../docs/AGENT_PLATFORM.md](../docs/AGENT_PLATFORM.md).

Migration 2026-09-23 preserved the working-tree contents of the old Galaxy Code lab, including existing changes. The older runbook below is retained for reference; execute its commands from this directory.

---

# Galaxy Blackhole

Galaxy Blackhole is a deterministic command-line laboratory for
`@galaxy-stack/ai-coder-core`. It intentionally uses one AI Coder runtime, one
scripted model adapter, one canonical tool registry, and explicit host ports.
It does not silently select a hosted model or carry forward the former
multi-agent implementation.

The original implementation remains recoverable from the
`legacy-v1-preserved` branch. Development of this clean implementation happens
on `v2`.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- Git, used to create a fixture baseline and verify the final diff
- The parent `galaxy-ai-coder-core` checkout

Build the core before running the CLI because the local package exports its
compiled `dist` contract:

```sh
cd ..
npm ci
npm run verify

cd testing
npm ci
npm run check
```

## Commands

For one fail-fast audit command, individual case selection, and retained logs,
see [docs/TEST_RUNBOOK.md](docs/TEST_RUNBOOK.md).
Audit and npm unit/integration/e2e runs append timestamps and failure evidence to
[TEST_ERROR_LOG.md](TEST_ERROR_LOG.md). The
[incident register](docs/TEST_FAILURE_ANALYSIS.md) links observed failures to
upstream research and the regression tests required before closing them.

```sh
npm run dev -- doctor --json
npm run dev -- tools --json
npm run dev -- prompt "Refactor the parser" --json
npm run dev -- eval --fixture fixtures --json
npm run dev -- campaign --fixture campaigns/progressive-project --json
npm run dev -- health --live --scenario live/scenarios/01-write-and-validate.json --json
npm run dev -- health --live --scenario live/scenarios/progressive --json
npm run dev -- health --live --scenario live/scenarios/dependency-backed --json
npm run dev -- health --live --scenario live/scenarios/full-application --json
npm run test:command-conformance
```

`test:command-conformance` is the native-host gate for `run_command`. Run it on
each supported OS; it verifies that the prompt contract, spawned interpreter,
shell dialect, closed stdin/no-TTY behavior, process lifecycle, output bounds,
and shell-safe Git paths agree. Passing on one OS does not certify another.

Persist and resume one live run across CLI processes:

```sh
npm run dev -- health --live \
  --scenario live/scenarios/01-write-and-validate.json \
  --workspace /path/to/workspace --store-dir /path/to/trusted-store \
  --run-id live-check-001 --pause-after-tool-calls 1 --json

npm run dev -- health --live \
  --scenario live/scenarios/01-write-and-validate.json \
  --workspace /path/to/workspace --store-dir /path/to/trusted-store \
  --run-id live-check-001 --resume --json
```

The store and workspace must not overlap. Resume verifies checkpoint integrity,
prompt/model/tool compatibility, and the fresh workspace fingerprint before the
next model request.

Run one fixture in an automatically removed temporary workspace:

```sh
npm run dev -- run --fixture fixtures/write-and-validate.json --json
```

Pass an explicit new or empty directory only when you need to inspect the
result afterward:

```sh
workdir="$(mktemp -d)"
npm run dev -- run \
  --fixture fixtures/write-and-validate.json \
  --workspace "$workdir" \
  --json
```

`run` expects exactly one fixture. Without `--workspace`, it never uses the
current directory: it creates and removes a temporary workspace. An explicit
workspace must be empty, preventing a fixture from overwriting an existing
project. `eval` accepts one JSON file or a directory
of JSON fixtures, sorts them by filename, and gives every fixture an isolated
workspace. An eval workspace is temporary by default; pass `--workspace` to
retain it.

`campaign` also sorts fixtures by filename, but executes every stage against
one shared workspace. It stops on the first unexpected oracle failure while an
expected negative stage may pass and allow later stages to continue. The
checked-in progressive campaign scaffolds a project, inspects the accumulated
state, performs exact hash-guarded edits, rejects an empty terminal response,
and resumes with a fresh host after hard context exhaustion.

For `health --live`, `--scenario` accepts either one JSON file or an ordered
directory. Directory stages run sequentially against one shared workspace and
stop at the first failed oracle. The checked-in progressive live campaign grows
one JavaScript/Python/Rust project across three increasingly complex stages.

Public `dev`, `test`, `typecheck`, and `check` workflows build the sibling core
before consuming its `dist` exports. This prevents a passing source test from
being followed by a CLI run against stale core JavaScript.

## What the laboratory verifies

- model-facing tool names resolve to one canonical tool descriptor;
- only tools backed by this host are exposed;
- input and output JSON schemas are checked at the adapter boundary;
- permissions, run mode, risk, and approval policy are enforced independently
  of prompt text;
- writes require optimistic-concurrency preconditions;
- failed tools cannot contribute completion evidence;
- canonical tool IDs and declared effect capabilities are enforced;
- completion requires inspection, explicitly scoped validation after every
  write, and a hashed review of the final Git diff;
- validation/diff/checkpoint evidence is bound to a deterministic workspace
  fingerprint, and trace completion requires a durable flush;
- repeated stale mutation families, repeated validation on unchanged state,
  and A→B→A content-hash cycles are circuit-broken across pause/resume;
- typed file/directory/symlink mutations and fatal UTF-8 text decoding prevent
  side effects or lossy edits from disappearing behind a successful report;
- repository validation scripts require explicit high-risk approval;
- provider token overflow, compaction/recount, hard exhaustion, checkpoint
  resume, checkpoint tampering, and workspace divergence are reproducible;
- a 13-round multilingual scenario survives 12 consecutive provider-overflow
  compactions while preserving the original task and accumulated evidence;
- an atomic file-backed store resumes both a deterministic run and an Ollama
  live run in separate Node.js processes without replaying completed work;
- an opt-in `full_contract` profile checks all 21 canonical descriptors while
  clearly labeling the nine optional implementations as in-memory doubles;
- an opt-in live research profile connects `search_web` and `fetch_url` to
  Ollama using host-held credentials; source/citation/order checks and transport
  failure tests are described in [docs/RESEARCH_CAMPAIGN.md](docs/RESEARCH_CAMPAIGN.md);
- seven additional cumulative live stages test research-first recommendations,
  retry policy, SQLite transactions, concurrent checkout, Unicode/CRLF edits
  and bounded incident-log processing; see [docs/READINESS.md](docs/READINESS.md);
- call IDs, registry hashes, prompt hashes, trace ordering, and run state are
  observable in tests.
- `run_command` uses an explicit `/bin/sh -c` contract on macOS/Linux and an
  explicit `cmd.exe /d /s /v:off /c` contract on Windows; the exact same frozen
  value drives process spawn and the model-visible system prompt.

## Ollama and GLM 5.3 Flash

The default live adapter settings identify `ollama` with
`glm-5.3-flash:cloud`.
Deterministic fixtures remain scripted and never call a provider. The separate
`health --live` command is an explicit opt-in smoke/evaluation path through the
same core runtime and real host tools. It probes `/api/show` before arranging
the scenario workspace, then calls streaming `/api/chat` only when tool calling
is verified as supported.

By default, connection resolution reads the first `agent` entry whose `type` is
`manual` from `~/.galaxy/config.json`. The manual `apiKey` takes precedence over
`OLLAMA_API_KEY`; CLI `--model` and `--base-url` override non-secret connection
settings. Reports contain only the credential source, never the credential.

The adapter accumulates interleaved `message.thinking`, `message.content`, and
`message.tool_calls`, creates round-scoped correlated call IDs when Ollama
omits or reuses provider-local IDs, maps usage and `done_reason`, and rejects
these terminal cases as `MALFORMED_STREAM`:

Multiple calls in one response are preserved in provider order. Repeated tool
names are valid when each call has a distinct correlation ID; the core executes
the preflighted batch sequentially so live filesystem behavior stays
deterministic.

For Ollama's narrower tool-schema parser, the adapter converts outbound
`oneOf`/`const` nodes to disjoint `anyOf`/single-value `enum` nodes. Core schemas
and host validation remain strict and unchanged.

- blank content plus no tool calls (the sole retryable malformed terminal,
  bounded by the core model-retry budget and durably failed when exhausted);
- thinking-only output with no visible result or action;
- malformed, duplicate, post-terminal, or unterminated chunks.

The core independently rejects an empty canonical `completed` event as
`INVALID_MODEL_STREAM`, so the live adapter cannot bypass this invariant. Live
cloud availability, authentication, latency, model drift, and response quality
remain outside the deterministic release gate.

For mutation tasks, once current validation and final structured Git evidence
are complete, core makes the following turn tool-free. This gives the model one
bounded final-report turn instead of allowing another successful evidence loop;
an emitted tool call in that turn fails closed before host dispatch.

Validation commands receive a small deterministic environment. In particular,
Python runs with `PYTHONDONTWRITEBYTECODE=1` and `PYTHONHASHSEED=0`, preventing
validation-only `__pycache__` writes from recursively invalidating otherwise
current evidence. The completion gate itself remains strict.

The online `dependency-backed` campaign installs exact Next.js, Vite, NestJS,
Vue, and Angular packages through a fixed host-owned setup step before the
mutation baseline. It then runs four cumulative real-runtime tests while the
oracle restricts each model stage to one expected source-file change.

The cumulative `full-application` campaign raises that gate to actual Next,
Vite/Vue, and Angular builds plus a live Nest HTTP listener and an idempotent
SQLite migration. Run it through `test:audit` so a failed stage retains its
workspace, checkpoint store, stdout, and stderr for diagnosis.

See [docs/LIVE_HEALTH.md](docs/LIVE_HEALTH.md) for isolation, oracle, credential,
and reporting details.

See [docs/CROSS_PLATFORM_COMMANDS.md](docs/CROSS_PLATFORM_COMMANDS.md) for the
native certification procedure and current per-OS status.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the host boundary and
[docs/FIXTURES.md](docs/FIXTURES.md) for the fixture contract. The coverage and
remaining production gaps are tracked in
[docs/TEST_MATRIX.md](docs/TEST_MATRIX.md).

## Scope

Current work is limited to baseline capture and repeated CLI stability testing;
VS Code/Desktop integration remains deferred. The new durable research campaign
combines research, forced compaction, actual process kill and resume. See
[docs/STABILITY_CAMPAIGN.md](docs/STABILITY_CAMPAIGN.md) for evidence boundaries
and [docs/TEST_RUNBOOK.md](docs/TEST_RUNBOOK.md) for fail-fast/repeat commands.

This branch is a conformance host, not yet an end-user provider CLI. The live
Ollama path is a health runner, not an interactive coding session. Interactive
approval UI, semantic indexes, Tree-sitter adapters, and subagents belong after
the shared single-agent contracts pass the same suite in CLI, VS Code, and
Desktop hosts. `NodeCommandPort` activates Linux `bubblewrap` only after every
runtime conformance probe passes. On this macOS host no backend qualifies, so
`required` fails closed while `best_effort` is explicitly reported as
uncontained and is not a security boundary.
