import type { RunExecutionContext, TraceEvent } from "@galaxy-stack/ai-coder-core/ports";
import assert from "node:assert/strict";
import test from "node:test";

import { MemoryPersistencePort } from "../../src/host/memory-persistence-port.js";
import { MemoryTracePort } from "../../src/host/memory-trace-port.js";

function runContext(
  runId = "run-memory",
  signal = new AbortController().signal,
  deadline = Date.now() + 10_000,
): RunExecutionContext {
  return Object.freeze({
    runId,
    taskId: "task-memory",
    mode: "auto",
    workspaceRoot: "/tmp",
    signal,
    deadline,
  });
}

test("MemoryPersistencePort enforces compare-and-swap revisions", async () => {
  const port = new MemoryPersistencePort();
  const context = runContext();
  const first = await port.storage.set({ key: "checkpoint", value: { turn: 1 } }, context);
  assert.equal(first.ok, true);
  const conflict = await port.storage.set({ key: "checkpoint", expectedRevision: "r0", value: { turn: 2 } }, context);
  assert.equal(conflict.ok, false);
  const second = await port.storage.set({ key: "checkpoint", expectedRevision: "r1", value: { turn: 2 } }, context);
  assert.equal(second.ok, true);
});

test("MemoryTracePort rejects non-monotonic sequences", async () => {
  const port = new MemoryTracePort();
  const context = runContext();
  const event = (sequence: number): TraceEvent => Object.freeze({
    eventId: `event-${sequence}`,
    executionId: "execution-one",
    kind: "state_transition",
    payload: Object.freeze({}),
    runId: context.runId,
    taskId: context.taskId,
    sequence,
    timestamp: "1970-01-01T00:00:00.000Z",
  });
  assert.equal((await port.emit(event(1), context)).ok, true);
  assert.equal((await port.emit(event(1), context)).ok, false);
});

test("MemoryPersistencePort isolates values and validates revisions", async () => {
  const port = new MemoryPersistencePort();
  const context = runContext();
  const original = { nested: { turn: 1 } };
  const stored = await port.storage.set({ key: "checkpoint", value: original }, context);
  assert.equal(stored.ok, true);
  original.nested.turn = 99;

  const firstRead = await port.storage.get({ key: "checkpoint" }, context);
  assert.equal(firstRead.ok, true);
  if (!firstRead.ok) return;
  assert.deepEqual(firstRead.data.value, { nested: { turn: 1 } });
  (firstRead.data.value as { nested: { turn: number } }).nested.turn = 50;
  const secondRead = await port.storage.get({ key: "checkpoint" }, context);
  assert.equal(secondRead.ok, true);
  if (secondRead.ok) assert.deepEqual(secondRead.data.value, { nested: { turn: 1 } });

  const invalidRevision = await port.storage.set({
    key: "checkpoint",
    expectedRevision: "r01",
    value: {},
  }, context);
  assert.equal(invalidRevision.ok, false);
  if (!invalidRevision.ok) assert.equal(invalidRevision.error.code, "INVALID_INPUT");

  const invalidValue = await port.storage.set({ key: "function", value: () => undefined }, context);
  assert.equal(invalidValue.ok, false);
  if (!invalidValue.ok) assert.equal(invalidValue.error.code, "INVALID_INPUT");
});

test("memory ports distinguish cancellation from an elapsed deadline", async () => {
  const persistence = new MemoryPersistencePort();
  const trace = new MemoryTracePort();
  const controller = new AbortController();
  controller.abort();
  const canceled = await persistence.storage.get({ key: "missing" }, runContext("run-cancel", controller.signal));
  assert.equal(canceled.ok, false);
  if (!canceled.ok) assert.equal(canceled.error.code, "CANCELED");

  const expiredContext = runContext("run-expired", new AbortController().signal, Date.now() - 1);
  const expired = await trace.emit({
    eventId: "expired",
    executionId: "execution-expired",
    kind: "checkpoint",
    payload: {},
    runId: expiredContext.runId,
    taskId: expiredContext.taskId,
    sequence: 1,
    timestamp: "1970-01-01T00:00:00.000Z",
  }, expiredContext);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error.code, "DEADLINE_EXCEEDED");
});

test("MemoryTracePort scopes sequences per run and does not expose stored payloads", async () => {
  const port = new MemoryTracePort();
  const firstContext = runContext("run-one");
  const secondContext = runContext("run-two");
  const event = (context: RunExecutionContext, eventId: string, executionId = "execution-one"): TraceEvent => ({
    eventId,
    executionId,
    kind: "state_transition",
    payload: { values: new Map([["key", "original"]]) },
    runId: context.runId,
    taskId: context.taskId,
    sequence: 1,
    timestamp: "1970-01-01T00:00:00.000Z",
  });
  assert.equal((await port.emit(event(firstContext, "first"), firstContext)).ok, true);
  assert.equal((await port.emit(event(secondContext, "second"), secondContext)).ok, true);

  const resumed = event(firstContext, "first-resumed", "execution-two");
  assert.equal((await port.emit(resumed, firstContext)).ok, true);

  const exposed = port.events[0]?.payload.values as Map<string, string> | undefined;
  exposed?.set("key", "mutated");
  const reread = port.events[0]?.payload.values as Map<string, string> | undefined;
  assert.equal(reread?.get("key"), "original");
});
