import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAiCoderRunCheckpoint,
  createAiCoderRunCheckpoint,
  validateAiCoderRunCheckpoint,
  type AiCoderRunCheckpointPayload,
} from "../src/context/checkpoint.js";
import {
  classifyAiCoderContextPressure,
  resolveAiCoderContextBudget,
} from "../src/context/context-profile.js";
import { boundAiCoderToolOutput } from "../src/context/tool-output.js";
import type { ModelCapabilities } from "../src/ports/capability-port.js";

function capabilities(contextWindow: number): ModelCapabilities {
  return Object.freeze({
    contextWindow,
    evidence: Object.freeze([]),
    identity: Object.freeze({ baseUrl: "https://model.invalid", model: "test", provider: "test" }),
    input: Object.freeze({ audio: "unsupported", image: "unsupported", text: "supported", video: "unsupported" }),
    output: Object.freeze({ image: "unsupported", text: "supported" }),
    parallelToolCalling: "unsupported",
    preserveThinking: "supported",
    streaming: "supported",
    structuredOutput: "supported",
    thinking: "optional",
    tokenCounting: "supported",
    toolCalling: "supported",
  });
}

test("context thresholds remain ordered and compaction is reachable on small models", () => {
  for (const window of [32_768, 65_536, 128_000, 200_000, 262_144]) {
    const budget = resolveAiCoderContextBudget("balanced", capabilities(window));
    assert.ok(budget.tightenThreshold < budget.evictionThreshold, `tighten/evict ordering for ${window}`);
    assert.ok(budget.evictionThreshold < budget.compactionThreshold, `evict/compact ordering for ${window}`);
    assert.ok(budget.compactionThreshold < budget.hardInputTokens, `compact/hard ordering for ${window}`);
    assert.equal(classifyAiCoderContextPressure(0, budget.tightenThreshold, budget), "tighten");
    assert.equal(classifyAiCoderContextPressure(0, budget.evictionThreshold, budget), "evict");
    assert.equal(classifyAiCoderContextPressure(0, budget.compactionThreshold, budget), "compact");
    assert.equal(classifyAiCoderContextPressure(0, budget.hardInputTokens, budget), "blocked");
  }
});

function checkpointPayload(): AiCoderRunCheckpointPayload {
  return Object.freeze({
    acceptanceCriteria: Object.freeze([Object.freeze({
      evidenceIds: Object.freeze(["call-read"]),
      id: "criterion-1",
      required: true,
      status: "satisfied",
      text: "Tests pass",
    })]),
    approvals: Object.freeze([]),
    compatibility: Object.freeze({
      activeToolNames: Object.freeze(["workspace_read"]),
      capabilitiesHash: "sha256:capabilities",
      effectCapabilitiesHash: "sha256:effects",
      modelIdentity: "model:test",
      promptHash: "sha256:prompt",
      promptVersion: "1.0.0",
      registrySnapshotHash: "sha256:registry",
      systemPromptHash: "sha256:system",
      taskContractHash: "sha256:task-contract",
    }),
    completionEvidence: Object.freeze({
      diffReview: Object.freeze({
        diffHash: "sha256:diff",
        sequence: 4,
        workspaceFingerprint: "sha256:workspace",
      }),
    }),
    constraints: Object.freeze(["password=super-secret-value"]),
    decisions: Object.freeze(["Keep API compatible"]),
    delivery: Object.freeze({ attachmentsDelivered: false }),
    edits: Object.freeze([Object.freeze({
      afterHash: "after",
      beforeHash: "before",
      path: "src/a.ts",
      sequence: 2,
      toolCallId: "call-write",
      workspaceFingerprint: "sha256:workspace-after-write",
    })]),
    executionBudget: Object.freeze({
      deadlinePolicy: "per_execution_segment",
      persistenceGraceMs: 10_000,
      segmentDeadlineMs: 60_000,
    }),
    goal: "Implement runtime with api_key=secret-value",
    lastToolCalls: Object.freeze([Object.freeze({
      argumentsHash: "hash:args",
      idempotencyKey: "idempotency-1",
      name: "workspace_read",
      outcome: "succeeded",
      toolCallId: "call-read",
    })]),
    nextAction: "Report",
    noProgress: Object.freeze({
      episodes: 2,
      failedToolFamilies: Object.freeze([Object.freeze({ count: 2, key: "workspace.edit:stale:sha256:workspace" })]),
      previousTool: Object.freeze({ argumentsHash: "hash:args", name: "workspace_read", repetitions: 2 }),
    }),
    openProblems: Object.freeze([]),
    pendingApprovals: Object.freeze([]),
    phase: "reviewing",
    plan: Object.freeze({ completed: Object.freeze(["Implement"]), inProgress: "Review", pending: Object.freeze([]) }),
    runId: "run-1",
    schemaVersion: 1,
    seenToolCallIds: Object.freeze(["call-read", "call-write"]),
    taskId: "task-1",
    tokenLedgerRef: "ledger://run-1",
    totals: Object.freeze({ compactionCount: 1, modelTurns: 4, toolCalls: 4 }),
    validation: Object.freeze([Object.freeze({
      detail: "unit tests pass",
      id: "validation:test",
      paths: Object.freeze(["src/a.ts"]),
      scope: "paths",
      sequence: 3,
      status: "passed",
      workspaceFingerprint: "sha256:workspace",
    })]),
    workspace: Object.freeze({
      activeFiles: Object.freeze([Object.freeze({ contentHash: "after", path: "src/a.ts" })]),
      dirtyStateSummary: null,
      instructions: Object.freeze([]),
      root: "/workspace",
      stateFingerprint: "sha256:workspace",
    }),
  });
}

test("checkpoint is deterministic, redacted and tamper-evident", async () => {
  const first = await createAiCoderRunCheckpoint(checkpointPayload(), "pause", () => "2026-08-28T00:00:00.000Z");
  const second = await createAiCoderRunCheckpoint(checkpointPayload(), "pause", () => "2026-08-28T00:00:00.000Z");
  assert.equal(first.contentHash, second.contentHash);
  assert.equal((await validateAiCoderRunCheckpoint(first)).length, 0);
  assert.doesNotMatch(JSON.stringify(first), /super-secret-value|secret-value/);
  assert.match(JSON.stringify(first), /REDACTED/);
  const issues = await validateAiCoderRunCheckpoint({ ...first, goal: "tampered" });
  assert.ok(issues.some((item) => item.code === "HASH_MISMATCH"));
  const changedReason = await validateAiCoderRunCheckpoint({ ...first, reason: "manual" });
  assert.ok(changedReason.some((item) => item.code === "HASH_MISMATCH"));
  const changedTime = await validateAiCoderRunCheckpoint({ ...first, createdAt: "2026-08-29T00:00:00.000Z" });
  assert.ok(changedTime.some((item) => item.code === "HASH_MISMATCH"));
  const later = await createAiCoderRunCheckpoint(checkpointPayload(), "pause", () => "2026-08-29T00:00:00.000Z");
  assert.notEqual(first.contentHash, later.contentHash);
});

test("checkpoint validation snapshots caller input and never throws on malformed values", async () => {
  const original = await createAiCoderRunCheckpoint(checkpointPayload(), "pause", () => "2026-08-28T00:00:00.000Z");
  const mutable = structuredClone(original) as unknown as Record<string, unknown>;
  const assertedPromise = assertAiCoderRunCheckpoint(mutable);
  mutable.goal = "mutated after validation started";
  const asserted = await assertedPromise;
  assert.notEqual(asserted, mutable);
  assert.notEqual(asserted.goal, mutable.goal);
  assert.ok(Object.isFrozen(asserted));
  assert.ok(Object.isFrozen(asserted.workspace.activeFiles));
  assert.ok(Object.isFrozen(asserted.noProgress?.failedToolFamilies));

  const malformed: unknown[] = [
    { ...original, acceptanceCriteria: [null] },
    { ...original, pendingApprovals: "bad" },
    { ...original, seenToolCallIds: 42 },
    { ...original, workspace: { activeFiles: [null] } },
    { ...original, noProgress: { episodes: -1, failedToolFamilies: [{ count: 0, key: "" }], previousTool: null } },
    Object.assign(Object.create(null), { self: null }),
  ];
  (malformed[5] as { self: unknown }).self = malformed[5];
  for (const value of malformed) {
    const issues = await validateAiCoderRunCheckpoint(value);
    assert.ok(issues.length > 0);
  }
});

test("checkpoint mutation evidence accepts deletion and rejects absent state", async () => {
  const deletionPayload = checkpointPayload();
  const deletion = await createAiCoderRunCheckpoint(Object.freeze({
    ...deletionPayload,
    edits: Object.freeze(deletionPayload.edits.map((edit) => Object.freeze({
      ...edit,
      afterHash: null,
      beforeHash: "sha256:deleted-content",
    }))),
  }), "pause", () => "2026-08-28T00:00:00.000Z");
  assert.equal((await validateAiCoderRunCheckpoint(deletion)).length, 0);
  assert.equal(deletion.edits[0]?.afterHash, null);

  const absentState = await createAiCoderRunCheckpoint(Object.freeze({
    ...deletionPayload,
    edits: Object.freeze(deletionPayload.edits.map((edit) => Object.freeze({
      ...edit,
      afterHash: null,
      beforeHash: null,
    }))),
  }), "pause", () => "2026-08-28T00:00:00.000Z");
  const issues = await validateAiCoderRunCheckpoint(absentState);
  assert.equal(issues.some((issue) => issue.path.endsWith("afterHash")), true);
});

test("tool output is bounded and points to the complete artifact", async () => {
  const artifacts: string[] = [];
  const bounded = await boundAiCoderToolOutput({
    content: `${"head ".repeat(500)}${"tail ".repeat(500)}`,
    context: Object.freeze({
      deadline: Date.now() + 10_000,
      mode: "auto",
      runId: "run-1",
      signal: new AbortController().signal,
      taskId: "task-1",
      workspaceRoot: "/workspace",
    }),
    limits: Object.freeze({ maxBytes: 700, maxTokens: 180, tailFraction: 0.25 }),
    runId: "run-1",
    spill: Object.freeze({
      async write(input: Readonly<{ content: string }>) {
        artifacts.push(input.content);
        return Object.freeze({ id: "artifact-1", mimeType: "text/plain" });
      },
    }),
    toolCallId: "call-1",
    toolName: "command_run",
  });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.returnedBytes <= 700);
  assert.ok(bounded.returnedTokens <= 180);
  assert.match(bounded.content, /artifact:\/\/artifact-1/);
  assert.equal(artifacts.length, 1);
});
