import assert from "node:assert/strict";
import test from "node:test";
import { AiCoderContextManager, type AiCoderToolObservation } from "../src/context/context-manager.js";
import { AiCoderTokenEstimator, AiCoderTokenLedger } from "../src/context/token-ledger.js";
import type { ModelCapabilities } from "../src/ports/capability-port.js";
import type { CodingMessage } from "../src/tools/coding-messages.js";
import { normalizeOllamaChatChunks } from "../src/adapters/node/provider/ollama-chat-stream.js";
import { OllamaCodingModel, verifiedSystemPromptUpdate } from "../src/adapters/node/provider/ollama-coding-model.js";

function capabilities(systemPromptUpdate: "in-place" | "in-history"): ModelCapabilities {
  return Object.freeze({
    contextWindow: 200_000,
    evidence: Object.freeze([]),
    identity: Object.freeze({ baseUrl: "https://model.invalid", model: "test", provider: "test" }),
    input: Object.freeze({ audio: "unsupported", image: "unsupported", text: "supported", video: "unsupported" }),
    output: Object.freeze({ image: "unsupported", text: "supported" }),
    parallelToolCalling: "unsupported",
    preserveThinking: "supported",
    promptCache: "supported",
    streaming: "supported",
    structuredOutput: "supported",
    systemPromptUpdate,
    thinking: "optional",
    tokenCounting: "supported",
    toolCalling: "supported",
  });
}
/** Approximate provider tokens by whitespace chunks of the serialized request. */
function tokens(messages: readonly CodingMessage[]): string[] {
  return JSON.stringify(messages).match(/\S+\s*/g) ?? [];
}
function commonPrefix(left: readonly string[], right: readonly string[]): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}
function observation(index: number, kind: "file" | "tool" = "file"): AiCoderToolObservation {
  return Object.freeze({
    call: Object.freeze({ arguments: Object.freeze({}), name: "read_file", toolCallId: `call-${index}` }),
    content: `[file content ${index}] ${"x".repeat(400)}`,
    kind,
    summary: `read_file result ${index}`,
    trust: "workspace" as const,
  });
}
async function prefixReuse(mode: "in-place" | "in-history"): Promise<number> {
  const manager = await AiCoderContextManager.create({
    capabilities: capabilities(mode),
    goalMessage: "Do the task",
    profile: "balanced",
    runId: `cache-${mode}`,
    systemPrompt: "SYSTEM PROMPT A: a detailed policy text that must stay byte-stable.",
    taskId: "task-cache",
  });
  for (let index = 0; index < 6; index += 1) {
    manager.addInteraction(Object.freeze({ role: "assistant", content: `step ${index}` }), [observation(index)], index + 1);
  }
  const before = tokens((await manager.prepareRound({ tools: [], turn: 7 })).messages);
  manager.replaceSystemPrompt("SYSTEM PROMPT B: a changed policy after lazy tool activation.", 7, mode);
  const after = tokens((await manager.prepareRound({ tools: [], turn: 8 })).messages);
  return commonPrefix(before, after) / before.length;
}

test("in-history keeps the cached prefix reusable across a prompt change", async () => {
  const inHistory = await prefixReuse("in-history");
  const inPlace = await prefixReuse("in-place");
  console.log(`cache-prefix-reuse in-history=${(inHistory * 100).toFixed(1)}% in-place=${(inPlace * 100).toFixed(1)}%`);
  assert.ok(inHistory > 0.9, `in-history reuse ${inHistory.toFixed(3)} should stay high`);
  assert.ok(inPlace < 0.5, `in-place reuse ${inPlace.toFixed(3)} should collapse after a head rewrite`);
  assert.ok(inHistory > inPlace, `in-history (${inHistory.toFixed(3)}) must beat in-place (${inPlace.toFixed(3)})`);
});

test("Ollama usage maps prompt_eval_cached_count into cachedInputTokens", () => {
  const events = normalizeOllamaChatChunks([
    { message: { role: "assistant", content: "hi" }, done: false },
    { done: true, done_reason: "stop", eval_count: 5, prompt_eval_cached_count: 64, prompt_eval_count: 100, message: { role: "assistant", content: "" } },
  ], { roundId: "round-1" });
  const done = events.find(event => event.type === "done");
  assert.ok(done !== undefined && done.type === "done");
  assert.equal(done.usage?.cachedInputTokens, 64);
  assert.equal(done.usage?.inputTokens, 100);
});

async function finalizationPrefix(cacheFriendly: boolean): Promise<number> {
  const manager = await AiCoderContextManager.create({
    capabilities: capabilities("in-place"),
    goalMessage: "Do the task",
    profile: "balanced",
    runId: cacheFriendly ? "fin-keep" : "fin-project",
    systemPrompt: "SYSTEM PROMPT: keep this prefix byte-stable across finalization.",
    taskId: "task-fin",
  });
  manager.addInteraction(Object.freeze({ role: "assistant", content: "step" }), [observation(0, "tool")], 1);
  const before = tokens((await manager.prepareRound({ tools: [], turn: 2 })).messages);
  if (!cacheFriendly) manager.projectForFinalization();
  manager.addFeedback("[GALAXY FINALIZATION - trusted runtime state]\nreturn the final report", 2);
  const after = tokens((await manager.prepareRound({ tools: [], turn: 3 })).messages);
  return commonPrefix(before, after) / before.length;
}

test("cache-friendly finalization keeps the prefix while projection does not", async () => {
  const kept = await finalizationPrefix(true);
  const projected = await finalizationPrefix(false);
  assert.ok(kept > 0.95, `append-only finalization reuse ${kept.toFixed(3)} should stay high`);
  assert.ok(projected < 0.5, `projected finalization reuse ${projected.toFixed(3)} should drop`);
});

test("token ledger records provider prompt-cache hits", () => {
  const ledger = new AiCoderTokenLedger("run-cache", () => "2026-09-26T00:00:00.000Z");
  const entry = ledger.record({
    compactionCount: 0,
    contextWindow: 1_000_000,
    estimatedInput: 10,
    model: "test",
    profile: "balanced",
    turn: 1,
    usage: { eval_count: 5, prompt_cache_hit_tokens: 1234, prompt_eval_count: 5000 },
  }, new AiCoderTokenEstimator());
  assert.equal(entry.cachedInput, 1234);
  assert.equal(entry.actualInput, 5000);
  assert.equal(entry.cacheHitRate, 1234 / 5000);
});

test("verified models default to in-history while unverified models stay in-place", () => {
  assert.equal(verifiedSystemPromptUpdate("deepseek-v4.1-flash:cloud"), "in-history");
  assert.equal(verifiedSystemPromptUpdate("gemma3:latest"), "in-history");
  assert.equal(verifiedSystemPromptUpdate("qwen3-coder:480b-cloud"), "unknown");
});

test("token ledger accumulates a session-cumulative cache hit rate", () => {
  const ledger = new AiCoderTokenLedger("run-cum", () => "t");
  const base = { compactionCount: 0, contextWindow: 1000, estimatedInput: 1, model: "m", profile: "balanced" as const, turn: 0 };
  ledger.record({ ...base, turn: 1, usage: { prompt_eval_count: 100, cachedInputTokens: 80, eval_count: 1 } }, new AiCoderTokenEstimator());
  const second = ledger.record({ ...base, turn: 2, usage: { prompt_eval_count: 100, cachedInputTokens: 40, eval_count: 1 } }, new AiCoderTokenEstimator());
  assert.equal(second.cumulativeActualInput, 200);
  assert.equal(second.cumulativeCachedInput, 120);
  assert.equal(second.cumulativeCacheHitRate, 0.6);
});

test("Ollama adapter exposes the configured systemPromptUpdate capability", async () => {
  const context = { deadline: Date.now() + 5000, mode: "auto" as const, runId: "r", taskId: "t", workspaceRoot: "/tmp", signal: new AbortController().signal };
  const fakeFetch = async () => new Response(JSON.stringify({ capabilities: ["tools"], model_info: {} }), { status: 200, headers: { "content-type": "application/json" } });
  const inHistory = new OllamaCodingModel({ baseUrl: "http://127.0.0.1:11434", model: "m", fetch: fakeFetch, systemPromptUpdate: "in-history" });
  const result = await inHistory.capabilities(context);
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.data.systemPromptUpdate : undefined, "in-history");
  const fallback = new OllamaCodingModel({ baseUrl: "http://127.0.0.1:11434", model: "m", fetch: fakeFetch });
  const fallbackResult = await fallback.capabilities(context);
  assert.equal(fallbackResult.ok ? fallbackResult.data.systemPromptUpdate : undefined, "unknown");
});
