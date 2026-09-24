import type { RunExecutionContext } from "@galaxy-stack/ai-coder-core/ports";
import assert from "node:assert/strict";
import test from "node:test";

import { ScriptedCodingModel } from "../../src/lab/scripted-model.js";

function runContext(): RunExecutionContext {
  return Object.freeze({
    runId: "run-model",
    taskId: "task-model",
    mode: "auto",
    workspaceRoot: "/tmp",
    signal: new AbortController().signal,
    deadline: Date.now() + 10_000,
  });
}

function roundRequest() {
  return Object.freeze({ messages: Object.freeze([]), preserveThinking: false, think: false, tools: Object.freeze([]) });
}

test("ScriptedCodingModel preserves call ids and fixture order", async () => {
  const model = new ScriptedCodingModel([
    {
      toolCalls: [
        { toolCallId: "call-1", toolName: "read_file", arguments: { path: "README.md" } },
        { toolCallId: "call-2", toolName: "read_file", arguments: { path: "package.json" } },
      ],
    },
  ]);
  const events = [];
  for await (const event of model.streamRound({ messages: [], preserveThinking: false, think: false, tools: [] }, runContext())) {
    events.push(event);
  }
  assert.deepEqual(
    events.filter((event) => event.type === "tool_call").map((event) => event.type === "tool_call" ? event.call.toolCallId : ""),
    ["call-1", "call-2"],
  );
});

test("ScriptedCodingModel fails deterministically when a fixture is exhausted", async () => {
  const model = new ScriptedCodingModel([]);
  const events = [];
  for await (const event of model.streamRound({ messages: [], preserveThinking: false, think: false, tools: [] }, runContext())) {
    events.push(event);
  }
  assert.equal(events.at(-1)?.type, "error");
});

test("ScriptedCodingModel replays raw malformed protocol without normalizing it", async () => {
  const model = new ScriptedCodingModel([{ events: Object.freeze([
    Object.freeze({ type: "content" as const, delta: "payload before started" }),
    Object.freeze({ type: "done" as const, content: "payload before started", stopReason: "completed" as const }),
  ]) }]);
  const events = [];
  for await (const event of model.streamRound(roundRequest(), runContext())) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["content", "done"]);
});

test("ScriptedCodingModel consumes deterministic provider token counts", async () => {
  const model = new ScriptedCodingModel([{ content: "done" }], {
    contextWindow: 100000,
    tokenCountSteps: [90000, 1000, { code: "UNAVAILABLE", message: "counter offline", retryable: true }],
  });
  const input = { messages: roundRequest().messages };
  const first = await model.countTokens(input, runContext());
  const second = await model.countTokens(input, runContext());
  const third = await model.countTokens(input, runContext());
  assert.equal(first.ok && first.data.tokens, 90000);
  assert.equal(second.ok && second.data.tokens, 1000);
  assert.equal(third.ok, false);
  assert.equal(!third.ok && third.error.code, "UNAVAILABLE");
  assert.equal(model.consumedTokenCountSteps, 3);
});
