/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Provider-neutral streaming model adapter and correlated message protocol.
 */

import type { AiCoderAttachment } from "../context/attachment-types.js";
import type {
  ModelCapabilities,
  ModelIdentity,
} from "../ports/capability-port.js";
import type { RunExecutionContext } from "../ports/execution-context.js";
import type { PortResult } from "../ports/port-result.js";

export type CodingToolCall = Readonly<{
  arguments: Readonly<Record<string, unknown>>;
  name: string;
  toolCallId: string;
}>;

export type CodingSystemMessage = Readonly<{
  content: string;
  role: "system";
}>;

export type CodingUserMessage = Readonly<{
  content: string;
  role: "user";
}>;

export type CodingAssistantMessage = Readonly<{
  content: string;
  role: "assistant";
  thinking?: string;
  toolCalls?: readonly CodingToolCall[];
}>;

/** `toolCallId` is mandatory so parallel and same-name calls remain unambiguous. */
export type CodingToolResultMessage = Readonly<{
  content: string;
  role: "tool";
  toolCallId: string;
  toolName: string;
}>;

export type CodingMessage =
  | CodingSystemMessage
  | CodingUserMessage
  | CodingAssistantMessage
  | CodingToolResultMessage;

export type CodingToolDefinition = Readonly<{
  function: Readonly<{
    description: string;
    name: string;
    parameters: Readonly<Record<string, unknown>>;
  }>;
  type: "function";
}>;

export type CodingRoundRequest = Readonly<{
  attachments?: readonly AiCoderAttachment[];
  maxOutputTokens?: number;
  messages: readonly CodingMessage[];
  preserveThinking: boolean;
  temperature?: number;
  think: boolean;
  tools: readonly CodingToolDefinition[];
}>;

export type CodingTokenCountInput = Readonly<{
  attachments?: readonly AiCoderAttachment[];
  messages: readonly CodingMessage[];
  tools?: readonly CodingToolDefinition[];
}>;

export type CodingTokenCount = Readonly<{
  exact: boolean;
  source: "provider" | "tokenizer" | "estimate";
  tokens: number;
}>;

export type CodingTokenUsage = Readonly<{
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}>;

export class CodingProviderError extends Error {
  constructor(
    readonly code:
      | "AUTHENTICATION"
      | "CANCELED"
      | "CAPABILITY_MISMATCH"
      | "CONTEXT_WINDOW_EXCEEDED"
      | "MALFORMED_STREAM"
      | "PROVIDER_ERROR"
      | "RATE_LIMITED"
      | "TIMEOUT",
    message: string,
    readonly retryable = false,
    readonly retryMode: "same_request" | "without_thinking" = "same_request",
  ) {
    super(message);
    this.name = "CodingProviderError";
  }
}

export type CodingRoundEvent =
  | Readonly<{ type: "started" }>
  | Readonly<{ delta: string; type: "thinking" }>
  | Readonly<{ delta: string; type: "content" }>
  | Readonly<{ call: CodingToolCall; type: "tool_call" }>
  | Readonly<{ type: "usage"; usage: CodingTokenUsage }>
  | Readonly<{
      content: string;
      identity: ModelIdentity;
      stopReason: "completed" | "tool_calls" | "length" | "unknown";
      thinking: string;
      type: "done";
      usage?: CodingTokenUsage;
    }>
  | Readonly<{ error: CodingProviderError; type: "error" }>
  | Readonly<{ type: "canceled" }>;

export interface CodingModelAdapter {
  readonly identity: ModelIdentity;
  capabilities(
    context: RunExecutionContext,
  ): Promise<PortResult<ModelCapabilities>>;
  countTokens(
    input: CodingTokenCountInput,
    context: RunExecutionContext,
  ): Promise<PortResult<CodingTokenCount>>;
  streamRound(
    request: CodingRoundRequest,
    context: RunExecutionContext,
  ): AsyncIterable<CodingRoundEvent>;
}
