import {
  CodingProviderError,
  portFailure,
  portSuccess,
  type CodingMessage,
  type CodingModelAdapter,
  type CodingRoundEvent,
  type CodingRoundRequest,
  type CodingTokenCount,
  type ModelCapabilities,
  type ModelIdentity,
  type PortErrorCode,
  type RunExecutionContext,
} from "../../../ports/index.js";

import { createOllamaChatNormalizer } from "./ollama-chat-stream.js";
import { randomUUID } from 'node:crypto';

type JsonObject = Readonly<Record<string, unknown>>;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type ResponseLease = Readonly<{
  dispose: () => void;
  response: Response;
  signal: AbortSignal;
}>;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TRANSPORT_RETRY_DELAYS_MS = Object.freeze([500, 1_000]);
const RETRYABLE_TRANSPORT_CAUSES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

export interface OllamaCodingModelOptions {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly model: string;
  readonly requestTimeoutMs?: number;
  /** Provider-owned control; named effort levels are only supported by some Ollama models. */
  readonly thinking?: boolean | "low" | "medium" | "high";
  /**
   * Set to "in-history" only when the model's chat template has been verified to
   * read a later system message as the effective prompt (append instead of
   * rewriting the leading system message keeps the prefix cache warm).
   */
  readonly systemPromptUpdate?: "in-place" | "in-history" | "unknown";
}

/**
 * Ollama models whose chat template has been probed to read a later system
 * message as the effective prompt (see docs/CACHE_HIT.md). Only add a model
 * after running the code-word probe against it; anything unmatched stays
 * in-place. An explicit systemPromptUpdate option always wins.
 */
const VERIFIED_IN_HISTORY_MODELS: readonly RegExp[] = Object.freeze([
  /(?:^|\/)gemma3(?=[:/]|$)/i,
  /(?:^|\/)deepseek-v4\.1-flash(?=[:/]|$)/i,
]);
export function verifiedSystemPromptUpdate(model: string): "in-history" | "unknown" {
  return VERIFIED_IN_HISTORY_MODELS.some((pattern) => pattern.test(model)) ? "in-history" : "unknown";
}

export interface OllamaModelDiagnostics {
  readonly chatRequests: number;
  readonly normalizedEvents: number;
  readonly responseBytes: number;
  readonly responseChunks: number;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiEndpoint(baseUrl: string, route: "chat" | "show"): string {
  const root = baseUrl.replace(/\/+$/, "");
  return `${root.endsWith("/api") ? root : `${root}/api`}/${route}`;
}

function estimatedTokens(value: unknown): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4));
}

function ollamaCompatibleJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(ollamaCompatibleJsonSchema));
  if (!isObject(value)) return value;
  if (Object.hasOwn(value, "oneOf") && Object.hasOwn(value, "anyOf")) {
    throw new Error("Ollama schema adaptation cannot safely combine oneOf and anyOf at the same node.");
  }
  const adapted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "const" || key === "oneOf") continue;
    adapted[key] = ollamaCompatibleJsonSchema(item);
  }
  if (Object.hasOwn(value, "const")) {
    adapted.enum = Object.freeze([ollamaCompatibleJsonSchema(value.const)]);
  }
  if (Object.hasOwn(value, "oneOf")) {
    if (!Array.isArray(value.oneOf) || value.oneOf.length === 0) {
      throw new Error("Ollama schema adaptation requires oneOf to contain at least one branch.");
    }
    adapted.anyOf = Object.freeze(value.oneOf.map(ollamaCompatibleJsonSchema));
  }
  return Object.freeze(adapted);
}

function ollamaToolDefinitions(tools: CodingRoundRequest["tools"]): CodingRoundRequest["tools"] {
  return Object.freeze(tools.map((tool) => Object.freeze({
    type: tool.type,
    function: Object.freeze({
      ...tool.function,
      parameters: ollamaCompatibleJsonSchema(tool.function.parameters) as Readonly<Record<string, unknown>>,
    }),
  })));
}

function modelMessages(messages: readonly CodingMessage[], preserveThinking: boolean): readonly JsonObject[] {
  return Object.freeze(messages.map((message): JsonObject => {
    if (message.role === "tool") {
      return Object.freeze({ role: "tool", tool_name: message.toolName, content: message.content });
    }
    if (message.role === "assistant") {
      return Object.freeze({
        role: "assistant",
        content: message.content,
        ...(preserveThinking && message.thinking ? { thinking: message.thinking } : {}),
        ...(message.toolCalls?.length ? {
          tool_calls: Object.freeze(message.toolCalls.map((call, index) => Object.freeze({
            type: "function",
            function: Object.freeze({ index, name: call.name, arguments: call.arguments }),
          }))),
        } : {}),
      });
    }
    return Object.freeze({ role: message.role, content: message.content });
  }));
}

function contextWindowFromShow(show: JsonObject): number | undefined {
  const info = show.model_info;
  if (!isObject(info)) return undefined;
  const values = Object.entries(info)
    .filter(([key, value]) => key.endsWith(".context_length") && Number.isSafeInteger(value) && Number(value) > 0)
    .map(([, value]) => Number(value));
  return values.length === 0 ? undefined : Math.max(...values);
}

function errorCodeForStatus(status: number): PortErrorCode {
  if (status === 401 || status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "CAPABILITY_MISMATCH";
  if (status === 408 || status === 504) return "DEADLINE_EXCEEDED";
  if (status === 429 || status >= 500) return "UNAVAILABLE";
  return "PROVIDER_ERROR";
}

function providerCodeForStatus(status: number): ConstructorParameters<typeof CodingProviderError>[0] {
  if (status === 401 || status === 403) return "AUTHENTICATION";
  if (status === 404) return "CAPABILITY_MISMATCH";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  return "PROVIDER_ERROR";
}

function safeErrorText(raw: string, apiKey: string | undefined): string {
  let value = raw.slice(0, 512).replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  if (apiKey) value = value.replaceAll(apiKey, "[REDACTED]");
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isObject(parsed) && typeof parsed.error === "string") value = parsed.error.slice(0, 300);
  } catch {
    // Preserve the bounded plain-text provider error.
  }
  return value.trim() || "Ollama request failed without an error message.";
}

function transportCauseCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isObject(current) || !isObject(current.cause) || typeof current.cause.code !== "string") return undefined;
    const code = current.cause.code.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}

function sanitizedStreamChunks(chunks: readonly unknown[], apiKey: string | undefined): readonly unknown[] {
  return Object.freeze(chunks.map((chunk) => {
    if (!isObject(chunk) || typeof chunk.error !== "string") return chunk;
    return Object.freeze({ ...chunk, error: safeErrorText(JSON.stringify({ error: chunk.error }), apiKey) });
  }));
}

async function* readResponseBody(response: Response, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (response.body === null) throw new Error("Ollama response has no body.");
  const reader = response.body.getReader();
  let bytes = 0;
  let ended = false;
  const abort = (): void => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) { ended = true; break; }
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Ollama response exceeded 8 MiB.");
      yield part.value;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  for await (const part of readResponseBody(response, signal)) text += decoder.decode(part, { stream: true });
  return text + decoder.decode();
}

async function* readNdjson(response: Response, signal: AbortSignal, onBytes: (bytes: number) => void): AsyncGenerator<unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  for await (const part of readResponseBody(response, signal)) {
    onBytes(part.byteLength);
    buffered += decoder.decode(part, { stream: true });
    let start = 0;
    let newline: number;
    while ((newline = buffered.indexOf("\n", start)) >= 0) {
      const line = buffered.slice(start, newline).trim();
      start = newline + 1;
      if (line) yield JSON.parse(line) as unknown;
    }
    buffered = buffered.slice(start);
  }
  buffered += decoder.decode();
  if (buffered.trim()) yield JSON.parse(buffered) as unknown;
}

export class OllamaCodingModel implements CodingModelAdapter {
  readonly identity: ModelIdentity;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  private capabilityCache: ModelCapabilities | null = null;
  private chatRequests = 0;
  private normalizedEvents = 0;
  private responseBytes = 0;
  private responseChunks = 0;
  // Ollama may omit tool IDs. A process-local counter alone collides with
  // checkpointed IDs when the same run resumes in a fresh adapter instance.
  private readonly correlationScope = randomUUID();

  constructor(private readonly options: OllamaCodingModelOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new Error("Ollama requestTimeoutMs must be a positive integer.");
    }
    this.identity = Object.freeze({
      baseUrl: options.baseUrl,
      model: options.model,
      provider: "ollama",
      runtimeVersion: "ollama-api-chat-v1",
    });
  }

  get diagnostics(): OllamaModelDiagnostics {
    return Object.freeze({
      chatRequests: this.chatRequests,
      normalizedEvents: this.normalizedEvents,
      responseBytes: this.responseBytes,
      responseChunks: this.responseChunks,
    });
  }

  private headers(): Readonly<Record<string, string>> {
    return Object.freeze({
      "Content-Type": "application/json",
      ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
    });
  }

  private async request(url: string, body: JsonObject, context: RunExecutionContext): Promise<ResponseLease> {
    if (context.signal.aborted) throw new CodingProviderError("CANCELED", "Ollama request was canceled.");
    const remaining = context.deadline - Date.now();
    if (remaining <= 0) throw new CodingProviderError("TIMEOUT", "Ollama request deadline elapsed.", true);
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const abortWith = (error: CodingProviderError): void => {
        if (!controller.signal.aborted) controller.abort(error);
      };
      const cancel = () => abortWith(new CodingProviderError("CANCELED", "Ollama request was canceled."));
      context.signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(
        () => abortWith(new CodingProviderError("TIMEOUT", "Ollama request timed out.", true)),
        Math.min(context.deadline - Date.now(), this.requestTimeoutMs),
      );
      const dispose = (): void => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", cancel);
      };
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        return Object.freeze({ dispose, response, signal: controller.signal });
      } catch (error) {
        dispose();
        const reason = controller.signal.reason;
        if (reason instanceof CodingProviderError) throw reason;
        const message = safeErrorText(error instanceof Error ? error.message : String(error), this.options.apiKey);
        const causeCode = transportCauseCode(error);
        const delayMs = TRANSPORT_RETRY_DELAYS_MS[attempt];
        if (causeCode !== undefined && RETRYABLE_TRANSPORT_CAUSES.has(causeCode) && delayMs !== undefined) {
          if (context.signal.aborted) throw new CodingProviderError("CANCELED", "Ollama request was canceled.");
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (context.signal.aborted) throw new CodingProviderError("CANCELED", "Ollama request was canceled.");
          continue;
        }
        throw new CodingProviderError(
          "PROVIDER_ERROR",
          `Ollama transport failed${causeCode === undefined ? "" : ` [cause=${causeCode}]`}: ${message}`,
          true,
        );
      }
    }
  }

  async capabilities(context: RunExecutionContext) {
    if (this.capabilityCache !== null) return portSuccess(this.capabilityCache);
    let lease: ResponseLease | null = null;
    try {
      lease = await this.request(apiEndpoint(this.options.baseUrl, "show"), Object.freeze({
        model: this.options.model,
        verbose: false,
      }), context);
      const { response } = lease;
      const raw = await boundedResponseText(response, lease.signal);
      if (!response.ok) {
        const code = errorCodeForStatus(response.status);
        return portFailure({
          code,
          message: `Ollama model probe failed (${response.status}): ${safeErrorText(raw, this.options.apiKey)}`,
          retryable: code === "UNAVAILABLE" || code === "DEADLINE_EXCEEDED",
        });
      }
      const show = JSON.parse(raw) as unknown;
      if (!isObject(show)) throw new Error("Ollama /api/show response must be an object.");
      const names = new Set(Array.isArray(show.capabilities)
        ? show.capabilities.filter((value): value is string => typeof value === "string")
        : []);
      const toolCalling = names.has("tools") || names.has("tool") ? "supported" as const : "unknown" as const;
      const isKimiK27Code = /(^|\/)kimi-k2\.7-code(?::|$)/i.test(this.options.model);
      const thinking = names.has("thinking")
        ? isKimiK27Code ? "required" as const : "optional" as const
        : "unknown" as const;
      const cloudModel = /:cloud$/i.test(this.options.model);
      const contextWindow = contextWindowFromShow(show);
      this.capabilityCache = Object.freeze({
        identity: this.identity,
        evidence: Object.freeze([Object.freeze({
          observedAt: new Date().toISOString(),
          source: "provider_api" as const,
          verified: true,
        })]),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        input: Object.freeze({
          text: "supported" as const,
          image: names.has("vision") ? "supported" as const : "unknown" as const,
          audio: "unknown" as const,
          video: "unknown" as const,
        }),
        output: Object.freeze({ text: "supported" as const, image: "unknown" as const }),
        parallelToolCalling: toolCalling === "supported" ? "supported" as const : "unknown" as const,
        preserveThinking: thinking === "optional" || thinking === "required" ? "supported" as const : "unknown" as const,
        // Ollama >= 0.34 reports prefix reuse (prompt_eval_cached_count), so the
        // runtime may keep a stable finalization prefix. In-history system-message
        // semantics still depend on the model template and stay opt-in.
        promptCache: "supported" as const,
        streaming: "supported" as const,
        // Ollama Cloud does not currently support structured outputs. A local
        // model advertising the standard API can still use the format field.
        structuredOutput: cloudModel ? "unknown" as const : "supported" as const,
        systemPromptUpdate: this.options.systemPromptUpdate ?? verifiedSystemPromptUpdate(this.options.model),
        thinking,
        tokenCounting: "unsupported" as const,
        toolCalling,
      });
      return portSuccess(this.capabilityCache);
    } catch (error) {
      const provider = error instanceof CodingProviderError ? error : null;
      const code: PortErrorCode = provider?.code === "CANCELED"
        ? "CANCELED"
        : provider?.code === "TIMEOUT"
          ? "DEADLINE_EXCEEDED"
          : "PROVIDER_ERROR";
      return portFailure({
        code,
        message: error instanceof Error ? error.message : String(error),
        retryable: provider?.retryable ?? false,
      });
    } finally {
      lease?.dispose();
    }
  }

  async countTokens(input: Parameters<CodingModelAdapter["countTokens"]>[0], context: RunExecutionContext) {
    if (context.signal.aborted) return portFailure({ code: "CANCELED", message: "Ollama token estimate was canceled.", retryable: false });
    const count: CodingTokenCount = Object.freeze({ exact: false, source: "estimate", tokens: estimatedTokens(input) });
    return portSuccess(count);
  }

  async *streamRound(request: CodingRoundRequest, context: RunExecutionContext): AsyncIterable<CodingRoundEvent> {
    this.chatRequests += 1;
    const roundId = `ollama:${this.correlationScope}:${this.chatRequests}`;
    let lease: ResponseLease;
    try {
      lease = await this.request(apiEndpoint(this.options.baseUrl, "chat"), Object.freeze({
        model: this.options.model,
        messages: modelMessages(request.messages, request.preserveThinking),
        // Ollama documents `tools` as optional. Omitting the field entirely on
        // a core-enforced tool-free finalization turn prevents model templates
        // from treating an empty array as an active tool-calling mode.
        ...(request.tools.length === 0 ? {} : { tools: ollamaToolDefinitions(request.tools) }),
        stream: true,
        think: this.options.thinking ?? request.think,
        options: Object.freeze({
          ...(request.maxOutputTokens === undefined ? {} : { num_predict: request.maxOutputTokens }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        }),
      }), context);
    } catch (error) {
      yield Object.freeze({ type: "started" });
      yield Object.freeze({
        type: "error",
        error: error instanceof CodingProviderError
          ? error
          : new CodingProviderError("PROVIDER_ERROR", error instanceof Error ? error.message : String(error), true),
      });
      return;
    }
    const { response } = lease;
    try {
    if (!response.ok) {
      try {
        const raw = await boundedResponseText(response, lease.signal);
        const code = providerCodeForStatus(response.status);
        yield Object.freeze({ type: "started" });
        yield Object.freeze({
          type: "error",
          error: new CodingProviderError(
            code,
            `Ollama chat failed (${response.status}): ${safeErrorText(raw, this.options.apiKey)}`,
            response.status === 408 || response.status === 429 || response.status >= 500,
          ),
        });
      } catch (error) {
        yield Object.freeze({ type: "started" });
        yield Object.freeze({
          type: "error",
          error: error instanceof CodingProviderError
            ? error
            : new CodingProviderError(
                "MALFORMED_STREAM",
                `Unable to read Ollama error response: ${error instanceof Error ? error.message : String(error)}`,
              ),
        });
      }
      return;
    }
    const normalizer = createOllamaChatNormalizer({
      identity: this.identity,
      ...(request.maxOutputTokens === undefined ? {} : { requestedMaxOutputTokens: request.maxOutputTokens }),
      roundId,
    });
    this.normalizedEvents += normalizer.initial.length;
    yield* normalizer.initial;
    try {
      for await (const chunk of readNdjson(response, lease.signal, bytes => { this.responseBytes += bytes; })) {
        this.responseChunks++;
        const events = normalizer.push(sanitizedStreamChunks([chunk], this.options.apiKey)[0]);
        this.normalizedEvents += events.length;
        yield* events;
        if (normalizer.failed) return;
      }
      const final = normalizer.finish();
      this.normalizedEvents += final.length;
      yield* final;
    } catch (error) {
      yield Object.freeze({
        type: "error",
        error: error instanceof CodingProviderError
          ? error
          : new CodingProviderError(
              "MALFORMED_STREAM",
              `Unable to decode Ollama NDJSON: ${error instanceof Error ? error.message : String(error)}`,
              // Invalid JSON structure is deterministic provider misbehavior;
              // a truncated body or decode failure is transport-level noise.
              !(error instanceof SyntaxError),
            ),
      });
    }
    } finally {
      lease.dispose();
      // Also release the response when the consumer stops just after `started`.
      if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    }
  }
}
