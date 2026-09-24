# Test runbook

Run these commands from `galaxy-code`, with its npm dependencies and the sibling
parent core dependencies installed.

## One command, stop at the first failure

```sh
npm run test:audit
```

The default audit runs core typecheck, source tests, build and distribution
smoke; CLI typecheck, unit, integration, end-to-end tests and build; then each
deterministic fixture and campaign. It builds required exports before consuming
them. It does not call Ollama or GitHub.

To include every live campaign with Ollama/Kimi and the GitHub repository
create/push/clone/pull/delete lifecycle:

```sh
npm run test:audit -- --live --github
```

`--live` explicitly permits provider calls and the dependency-backed campaign's
npm installation, plus Ollama public web search/fetch in the research campaign.
Connection settings come from the normal live config, by
default the manual entry in `~/.galaxy/config.json`. The polyglot campaigns also
require Python, Rust and Java on the host. `--github` explicitly opts into the
temporary private repository lifecycle and requires authenticated `gh` with
deletion authority. The wrapper supplies the lifecycle confirmation flag.
If interrupted during that external lifecycle, the audit waits for its cleanup
before stopping; it does not terminate the lifecycle child midway through deletion.

The audit stops when a command fails, a scenario oracle fails, or the Node test
runner reports its first failing test. Later groups and campaigns do not start.
Node tests use an abort signal; a file subprocess already running may finish
emitted work or cleanup before cancellation is observed. This is not a promise
that every instruction stops synchronously at an assertion. See the official
[Node test runner cancellation option](https://nodejs.org/api/test.html#runoptions).
Expected negative scenarios still pass when their declared oracle is satisfied.

## Run only the failing case

List the available step IDs without running them:

```sh
npm run test:audit -- --list
npm run test:audit -- --live --github --list
```

Select one step; necessary core/CLI builds are included automatically:

```sh
npm run test:audit -- --only core:tests
npm run test:audit -- --only cli:unit
npm run test:audit -- --only cli:integration
npm run test:audit -- --only cli:e2e
npm run test:audit -- --only fixture:stale-edit-loop
npm run test:audit -- --only campaign:progressive-project
npm run test:audit -- --live --only live:dependency-backed
npm run test:audit -- --live --only live:full-application
npm run test:audit -- --live --only live:advanced-resilience
npm run test:audit -- --live --only live:research
npm run test:audit -- --live --only live:durable-research
npm run test:audit -- --github --only github
```

Run only the combined repeated-compaction/process-resume case:

```sh
npm run test:audit -- --only cli:e2e \
  --test-name 'long run compacts repeatedly'
```

The other live IDs are `live:smoke`, `live:progressive`,
`live:advanced-commerce`, and `live:advanced-polyglot`.
Live and GitHub steps still require their opt-in flag
when selected with `--only`.

The expanded audit has 23 deterministic groups, nine live campaign groups and
one optional GitHub group (33 groups with `--live --github`). A group is not one
test: campaigns contain cumulative stages and test groups contain many assertions.
The two new directories add seven live stages. They reuse a workspace within
their own campaign; select the directory to retain the earlier stages.
See [RESEARCH_CAMPAIGN.md](RESEARCH_CAMPAIGN.md) and
[READINESS.md](READINESS.md) for coverage and integration gates.

## Repeat live campaigns to assess stability

```sh
# Research, forced repeated compaction, actual SIGKILL and fresh-process resume.
npm run test:audit -- --live --only live:durable-research --repeat 3

# Recheck the existing three-stage research campaign independently.
npm run test:audit -- --live --only live:research --repeat 3

# All offline groups once, each of the nine live groups three times; no GitHub.
npm run test:audit -- --live --repeat 3
```

`--repeat` accepts 1–20 and repeats only live groups, each in an isolated
workspace and store. By default, any failure stops the entire audit. The summary's
`stability` section distinguishes planned, attempted and passed runs; unattempted
runs are never counted as passes. Counts, retries, rejections and compactions
remain available per stage. Do not edit source while an audit runs: source
hashes are recorded at the beginning and end, and source drift fails the audit.
See [STABILITY_CAMPAIGN.md](STABILITY_CAMPAIGN.md) for the fault model, baseline
capture and retained evidence.

`--keep-going` continues past failed opt-in steps (live and GitHub) so one run
records every group's outcome instead of stopping at the first flake. Each
failed step records a `failureClass`: `environmental` (provider transport,
deadline, cancellation), `model-behavior` (paused runs and oracle misses without
a runtime error), or `product` (everything else), and the summary aggregates
them under `failureClasses`. Deterministic steps still stop the audit
immediately: a deterministic failure is a product fault, not noise. Paused live
reports also carry the runtime's `pauseReason`.

To select a named unit/integration/end-to-end test, combine exactly one test
group with a regular expression:

```sh
npm run test:audit -- --only core:tests \
  --test-name 'tool-free finalization'
npm run test:audit -- --only core:tests \
  --test-name 'passing validation closes retried diagnostics'
npm run test:audit -- --only cli:integration \
  --test-name 'declared npm dependencies'
```

## Push gates

`npm run test:audit` is the deterministic gate for CI and release. For a fast
local pre-push signal, enable the repository hook once:

```sh
git config core.hooksPath .githooks
```

`.githooks/pre-push` runs the CLI typecheck and unit suite; it does not replace
the full audit or the opt-in live stability campaigns.

## Recorded session replay

One recorded live session gives the keyless suite deterministic coverage of the
real model orchestration path. Record a fresh run with an explicit output file;
the recorder captures every provider round (capability probe plus chat NDJSON
bodies), redacts credentials, and stores the fixture under `live/recordings/`:

```sh
npm run dev -- health --live \
  --scenario live/scenarios/01-write-and-validate.json \
  --record live/recordings/01-write-and-validate.json
```

`test/e2e/recorded-session-replay.test.ts` replays that fixture through the
real Ollama normalizer and run controller with a replay fetch — no provider, no
API key, no network. Re-record when the scenario, prompt version, or model
identity changes so the fixture keeps matching the current contract. Recorded
bodies contain model output and workspace content from the synthetic scenario
only; provider headers and credentials are never stored.

`--test-name` applies to test groups, not fixture or campaign IDs.

## Logs for investigation

[TEST_ERROR_LOG.md](../TEST_ERROR_LOG.md) is the append-only run journal. It records
start/end timestamps in UTC and Asia/Ho_Chi_Minh, the last passing and failed step,
DONE/PASS counts against the planned groups, source fingerprint/commit, model/run ID,
failure details and links to raw evidence. A symptom signature links matching earlier
runs; it does not automatically label a failure as a regression or diagnose its cause.
The [incident register](TEST_FAILURE_ANALYSIS.md) records upstream references,
confirmed observations, remaining hypotheses and regression requirements.

Each run also maintains `summary.md` after every step, including RUNNING and NOT RUN
rows. A killed process may leave a RUNNING row; it is never interpreted as PASS.
Historical logs can be imported without provider access:

```sh
npm run test:audit:log
```

Import is idempotent for finished runs and does not rewrite original JSON evidence.
Old runs did not record per-step wall-clock times; these remain explicitly unknown.
Generated Markdown journals are excluded from source fingerprints, so logging does
not create source drift. Preserve the journals and their `.galaxy/` evidence together.
Common credential patterns are redacted in Markdown; raw local stdout/JSON traces
still need review before sharing.

`npm test`, `npm run test:unit`, `npm run test:integration`, and `npm run test:e2e`
use the audit logger. Named filtering uses `--test-name <regex>` on the selected group.
Standalone `npm test` in ai-coder-core has its own development-only Node reporter,
writing that repository's `TEST_ERROR_LOG.md` and `.galaxy/tests/`; it does not need
the CLI checkout. Raw `npx tsx --test`, direct scenario invocations and specialized
commands such as `test:command-conformance` remain outside these automatic journals.

Each audit run creates a unique directory under `.galaxy/audit/`, containing
`summary.json` and per-step `stdout.log` / `stderr.log`. The summary identifies
the failing step and its log paths; the terminal also reports where to look.
Fixture and campaign workspaces are retained beside the logs for inspection.
Live steps also retain checkpoints and final reports in a sibling `store/`
directory through `FileRunStore`.
Each independent live campaign has its own workspace, while its stages share
one accumulated project.

When a run fails, provide the audit directory path. Start diagnosis with its
summary and the failed step's logs, then inspect the retained workspace if
needed. Rerun the selected step after investigating; another full live run is
unnecessary until the failure is understood. Logs are diagnostic artifacts and
may contain generated code or terminal output; review them before sharing
outside the project.

## Existing direct commands

The audit wrapper provides fail-fast behavior and retained logs. Direct commands
remain useful for one known file or scenario, but do not provide the same audit
logging or fail-fast orchestration.

```sh
# Run exactly one integration test by name; test options precede the file.
npm run core:build
npx tsx --test --test-name-pattern='declared npm dependencies' \
  test/integration/live-health-runner.test.ts

# Run one deterministic fixture.
npm run dev -- run --fixture fixtures/scenarios/stale-edit-loop.json --json

# Run the deterministic campaign in stage order.
npm run dev -- campaign --fixture campaigns/progressive-project --json

# Run each complete live campaign independently.
npm run dev -- health --live --scenario live/scenarios/01-write-and-validate.json --json
npm run dev -- health --live --scenario live/scenarios/progressive --json
npm run dev -- health --live --scenario live/scenarios/advanced-commerce --json
npm run dev -- health --live --scenario live/scenarios/advanced-polyglot --json
npm run dev -- health --live --scenario live/scenarios/dependency-backed --json
npm run dev -- health --live --scenario live/scenarios/full-application --json

# Run native command conformance on the current OS.
npm run test:command-conformance
```

Do not run `health --live --scenario live/scenarios`: that directory contains
several independent campaigns, not one shared project. Later campaign stages
depend on earlier stages and must not be run alone in an empty workspace. Use
the campaign directory, or its `live:<name>` audit ID, to reproduce a failure.

## What should be verified next

The user-run 32-group audit on 2026-09-12 passed the existing full-application,
advanced-resilience and research campaigns. That is one observed successful
run, not proof of repeatable model behavior. Repeat those campaigns and the new
durable research campaign before considering host integration. Native Linux and
Windows command gates are also still required; a macOS pass cannot certify them. See
[CROSS_PLATFORM_COMMANDS.md](CROSS_PLATFORM_COMMANDS.md) for the CI dependency
layout that must be resolved first.

VS Code/Desktop integration is explicitly deferred. Current work remains in
CLI stability testing; current evidence does not certify every host or provider.
