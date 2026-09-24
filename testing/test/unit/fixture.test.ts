import assert from "node:assert/strict";
import test from "node:test";

import { parseDeterministicFixture } from "../../src/domain/fixture.js";

test("parseDeterministicFixture accepts a minimal deterministic script", () => {
  const fixture = parseDeterministicFixture({
    schemaVersion: 1,
    name: "minimal",
    task: "Inspect the workspace",
    rounds: [{ content: "Done", finishReason: "stop" }],
  });

  assert.equal(fixture.name, "minimal");
  assert.equal(fixture.schemaVersion, 2);
  assert.equal(fixture.rounds.length, 1);
  assert.ok(Object.isFrozen(fixture));
});

test("parseDeterministicFixture accepts strict v2 runtime, raw protocol, and assertions", () => {
  const fixture = parseDeterministicFixture({
    schemaVersion: 2,
    name: "protocol pressure",
    task: "Exercise retry and context pressure",
    model: { contextWindow: 128000, tokenCountSteps: [90000, 20000] },
    runtime: {
      budget: { maxModelRetries: 1, maxTurns: 2 },
      commandContainment: "required",
      resume: { on: "failed", maxExecutions: 2, recreateHost: true },
      tokenProfile: "balanced",
    },
    rounds: [{
      events: [
        { type: "started" },
        { type: "content", delta: "done" },
        { type: "done", content: "done", stopReason: "completed" },
      ],
    }],
    expected: {
      checkpointReasons: ["provider_overflow"],
      errorCode: null,
      status: "completed",
      traceKindsInclude: ["checkpoint"],
    },
  });

  assert.deepEqual(fixture.model?.tokenCountSteps, [90000, 20000]);
  assert.equal(fixture.runtime?.commandContainment, "required");
  assert.equal(fixture.runtime?.resume?.recreateHost, true);
  assert.equal(fixture.rounds[0]?.events?.at(-1)?.type, "done");
  assert.equal(Object.isFrozen(fixture.rounds[0]?.events), true);
});

test("parseDeterministicFixture rejects unknown fields and mixed raw/structured rounds", () => {
  assert.throws(() => parseDeterministicFixture({
    schemaVersion: 2,
    name: "typo",
    task: "fail closed",
    rounds: [{ content: "done" }],
    runtim: {},
  }), /unknown field.*runtim/i);

  assert.throws(() => parseDeterministicFixture({
    schemaVersion: 2,
    name: "mixed",
    task: "fail closed",
    rounds: [{ content: "done", events: [{ type: "started" }] }],
  }), /cannot mix raw events/i);

  assert.throws(() => parseDeterministicFixture({
    schemaVersion: 2,
    name: "provider snapshot is not a canonical round",
    task: "Reject ambiguous provider payloads at the adapter boundary",
    rounds: [{ content: "", think: "", done: true, tools: [] }],
  }), /unknown field.*done.*think.*tools/i);
});

test("raw protocol can intentionally reuse ids for negative runtime tests", () => {
  const fixture = parseDeterministicFixture({
    schemaVersion: 2,
    name: "duplicate protocol id",
    task: "runtime must reject duplicate ids",
    rounds: [
      { events: [
        { type: "started" },
        { type: "tool_call", call: { toolCallId: "same", toolName: "list_files", arguments: { path: "." } } },
        { type: "done", content: "", stopReason: "tool_calls" },
      ] },
      { events: [
        { type: "started" },
        { type: "tool_call", call: { toolCallId: "same", toolName: "list_files", arguments: { path: "." } } },
        { type: "done", content: "", stopReason: "tool_calls" },
      ] },
    ],
  });
  assert.equal(fixture.rounds.length, 2);
});

test("parseDeterministicFixture rejects missing call correlation", () => {
  assert.throws(
    () => parseDeterministicFixture({
      schemaVersion: 1,
      name: "invalid",
      task: "Write a file",
      rounds: [{ toolCalls: [{ toolName: "write_file", arguments: {} }] }],
    }),
    /toolCallId/,
  );
});

test("parseDeterministicFixture rejects duplicate call ids and unsafe fixture paths", () => {
  assert.throws(
    () => parseDeterministicFixture({
      schemaVersion: 1,
      name: "duplicate",
      task: "Call twice",
      rounds: [
        { toolCalls: [{ toolCallId: "same", toolName: "list_files", arguments: { path: "." } }] },
        { toolCalls: [{ toolCallId: "same", toolName: "read_file", arguments: { path: "a" } }] },
      ],
    }),
    /Duplicate toolCallId/,
  );
  assert.throws(
    () => parseDeterministicFixture({
      schemaVersion: 1,
      name: "escape",
      task: "Write outside",
      initialFiles: [{ path: "../outside.txt", content: "no" }],
      rounds: [{ content: "done" }],
    }),
    /workspace-relative POSIX path|must not contain/,
  );
});

test("parseDeterministicFixture clones and freezes nested JSON arguments", () => {
  const input = {
    schemaVersion: 1,
    name: "frozen",
    task: "Write",
    rounds: [{
      toolCalls: [{
        toolCallId: "write-1",
        toolName: "write_file",
        arguments: { path: "a.txt", precondition: { kind: "must_not_exist" } },
      }],
    }],
  };
  const fixture = parseDeterministicFixture(input);
  const argumentsValue = fixture.rounds[0]?.toolCalls?.[0]?.arguments;
  assert.ok(argumentsValue);
  assert.equal(Object.isFrozen(argumentsValue), true);
  assert.equal(Object.isFrozen(argumentsValue.precondition), true);
  input.rounds[0]!.toolCalls[0]!.arguments.path = "changed.txt";
  assert.equal(argumentsValue.path, "a.txt");
});
