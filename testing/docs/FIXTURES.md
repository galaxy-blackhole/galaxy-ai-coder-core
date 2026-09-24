# Deterministic fixture format

The current format is `schemaVersion: 2`. Version 1 remains readable and is
normalized to version 2 in memory, but new fixtures should use version 2. The
parser rejects unknown fields, unsafe paths, non-JSON arguments, and duplicate
structured `toolCallId` values so a misspelled assertion cannot silently pass.

```json
{
  "schemaVersion": 2,
  "name": "inspect an existing project",
  "task": "Find the entry point and declared test command.",
  "initialFiles": [
    { "path": "package.json", "content": "{\"scripts\":{\"test\":\"node --test\"}}\n" },
    { "path": "src/index.ts", "content": "export const ready = true;\n" }
  ],
  "rounds": [
    {
      "toolCalls": [
        {
          "toolCallId": "detect-1",
          "toolName": "detect_project",
          "arguments": { "path": "." }
        }
      ],
      "finishReason": "tool_calls"
    },
    { "content": "The project is TypeScript and declares node --test.", "finishReason": "stop" }
  ],
  "expected": {
    "status": "completed",
    "errorCode": null,
    "allowedChanges": [],
    "allModelStepsConsumed": true,
    "toolSequence": ["detect_project"],
    "toolResults": [
      { "canonicalToolId": "project.detect", "ok": true, "contentIncludes": ["TypeScript", "node --test"] }
    ],
    "finalResponseIncludes": ["TypeScript", "node --test"]
  }
}
```

## Scripted model rounds

A structured round may contain `content`, `toolCalls`, `finishReason`,
`inputTokens`, and `outputTokens`. Calls are executed in declared order, every
call needs a globally unique correlation ID, and the runtime currently rejects
multiple calls in one model round until batch side-effect semantics are
defined.

For malformed-provider tests, use raw `events` instead of structured fields:

```json
{
  "events": [
    { "type": "started" },
    { "type": "content", "delta": "partial" },
    {
      "type": "error",
      "code": "RATE_LIMITED",
      "message": "temporary quota",
      "retryable": true
    }
  ]
}
```

Raw event types are `started`, `thinking`, `content`, `tool_call`, `usage`,
`done`, `error`, and `canceled`. Raw streams deliberately permit protocol-level
faults such as reused call IDs; those cases must reach the runtime so its own
fail-closed checks are tested. A round cannot mix `events` with structured
fields.

An Ollama wire response such as
`message: { content: "", thinking: "", tool_calls: [] }, done: true` is
normalized by the host adapter, not copied directly into this provider-neutral
fixture schema. The Ollama protocol contract must produce `MALFORMED_STREAM`;
the canonical equivalent `{ "content": "", "finishReason": "stop" }` then
proves the core's independent `INVALID_MODEL_STREAM` defense. Thinking without
visible content or a tool call is not a successful user-facing completion.

## Workspace and task contract

- `initialFiles` are arranged before the local Git baseline. Paths must be
  portable workspace-relative POSIX paths and may not contain `.` or `..`
  segments.
- `mode` is `auto`, `scaffold`, `refactor`, `review_only`, or `validate_only`.
- `acceptanceCriteria`, `constraints`, and `workspaceInstructions` feed the
  core-owned task and prompt contracts; they do not replace the system prompt.
- `approvalDecisions` maps a canonical ID or model name to `allow` or `deny`.
  Missing decisions deny an operation whenever approval is required.
  `project.validate` is deliberately high-risk because manifest scripts execute
  repository code, so runnable validation fixtures must explicitly allow it.
- `controls` inject `cancel` or `pause` on the Nth `model`, `tool_start`,
  `tool_result`, or `context_pressure` event.

Mutation calls use one of the core preconditions:

```json
{ "kind": "must_not_exist" }
```

```json
{ "kind": "matches_sha256", "contentSha256": "<64 lowercase hex characters>" }
```

An existing file is never overwritten without its observed SHA-256 hash.
Text operations reject invalid UTF-8 bytes instead of decoding them lossily.

## Context pressure, failure, and resume

`model.contextWindow` and `model.maxOutputTokens` override the deterministic
capability snapshot. `model.tokenCountSteps` is a queue of provider token
counts or structured provider-counting errors. For example, a high count
followed by a safe count tests checkpoint → compaction → recount:

```json
{
  "model": { "tokenCountSteps": [90000, 20000] },
  "expected": { "checkpointReasons": ["provider_overflow"] }
}
```

Resume uses the same model queue, trusted in-memory run store, and workspace:

```json
{
  "runtime": {
    "resume": { "on": "failed", "maxExecutions": 2 }
  },
  "expected": {
    "executionStatuses": ["failed", "completed"],
    "checkpointReasons": ["provider_overflow", "failure"]
  }
}
```

`tamperCheckpoint: true` proves checkpoint integrity rejection.
`mutateBeforeResume` proves that a valid checkpoint is still rejected when its
workspace fingerprint is stale. `recreateHost: true` constructs a fresh CLI
tool executor and controller before resume, proving that lazy registry state is
restored from the checkpoint rather than surviving accidentally in memory.

The report verifies every persisted checkpoint hash and exposes
`checkpointAudits` (compaction count, active tools, edits, validations, and
diff-review presence) plus `modelContextAudit` (task presence in every model
request and checkpoint hashes actually delivered to the model). These fields
let scenarios prove continuity without retaining private model reasoning.
The CLI lab also supplies `task.checkpoint` with host-owned state shared across
executor reconstruction; a fresh-host scenario reads the exact goal, progress,
decisions, and next step written before exhaustion.
Replay hashing intentionally excludes concrete checkpoint content hashes (which
bind the absolute workspace root) while retaining their structural audits and
observed count. This makes the replay oracle portable across isolated temporary
workspaces without weakening each checkpoint's own integrity hash.

## Runtime settings

`runtime` supports:

- `approvalProfile`: `strict`, `balanced`, or `trusted-workspace`;
- `commandContainment`: `required` to fail before spawn unless a verified
  backend is active, or explicit lab-only `best_effort` (the current default);
- bounded `budget`: deadline, turns, tool calls, model retries, completion
  rejections, persistence grace, and tool-output limits;
- `completion`: inspection, validation, trace, token-ledger, and final-report
  persistence requirements;
- `tokenProfile`: `conservative`, `balanced`, or `extended`;
- `toolProfile`: `host` for the normal 12-tool host set, or `full_contract` for
  the 21-tool registry with nine deterministic in-memory optional-tool doubles;
- `resume`: trigger, maximum executions, fresh-host reconstruction, tamper, and
  workspace-divergence hooks.

`full_contract` performs no real network, command-session, preview, media,
artifact-service, or user interaction. It verifies registry, schema, approval,
provenance, pagination, hashing, idempotency, and lazy activation contracts. It
must not be described as a production adapter.

Every fixture that reports `completed` also checks evidence completeness:
actual final filesystem changes must be represented by trusted typed mutation
effects. This prevents an allowed-change assertion from hiding a side effect
that the core lost before checkpointing.

## Assertions

`expected` can assert:

- final `status`, `errorCode`, and every `executionStatuses` segment;
- exact `checkpointReasons`, context-pressure states, retry delays, model
  request count, and whether all scripted model rounds plus provider token-count
  steps were consumed; declared control hooks must always fire;
- exact ordered `toolSequence` and per-result model name, canonical ID,
  success, error code, summary fragment, and content fragments;
- exact file content, included fragments, absence, unchanged state, and the
  complete `allowedChanges` set;
- final-response includes/excludes and completion-gate issue codes;
- minimum trace count, required trace kinds, and state transitions.

When `allowedChanges` is present, any undeclared create, edit, delete, or
symlink change fails the fixture. This comparison includes build-output and
dependency directories; only `.git` and Galaxy's lock files are excluded.

The runnable baseline is
[`fixtures/write-and-validate.json`](../fixtures/write-and-validate.json).
The dynamic and adversarial matrix lives in
[`test/e2e/full-flow-scenarios.test.ts`](../test/e2e/full-flow-scenarios.test.ts),
where hashes and temporary workspaces can be generated safely at test time.

## Ordered campaigns

`eval` isolates fixtures. `campaign` intentionally does the opposite: it runs
the lexically sorted fixture files on one shared workspace so each stage must
consume the prior stage's real output. Fixture names must be unique because a
name defines the deterministic run identity. Campaign execution stops at the
first report whose oracle fails; expected negative fixtures still count as a
passing stage and therefore test recovery by later stages.

Campaign stages should avoid `initialFiles` after the first stage because
arranging them could hide a bad earlier result. Prefer creating the project
through tools, reading actual hashes in a later stage, and applying edits with
those fixed compare-and-swap preconditions. The reference sequence is
[`campaigns/progressive-project`](../campaigns/progressive-project).
