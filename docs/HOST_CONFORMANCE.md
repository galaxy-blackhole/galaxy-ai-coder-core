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
    request while retaining the task and checkpoint hash.

## Integration order

1. Keep `galaxy-code` v2 green as the reference laboratory.
2. Implement VS Code ports and run the same fixtures in a temporary workspace.
3. Implement Desktop/Tauri ports and repeat the fixtures.
4. Compare tool sequence, canonical effects, completion evidence, and replay
   hashes across hosts.
5. Add optional retrieval/MCP features one at a time behind capabilities.
6. Consider subagents only after the single-agent matrix remains stable.
