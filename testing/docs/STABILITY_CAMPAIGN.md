# Reproducible baseline and CLI stability campaign

Scope: CLI/core testing only. VS Code/Desktop integration is deferred. Live
Ollama/Kimi calls are opt-in and are run by the user, not as part of offline audit.

## Baselines and source binding

The pre-stability snapshot is retained at
`.galaxy/baselines/2026-09-12-pre-stability/`, together with the user's passed
32-group audit `2026-09-12T03-54-47-165Z-58ljYm`. Its manifest explicitly says
`retrospective-unverified`: the historical audit had no source fingerprint.
The snapshot was taken before the campaign and adapter changes, but is not a
claim that every byte is identical to those exercised in the historical audit.

New audits hash CLI/core public source, tests, scripts, fixtures, campaigns,
documentation, package manifests/locks and TypeScript configs before and after
execution. A changed hash fails the audit. This detects end-to-end source drift,
not transient edits restored during a run or changes to tools outside this
inventory. Git HEAD, package versions, Node and host platform are recorded.
Do not change source while auditing. No automatic commits, tags, resets or
restores are performed; existing dirty changes remain intact.

After a passed run, save and verify a new baseline (use a new directory name):

```sh
node scripts/source-baseline.mjs .galaxy/audit/<run>/summary.json \
  .galaxy/baselines/<new-name>
node scripts/source-baseline.mjs --verify .galaxy/baselines/<new-name>
```

`matched-at-audit-start` means the snapshot's source fingerprint matches the
audit. Inspect its recorded steps: an offline pass does not imply a live pass.
Existing directories are never overwritten. The snapshot includes untracked
source, excludes `.git`, `.galaxy`, `node_modules`, `dist` and symlinks, and does
not read `~/.galaxy/config.json`. Keep credentials out of public source files.
Checksums detect accidental modification; they are not a signed attestation.
To recover code, verify first and review/copy the desired files from
`snapshot/cli` and `snapshot/core` into a separate checkout. Do not overwrite a
dirty checkout wholesale. Reinstall from lockfiles and rebuild; external model,
runtime and online framework behavior are not frozen by a source snapshot.

## Durable research workflow

```sh
npm run test:audit -- --live --only live:durable-research
npm run test:audit -- --live --only live:durable-research --repeat 3
npm run test:audit -- --live --repeat 3
```

The new campaign uses the real Ollama adapter and normal manual configuration.
It builds a small HTTP client with injected fetch, bounded GET/HEAD retry policy,
HTTP error handling, cancellation and response-body cleanup. Only two source
files may change; the specification and executable tests remain immutable.

The model must inspect the project, search public documentation, fetch Node and
MDN sources, then implement the policy first. The harness injects an overflowing
token-count estimate between rounds. Core performs its actual compaction and
checkpoint persistence; neither the core nor the provider response is mocked in
live mode. At least two `provider_overflow` compactions must occur in each process.

After fetched-source hashes and the first edit are persisted, the worker blocks
at an observer barrier. The supervisor independently reads the checkpoint and
sends SIGKILL. A new process opens the same FileRunStore and run ID. The client
must still be unfinished at interruption, so resumption must do genuine work.
The first resumed request is checked for task, constraints, research URLs/hashes
and prior edit hashes. The resumed model implements the client, runs executable
tests, checks Git diff and reports source citations. The oracle combines the two
process journals and rejects missing research before writing, repeated confirmed
mutations, any repeated research for this fixed task, lost evidence, altered
fixture tests, missing validation, too few compactions or over 64 total tool calls.

This is a deliberately strict no-refetch oracle for an unchanged small task,
not a universal prohibition on researching new questions after compaction.
Forced overflow tests state retention deterministically; it does not measure
natural model degradation across hundreds of thousands of real context tokens.
The crash occurs at a quiescent, acknowledged checkpoint, not midway through a
filesystem mutation. It does not certify power-loss recovery or every in-flight
side-effect case. No unlimited-duration or perfect-memory guarantee is implied.

## Evidence and repetition

The expanded full audit has 33 groups including nine live groups and optional
GitHub. `--repeat N` (1–20) repeats live groups only; each repetition has a fresh
workspace and store. Offline tests/builds and GitHub are not multiplied. The audit
stops on the first failure. `summary.json.stability` records planned, attempted,
passed, failed and the observed pass rate among attempts, with per-stage metrics.
Untested repetitions are not successes. A few successful repeats are useful
regression evidence, not a statistical guarantee of arbitrary-task reliability.

Within the durable campaign step, `store/campaign-evidence/` retains:

- `campaign-report.json`: combined assertions, process IDs, kill signal,
  checkpoint hashes, research outcome and counts.
- `before/after.jsonl`: tool/effect journals with arguments stripped and source
  excerpts bounded; retained content hashes identify the original fetched source.
- `before/after-observations.json`: counts, checkpoint reasons and observer errors.
- `before/after-requests.json`: boolean evidence-retention checks, not raw prompts.
- `kill-checkpoint.json`, `after-report.json`, worker stdout/stderr and normal
  FileRunStore records for investigation.

Report the audit path on failure; do not rerun blindly or raise call budgets
without inspecting the tool sequence. Offline `cli:e2e` runs the same supervisor
against a local protocol server: real tools, real process kill/resume, synthetic
model responses. It verifies success and rejects repeated research and a missing
crash boundary. A separate executable fixture test rejects TODO stubs, excessive
retry attempts and missing response-body cleanup.

## Resume bug found by the new test

The first offline cross-process run failed with `INVALID_MODEL_STREAM` because
`ollama:1:tool:1` had already been used before the crash. The adapter's in-memory
round counter restarted in the fresh process. Earlier mocks supplied distinct
provider IDs and missed this absent-ID case. The official
[Ollama tool-calling examples](https://docs.ollama.com/capabilities/tool-calling)
show function/index/arguments without requiring a tool-call ID.

Each adapter instance now namespaces canonical correlation IDs with a UUID,
followed by its round counter and normalized provider ID or tool position.
Core's duplicate-ID rejection is unchanged. Unit tests cover absent and repeated
provider IDs across rounds and adapter instances; the durable process test uses
absent provider IDs throughout. This fixes host correlation, not model quality;
the live campaign still needs empirical runs with Kimi.
