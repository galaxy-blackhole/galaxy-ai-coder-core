# AI Coder Core Architecture

## Scope

The core owns provider-neutral orchestration and correctness policy. A host owns
filesystem, command, model, persistence, trace, artifact, UI, and approval I/O.
This split keeps Terminal, VS Code, and Desktop behavior equivalent without
sharing platform APIs.

The current baseline is deliberately single-agent. Subagents may be added only
after deterministic single-agent fixtures remain stable across all hosts.

## Trust boundaries

There are four distinct input classes:

| Input | Trust | Runtime treatment |
| --- | --- | --- |
| System prompt and workspace policy | trusted host policy | versioned and hashed |
| User task | trusted user request | separated from workspace/tool content |
| Workspace, command, web, and MCP text | untrusted data | bounded observation only |
| Host-declared tool effects | trusted host assertion | schema, identity, and capability checked |

`effectsAuthority: "host"` is necessary but not sufficient. The runtime also
requires the tool result's canonical ID to match the active model-name mapping
and requires each effect category to appear in that canonical tool's declared
effect capability set.

## One-round protocol

Each provider stream must:

1. emit exactly one `started` event first;
2. emit content, thinking, usage, or at most one tool call;
3. emit exactly one `done` event last;
4. use `stopReason: "tool_calls"` if and only if a tool call was emitted;
5. preserve the configured model identity;
6. use a non-empty, run-unique `toolCallId`.

Multiple calls are rejected for now. Sequential execution disguised as a
parallel batch creates ambiguous approval and partial-result behavior, so batch
support needs a separate versioned protocol.

## Tool correctness boundary

The host supplies an active tool set containing:

- model-visible definitions;
- a complete model-name-to-canonical-ID mapping;
- canonical-tool effect capabilities;
- a deterministic registry snapshot hash.

Before an observation enters context, the runtime verifies result correlation,
success/error consistency, effect authority, mode restrictions, effect shapes,
and effect capabilities. Oversized output is bounded; an optional spill adapter
must receive the run context and honor cancellation/deadline.

Tool output strings can explain what happened, but never satisfy inspection,
write, validation, diff, approval, or acceptance criteria by themselves.

## Completion evidence

A final report is only a candidate. The completion gate checks:

- non-empty final report;
- workspace inspection when required;
- no running tool and no pending approval;
- all required criteria are `satisfied`;
- the latest result for each validation ID (later array entry wins a sequence
  tie);
- no failed current validation;
- every write has a later successful validation whose explicit scope covers the
  path;
- final diff review occurs after the last write and carries a non-empty diff
  hash;
- validation and diff evidence match the fresh final workspace fingerprint;
- token ledger contains the current model turn;
- final report storage and trace flush when those host dependencies are present
  (or when explicitly requested).

The workspace verifier declares `serialized_workspace`: AI Coder mutations must
not race evidence capture. Hosts must still detect or coordinate external edits.

## Checkpoint and resume

Checkpoint free text is data, even after integrity verification. A checkpoint:

- excludes raw chain-of-thought and raw tool output;
- redacts common credential forms;
- rejects unknown and forbidden fields;
- includes prompt, task, model, capability, registry, effect-policy, workspace,
  tool-call, approval, validation, and delivery compatibility state;
- hashes the sanitized payload, reason, and creation timestamp with SHA-256;
- is cloned before asynchronous validation and deeply frozen before use;
- requires trusted host provenance and a matching live workspace fingerprint.

The deadline policy is explicitly `per_execution_segment`: a manual resume gets
a new absolute deadline from the resume request. The prior segment budget and
checkpoint-persistence grace are retained in the checkpoint for audit.

SHA-256 detects accidental or workspace-level tampering; it is not a signature.
The `AiCoderRunStore.checkpointTrust` contract therefore requires checkpoint
storage to be isolated from model/workspace-controlled writes.

## Cancellation semantics

The core races model, tool, persistence, spill, and trace waits against the run
signal. It cannot roll back an arbitrary external side effect. If cancellation
wins before a tool adapter returns a structured result, the outcome is recorded
as `unknown`, not `canceled`. Host adapters must terminate or supervise their
own process/network operation and preserve idempotency keys where supported.

## Portability constraints

- Workspace compare-and-swap is only atomic between writers that cooperate on
  the same locking protocol. Production native hosts should prefer descriptor-
  relative/openat-style primitives where available to reduce symlink races.
- A validated command `cwd` is a scope check, not an operating-system sandbox.
  Production hosts still need process permissions/sandboxing.
- The core contains no Node.js filesystem or process dependency; those live in
  `galaxy-code` host adapters.
