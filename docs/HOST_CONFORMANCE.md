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

### Model

- Expose an immutable deployment-specific identity and capability snapshot.
- Implement exact or explicitly estimated token counting.
- Follow the ordered streaming protocol and correlation IDs.
- Resend/reconstruct attachments because the core does not assume a stateful
  provider session.

### Tool executor

- Validate input and output schemas.
- Route model names to stable canonical IDs.
- Declare effect capabilities per canonical ID.
- Apply task-mode and approval policy before side effects.
- Never derive trusted effects by parsing model-visible output text.
- Preserve the core-provided idempotency key for operations that support it.

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
14. deterministic replay hash across two isolated runs.

## Integration order

1. Keep `galaxy-code` v2 green as the reference laboratory.
2. Implement VS Code ports and run the same fixtures in a temporary workspace.
3. Implement Desktop/Tauri ports and repeat the fixtures.
4. Compare tool sequence, canonical effects, completion evidence, and replay
   hashes across hosts.
5. Add optional retrieval/MCP features one at a time behind capabilities.
6. Consider subagents only after the single-agent matrix remains stable.
