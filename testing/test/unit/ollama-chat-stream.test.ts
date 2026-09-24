import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOllamaChatChunks,
  OLLAMA_GLM_5_3_FLASH_IDENTITY,
} from "../../src/provider/ollama-chat-stream.js";

test("Ollama Kimi chunks preserve thinking, content, usage, and deterministic tool correlation", () => {
  const events = normalizeOllamaChatChunks([
    { message: { role: "assistant", thinking: "inspect " }, done: false },
    { message: { role: "assistant", content: "I will inspect." }, done: false },
    {
      message: {
        role: "assistant",
        tool_calls: [{ function: { name: "list_files", arguments: { path: "." } } }],
      },
      done: false,
    },
    { message: { role: "assistant", content: "", thinking: "", tool_calls: [] }, done: true, done_reason: "stop", prompt_eval_count: 20, eval_count: 7 },
  ], { roundId: "run-1:turn-1" });

  assert.deepEqual(events.map((event) => event.type), ["started", "thinking", "content", "tool_call", "usage", "done"]);
  const call = events.find((event) => event.type === "tool_call");
  assert.equal(call?.call.toolCallId, "run-1:turn-1:tool:1");
  const done = events.find((event) => event.type === "done");
  assert.equal(done?.content, "I will inspect.");
  assert.equal(done?.thinking, "inspect ");
  assert.equal(done?.stopReason, "tool_calls");
  assert.deepEqual(done?.identity, OLLAMA_GLM_5_3_FLASH_IDENTITY);
  assert.deepEqual(done?.usage, { inputTokens: 20, outputTokens: 7, totalTokens: 27 });
});

test("Ollama preserves repeated tool names as distinct ordered calls", () => {
  const events = normalizeOllamaChatChunks([
    {
      message: {
        role: "assistant",
        tool_calls: [
          { id: "create-a", function: { name: "write_file", arguments: { path: "a.txt", content: "a" } } },
          { id: "create-b", function: { name: "write_file", arguments: { path: "b.txt", content: "b" } } },
        ],
      },
      done: true,
      done_reason: "stop",
    },
  ], { roundId: "run-batch:turn-1" });

  const calls = events.filter((event) => event.type === "tool_call");
  assert.deepEqual(calls.map((event) => [event.call.toolCallId, event.call.name, event.call.arguments.path]), [
    ["run-batch:turn-1:provider:create-a", "write_file", "a.txt"],
    ["run-batch:turn-1:provider:create-b", "write_file", "b.txt"],
  ]);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "done");
  assert.equal(terminal?.type === "done" ? terminal.stopReason : null, "tool_calls");
});

test("Ollama empty terminal payload fails before it can become a successful Kimi turn", () => {
  const events = normalizeOllamaChatChunks([
    {
      message: { role: "assistant", content: "", thinking: "", tool_calls: [] },
      done: true,
      done_reason: "stop",
    },
  ], { roundId: "run-empty:turn-1" });

  assert.deepEqual(events.map((event) => event.type), ["started", "error"]);
  const failure = events.at(-1);
  assert.equal(failure?.type, "error");
  if (failure?.type === "error") {
    assert.equal(failure.error.code, "MALFORMED_STREAM");
    assert.equal(failure.error.retryable, true);
    assert.equal(failure.error.retryMode, "same_request");
    assert.match(failure.error.message, /empty content and no tool_calls/);
  }
});

test("Ollama thinking-only terminal payload is not mistaken for visible completion", () => {
  const events = normalizeOllamaChatChunks([
    { message: { role: "assistant", thinking: "internal reasoning only" }, done: false },
    { message: { role: "assistant", content: "", thinking: "", tool_calls: [] }, done: true, done_reason: "stop" },
  ], { roundId: "run-thinking:turn-1" });

  assert.deepEqual(events.map((event) => event.type), ["started", "thinking", "error"]);
  const failure = events.at(-1);
  assert.equal(failure?.type, "error");
  if (failure?.type === "error") {
    assert.equal(failure.error.code, "MALFORMED_STREAM");
    assert.equal(failure.error.retryMode, "without_thinking");
    assert.match(failure.error.message, /thinking_characters=23/);
  }
});

test("Ollama reports when hidden thinking exhausts the requested output budget", () => {
  const events = normalizeOllamaChatChunks([
    { message: { role: "assistant", thinking: "still reasoning" }, done: false },
    {
      message: { role: "assistant", content: "", thinking: "", tool_calls: [] },
      done: true,
      done_reason: "length",
      prompt_eval_count: 512,
      eval_count: 8192,
    },
  ], { requestedMaxOutputTokens: 8192, roundId: "run-exhausted:turn-1" });

  const failure = events.at(-1);
  assert.equal(failure?.type, "error");
  if (failure?.type === "error") {
    assert.equal(failure.error.retryMode, "without_thinking");
    assert.match(failure.error.message, /eval_count=8192/);
    assert.match(failure.error.message, /requested_max_output_tokens=8192/);
    assert.match(failure.error.message, /output-token budget was exhausted/);
  }
});

test("Ollama malformed or unterminated streams fail closed", () => {
  const flattened = normalizeOllamaChatChunks([
    { content: "", think: "", tools: [], done: true },
  ], { roundId: "run-flat:turn-1" });
  const unterminated = normalizeOllamaChatChunks([
    { message: { role: "assistant", content: "partial" }, done: false },
  ], { roundId: "run-open:turn-1" });

  assert.equal(flattened.at(-1)?.type, "error");
  assert.equal(unterminated.at(-1)?.type, "error");
  const terminal = unterminated.at(-1);
  if (terminal?.type === "error") assert.match(terminal.error.message, /without a done=true/);
  if (terminal?.type === "error") {
    assert.equal(terminal.error.code, "MALFORMED_STREAM");
    assert.equal(terminal.error.retryable, true, "an unterminated body is transport truncation, not provider misbehavior");
  }
});

test("Ollama mid-stream errors remain retryable provider failures", () => {
  const events = normalizeOllamaChatChunks([
    { message: { role: "assistant", content: "partial" }, done: false },
    { error: "cloud worker unavailable" },
  ], { roundId: "run-error:turn-1" });
  const failure = events.at(-1);
  assert.equal(failure?.type, "error");
  if (failure?.type === "error") {
    assert.equal(failure.error.code, "PROVIDER_ERROR");
    assert.equal(failure.error.retryable, true);
  }
});
