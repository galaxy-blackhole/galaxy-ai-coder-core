import {
  CodingProviderError,
  type CodingRoundEvent,
  type ModelIdentity,
} from "../../../ports/index.js";

type JsonObject = Readonly<Record<string, unknown>>;

export const OLLAMA_GLM_5_3_FLASH_IDENTITY: ModelIdentity = Object.freeze({
  baseUrl: "https://ollama.com",
  model: "glm-5.3-flash:cloud",
  provider: "ollama",
  runtimeVersion: "ollama-api-chat-v1",
});

export interface NormalizeOllamaChatOptions {
  readonly identity?: ModelIdentity;
  readonly requestedMaxOutputTokens?: number;
  readonly roundId: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function malformed(
  message: string,
  retryable = false,
  retryMode: CodingProviderError["retryMode"] = "same_request",
): CodingRoundEvent {
  return Object.freeze({
    type: "error",
    error: new CodingProviderError("MALFORMED_STREAM", message, retryable, retryMode),
  });
}

function textField(message: JsonObject, name: "content" | "thinking"): string {
  const value = message[name];
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`Ollama message.${name} must be a string.`);
  return value;
}

/** Stateful normalizer shared by live NDJSON and deterministic replay. */
export function createOllamaChatNormalizer(options: NormalizeOllamaChatOptions) {
  const initial: CodingRoundEvent[] = [Object.freeze({ type: "started" })];
  let failed = options.roundId.trim().length === 0;
  if (failed) initial.push(malformed("Ollama normalization requires a non-empty roundId."));
  const identity = options.identity ?? OLLAMA_GLM_5_3_FLASH_IDENTITY;
  let content = "";
  let thinking = "";
  let toolCallCount = 0;
  let terminalSeen = false;
  let chunksSeen = 0;
  const callIds = new Set<string>();
  const push = (rawChunk: unknown): readonly CodingRoundEvent[] => {
    if (failed) return [];
    const events: CodingRoundEvent[] = [];
    const chunkIndex = chunksSeen++;
    try {
      if (terminalSeen) throw new Error(`Ollama emitted chunk ${chunkIndex + 1} after done=true.`);
      if (!isObject(rawChunk)) throw new Error(`Ollama chunk ${chunkIndex + 1} must be an object.`);
      if (typeof rawChunk.error === "string" && rawChunk.error.trim().length > 0) {
        events.push(Object.freeze({
          type: "error",
          error: new CodingProviderError("PROVIDER_ERROR", `Ollama stream failed: ${rawChunk.error.slice(0, 300)}`, true),
        }));
        failed = true;
        return Object.freeze(events);
      }
      const messageValue = rawChunk.message;
      if (messageValue !== undefined && !isObject(messageValue)) {
        throw new Error(`Ollama chunk ${chunkIndex + 1} message must be an object.`);
      }
      const message: JsonObject = messageValue ?? Object.freeze({});
      if (message.role !== undefined && message.role !== "assistant") {
        throw new Error(`Ollama chunk ${chunkIndex + 1} message.role must be 'assistant'.`);
      }

      const thinkingDelta = textField(message, "thinking");
      const contentDelta = textField(message, "content");
      if (thinkingDelta.length > 0) {
        thinking += thinkingDelta;
        events.push(Object.freeze({ type: "thinking", delta: thinkingDelta }));
      }
      if (contentDelta.length > 0) {
        content += contentDelta;
        events.push(Object.freeze({ type: "content", delta: contentDelta }));
      }

      const rawToolCalls = message.tool_calls;
      if (rawToolCalls !== undefined && !Array.isArray(rawToolCalls)) {
        throw new Error(`Ollama chunk ${chunkIndex + 1} message.tool_calls must be an array.`);
      }
      for (const [callIndex, rawCall] of (rawToolCalls ?? []).entries()) {
        if (!isObject(rawCall) || !isObject(rawCall.function)) {
          throw new Error(`Ollama chunk ${chunkIndex + 1} tool call ${callIndex + 1} is invalid.`);
        }
        const name = rawCall.function.name;
        const argumentsValue = rawCall.function.arguments;
        if (typeof name !== "string" || name.trim().length === 0 || !isObject(argumentsValue)) {
          throw new Error(`Ollama chunk ${chunkIndex + 1} tool call ${callIndex + 1} requires a name and object arguments.`);
        }
        const providerId = typeof rawCall.id === "string" && rawCall.id.trim().length > 0 ? rawCall.id : undefined;
        const toolCallId = providerId === undefined
          ? `${options.roundId}:tool:${toolCallCount + 1}`
          : `${options.roundId}:provider:${providerId}`;
        if (callIds.has(toolCallId)) throw new Error(`Ollama reused tool call id '${toolCallId}'.`);
        callIds.add(toolCallId);
        toolCallCount += 1;
        events.push(Object.freeze({
          type: "tool_call",
          call: Object.freeze({ arguments: Object.freeze({ ...argumentsValue }), name, toolCallId }),
        }));
      }

      if (rawChunk.done !== undefined && typeof rawChunk.done !== "boolean") {
        throw new Error(`Ollama chunk ${chunkIndex + 1} done must be a boolean.`);
      }
      if (rawChunk.done !== true) return Object.freeze(events);
      terminalSeen = true;

      const inputTokens = nonNegativeInteger(rawChunk.prompt_eval_count);
      const outputTokens = nonNegativeInteger(rawChunk.eval_count);
      const usage = Object.freeze({
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(inputTokens === undefined || outputTokens === undefined ? {} : { totalTokens: inputTokens + outputTokens }),
      });
      if (Object.keys(usage).length > 0) events.push(Object.freeze({ type: "usage", usage }));

      if (content.trim().length === 0 && toolCallCount === 0) {
        const diagnostics = [
          `done_reason=${JSON.stringify(typeof rawChunk.done_reason === "string" ? rawChunk.done_reason.slice(0, 64) : "unknown")}`,
          `eval_count=${outputTokens ?? "unknown"}`,
          `requested_max_output_tokens=${options.requestedMaxOutputTokens ?? "unknown"}`,
          `thinking_characters=${thinking.length}`,
        ];
        const exhaustedOutputBudget = outputTokens !== undefined
          && options.requestedMaxOutputTokens !== undefined
          && outputTokens >= options.requestedMaxOutputTokens;
        events.push(malformed(
          [
            "Ollama completed the chat stream with empty content and no tool_calls; thinking alone is not a user-visible result.",
            `Terminal diagnostics: ${diagnostics.join(", ")}.`,
            ...(exhaustedOutputBudget ? ["The requested output-token budget was exhausted before any visible content or tool call was produced."] : []),
          ].join(" "),
          true,
          thinking.trim().length > 0 ? "without_thinking" : "same_request",
        ));
        failed = true;
        return Object.freeze(events);
      }
      const doneReason = typeof rawChunk.done_reason === "string" ? rawChunk.done_reason : "";
      events.push(Object.freeze({
        type: "done",
        content,
        thinking,
        identity,
        stopReason: toolCallCount > 0 ? "tool_calls" : doneReason === "length" ? "length" : doneReason === "stop" ? "completed" : "unknown",
        ...(Object.keys(usage).length === 0 ? {} : { usage }),
      }));
    } catch (error) {
      failed = true;
      events.push(malformed(error instanceof Error ? error.message : String(error)));
    }
    return Object.freeze(events);
  };
  return {
    initial: Object.freeze(initial),
    push,
    get failed() { return failed; },
    finish(): readonly CodingRoundEvent[] {
      if (failed || terminalSeen) return [];
      failed = true;
      return [malformed("Ollama chat stream ended without a done=true chunk.", true)];
    },
  };
}

/** Pure replay helper; live adapters push each chunk without buffering the response. */
export function normalizeOllamaChatChunks(chunks: readonly unknown[], options: NormalizeOllamaChatOptions): readonly CodingRoundEvent[] {
  const normalizer = createOllamaChatNormalizer(options);
  const events = [...normalizer.initial];
  for (const chunk of chunks) {
    events.push(...normalizer.push(chunk));
    if (normalizer.failed) break;
  }
  events.push(...normalizer.finish());
  return Object.freeze(events);
}
