# Ollama live health runner

`galaxy-code health --live` is the narrow, explicit bridge between the
deterministic laboratory and a real Ollama-compatible model. It is not part of
`npm test`, does not run implicitly, and does not make live model output a
deterministic release gate.

## Run

```sh
npm run dev -- health --live \
  --scenario live/scenarios/01-write-and-validate.json \
  --json

npm run dev -- health --live \
  --scenario live/scenarios/progressive \
  --json

npm run dev -- health --live \
  --scenario live/scenarios/advanced-commerce \
  --json

npm run dev -- health --live \
  --scenario live/scenarios/advanced-polyglot \
  --json

npm run dev -- health --live \
  --scenario live/scenarios/dependency-backed \
  --json

npm run dev -- health --live \
  --scenario live/scenarios/full-application \
  --json

npm run test:audit -- --live --only live:advanced-resilience
npm run test:audit -- --live --only live:research
```

## Public web research

Core has canonical `research.search` (`search_web`) and `research.fetch`
(`fetch_url`). A scenario opts into the real Ollama adapter with
`runtime.research: { "provider": "ollama" }`; other scenarios retain their
existing tool profile. `fetch_url` is initially active and `search_web` is
discovered through `search_tools`. Both also work in `review_only` mode while
workspace writes and commands remain unavailable.

The adapter uses the already-resolved manual API key (or `OLLAMA_API_KEY`) and
fixed `https://ollama.com/api/web_search` and `/api/web_fetch` endpoints, even
when model chat uses a local or customized Ollama base URL. The research
scenario explicitly allows the two tools through `approvalDecisions`; the
`trusted-workspace` profile alone does not approve external requests.

Queries have a 2048-byte bound; the agent default is three results and the hard
maximum is 10. HTTP response
bodies stop at 1 MiB, and model-visible research JSON is bounded to 32,000 bytes.
The executor requests at most 12,000 bytes of page content and reduces it further
when JSON escaping or the core estimator's maximum token calibration would exceed
the tool budget (4000 search tokens, 6000 fetch tokens). Successful identical
queries and fragment-normalized URLs are reused from the executor cache. Truncation is explicit;
Ollama does not offer continuation cursors, so the model must refine the query
or choose a more specific page. Source hashes describe the returned, sanitized
content. Private URL literals, credentials in URLs, local hostnames, redirects,
stalled streams, malformed responses and common HTTP errors have deterministic
tests. The cloud service resolves public DNS; this URL validation is not a
general DNS or command sandbox.

Reports include `research`: successful search/non-empty fetch counts, bounded
source URLs/hashes and 512-code-point untrusted diagnostic excerpts (fetched
sources first), citations, unsupported citations, failed calls and
research-before-write checks. The oracle requires fetched domains and citations
when configured, and treats external text as untrusted data without granting
workspace inspection, mutation or validation effects. Research observations have
`scope: "current_process"` for call-count diagnostics. Independently, core
checkpoints persist up to 24 unique `(kind, URL)`, host-attested search/fetch records with a
bounded untrusted summary, URL, hash and originating tool call. This evidence is
restored to mandatory model context after compaction or process resume; it is not
silently counted as a new call by the current-process oracle. Source-to-claim
semantic accuracy still requires review.

Every report also contains a bounded `toolJournal` with the correlated call ID,
canonical tool ID, argument hash, redacted argument excerpt, result status/error,
and redacted result excerpt. It is intended for post-failure diagnosis without
printing unbounded command output or credentials. `warnings` records efficiency
targets such as a soft scenario tool-count overrun separately from correctness
failures.

The system prompt's versioned `research-policy` instructs the model to inspect
first, research before requested proposals/fixes, fetch primary sources, cite
observed URLs, keep private material out of queries, stop once sufficient primary
evidence exists, avoid refetching durable sources and preserve uncertainty.
See [RESEARCH_CAMPAIGN.md](RESEARCH_CAMPAIGN.md) for the three live stages.

For a durable single-scenario run, provide an external trusted store and stable
run ID. `--pause-after-tool-calls` is a health-lab control for creating a safe
checkpoint boundary; resume must omit it:

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

The CLI rejects a durable store inside or above/below the model-writable
workspace. Resume accepts exactly one scenario, reloads the checkpoint by run
ID, verifies the live workspace, and restores trusted historical tool evidence
for the oracle without pretending those tools ran again in the new process.

Scenario budgets may tune the deterministic no-progress policy through
`maxNoProgressEpisodes`, `maxObservationRepeats`, and `maxRepeatedToolRequests`
(defaults 2 each, minimum 1). Repeated identical reads never manufacture a
blocked failure: from the `maxObservationRepeats` threshold the observation
dispatches with an advisory nudge, and cross-round repetition stays bounded by
the no-progress episode budget while alternating cycles and repeated mutations
remain hard-blocked. Inspection-heavy campaigns raise these thresholds so a
model that re-reads files gets more nudged rounds before the run pauses. Every
live report also records `pauseReason` when a run ends paused, so stability
failures state their cause.
`runtime.requestTimeoutMs` bounds one model request (default 180 seconds) and
the report carries the whole effective budget under `effectiveBudget`.
Blocked observations count at most one no-progress episode per model round, so
a single round can never exhaust the pause budget before the model reads the
corrective feedback.

The default scenario creates a temporary project, asks the model to inspect it,
write one exact file, run the declared test, and review the final diff with the
model-visible structured Git tool. The temporary workspace is deleted after the report. To inspect the
result, provide a new or empty directory with `--workspace`; non-empty targets
are rejected before provider access or file writes.

When `--scenario` names a directory, the runner recursively loads sorted JSON
stages and executes them sequentially against the same workspace. It stops at
the first failed independent oracle. The progressive directory exercises one
accumulated JavaScript/Python/Rust project rather than isolated toy workspaces.

The checked-in health scenario uses the core `trusted-workspace` approval
profile so medium/high-risk workspace tools do not pause for interactive
approval. This bypasses only the approval prompt: manifest permissions, task
mode, transport policy, workspace scope, command containment, schemas, and the
independent oracle remain enforced. Critical or external-side-effect tools are
not auto-approved by this profile.

`--live` is mandatory so an ordinary deterministic command cannot accidentally
spend provider quota. Optional `--model`, `--base-url`, and `--config` flags are
explicit overrides.

## Credential resolution and redaction

The default config is `~/.galaxy/config.json`:

```json
{
  "agent": [
    { "type": "manual", "apiKey": "..." }
  ]
}
```

The first manual entry is used. Its `apiKey` wins over `OLLAMA_API_KEY`; its
optional `model` and `baseUrl` are used only when CLI overrides are absent.
Without configured values, the core defaults are `https://ollama.com` and
`glm-5.3-flash:cloud`.

The key is sent only as an `Authorization: Bearer` header. It is not included in
the request JSON, public connection record, trace, transcript, or report. HTTP
and mid-stream provider errors are bounded and redacted before entering runtime
events.

The Ollama adapter preserves the core's strict tool schemas for host-side
validation, but translates provider-incompatible `oneOf`/`const` nodes to
disjoint `anyOf`/single-value `enum` nodes in the outbound chat request. This
prevents Ollama Cloud from degrading mutation preconditions while leaving the
canonical execution contract unchanged.

A well-formed Ollama terminal response with no visible content and no tool call
is treated as retryable `MALFORMED_STREAM`. The immediate retry includes bounded
recovery feedback in the actual request. If the failed response contained only
hidden thinking, that retry disables thinking only when the capability contract
verifies that thinking is optional; required or unverified thinking is preserved.
A fully empty response retries the same mode. Exhausting the configured
retry limit persists a failure checkpoint instead of looping or fabricating
completion. Terminal errors now include bounded `done_reason`, `eval_count`, the
requested output limit, and thinking-character diagnostics.

`/api/show` does not publish a verified maximum output-token value, so the adapter
does not invent an 8,192-token capability ceiling. The selected core token profile
supplies `num_predict` (32,768 for `balanced`) while Ollama/model stop conditions
may still finish a normal response earlier.

Kimi-K2.7-Code is treated as requiring thinking when Ollama advertises that
capability, and preserved thinking remains enabled. A `:cloud` model is not
declared to support structured output because the Ollama Cloud contract does not
currently guarantee it; neither setting is inferred from successful text output.
Transport failures retain a bounded, credential-redacted message and, when the
runtime exposes one, a validated cause code such as `ENOTFOUND` or
`ECONNREFUSED`. This makes DNS and connection failures diagnosable without
serializing arbitrary nested transport errors or secrets.

When Git is available, `git_operation` is active in the first model request.
Generic `run_command` output from `git diff` or `git status` is deliberately not
trusted as completion evidence. If the model attempts that route, the completion
gate returns an actionable instruction to use `git_operation` instead.

After a write has current passing validation and a structured final diff, core
sends the next Ollama request with no `tools` field and explicit trusted
finalization feedback. This prevents another successful read/validate/diff
cycle from consuming the remaining budget. Some provider/model combinations
can still emit a tool call in that tool-free turn. Such a call is never
dispatched: core records a completion rejection and retries the plain-text
final report within `maxCompletionRejections`; repeated violations fail closed.
Early project inspection remains tool-enabled, so this boundary does not
truncate the normal inspect → write → validate → diff sequence.

The `advanced-commerce` and `advanced-polyglot` campaigns are framework-shaped integration contracts rather than
offline framework installations. They exercise realistic commerce, Axios-like
HTTP, GraphQL, SQL, CMS, and inventory boundaries while using standard-library
test harnesses. `advanced-polyglot` invokes Node, Python/SQLite, Rust, and Java
from one portable Node orchestrator with `shell: false`; generated binaries and
class directories are removed in `finally` blocks.

`dependency-backed` is the separate online framework campaign. Its first stage
uses the only supported host-owned setup declaration,
`runtime.dependencySetup: { packageManager: "npm" }`. The runner executes the
fixed `npm install --ignore-scripts --no-audit --no-fund` command before the Git
and mutation baselines, reports its bounded output/status, and never accepts an
arbitrary setup command from scenario JSON. Exact package versions cover React
and Next.js, Vite and Vue, NestJS, and Angular; later stages reuse the installed
tree and run all preceding tests cumulatively. `node_modules` remains observable
to the host mutation detector, but it is classified as derived state. Dependency
files use identity, size, and filesystem change timestamps; authored files,
root manifests, and root lockfiles use byte hashes. Derived paths are reported
separately and can advance the host state version, but their metadata fingerprints
never enter core `writes`, completion evidence, or resume `contentHash` fields.
This preserves visibility without pretending that a metadata digest is durable
byte evidence or hashing hundreds of MiB before and after every tool call.

`full-application` goes beyond package API calls. Its four cumulative stages
run real Next, Vite/Vue, and Angular production builds, then start a Nest
application on an ephemeral loopback port, make an HTTP request, and verify an
idempotent SQLite schema migration using Node's built-in `node:sqlite` database.
Trusted test harnesses remove build output before validation returns so generated
artifacts cannot masquerade as model-authored changes. The Angular stage uses an
explicit `tsconfig.angular.json` rather than a root `tsconfig.json`, so the
cumulative JavaScript Next application cannot accidentally enter Next's
TypeScript auto-configuration path. The Next harness also sets `CI=1` and an
explicit absolute `turbopack.root`, preventing validation from silently installing
missing types or selecting a parent workspace lockfile.

`advanced-resilience` adds four cumulative stages using real Node/SQLite
execution without installing packages. They cover idempotent reversible
migrations, rollback/data preservation, concurrent checkout with independent
database connections, an exact Unicode/CRLF pricing edit and streaming incident
analysis of a 48+ MiB log under a 32 MiB V8 heap limit. Its producer emits about
1.5 MiB of terminal output over 1.5 seconds, ending with error/completion records.
The fixture verifier proves incomplete and deliberately faulty implementations
fail, and a known-good implementation passes the accumulated test suite. These
stages require Node >=24. They do not prove a total-process memory ceiling or
arbitrarily long command supervision.

## Opt-in GitHub lifecycle

Local command conformance covers init, commit, push to a bare remote, clone,
second push, and fast-forward pull. A separate external health script can also
create a uniquely named private GitHub repository, repeat push/clone/pull, and
delete that exact repository in `finally`:

```sh
GALAXY_GITHUB_LIFECYCLE_CONFIRM=1 npm run test:github-lifecycle
```

This is intentionally outside `npm test`. Before creating anything it requires
an authenticated credential whose response headers include `delete_repo`; the
normal `repo` scope alone cannot delete a repository. It then resolves the
authenticated owner, proves the random target does not exist, and never reuses
or deletes an existing repository. A failed older run can be cleaned only by
an explicit, marker-checked recovery command:

```sh
GALAXY_GITHUB_LIFECYCLE_CONFIRM=1 npm run test:github-lifecycle -- \
  --cleanup-existing owner/galaxy-code-health-id
```

Recovery accepts only the authenticated owner's private repository with the
generated health-test name and exact lifecycle description, then verifies that
the repository no longer exists.

## Safety and oracle

The runner performs `/api/show` capability preflight first. A failed probe or a
model that does not advertise tool calling produces a structured failed report
without arranging scenario files or calling `/api/chat`.

Ollama tool support is also reported as parallel-tool support. One model round
may contain several calls, including the same name with different arguments.
The core validates the complete batch before execution and then dispatches it
sequentially in emitted order; this keeps filesystem evidence, approval, and
cancellation deterministic while retaining Ollama's native multi-call output.

The model never decides whether the health run passed. A host-owned oracle
independently checks:

- terminal core state;
- the complete sorted set of changed paths;
- exact file bytes or required fragments;
- required canonical tool IDs and alternative mutation-tool groups;
- maximum tool-call count as an efficiency warning; the runtime's configured
  `maxToolCalls` remains the hard safety limit and still fails closed;
- trusted successful validation evidence;
- leaked `.galaxy-code.lock` files.

Reports expose tool names, canonical IDs, summaries, error codes, open problems, state
transitions, checkpoint reasons, context-pressure classes, event counts, and
provider byte/chunk counts. They intentionally omit raw prompts and thinking.

Scenario `acceptanceCriteria` are model-facing guidance unless a host tool can
attest criterion satisfaction. Hard pass/fail conditions belong in `expected`,
which is evaluated by the independent oracle.

Validation commands are run with `PYTHONDONTWRITEBYTECODE=1` and
`PYTHONHASHSEED=0`. This follows Python's documented
[`-B`/bytecode-cache control](https://docs.python.org/3/using/cmdline.html)
and prevents an import performed by validation from creating an endless
validate → workspace-write → revalidate loop. The runtime still records and
requires evidence for every persistent write reported by the host.

## Current limitations

- Live behavior, latency, authentication, quota, and model drift are inherently
  non-deterministic and excluded from the normal test gate.
- The live runner uses in-memory checkpoint/final-report storage by default.
  `--store-dir` switches those artifacts to the atomic `FileRunStore`; both an
  Ollama wire test and a real Kimi run resume successfully in a second process.
  Trace events remain process-local, and an abrupt kill can resume only from
  the most recent checkpoint—not from arbitrary in-flight instruction state.
- `best_effort` command containment is reported honestly and is not a sandbox.
  `required` activates Linux `bubblewrap` only after all filesystem, network,
  hard-link, toolchain, and descendant-process probes pass. The present macOS
  host fails closed because its deprecated Seatbelt CLI prototype fails two of
  those assertions.
- Only Ollama's chat/show wire contract is implemented. Other providers still
  need their own adapter conformance suites.
