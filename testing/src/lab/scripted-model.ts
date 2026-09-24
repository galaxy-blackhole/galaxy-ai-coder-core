import {
  CodingProviderError,
  type CodingModelAdapter,
  type CodingRoundEvent,
  type CodingRoundRequest,
  type CodingTokenCount,
} from "@galaxy-stack/ai-coder-core/ports";
import type { ModelCapabilities } from "@galaxy-stack/ai-coder-core/ports";
import type { PortErrorCode } from "@galaxy-stack/ai-coder-core/ports";
import type { RunExecutionContext } from "@galaxy-stack/ai-coder-core/ports";

import type {
  ScriptedModelEvent,
  ScriptedRound,
  ScriptedTokenCountStep,
} from "../domain/fixture.js";

const IDENTITY = Object.freeze({
  provider: "galaxy-fixture",
  model: "scripted-v1",
  baseUrl: "fixture://local",
  runtimeVersion: "1",
});

export const SCRIPTED_MODEL_CAPABILITIES: ModelCapabilities = Object.freeze({
  identity: IDENTITY,
  evidence: Object.freeze([
    Object.freeze({
      observedAt: "1970-01-01T00:00:00.000Z",
      source: "static_fallback" as const,
      verified: true,
    }),
  ]),
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  input: Object.freeze({ text: "supported", image: "unsupported", audio: "unsupported", video: "unsupported" }),
  output: Object.freeze({ text: "supported", image: "unsupported" }),
  parallelToolCalling: "supported",
  preserveThinking: "supported",
  streaming: "supported",
  structuredOutput: "supported",
  thinking: "optional",
  tokenCounting: "supported",
  toolCalling: "supported",
});

export interface ScriptedCodingModelOptions {
  readonly contextWindow?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly tokenCountSteps?: readonly ScriptedTokenCountStep[] | undefined;
}

function estimatedTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

export class ScriptedCodingModel implements CodingModelAdapter {
  readonly identity = IDENTITY;
  readonly requests: CodingRoundRequest[] = [];
  readonly tokenCountInputs: Parameters<CodingModelAdapter["countTokens"]>[0][] = [];
  readonly capabilitiesSnapshot: ModelCapabilities;
  private roundIndex = 0;
  private tokenCountIndex = 0;

  constructor(
    private readonly rounds: readonly ScriptedRound[],
    private readonly options: ScriptedCodingModelOptions = {},
  ) {
    this.capabilitiesSnapshot = Object.freeze({
      ...SCRIPTED_MODEL_CAPABILITIES,
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    });
  }

  get consumedRounds(): number {
    return this.roundIndex;
  }

  get remainingRounds(): number {
    return Math.max(0, this.rounds.length - this.roundIndex);
  }

  get consumedTokenCountSteps(): number {
    return this.tokenCountIndex;
  }

  async capabilities(context: RunExecutionContext) {
    if (context.signal.aborted) {
      return {
        ok: false as const,
        error: Object.freeze({ code: "CANCELED" as const, message: "The fixture run was canceled.", retryable: false }),
      };
    }
    return { ok: true as const, data: this.capabilitiesSnapshot };
  }

  async countTokens(
    input: Parameters<CodingModelAdapter["countTokens"]>[0],
    context: RunExecutionContext,
  ) {
    if (context.signal.aborted) {
      return {
        ok: false as const,
        error: Object.freeze({ code: "CANCELED" as const, message: "The fixture run was canceled.", retryable: false }),
      };
    }
    this.tokenCountInputs.push(input);
    const scripted = this.options.tokenCountSteps?.[this.tokenCountIndex];
    if (scripted !== undefined) {
      this.tokenCountIndex += 1;
      if (typeof scripted === "number") {
        const count: CodingTokenCount = Object.freeze({ exact: true, source: "provider", tokens: scripted });
        return { ok: true as const, data: count };
      }
      const knownCodes = new Set<PortErrorCode>([
        "CANCELED", "CAPABILITY_MISMATCH", "DEADLINE_EXCEEDED", "INTERNAL", "INVALID_INPUT",
        "LIMIT_EXCEEDED", "PROVIDER_ERROR", "UNAVAILABLE", "UNSUPPORTED",
      ]);
      const code = knownCodes.has(scripted.code as PortErrorCode) ? scripted.code as PortErrorCode : "PROVIDER_ERROR";
      return {
        ok: false as const,
        error: Object.freeze({
          code,
          message: scripted.message,
          retryable: scripted.retryable ?? false,
        }),
      };
    }
    const serialized = JSON.stringify(input);
    const count: CodingTokenCount = Object.freeze({ exact: false, source: "estimate", tokens: estimatedTokens(serialized) });
    return { ok: true as const, data: count };
  }

  async *streamRound(
    request: CodingRoundRequest,
    context: RunExecutionContext,
  ): AsyncIterable<CodingRoundEvent> {
    this.requests.push(request);
    if (context.signal.aborted) {
      yield Object.freeze({ type: "canceled" });
      return;
    }
    const round = this.rounds[this.roundIndex];
    this.roundIndex += 1;
    if (round === undefined) {
      yield Object.freeze({
        type: "error",
        error: new CodingProviderError("PROVIDER_ERROR", "Deterministic fixture exhausted its scripted rounds."),
      });
      return;
    }

    if (round.events !== undefined) {
      for (const event of round.events) yield this.modelEvent(event);
      return;
    }

    yield Object.freeze({ type: "started" });
    const content = round.content ?? "";
    if (content.length > 0) yield Object.freeze({ type: "content", delta: content });
    for (const call of round.toolCalls ?? []) {
      yield Object.freeze({
        type: "tool_call",
        call: Object.freeze({ toolCallId: call.toolCallId, name: call.toolName, arguments: call.arguments }),
      });
    }
    yield Object.freeze({
      type: "usage",
      usage: Object.freeze({
        inputTokens: round.inputTokens ?? estimatedTokens(JSON.stringify(request)),
        outputTokens: round.outputTokens ?? estimatedTokens(content),
      }),
    });
    yield Object.freeze({
      type: "done",
      content,
      thinking: "",
      identity: IDENTITY,
      stopReason: (round.toolCalls?.length ?? 0) > 0 || round.finishReason === "tool_calls"
        ? "tool_calls"
        : round.finishReason === "length" || round.finishReason === "unknown"
          ? round.finishReason
          : "completed",
      usage: Object.freeze({
        inputTokens: round.inputTokens ?? estimatedTokens(JSON.stringify(request)),
        outputTokens: round.outputTokens ?? estimatedTokens(content),
      }),
    });
  }

  private modelEvent(event: ScriptedModelEvent): CodingRoundEvent {
    if (event.type === "tool_call") {
      return Object.freeze({
        type: "tool_call",
        call: Object.freeze({
          arguments: event.call.arguments,
          name: event.call.toolName,
          toolCallId: event.call.toolCallId,
        }),
      });
    }
    if (event.type === "error") {
      return Object.freeze({
        type: "error",
        error: new CodingProviderError(event.code, event.message, event.retryable ?? false),
      });
    }
    if (event.type === "done") {
      return Object.freeze({
        type: "done",
        content: event.content,
        thinking: event.thinking ?? "",
        stopReason: event.stopReason,
        identity: Object.freeze({
          baseUrl: event.identity?.baseUrl ?? IDENTITY.baseUrl,
          model: event.identity?.model ?? IDENTITY.model,
          provider: event.identity?.provider ?? IDENTITY.provider,
          runtimeVersion: event.identity?.runtimeVersion ?? IDENTITY.runtimeVersion,
        }),
      });
    }
    if (event.type === "usage") {
      const usage = Object.freeze(Object.fromEntries(
        Object.entries(event.usage).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      ));
      return Object.freeze({ type: "usage", usage });
    }
    if (event.type === "content" || event.type === "thinking") return Object.freeze({ type: event.type, delta: event.delta });
    return Object.freeze({ type: event.type });
  }
}
