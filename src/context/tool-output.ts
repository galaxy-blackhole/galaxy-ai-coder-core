import { AiCoderTokenEstimator } from "./token-ledger.js";
import type { RunExecutionContext } from "../ports/execution-context.js";

export type AiCoderToolOutputLimits = Readonly<{
  maxBytes: number;
  maxTokens: number;
  tailFraction?: number;
}>;

export type AiCoderToolOutputArtifact = Readonly<{
  id: string;
  mimeType: string;
}>;

export interface AiCoderToolOutputSpill {
  write(input: Readonly<{
    content: string;
    contentType: string;
    runId: string;
    toolCallId: string;
    toolName: string;
  }>, context: RunExecutionContext): Promise<AiCoderToolOutputArtifact>;
}

export type AiCoderBoundedToolOutput = Readonly<{
  artifact: AiCoderToolOutputArtifact | null;
  content: string;
  originalBytes: number;
  originalTokens: number;
  returnedBytes: number;
  returnedTokens: number;
  truncated: boolean;
}>;

function safePositiveInteger(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 1) throw new RangeError(`${field} must be a positive finite number.`);
  return Math.floor(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sliceToBudget(
  value: string,
  maxBytes: number,
  maxTokens: number,
  estimator: AiCoderTokenEstimator,
): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (utf8Bytes(candidate) <= maxBytes && estimator.estimateText(candidate) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

/**
 * Bounds output before it can enter model context. The complete value may be
 * persisted through an injected spill adapter; the returned head/tail remains
 * useful for command failures without tying core to a filesystem.
 */
export async function boundAiCoderToolOutput(input: Readonly<{
  content: string;
  contentType?: string;
  context?: RunExecutionContext;
  estimator?: AiCoderTokenEstimator;
  limits: AiCoderToolOutputLimits;
  runId: string;
  spill?: AiCoderToolOutputSpill;
  toolCallId: string;
  toolName: string;
}>): Promise<AiCoderBoundedToolOutput> {
  const estimator = input.estimator ?? new AiCoderTokenEstimator();
  const maxBytes = safePositiveInteger(input.limits.maxBytes, "maxBytes");
  const maxTokens = safePositiveInteger(input.limits.maxTokens, "maxTokens");
  const originalBytes = utf8Bytes(input.content);
  const originalTokens = estimator.estimateText(input.content);
  if (originalBytes <= maxBytes && originalTokens <= maxTokens) {
    return Object.freeze({
      artifact: null,
      content: input.content,
      originalBytes,
      originalTokens,
      returnedBytes: originalBytes,
      returnedTokens: originalTokens,
      truncated: false,
    });
  }

  if (input.spill && !input.context) {
    throw new RangeError("A spill adapter requires the run execution context for cancellation and deadline enforcement.");
  }
  let artifact: AiCoderToolOutputArtifact | null = null;
  if (input.spill && input.context) {
    artifact = await input.spill.write({
      content: input.content,
      contentType: input.contentType ?? "text/plain",
      runId: input.runId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
    }, input.context);
  }
  const tailFraction = Math.min(0.5, Math.max(0, input.limits.tailFraction ?? 0.25));
  const artifactHint = artifact ? ` Complete output: artifact://${artifact.id}.` : " Use pagination for the complete result.";
  const marker = `\n…[GALAXY OUTPUT TRUNCATED.${artifactHint}]…\n`;
  const markerBytes = utf8Bytes(marker);
  const markerTokens = estimator.estimateText(marker);
  const availableBytes = Math.max(1, maxBytes - markerBytes);
  const availableTokens = Math.max(1, maxTokens - markerTokens);
  // The tail is anchored to the END of the value by construction, so JSON
  // fields near the end survive; overshoot is absorbed by shrinking the head,
  // never by re-slicing from the front which would cut the tail mid-value.
  const reversedTail = sliceToBudget(
    [...input.content].reverse().join(""),
    Math.max(1, Math.floor(availableBytes * tailFraction)),
    Math.max(1, Math.floor(availableTokens * tailFraction)),
    estimator,
  );
  const tail = [...reversedTail].reverse().join("");
  const tailBytes = utf8Bytes(tail);
  const tailTokens = estimator.estimateText(tail);
  // Head source excludes the tail region so head+tail never double-counts.
  const tailCharacters = tail.length;
  const headSource = input.content.length > tailCharacters ? input.content.slice(0, input.content.length - tailCharacters) : "";
  let headTokenBudget = Math.max(0, availableTokens - tailTokens);
  let head = "";
  let content = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const headBytes = Math.max(0, availableBytes - tailBytes);
    head = headTokenBudget <= 0 || headBytes === 0 ? "" : sliceToBudget(headSource, headBytes, headTokenBudget, estimator);
    content = `${head}${marker}${tail}`;
    const contentTokens = estimator.estimateText(content);
    const contentBytes = utf8Bytes(content);
    if (contentTokens <= maxTokens && contentBytes <= maxBytes) break;
    const overshoot = Math.max(contentTokens - maxTokens, Math.ceil((contentBytes - maxBytes) / 4));
    headTokenBudget = Math.max(0, headTokenBudget - overshoot - 16);
    if (headTokenBudget === 0 && head === "") break;
  }
  return Object.freeze({
    artifact,
    content,
    originalBytes,
    originalTokens,
    returnedBytes: utf8Bytes(content),
    returnedTokens: estimator.estimateText(content),
    truncated: true,
  });
}
