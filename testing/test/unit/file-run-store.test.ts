import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAiCoderRunCheckpoint,
  type AiCoderRunCheckpointPayload,
} from "@galaxy-stack/ai-coder-core";

import { FileRunStore } from "../../src/host/file-run-store.js";

const context = () => Object.freeze({
  deadline: Date.now() + 30_000,
  signal: new AbortController().signal,
});

function payload(runId: string): AiCoderRunCheckpointPayload {
  return Object.freeze({
    acceptanceCriteria: Object.freeze([]), approvals: Object.freeze([]),
    compatibility: Object.freeze({
      activeToolNames: Object.freeze([]), capabilitiesHash: "cap", effectCapabilitiesHash: "effect",
      modelIdentity: "model", promptHash: "prompt", promptVersion: "v1", registrySnapshotHash: "registry",
      systemPromptHash: "system", taskContractHash: "task",
    }),
    completionEvidence: Object.freeze({ diffReview: null }), constraints: Object.freeze([]), decisions: Object.freeze([]),
    delivery: Object.freeze({ attachmentsDelivered: false }), edits: Object.freeze([]),
    executionBudget: Object.freeze({ deadlinePolicy: "per_execution_segment", persistenceGraceMs: 1_000, segmentDeadlineMs: 30_000 }),
    goal: "durable goal", lastToolCalls: Object.freeze([]), nextAction: "resume", noProgress: Object.freeze({
      episodes: 0, failedToolFamilies: Object.freeze([]), previousTool: null, toolCycleSuffix: Object.freeze([]),
    }), openProblems: Object.freeze([]), pendingApprovals: Object.freeze([]), phase: "inspecting",
    plan: Object.freeze({ completed: Object.freeze([]), inProgress: null, pending: Object.freeze([]) }),
    runId, schemaVersion: 1, seenToolCallIds: Object.freeze([]), taskId: "task", tokenLedgerRef: `ledger://${runId}`,
    totals: Object.freeze({ compactionCount: 0, modelTurns: 1, toolCalls: 0 }), validation: Object.freeze([]),
    workspace: Object.freeze({ activeFiles: Object.freeze([]), dirtyStateSummary: null, instructions: Object.freeze([]), root: null, stateFingerprint: "workspace" }),
  });
}

test("FileRunStore atomically persists a validated checkpoint and final report", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-file-store-"));
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  const store = await FileRunStore.create(root);
  const checkpoint = await createAiCoderRunCheckpoint(payload("run/file-safe"), "pause", () => "1970-01-01T00:00:00.000Z");

  const saved = await store.saveCheckpoint(checkpoint, context());
  const loaded = await store.loadLatestCheckpoint(checkpoint.runId, context());
  assert.deepEqual(loaded, checkpoint);
  assert.match(saved.artifactRef ?? "", /^galaxy-checkpoint:\/\//);

  const report = Object.freeze({
    completedAt: "1970-01-01T00:00:01.000Z", content: "complete", runId: checkpoint.runId,
    taskId: checkpoint.taskId, validation: Object.freeze([]), writes: Object.freeze([]),
  });
  await store.saveFinalReport(report, context());
  assert.deepEqual(await store.loadFinalReport(checkpoint.runId), report);
});

test("FileRunStore rejects a tampered durable checkpoint", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-file-store-tamper-"));
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  const store = await FileRunStore.create(root);
  const checkpoint = await createAiCoderRunCheckpoint(payload("tamper-run"), "pause", () => "1970-01-01T00:00:00.000Z");
  await store.saveCheckpoint(checkpoint, context());
  const directoryNames = await import("node:fs/promises").then(({ readdir }) => readdir(root));
  const checkpointPath = join(root, directoryNames[0]!, "checkpoint.json");
  const raw = JSON.parse(await readFile(checkpointPath, "utf8")) as Record<string, unknown>;
  raw.goal = "tampered";
  await writeFile(checkpointPath, JSON.stringify(raw), "utf8");
  await assert.rejects(store.loadLatestCheckpoint(checkpoint.runId, context()), /hash/i);
});
