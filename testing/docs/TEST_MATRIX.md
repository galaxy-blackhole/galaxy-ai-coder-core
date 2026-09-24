# AI Coder deterministic test matrix

Updated: 2026-09-05

This matrix separates three claims that must not be conflated:

1. **Core contract** — descriptor, schema, approval, effect capability, prompt,
   checkpoint, and completion behavior.
2. **Galaxy Code host** — real temporary-workspace filesystem, Git, project,
   and bounded command adapters.
3. **Contract double** — deterministic in-memory behavior used to prove an
   optional tool can participate in the runtime. It is not a production
   integration.

## End-to-end risk matrix

| Area | Automated scenarios | Deterministic oracle |
| --- | --- | --- |
| New project/files | atomic create, must-not-exist conflict, parent creation, command-created tree, untracked Git diff | exact bytes/kinds/hash, evidence-complete allowed-change set, reviewed diff |
| Existing project | project detection, manifest/source/test reads, nested package roots, bounded pagination | reported language/scripts must come from observed files |
| Focused edit | matching hash, stale hash, ambiguous/zero match, no-op replacement | compare-and-swap result and inode/content preservation on failure |
| Edit/tool loops | identical retry, alternating successful tool suffix, varied stale arguments, A→B→A→B hash return, pause/resume boundary | duplicate validation/diff/criterion evidence cannot advance semantic state; calls in a repeated cycle are blocked before dispatch; counters survive resume and pause with checkpoint |
| Full filesystem mutation | create/edit/delete, directories, symlinks, command-created outputs | before/after kind plus content/entry hashes; every final change has evidence |
| Validation | fail→edit→pass, pass→fail→pass, same-call compiler cleanup followed by an identical pass, volatile retry diagnostics, repeated fail without state change, skipped script, cancellation/deadline, Python import without bytecode-cache mutation, multi-subprocess stdout plus stderr | stable validation ID + final workspace fingerprint; latest causal observation is retained while semantic progress advances only for status or newly covered mutations; same-state failures replace volatile diagnostics; deterministic Python validation environment; labeled bounded tails retain evidence from both streams |
| Git review | working tree, staged changes, untracked files, shell-safe path transport, truncation, local commit→bare-remote push→clone→second push→pull | diff hash only when complete; no index mutation; metacharacter-like paths remain data; cloned consumer receives the final bytes |
| Context limits | provider overflow, 12-compaction 13-round multilingual run after write/validation/lazy activation/diff, hard exhaustion after mutation, output pressure, nine compactions split across two OS processes | ordered pressure/checkpoint events, progressive durable evidence, task present in every model request, bounded token ledger |
| Resume | successful continuation, fresh-host registry and `task.checkpoint` reconstruction, alternating-cycle suffix, evidence-ready first-turn finalization, tampered checkpoint, changed workspace, separate-process file-store resume, executable CLI pause/resume over Ollama protocol, six compactions before process interruption and three after resume | checkpoint hash and compaction total, active-tool snapshot, bounded goal/progress/decisions/next-step state, edit evidence, fresh workspace verification, restored oracle history, and no repeated completed tools |
| Provider protocol | missing start, duplicate correlation, same-name multi-call batch, retryable empty terminal/error, immediate retry feedback, optional-thinking recovery, required-thinking preservation, cancellation before and after response headers | fail-closed code; bounded retry with feedback in the actual retry request; response-body abort; emitted-order correlation; no duplicate tool execution |
| Ollama/Kimi protocol | interleaved thinking/content/tool calls, repeated tool names with distinct arguments, missing call ID, empty terminal, thinking-only output exhaustion, malformed/unterminated stream, HTTP/mid-stream errors | deterministic round-scoped correlation and usage mapping; verified parallel-tool capability; no fabricated output ceiling; bounded terminal diagnostics; `MALFORMED_STREAM` before false completion |
| Public web research | real Ollama search/fetch adapter with mocked transport, lazy activation, read-only review, explicit approval, primary-source recommendation, HTTP retry and migration investigation | exact API request/auth, source provenance, UTF-8/JSON/body bounds, deadline/cancel, structured errors, no forged workspace effects, fetched-domain/citation/order oracle; prose semantics still require review |
| Advanced resilience | cumulative real SQLite migration, rollback/idempotency, stock contention from independent worker connections, Unicode/CRLF targeted pricing, streaming 48+ MiB logs and delayed large terminal output | deliberately incomplete and semantically faulty solutions fail; known-good cumulative implementation passes; durable data checks, memory ceiling and bounded log result |
| Live health runner | capability preflight, real core rounds over an Ollama wire mock, bounded empty-terminal and tool-free-finalization retries, fixed host-owned dependency setup, a two-call round with recoverable invalid arguments, generic-Git rejection and structured-Git recovery, real write/test/Git adapters, ordered JavaScript/Python/Rust, commerce, polyglot, dependency-backed framework, and full-application campaigns, durable two-process CLI pause/resume, auth failure | no mutation before failed preflight; dependency installation precedes Git/snapshot baseline; large derived dependency trees use metadata comparison fingerprints while authored files retain byte hashes; derived paths remain observable but never become core writes/content evidence; Git is visible initially; generic shell output cannot forge diff evidence; every batch result is correlated; finalization tool calls never dispatch; resumed oracle uses checkpoint history without replaying it; credential absent from request body and report |
| Approval/mode | explicit allow/deny, missing decision, review/validate-only writes | denied calls have no success effects or workspace changes |
| Output bounds | UTF-8 pagination/cursors, multi-megabyte terminal truncation, streamed search through a 20+ MiB log, stdout/stderr validation tails, spill contract | stable cursor/full-file hash/provenance and configured byte/token limits; search returns only bounded matching lines instead of loading the log into context |
| Adapter evidence failure | malformed output, unexpected throw, structured failure after a real write/edit, dependency tree above the byte-hash budget, baseline failure before dispatch | shared dependency-aware before/after policy; comparison fingerprints are separated from durable content hashes; durable unknown outcome only after a possible side effect; a baseline failure returns a structured error and never calls the mutation adapter |
| Workspace scope | traversal, absolute path, symlink escape, ignored-dir active evidence | canonical real path remains under root; checkpoint detects divergence |
| Command safety | exact interpreter/prompt contract, native shell dialect, env/chaining/redirection, Unicode paths, closed stdin/no TTY, timeout with verified partial mutation recovery, cancellation, process group, output tail, hard-link preflight, macOS Seatbelt diagnostics, Linux bubblewrap argument policy and live host probe | adapter spawns the advertised executable with `shell: false`; no false sandbox claim; timeout effects are independently snapshotted and repaired with an observed hash; `required` fails before spawn unless every backend assertion passes; network and outside writes denied when active |
| Completion | premature final, missing validation, stale/duplicate validation, volatile repeated failure output, duplicate diff/criterion evidence, missing final diff/trace, host-owned final-report persistence, provider tool call during tool-free finalization | model receives only actionable evidence issues; recovered validation closes the stable prior problem; evidence-ready mutation finalizes with no provider tool definitions; forbidden finalization calls never dispatch and are bounded by completion-rejection budget; runtime persistence/trace failures become `PERSISTENCE_ERROR` without another model turn |
| Registry drift | default host profile, full 21-tool profile, lazy activation | canonical ID set and effect profile exactly match core catalog |
| Seeded properties | 96 checkpoint payloads, 128 registry permutations, 64 nested UTF-8 CAS mutation cases | reproducible seed; stable hashes/order; no secret leak; stale writes never change bytes |
| Soak/replay | repeated multi-compaction write/validate/diff fixture plus a 13-round multilingual fixture with 12 consecutive compactions in isolated temporary roots | every run passes with identical normalized replay hash, retained task/evidence, and no leaked in-memory state |
| Progressive campaign | scaffold → inspect → hash-guarded edit → expected empty-response failure → fresh-host exhaustion/resume on one project | later stages consume accumulated bytes; failure does not poison the next run; identical campaign replay hash; no leaked lock files |

## Tool coverage

| Canonical tool | Core contract | Galaxy Code executable coverage |
| --- | --- | --- |
| `catalog.search` | schema, lazy activation, prompt reassembly | real registry search and activation |
| `task.checkpoint` | schema, plan effects | in-memory deterministic host state |
| `workspace.list` | schema, inspect effect | real filesystem, bounds, pagination |
| `workspace.glob` | schema, inspect effect | real filesystem patterns and bounds |
| `workspace.grep` | schema, inspect effect | real text/regex search and bounds |
| `workspace.read` | cursor in input/output contract | real UTF-8 range and cursor continuation |
| `workspace.edit` | write effect, hash precondition | real atomic exact replacement and conflict safety |
| `workspace.write` | create/edit effect | real atomic create/replace and no-op rejection |
| `command.run` | approval/state/write capability | real bounded process; conditionally verified Linux bubblewrap backend; macOS remains fail-closed/uncontained |
| `project.detect` | schema and inspect capability | bounded file-kind-aware scan; exclusions/warnings/completeness are asserted |
| `project.validate` | high-risk approval, stable validation/write effects | declared npm scripts cannot run without explicit approval; typed mutation snapshot |
| `git.exec` | approval/diff/inspect capability | real read-only status/diff/log, including untracked content |
| `research.fetch` | full descriptor/effect contract, approved read-only research | real opt-in Ollama web_fetch adapter; bounded untrusted content/hash; durable checkpoint evidence and executor URL cache; mocked transport tests; live campaign awaits user run |
| `research.search` | full descriptor/effect contract, lazy activation | real opt-in Ollama web_search adapter; bounded untrusted results; durable checkpoint evidence and executor query cache; mocked transport tests; live campaign awaits user run |
| `command.session` | full descriptor/effect contract | deterministic contract double only |
| `preview.manage` | full descriptor/effect contract | deterministic contract double only |
| `perception.analyze` | full descriptor/effect contract | deterministic contract double only |
| `artifact.create` | full descriptor/effect contract | deterministic state/idempotency double only |
| `artifact.list` | full descriptor/effect contract | deterministic pagination double only |
| `artifact.read` | full descriptor/effect contract | deterministic hash/provenance double only |
| `user.ask` | full descriptor/effect contract | deterministic correlated-answer double only |

Every optional contract tool has success plus invalid/not-found coverage where
applicable. External/process tools also have explicit approval denial coverage.
The full-profile end-to-end scenario invokes all nine non-production contract
doubles in one single-agent run and exercises prompt reassembly after lazy
activation. Default profile scenarios invoke all 12 adapter-backed tools,
including checkpoint, glob, grep, project, command, and initially active Git.
The research live profile adds two real HTTP adapters without enabling the
remaining seven doubles. Existing `full_contract` fixtures still use all nine
deterministic doubles when no real research port is supplied.

## Release gates

A change is acceptable only when all of the following pass:

```sh
cd galaxy-ai-coder-core && npm run verify
cd testing && npm run check
npm run test:command-conformance
```

Additionally:

- `git diff --check` must pass in both repositories;
- the core distribution smoke test must import built exports;
- Galaxy Code must build the sibling core before reading its `dist` exports;
- the 21 canonical IDs and effect profile must have no missing/extra entry;
- fixture reports must match their declared model-round/token-count consumption
  expectation, fire every declared control hook, and validate every persisted
  checkpoint;
- completed fixture reports must reject any final filesystem change lacking
  matching trusted mutation evidence;
- no test may claim a contract double or `best_effort` command execution is a
  production security/integration guarantee.
- `test:command-conformance` must pass natively on every OS advertised for a
  release; a simulated platform mapping is not native certification.

Research/resilience implementation verification on 2026-09-05:

- `.galaxy/audit/2026-09-05T06-17-42-970Z-HmbVoi/summary.json` passed all
  23 deterministic groups: 90 core, 103 CLI unit, 77 integration (+ one
  Linux-only skip), and 37 end-to-end tests, plus builds/dist/fixtures/campaign.
- The final research output refinements passed a further focused 20-test run
  over `research-observations.test.ts`, `live-research.test.ts` and
  `research-output-bounds.test.ts`, plus CLI typecheck/build. This includes
  four newly added output-budget regressions and one diagnostic-excerpt test
  not enumerated when the full audit started. The next full audit discovers
  them automatically.
- The output regressions reproduce long web JSON hitting the core's calibrated
  token limit despite fitting its byte cap. Research now preserves valid JSON
  under both limits, shortens snippets before dropping source URLs, and
  recomputes hashes after shortening fetched text. Balanced parentheses in
  real source URLs survive Markdown citation parsing.
- No new live campaign or actual web API call was run by the implementation
  agent; `live:research` and `live:advanced-resilience` await user-run evidence.

Historical acceptance evidence on 2026-09-05 (before the research/resilience extension):

- User-run `.galaxy/audit/2026-09-05T05-28-44-045Z-wiufTz/summary.json`
  was inspected: all 30 groups passed, including `live:full-application` and
  the complete `github` lifecycle. This supersedes the earlier pending live
  items below. The new research/resilience live campaigns have not been run by
  the implementation agent.

- `@galaxy-stack/ai-coder-core`: 89/89 source tests plus typecheck, build, and
  distribution smoke passed;
- `galaxy-code`: 174 passed, 0 failed, and 1 host-inapplicable Linux-only
  containment test skipped, plus typecheck and build passed;
- `npm run test:audit`: all 23 deterministic steps passed outside the nested
  execution sandbox, including 13 individual fixtures and the progressive
  campaign. The new two-process scenario completed six compactions before its
  pause and three after resume without replaying completed tools. Six audit
  regression tests cover first-failure cancellation,
  unmatched name filters, explicit external opt-ins, retained oracle evidence,
  and completing external cleanup before interruption. Live/GitHub were not
  rerun in this audit;
- real `ollama` / `kimi-k2.7-code:cloud`: the ordered progressive campaign
  passed 3/3 stages on one accumulated JavaScript/Python/Rust workspace with 22
  total tools, exact allowed changes, passing validation, structured final Git
  review, and no rejection, retry, checkpoint, or pause;
- real Ollama/Kimi durable resume: process one paused after `project.detect` and
  persisted a checkpoint; process two loaded its hash, did not repeat project
  detection, then completed inspection, write, validation, Git review, and
  tool-free finalization with no retry or completion rejection;
- real Ollama/Kimi advanced commerce campaign: 3/3 accumulated stages and 6/6
  business tests passed across Next-style rendering, Vite/Nest-style checkout,
  Axios-compatible injection, GraphQL schema, SQL migration, and CMS resolvers;
- real Ollama/Kimi advanced polyglot campaign: 3/3 accumulated stages passed;
  the final project was detected as four languages and its portable validation
  ran Node, Python/SQLite, Rust, and Java before structured Git review;
- real Ollama/Kimi dependency-backed campaign: 4/4 accumulated stages passed
  against 245 installed packages; the final cumulative suite executed actual
  Angular signals, Nest dependency injection/testing, Next/React server APIs,
  and Vite/Vue transformation/reactivity with exact source changes and empty
  `openProblems` in every stage;
- Before the successful 05:28 audit, the full-application campaign exposed the
  previous 512 MiB full-byte dependency
  snapshot limit; a later real Kimi run proved that the tool executor still used
  its own default snapshot after the runner had been fixed. Runner and executor
  now share one dependency-aware policy for edit, write, command, and validation;
  `node_modules` uses metadata comparison fingerprints while authored files
  retain byte hashes. Derived dependency paths remain separately observable but
  never become core writes. A baseline failure is structured before dispatch instead of being
  mislabeled as an unknown side effect;
- the next full-application run completed the real Next stage and exposed Vite's
  default ESM config-loader directory, `node_modules/.vite-temp`. The Vue source
  and both production builds passed, but the leftover empty directory correctly
  failed the exact-change and completion gates. The trusted Vite harness now uses
  the supported native config loader and removes that exact temporary directory
  in `finally`;
- the following run completed Next, Vite/Vue, and Nest/SQLite, then exposed a
  cross-framework config collision: Angular's root `tsconfig.json` activated
  Next's TypeScript setup, after which the model installed `@types/react` into
  `node_modules`. Angular now owns `tsconfig.angular.json`; Next runs with
  `CI=1` and an explicit `turbopack.root`. Metadata comparison fingerprints for
  derived dependencies are separated from byte-verifiable core writes, and an
  Executor→RunController→WorkspaceVerifier regression covers a command that
  mutates both classes;
- GitHub lifecycle recovery: an earlier run created
  `buikevin/galaxy-code-health-1788551807028-302f216a`, completed its
  push/clone/pull checks, then received HTTP 403 because deletion authority was
  missing. The user subsequently completed `gh auth refresh` for `delete_repo`
  and supplied a successful marker-checked cleanup result:
  `{"cleanedExistingRepository":true,"passed":true,"repository":"buikevin/galaxy-code-health-1788551807028-302f216a"}`.
  The orphan was removed. The subsequent 05:28 audit also confirms a fresh
  complete lifecycle pass with the updated preflight.

## Known non-green production items

- Native `run_command` conformance is green on macOS arm64. Linux and Windows
  mappings and prompt contracts have deterministic unit coverage, but native
  execution remains uncertified until this same gate runs on those operating
  systems. See `CROSS_PLATFORM_COMMANDS.md`.
- The implemented Linux `bubblewrap` backend could not be executed on this
  macOS host; it remains inactive on any Linux host until its live probe passes.
  macOS `sandbox-exec` is deprecated and still fails hard-link and
  detached-descendant probes, so `required` correctly refuses commands here.
- Seven optional tools still use lab-only doubles, not real provider/UI/storage
  adapters.
- Cross-host VS Code/Desktop conformance is outside this Galaxy Code lab run.
- `health --live` supports Ollama/Kimi as a manually invoked, non-deterministic
  health check. It is deliberately excluded from `npm test` and release gates.
- Live trace history remains process-local. Checkpoints and final reports can be
  durable, but an abrupt kill resumes from the latest safe checkpoint rather
  than reconstructing uncheckpointed in-flight state.

These limitations do not weaken the deterministic core assertions; they limit
which host capabilities may honestly be advertised as production-ready.
