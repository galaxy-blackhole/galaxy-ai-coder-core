import assert from "node:assert/strict";
import test from "node:test";
import { AiCoderContextManager } from "../src/context/context-manager.js";
import type { ModelCapabilities } from "../src/ports/capability-port.js";

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
async function manager(mode: "in-place" | "in-history"): Promise<AiCoderContextManager> {
  return AiCoderContextManager.create({
    capabilities: capabilities(mode),
    goalMessage: "Do the task",
    profile: "balanced",
    runId: "run-cache",
    systemPrompt: "PROMPT A",
    taskId: "task-cache",
  });
}
function systems(round: Awaited<ReturnType<AiCoderContextManager["prepareRound"]>>): string[] {
  return round.messages.filter(message => message.role === "system").map(message => message.content);
}

test("in-history prompt updates append after the cached prefix", async () => {
  const m = await manager("in-history");
  m.replaceSystemPrompt("PROMPT B", 2, "in-history");
  assert.deepEqual(systems(await m.prepareRound({ tools: [], turn: 2 })), ["PROMPT A", "PROMPT B"]);
  // Re-issuing the same update must not duplicate it.
  m.replaceSystemPrompt("PROMPT B", 3, "in-history");
  assert.deepEqual(systems(await m.prepareRound({ tools: [], turn: 3 })), ["PROMPT A", "PROMPT B"]);
});

test("in-place prompt updates rewrite the leading system message", async () => {
  const m = await manager("in-place");
  m.replaceSystemPrompt("PROMPT B", 2, "in-place");
  assert.deepEqual(systems(await m.prepareRound({ tools: [], turn: 2 })), ["PROMPT B"]);
  // A later in-place update drops any previously appended in-history nodes.
  m.replaceSystemPrompt("PROMPT A", 2, "in-history");
  m.replaceSystemPrompt("PROMPT C", 4, "in-place");
  assert.deepEqual(systems(await m.prepareRound({ tools: [], turn: 4 })), ["PROMPT C"]);
});
