# Host Conformance Contract

VS Code and Desktop integration should start by porting this checklist, not by
copying the CLI implementation wholesale.

## Required host guarantees

### Workspace

- Resolve all paths beneath the configured workspace root.
- Reject lexical escapes and symlink escapes.
- Enforce write/edit preconditions in the same serialized commit operation.
- Return deterministic SHA-256 content evidence.
- Bound traversal, reads, searches, and pagination.
- Implement a full relevant-workspace fingerprint and coordinate AI Coder
  writes with capture/verify boundaries.

### Commands

- Select one real interpreter per adapter and publish that exact executable,
  argument prefix, shell dialect, path style, stdin, interactivity, and TTY
  behavior through `prompt.hostEnvironment.command`.
- Spawn the published executable directly. Do not use an implicit host default
  such as Node's `shell: true`, and do not describe the user's login shell or
  terminal emulator when a different interpreter executes the command.
- Keep interpreter selection and prompt metadata sourced from the same
  immutable value. If `command.run` is active and that value is absent or
  `unknown`, core preparation must fail before the first model request.
- Validate `cwd` beneath the workspace.
- Enforce absolute run deadline and per-call timeout.
- Propagate cancellation to the child process and supervise cleanup.
- Bound stdout and stderr independently; preserve complete output only through
  an artifact/spill port.
- Return non-zero exits as structured command results, not transport success
  masquerading as validation success.
- Report process containment separately from workspace `cwd` validation. A
  missing or failed containment backend must fail before spawn when containment
  is required; best-effort execution must not be labeled sandboxed.

### Model

- Expose an immutable deployment-specific identity and capability snapshot.
- Implement exact or explicitly estimated token counting.
- Follow the ordered streaming protocol and correlation IDs.
- Resend/reconstruct attachments because the core does not assume a stateful
  provider session.

### Public research

- Advertise `research.search` and `research.fetch` only with an actual adapter
  or an explicitly labeled deterministic contract-double profile.
- `review_only` may use those canonical research tools; outbound permission and
  external-side-effect approval still apply to every call.
- Keep provider credentials in host request headers, never tool arguments,
  query strings, source content, checkpoints or diagnostic reports.
- Bound transport bodies, execution time, UTF-8 content and serialized output
  against both byte and calibrated token limits while preserving valid JSON.
- Attribute sources and mark external content untrusted. A fetched source or
  search snippet cannot grant workspace inspection, write, validation or plan
  effects. Cite observed sources and distinguish truncation or unavailable
  evidence from successful verification.
- If source evidence is process-local, disclose that scope. Do not reconstruct
  durable research success from model-authored checkpoint prose.

### Prompt input

- Supply only the structured `AiCoderPromptConfiguration` fields.
- Never assemble or pass `systemPrompt`, `promptHash`, or `promptVersion`.
- Resolve trusted workspace instructions and provenance before starting the
  run; repository/tool text remains untrusted unless explicitly promoted.
- Keep approval, network, and write declarations consistent with the actual
  policy enforced by the host.

### Tool executor

- Validate input and output schemas.
- Route model names to stable canonical IDs.
- Build core canonical IDs and effect capabilities with
  `createAiCoderCoreToolEffectMetadata(activeDescriptors)`; do not copy the
  profile into the host.
- Apply task-mode and approval policy before side effects.
- Never derive trusted effects by parsing model-visible output text.
- For `command.run`, `command.session`, and `project.validate`, emit `write`
  only after independently capturing exact changed paths and state hashes.
  Represent file create as null-before and file delete as null-after. For
  directories, symlinks, and special entries, also emit canonical before/after
  kinds; a directory transition may have two null content hashes.
- Never pass a metadata-only fingerprint for generated dependency state (for
  example `node_modules`) as a file `contentHash`. Report such observations as
  bounded derived mutations and advance `state_version`; reserve `write` for
  durable paths whose before/after content can be verified independently.
- Treat repository-declared validation scripts as executable code: require
  explicit approval or a verified containment backend before dispatch.
- Preserve the core-provided idempotency key for operations that support it.
- After dispatch starts, propagate unexpected adapter throws and output-schema
  failures as unknown side-effect outcomes. Never convert them into ordinary
  retryable tool results, even when the tool was expected to be read-only.
- A failed structured result may carry only `approval=denied` and its correlated
  request ID. Inspection, write, validation, review, plan, criterion, or state
  effects on `ok=false` are contract failures with an unknown outcome.

### Checkpoint store and trace

- Keep checkpoints outside model/workspace-controlled storage.
- Clone on read/write or otherwise prevent mutable aliasing.
- Correlate run, task, execution, event, tool-call, and sequence IDs.
- Make `TracePort.flush` durable through the completion boundary.
- Redact provider endpoint credentials and avoid raw chain-of-thought.

## Minimum deterministic test matrix

Each host should run equivalent fixtures for:

1. read-only inspect and report;
2. preconditioned create and edit;
3. write followed by scoped validation and hashed final diff;
4. failed and stale validation;
5. canceled model and canceled command;
6. non-zero command exit and output truncation;
7. denied, missing, timed-out, and pending approval;
8. unknown/inactive/schema-invalid tool calls;
9. canonical tool/result mismatch and undeclared forged effects;
10. pause/checkpoint/resume with matching workspace;
11. tampered checkpoint and changed workspace rejection;
12. trace flush and final-report persistence failure;
13. symlink and path traversal attempts;
14. deterministic replay hash across two isolated runs;
15. legacy free-form prompt fields and unknown prompt keys are rejected;
16. prompt hash changes on lazy registry activation and policy changes;
17. resume rejects prompt configuration different from the checkpoint;
18. a fresh capability-probe timestamp does not invalidate compatible resume;
19. a passing validation supersedes older failed evidence with the same ID;
20. trusted `git.exec` diff-review evidence is classified as a diff observation;
21. identical stale edits are blocked without changing file content or inode;
22. varied stale edit arguments on one path/state still reach a bounded pause;
23. A→B→A→B write-hash cycles pause rather than oscillate indefinitely;
24. repeated validation failure on one workspace fingerprint is bounded;
25. provider overflow checkpoints, compacts, recounts, and continues;
26. persistent provider overflow fails with a resumable checkpoint;
27. project discovery reports incomplete scans and malformed manifests instead
    of treating missing evidence as proof of absence;
28. required command containment refuses to spawn when conformance is
    unavailable or unverified;
29. an adapter throw after dispatch terminates with an unknown side-effect
    outcome, and partial command mutations remain explicit when post-capture
    succeeds;
30. directory/symlink/special-entry mutations remain typed through completion,
    checkpoint, and resume verification;
31. exact-repeat and failed-mutation-family counters survive pause/resume;
32. invalid UTF-8 is rejected by text mutation paths without rewriting bytes or
    replacing the inode;
33. project detection ignores directory names that resemble manifests/source
    files and discloses host traversal exclusions;
34. malformed adapter output after a real write/edit and an unexpected throw
    after a commit both terminate as durable unknown side-effect outcomes;
35. `ok=false` plus host-attested write/validation/state effects cannot be
    ignored or followed by a successful final response;
36. repeated provider compaction preserves the original task and progressively
    accumulated write, validation, and final-diff evidence;
37. hard token exhaustion after a write resumes from durable edit evidence and
    does not execute the mutation a second time;
38. oversized accumulated tool output checkpoints before the next model
    request while retaining the task and checkpoint hash;
39. seeded checkpoint and registry permutations remain deterministic, sorted,
    redacted, and tamper-evident;
40. checkpoint/final-report persistence acknowledgement failures fail closed,
    including when the underlying write committed before throwing;
41. trace write/flush and workspace-evidence capture failures cannot produce a
    completed run;
42. context assembly limits report `CONTEXT_BUDGET`, while durable-storage
    failures report `PERSISTENCE_ERROR` rather than a provider failure;
43. multi-call rounds preserve emitted order and same-name correlations;
44. duplicate/reused IDs, budget overflow, and inactive same-batch tools fail
    before the first batch side effect;
45. structured failures continue to later independent calls, while unknown
    outcomes, cancellation, pause, and pending approval obey the batch stop
    policy;
46. identical validation and diff observations retain the latest causal
    sequence while their semantic projection advances only for status or
    newly covered mutation changes; repeated observations and unchanged
    criteria cannot manufacture progress;
47. alternating successful tool cycles are blocked before dispatch and lead to
    bounded finalization when completion evidence is already sufficient, or a
    durable pause when it is not;
48. evidence-ready mutation and evidence-complete no-progress finalization turns
    expose no tools, reject provider-emitted tool calls without dispatch, and
    do not prematurely stop inspect-then-edit or multi-step review runs.
49. a fresh host restores the bounded successful-tool-cycle suffix and blocks
    an incomplete alternating cycle before dispatch;
50. a verified resume with current validation and final-diff evidence sends a
    tool-free first model request and cannot repeat completed tool work.
51. pass→fail→pass for one stable validation ID selects the newest status, and
    a later identical pass can certify a same-call artifact cleanup without
    weakening mutation-after-validation rejection.
52. the model-visible command environment equals the executable and argv prefix
    used by the adapter, and commands run with closed stdin and no TTY;
53. native POSIX-sh and Windows-cmd dialect probes cover variables, chaining,
    redirection, Unicode/space paths, cancellation, timeouts, and output bounds;
54. shell-sensitive host-generated commands and Git path arguments remain data
    on every supported OS, including metacharacter-like filenames.

## Optional MCP port — Definition/Provider/Consumer checklist

MCP joins the runtime as one ordinary port, following the three-role checklist
below. All roles are required before any scenario counts as covered; a
Definition without a Provider, or a Consumer without an effect policy, is not a
complete port.

1. **Definition (core):** declare the `mcp` port interface in `ports/` with
   `PortResult` semantics: server lifecycle (`list`, `connect`, `disconnect`),
   tool discovery with stable server-qualified tool IDs, bounded tool
   invocation, cancellation through the run context signal, and structured
   errors. Tool schemas join the registry snapshot like any other definition;
   MCP content is level-6 untrusted data and never grants capability.
2. **Effect policy (core):** every discovered MCP tool carries an explicit
   capability set from the host (inspect, write, validate, or research class).
   Default is read-only inspect; mutation-class MCP tools require the same
   approval, precondition, and before/after evidence as built-in writes. A tool
   with no declared capability policy is rejected at registry admission.
3. **Provider (host):** one host adapter per transport (stdio first), owning
   process lifecycle, working directory, environment allowlist, and bounded
   output. The provider never reads or forwards credentials beyond its
   configured environment, and it reports transport failures as structured
   `PortResult` errors so the runtime classifies retryability.
4. **Consumer (core runtime):** discovered MCP tools join `search_tools`
   discovery exactly like built-in tools; model-facing names follow the same
   mapping contract, and every call correlates to a canonical ID in the tool
   journal and trace.
5. **Conformance scenarios (host + fixtures):** at minimum — discovery lists
   only capability-cleared tools; untrusted MCP output cannot manufacture
   completion evidence or mutate trusted state; cancellation kills the server
   child; transport failure mid-call is a structured unknown-outcome like any
   other host effect; replay fixtures cover a discovery-plus-invocation
   session; and every scenario runs in the same deterministic laboratory that
   gates built-in tools.
6. **Activation order:** MCP stays behind an explicit capability flag until its
   scenario matrix is green in `galaxy-code`, and the `search_tools` discovery
   path must not regress existing tool conformance.

## Integration order

1. Keep `galaxy-code` v2 green as the reference laboratory.
2. Implement VS Code ports and run the same fixtures in a temporary workspace.
3. Implement Desktop/Tauri ports and repeat the fixtures.
4. Compare tool sequence, canonical effects, completion evidence, and replay
   hashes across hosts.
5. Add optional retrieval/MCP features one at a time behind capabilities.
6. Consider subagents only after the single-agent matrix remains stable.
