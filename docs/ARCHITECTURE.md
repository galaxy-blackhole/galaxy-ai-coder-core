# AI Coder Core Architecture

## Scope

The core owns provider-neutral orchestration and correctness policy. A host owns
filesystem, command, model, persistence, trace, artifact, UI, and approval I/O.
This split keeps Terminal, VS Code, and Desktop behavior equivalent without
sharing platform APIs.

The current baseline is deliberately single-agent. Subagents may be added only
after deterministic single-agent fixtures remain stable across all hosts.

## Prompt ownership

Hosts provide `AiCoderPromptConfiguration`, never free-form system text or a
claimed hash/version. After capability probing and registry resolution, the
runtime calls `assembleAiCoderPrompt` and retains the immutable snapshot. It
also builds the sole P0 user task through `createAiCoderTaskContract` and
`formatAiCoderUserTask`.

When lazy activation changes the registry snapshot, runtime assembly runs again
and atomically replaces the context manager's system-policy item. Checkpoint
compatibility always uses the current core-produced snapshot. See
[PROMPT_CONTRACT.md](PROMPT_CONTRACT.md).

## Trust boundaries

There are five distinct input classes:

| Input | Trust | Runtime treatment |
| --- | --- | --- |
| Structured prompt configuration | trusted host metadata | validated before asynchronous work |
| Core-assembled system prompt | trusted core policy | versioned, hashed, and immutable per registry snapshot |
| User task | trusted user request | separated from workspace/tool content |
| Workspace, command, web, and MCP text | untrusted data | bounded observation only |
| Host-declared tool effects | trusted host assertion | schema, identity, and capability checked |

`effectsAuthority: "host"` is necessary but not sufficient. The runtime also
requires the tool result's canonical ID to match the active model-name mapping
and requires each effect category to appear in that canonical tool's declared
effect capability set. The result type and runtime validator also prohibit
success effects on `ok=false`; only a correlated host approval denial may
accompany a failed result.

## One-round protocol

Each provider stream must:

1. emit exactly one `started` event first;
2. emit content, thinking, usage, or at most one tool call;
3. emit exactly one `done` event last;
4. use `stopReason: "tool_calls"` if and only if a tool call was emitted;
5. preserve the configured model identity;
6. use a non-empty, run-unique `toolCallId`.

A `completed` terminal event with blank visible content and no tool call is a
malformed provider turn, even when the provider reports a normal stop reason
or includes private thinking. The runtime fails it as `INVALID_MODEL_STREAM`
instead of spending the remaining turn budget retrying an impossible
completion report. Provider adapters should detect this earlier when their
wire protocol permits an empty terminal payload, but the core check remains a
provider-neutral last line of defense.

Multiple calls are rejected for now. Sequential execution disguised as a
parallel batch creates ambiguous approval and partial-result behavior, so batch
support needs a separate versioned protocol.

## Tool correctness boundary

The host supplies an active tool set containing:

- model-visible definitions;
- a complete model-name-to-canonical-ID mapping;
- the versioned canonical core-tool effect profile;
- a deterministic registry snapshot hash.

All built-in tools use `AI_CODER_CORE_TOOL_EFFECT_PROFILE`. Hosts derive both
the active model-name mapping and stable full effect policy with
`createAiCoderCoreToolEffectMetadata(activeDescriptors)`; they must not keep a
local copy. Runtime startup fails closed when a built-in tool omits or changes
its canonical capabilities. Extension and MCP canonical IDs may declare their
own versioned host profile.

Before an observation enters context, the runtime verifies result correlation,
success/error consistency, effect authority, mode restrictions, effect shapes,
and effect capabilities. Oversized output is bounded; an optional spill adapter
must receive the run context and honor cancellation/deadline.

A host adapter that throws instead of returning a structured result has an
unknown side-effect outcome. The runtime records that outcome in the failure
checkpoint and terminates the run; it never converts the throw into a harmless
tool observation that the model can talk past.

Tool output strings can explain what happened, but never satisfy inspection,
write, validation, diff, approval, or acceptance criteria by themselves.

Generic command tools may report `write` only when the host independently
captures exact changed paths and state hashes. Creation uses a null before hash;
deletion uses a null after hash. Non-file transitions additionally carry
`beforeKind`/`afterKind` (`missing`, `directory`, `symlink`, or `other`), so a
directory create/delete may validly have two null content hashes while its kinds
prove the change. Symlink and special-entry hashes bind their entry state.
Merely parsing stdout or assuming command success changed a path is
insufficient.

## No-progress guards

The runtime bounds several loops that are semantically equivalent even when
their call JSON is not byte-identical:

- the same tool and arguments repeated on one state;
- different failed mutation arguments against one canonical tool, path, and
  state (for example, repeatedly guessing stale edit fragments);
- a file returning to a prior content hash, such as A→B→A→B;
- one stable validation ID failing repeatedly on the same workspace
  fingerprint.

The first incidents add trusted corrective feedback. Two no-progress episodes
without a materially different inspection or state transition pause the run
and persist a checkpoint. Write-state and validation history are reconstructed,
while exact-repeat and failed-mutation-family counters are explicitly persisted
and restored on resume; the model cannot erase them with prose.
Successful validation also removes superseded failure details, while repeated
identical open problems are deduplicated to keep checkpoints bounded.

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

Provider token counting runs before each model request when supported. If the
provider reports overflow, the runtime checkpoints, compacts, rebuilds the
round, and counts again. A still-over-budget round fails with a checkpoint
rather than silently truncating mandatory task, evidence, or tool-policy state.
Repeated compactions retain the immutable task envelope plus the latest
verified checkpoint. Raw reasoning is intentionally disposable; goal,
registry compatibility, writes, validation, diff review, approvals, plan,
open problems, and no-progress counters are durable state.

Runtime error domains remain distinct: model/capability failures are provider
errors, context assembly failures are `CONTEXT_BUDGET`, and checkpoint or final
report storage acknowledgement failures are `PERSISTENCE_ERROR`. A storage
operation that commits and then throws still fails closed because the runtime
cannot prove durable acknowledgement.

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
