export const FIXTURE_SCHEMA_VERSION = 2 as const;
export const LEGACY_FIXTURE_SCHEMA_VERSION = 1 as const;

export type FixtureMode = "auto" | "scaffold" | "refactor" | "review_only" | "validate_only";
export type FixtureStatus = "completed" | "failed" | "canceled" | "paused";
export type FixtureCheckpointReason =
  | "app_shutdown"
  | "context_threshold"
  | "failure"
  | "manual"
  | "milestone"
  | "pause"
  | "provider_overflow"
  | "tool_result_pressure"
  | "tool_round_limit";

export interface ScriptedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ScriptedProviderErrorCode =
  | "AUTHENTICATION"
  | "CANCELED"
  | "CAPABILITY_MISMATCH"
  | "CONTEXT_WINDOW_EXCEEDED"
  | "MALFORMED_STREAM"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "TIMEOUT";

export type ScriptedModelEvent =
  | Readonly<{ type: "started" }>
  | Readonly<{ delta: string; type: "thinking" | "content" }>
  | Readonly<{ call: ScriptedToolCall; type: "tool_call" }>
  | Readonly<{
      type: "usage";
      usage: Readonly<{
        cachedInputTokens?: number | undefined;
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        reasoningTokens?: number | undefined;
        totalTokens?: number | undefined;
      }>;
    }>
  | Readonly<{
      content: string;
      identity?: Readonly<{ baseUrl?: string | undefined; model?: string | undefined; provider?: string | undefined; runtimeVersion?: string | undefined }> | undefined;
      stopReason: "completed" | "tool_calls" | "length" | "unknown";
      thinking?: string | undefined;
      type: "done";
    }>
  | Readonly<{ code: ScriptedProviderErrorCode; message: string; retryable?: boolean | undefined; type: "error" }>
  | Readonly<{ type: "canceled" }>;

export interface ScriptedRound {
  readonly content?: string | undefined;
  readonly events?: readonly ScriptedModelEvent[] | undefined;
  readonly finishReason?: "stop" | "tool_calls" | "length" | "unknown" | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly toolCalls?: readonly ScriptedToolCall[] | undefined;
}

export type ScriptedTokenCountStep = number | Readonly<{
  code: string;
  message: string;
  retryable?: boolean | undefined;
}>;

export interface ExpectedFile {
  readonly path: string;
  readonly absent?: boolean | undefined;
  readonly content?: string | undefined;
  readonly contentIncludes?: readonly string[] | undefined;
  readonly unchanged?: boolean | undefined;
}

export interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

export interface ExpectedToolResult {
  readonly canonicalToolId?: string | undefined;
  readonly contentIncludes?: readonly string[] | undefined;
  readonly errorCode?: string | null | undefined;
  readonly ok?: boolean | undefined;
  readonly summaryIncludes?: string | undefined;
  readonly toolName?: string | undefined;
}

export interface FixtureControl {
  readonly action: "cancel" | "pause";
  readonly event: "context_pressure" | "model" | "tool_result" | "tool_start";
  readonly occurrence: number;
}

export interface DeterministicFixture {
  readonly schemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  readonly name: string;
  readonly task: string;
  readonly mode?: FixtureMode | undefined;
  readonly acceptanceCriteria?: readonly Readonly<{ id: string; required?: boolean | undefined; text: string }>[] | undefined;
  readonly constraints?: readonly string[] | undefined;
  readonly workspaceInstructions?: readonly string[] | undefined;
  readonly rounds: readonly ScriptedRound[];
  readonly initialFiles?: readonly FixtureFile[] | undefined;
  readonly approvalDecisions?: Readonly<Record<string, "allow" | "deny">> | undefined;
  readonly controls?: readonly FixtureControl[] | undefined;
  readonly model?: Readonly<{
    contextWindow?: number | undefined;
    maxOutputTokens?: number | undefined;
    tokenCountSteps?: readonly ScriptedTokenCountStep[] | undefined;
  }> | undefined;
  readonly runtime?: Readonly<{
    approvalProfile?: "strict" | "balanced" | "trusted-workspace" | undefined;
    commandContainment?: "best_effort" | "required" | undefined;
    budget?: Readonly<{
      deadlineMs?: number | undefined;
      maxCompletionRejections?: number | undefined;
      maxModelRetries?: number | undefined;
      modelRetryDelaysMs?: readonly number[] | undefined;
      maxToolCalls?: number | undefined;
      maxTurns?: number | undefined;
      persistenceGraceMs?: number | undefined;
      toolOutput?: Readonly<{ maxBytes: number; maxTokens: number; tailFraction: number }> | undefined;
    }> | undefined;
    completion?: Readonly<{
      requireFinalReportPersistence?: boolean | undefined;
      requireInspection?: boolean | undefined;
      requireTokenLedger?: boolean | undefined;
      requireTrace?: boolean | undefined;
      requireValidation?: boolean | undefined;
    }> | undefined;
    resume?: Readonly<{
      maxExecutions: number;
      on: "failed" | "paused";
      recreateHost?: boolean | undefined;
      tamperCheckpoint?: boolean | undefined;
      mutateBeforeResume?: readonly FixtureFile[] | undefined;
    }> | undefined;
    tokenProfile?: "conservative" | "balanced" | "extended" | undefined;
    toolProfile?: "host" | "full_contract" | undefined;
  }> | undefined;
  readonly expected?: Readonly<{
    allowedChanges?: readonly string[] | undefined;
    allModelStepsConsumed?: boolean | undefined;
    checkpointReasons?: readonly FixtureCheckpointReason[] | undefined;
    completionIssuesInclude?: readonly string[] | undefined;
    contextPressures?: readonly ("normal" | "tighten" | "evict" | "compact" | "blocked")[] | undefined;
    errorCode?: string | null | undefined;
    executionStatuses?: readonly FixtureStatus[] | undefined;
    files?: readonly ExpectedFile[] | undefined;
    finalResponseExcludes?: readonly string[] | undefined;
    finalResponseIncludes?: readonly string[] | undefined;
    minTraceEvents?: number | undefined;
    modelRequestCount?: number | undefined;
    retryDelaysMs?: readonly number[] | undefined;
    status?: FixtureStatus | undefined;
    toolResults?: readonly ExpectedToolResult[] | undefined;
    toolSequence?: readonly string[] | undefined;
    traceKindsInclude?: readonly string[] | undefined;
    transitionsInclude?: readonly string[] | undefined;
  }> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedKeys.has(key)).sort();
  if (unknown.length > 0) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}.`);
}

function requiredString(record: Record<string, unknown>, key: string, label = "Fixture"): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} field '${key}' must be a non-empty string.`);
  }
  return value;
}

function fixturePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${label} must be a portable workspace-relative POSIX path.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`${label} must not contain empty, '.' or '..' path segments.`);
  }
  return value;
}

function jsonClone(value: unknown, label: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((item, index) => jsonClone(item, `${label}[${index}]`)));
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonClone(item, `${label}.${key}`)]),
    ));
  }
  throw new Error(`${label} must contain JSON values only.`);
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return Object.freeze([...value] as string[]);
}

function optionalInteger(value: unknown, label: string, minimum = 0): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}.`);
  }
  return Number(value);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${label} '${String(value)}' is invalid.`);
  return value as T;
}

function parseToolCall(candidate: unknown, label: string): ScriptedToolCall {
  if (!isRecord(candidate) || !isRecord(candidate.arguments)) throw new Error(`${label} is invalid.`);
  rejectUnknown(candidate, ["arguments", "toolCallId", "toolName"], label);
  return Object.freeze({
    arguments: jsonClone(candidate.arguments, `${label} arguments`) as Readonly<Record<string, unknown>>,
    toolCallId: requiredString(candidate, "toolCallId", label),
    toolName: requiredString(candidate, "toolName", label),
  });
}

function parseUsage(value: unknown, label: string): Extract<ScriptedModelEvent, { type: "usage" }> {
  if (!isRecord(value)) throw new Error(`${label} usage must be an object.`);
  rejectUnknown(value, ["cachedInputTokens", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens"], `${label} usage`);
  const usage = Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    optionalInteger(item, `${label} usage.${key}`),
  ]).filter(([, item]) => item !== undefined));
  return Object.freeze({ type: "usage", usage: Object.freeze(usage) });
}

function parseModelEvent(value: unknown, label: string): ScriptedModelEvent {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const type = value.type;
  if (type === "started" || type === "canceled") {
    rejectUnknown(value, ["type"], label);
    return Object.freeze({ type });
  }
  if (type === "content" || type === "thinking") {
    rejectUnknown(value, ["delta", "type"], label);
    if (typeof value.delta !== "string") throw new Error(`${label}.delta must be a string.`);
    return Object.freeze({ type, delta: value.delta });
  }
  if (type === "tool_call") {
    rejectUnknown(value, ["call", "type"], label);
    return Object.freeze({ type, call: parseToolCall(value.call, `${label}.call`) });
  }
  if (type === "usage") {
    rejectUnknown(value, ["type", "usage"], label);
    return parseUsage(value.usage, label);
  }
  if (type === "error") {
    rejectUnknown(value, ["code", "message", "retryable", "type"], label);
    const code = enumValue(value.code, [
      "AUTHENTICATION", "CANCELED", "CAPABILITY_MISMATCH", "CONTEXT_WINDOW_EXCEEDED",
      "MALFORMED_STREAM", "PROVIDER_ERROR", "RATE_LIMITED", "TIMEOUT",
    ] as const, `${label}.code`);
    if (code === undefined) throw new Error(`${label}.code is required.`);
    return Object.freeze({
      code,
      message: requiredString(value, "message", label),
      ...(value.retryable === undefined ? {} : { retryable: optionalBoolean(value.retryable, `${label}.retryable`) }),
      type,
    });
  }
  if (type === "done") {
    rejectUnknown(value, ["content", "identity", "stopReason", "thinking", "type"], label);
    if (typeof value.content !== "string") throw new Error(`${label}.content must be a string.`);
    if (value.thinking !== undefined && typeof value.thinking !== "string") throw new Error(`${label}.thinking must be a string.`);
    const stopReason = enumValue(value.stopReason, ["completed", "tool_calls", "length", "unknown"] as const, `${label}.stopReason`);
    if (stopReason === undefined) throw new Error(`${label}.stopReason is required.`);
    let identity: Readonly<{ baseUrl?: string; model?: string; provider?: string; runtimeVersion?: string }> | undefined;
    if (value.identity !== undefined) {
      if (!isRecord(value.identity)) throw new Error(`${label}.identity must be an object.`);
      rejectUnknown(value.identity, ["baseUrl", "model", "provider", "runtimeVersion"], `${label}.identity`);
      if (Object.values(value.identity).some((item) => typeof item !== "string")) throw new Error(`${label}.identity values must be strings.`);
      identity = Object.freeze({ ...value.identity }) as typeof identity;
    }
    return Object.freeze({
      content: value.content,
      ...(identity === undefined ? {} : { identity }),
      stopReason,
      ...(value.thinking === undefined ? {} : { thinking: value.thinking }),
      type,
    });
  }
  throw new Error(`${label}.type '${String(type)}' is invalid.`);
}

function parseRound(candidate: unknown, roundIndex: number, seenToolCallIds: Set<string>): ScriptedRound {
  const label = `Round ${roundIndex + 1}`;
  if (!isRecord(candidate)) throw new Error(`${label} must be an object.`);
  rejectUnknown(candidate, ["content", "events", "finishReason", "inputTokens", "outputTokens", "toolCalls"], label);
  if (candidate.events !== undefined) {
    if (!Array.isArray(candidate.events) || candidate.events.length === 0) throw new Error(`${label} events must be a non-empty array.`);
    if ([candidate.content, candidate.finishReason, candidate.inputTokens, candidate.outputTokens, candidate.toolCalls].some((item) => item !== undefined)) {
      throw new Error(`${label} cannot mix raw events with structured round fields.`);
    }
    return Object.freeze({ events: Object.freeze(candidate.events.map((event, index) => parseModelEvent(event, `${label} event ${index + 1}`))) });
  }
  let toolCalls: readonly ScriptedToolCall[] | undefined;
  if (candidate.toolCalls !== undefined) {
    if (!Array.isArray(candidate.toolCalls)) throw new Error(`${label} toolCalls must be an array.`);
    toolCalls = Object.freeze(candidate.toolCalls.map((rawCall, callIndex) => {
      const call = parseToolCall(rawCall, `${label} tool call ${callIndex + 1}`);
      if (seenToolCallIds.has(call.toolCallId)) throw new Error(`Duplicate toolCallId '${call.toolCallId}'.`);
      seenToolCallIds.add(call.toolCallId);
      return call;
    }));
  }
  if (candidate.content !== undefined && typeof candidate.content !== "string") throw new Error(`${label} content must be a string.`);
  const finishReason = enumValue(candidate.finishReason, ["stop", "tool_calls", "length", "unknown"] as const, `${label} finishReason`);
  if (toolCalls !== undefined && toolCalls.length > 0 && finishReason === "stop") throw new Error(`${label} cannot stop while emitting tool calls.`);
  if (candidate.content === undefined && toolCalls === undefined && finishReason === undefined) {
    throw new Error(`${label} must declare content, toolCalls, finishReason, or events.`);
  }
  return Object.freeze({
    ...(candidate.content === undefined ? {} : { content: candidate.content }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(candidate.inputTokens === undefined ? {} : { inputTokens: optionalInteger(candidate.inputTokens, `${label} inputTokens`) }),
    ...(candidate.outputTokens === undefined ? {} : { outputTokens: optionalInteger(candidate.outputTokens, `${label} outputTokens`) }),
  });
}

function parseFiles(value: unknown, label: string): readonly FixtureFile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const seen = new Set<string>();
  return Object.freeze(value.map((candidate, index): FixtureFile => {
    if (!isRecord(candidate) || typeof candidate.content !== "string") throw new Error(`${label} ${index + 1} is invalid.`);
    rejectUnknown(candidate, ["content", "path"], `${label} ${index + 1}`);
    const path = fixturePath(candidate.path, `${label} ${index + 1} path`);
    if (seen.has(path)) throw new Error(`${label} contains duplicate path '${path}'.`);
    seen.add(path);
    return Object.freeze({ path, content: candidate.content });
  }));
}

function parseAcceptanceCriteria(value: unknown): DeterministicFixture["acceptanceCriteria"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Fixture acceptanceCriteria must be an array.");
  const seen = new Set<string>();
  return Object.freeze(value.map((candidate, index) => {
    const label = `Acceptance criterion ${index + 1}`;
    if (!isRecord(candidate)) throw new Error(`${label} must be an object.`);
    rejectUnknown(candidate, ["id", "required", "text"], label);
    const id = requiredString(candidate, "id", label);
    if (seen.has(id)) throw new Error(`Duplicate acceptance criterion id '${id}'.`);
    seen.add(id);
    return Object.freeze({
      id,
      text: requiredString(candidate, "text", label),
      ...(candidate.required === undefined ? {} : { required: optionalBoolean(candidate.required, `${label}.required`) }),
    });
  }));
}

function parseControls(value: unknown): readonly FixtureControl[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Fixture controls must be an array.");
  return Object.freeze(value.map((candidate, index) => {
    const label = `Control ${index + 1}`;
    if (!isRecord(candidate)) throw new Error(`${label} must be an object.`);
    rejectUnknown(candidate, ["action", "event", "occurrence"], label);
    const action = enumValue(candidate.action, ["cancel", "pause"] as const, `${label}.action`);
    const event = enumValue(candidate.event, ["context_pressure", "model", "tool_result", "tool_start"] as const, `${label}.event`);
    if (action === undefined || event === undefined) throw new Error(`${label} action and event are required.`);
    return Object.freeze({ action, event, occurrence: optionalInteger(candidate.occurrence, `${label}.occurrence`, 1) ?? 1 });
  }));
}

function parseModel(value: unknown): DeterministicFixture["model"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Fixture model must be an object.");
  rejectUnknown(value, ["contextWindow", "maxOutputTokens", "tokenCountSteps"], "Fixture model");
  let tokenCountSteps: readonly ScriptedTokenCountStep[] | undefined;
  if (value.tokenCountSteps !== undefined) {
    if (!Array.isArray(value.tokenCountSteps)) throw new Error("Fixture model.tokenCountSteps must be an array.");
    tokenCountSteps = Object.freeze(value.tokenCountSteps.map((step, index) => {
      if (typeof step === "number") return optionalInteger(step, `Token count step ${index + 1}`) ?? 0;
      if (!isRecord(step)) throw new Error(`Token count step ${index + 1} is invalid.`);
      rejectUnknown(step, ["code", "message", "retryable"], `Token count step ${index + 1}`);
      return Object.freeze({
        code: requiredString(step, "code", `Token count step ${index + 1}`),
        message: requiredString(step, "message", `Token count step ${index + 1}`),
        ...(step.retryable === undefined ? {} : { retryable: optionalBoolean(step.retryable, `Token count step ${index + 1}.retryable`) }),
      });
    }));
  }
  return Object.freeze({
    ...(value.contextWindow === undefined ? {} : { contextWindow: optionalInteger(value.contextWindow, "Fixture model.contextWindow", 1) }),
    ...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: optionalInteger(value.maxOutputTokens, "Fixture model.maxOutputTokens", 1) }),
    ...(tokenCountSteps === undefined ? {} : { tokenCountSteps }),
  });
}

function parseRuntime(value: unknown): DeterministicFixture["runtime"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Fixture runtime must be an object.");
  rejectUnknown(value, ["approvalProfile", "budget", "commandContainment", "completion", "resume", "tokenProfile", "toolProfile"], "Fixture runtime");
  let budget: NonNullable<NonNullable<DeterministicFixture["runtime"]>["budget"]> | undefined;
  if (value.budget !== undefined) {
    if (!isRecord(value.budget)) throw new Error("Fixture runtime.budget must be an object.");
    rejectUnknown(value.budget, ["deadlineMs", "maxCompletionRejections", "maxModelRetries", "modelRetryDelaysMs", "maxToolCalls", "maxTurns", "persistenceGraceMs", "toolOutput"], "Fixture runtime.budget");
    const result: Record<string, unknown> = {};
    for (const key of ["deadlineMs", "maxCompletionRejections", "maxModelRetries", "maxToolCalls", "maxTurns", "persistenceGraceMs"] as const) {
      if (value.budget[key] !== undefined) {
        const minimum = key === "maxTurns" || key === "maxToolCalls" || key === "deadlineMs" ? 1 : 0;
        result[key] = optionalInteger(value.budget[key], `Fixture runtime.budget.${key}`, minimum);
      }
    }
    if (value.budget.modelRetryDelaysMs !== undefined) {
      const rawDelays = value.budget.modelRetryDelaysMs;
      if (!Array.isArray(rawDelays) || rawDelays.length === 0) {
        throw new Error("Fixture runtime.budget.modelRetryDelaysMs must be a non-empty array.");
      }
      if (rawDelays.length > 8) throw new Error("Fixture runtime.budget.modelRetryDelaysMs must contain at most 8 delays.");
      for (const delay of rawDelays) {
        if (!Number.isSafeInteger(Number(delay)) || Number(delay) < 1 || Number(delay) > 600_000) {
          throw new Error("Fixture runtime.budget.modelRetryDelaysMs entries must be integers between 1 and 600000.");
        }
      }
      result.modelRetryDelaysMs = Object.freeze(rawDelays.map((delay) => Number(delay)));
    }
    if (value.budget.toolOutput !== undefined) {
      if (!isRecord(value.budget.toolOutput)) throw new Error("Fixture runtime.budget.toolOutput must be an object.");
      rejectUnknown(value.budget.toolOutput, ["maxBytes", "maxTokens", "tailFraction"], "Fixture runtime.budget.toolOutput");
      const maxBytes = optionalInteger(value.budget.toolOutput.maxBytes, "Fixture runtime.budget.toolOutput.maxBytes", 1);
      const maxTokens = optionalInteger(value.budget.toolOutput.maxTokens, "Fixture runtime.budget.toolOutput.maxTokens", 1);
      const tailFraction = value.budget.toolOutput.tailFraction;
      if (maxBytes === undefined || maxTokens === undefined || typeof tailFraction !== "number" || tailFraction <= 0 || tailFraction >= 1) {
        throw new Error("Fixture runtime.budget.toolOutput requires maxBytes/maxTokens and 0 < tailFraction < 1.");
      }
      result.toolOutput = Object.freeze({ maxBytes, maxTokens, tailFraction });
    }
    budget = Object.freeze(result) as typeof budget;
  }
  let completion: NonNullable<NonNullable<DeterministicFixture["runtime"]>["completion"]> | undefined;
  if (value.completion !== undefined) {
    if (!isRecord(value.completion)) throw new Error("Fixture runtime.completion must be an object.");
    const completionRecord = value.completion;
    const keys = ["requireFinalReportPersistence", "requireInspection", "requireTokenLedger", "requireTrace", "requireValidation"] as const;
    rejectUnknown(completionRecord, keys, "Fixture runtime.completion");
    completion = Object.freeze(Object.fromEntries(keys
      .filter((key) => completionRecord[key] !== undefined)
      .map((key) => [key, optionalBoolean(completionRecord[key], `Fixture runtime.completion.${key}`)]))) as typeof completion;
  }
  let resume: NonNullable<NonNullable<DeterministicFixture["runtime"]>["resume"]> | undefined;
  if (value.resume !== undefined) {
    if (!isRecord(value.resume)) throw new Error("Fixture runtime.resume must be an object.");
    rejectUnknown(value.resume, ["maxExecutions", "mutateBeforeResume", "on", "recreateHost", "tamperCheckpoint"], "Fixture runtime.resume");
    const on = enumValue(value.resume.on, ["failed", "paused"] as const, "Fixture runtime.resume.on");
    if (on === undefined) throw new Error("Fixture runtime.resume.on is required.");
    resume = Object.freeze({
      maxExecutions: optionalInteger(value.resume.maxExecutions, "Fixture runtime.resume.maxExecutions", 2) ?? 2,
      on,
      ...(value.resume.mutateBeforeResume === undefined ? {} : { mutateBeforeResume: parseFiles(value.resume.mutateBeforeResume, "Resume mutation") }),
      ...(value.resume.recreateHost === undefined ? {} : { recreateHost: optionalBoolean(value.resume.recreateHost, "Fixture runtime.resume.recreateHost") }),
      ...(value.resume.tamperCheckpoint === undefined ? {} : { tamperCheckpoint: optionalBoolean(value.resume.tamperCheckpoint, "Fixture runtime.resume.tamperCheckpoint") }),
    });
  }
  return Object.freeze({
    ...(value.approvalProfile === undefined ? {} : { approvalProfile: enumValue(value.approvalProfile, ["strict", "balanced", "trusted-workspace"] as const, "Fixture runtime.approvalProfile") }),
    ...(budget === undefined ? {} : { budget }),
    ...(value.commandContainment === undefined ? {} : { commandContainment: enumValue(value.commandContainment, ["best_effort", "required"] as const, "Fixture runtime.commandContainment") }),
    ...(completion === undefined ? {} : { completion }),
    ...(resume === undefined ? {} : { resume }),
    ...(value.tokenProfile === undefined ? {} : { tokenProfile: enumValue(value.tokenProfile, ["conservative", "balanced", "extended"] as const, "Fixture runtime.tokenProfile") }),
    ...(value.toolProfile === undefined ? {} : { toolProfile: enumValue(value.toolProfile, ["host", "full_contract"] as const, "Fixture runtime.toolProfile") }),
  });
}

function parseExpected(value: unknown): DeterministicFixture["expected"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Fixture expected must be an object.");
  rejectUnknown(value, [
    "allowedChanges", "allModelStepsConsumed", "checkpointReasons", "completionIssuesInclude", "contextPressures", "errorCode",
    "executionStatuses", "files", "finalResponseExcludes", "finalResponseIncludes", "minTraceEvents",
    "modelRequestCount", "retryDelaysMs", "status", "toolResults", "toolSequence", "traceKindsInclude", "transitionsInclude",
  ], "Fixture expected");
  let files: readonly ExpectedFile[] | undefined;
  if (value.files !== undefined) {
    if (!Array.isArray(value.files)) throw new Error("Fixture expected.files must be an array.");
    files = Object.freeze(value.files.map((candidate, index) => {
      const label = `Expected file ${index + 1}`;
      if (!isRecord(candidate)) throw new Error(`${label} must be an object.`);
      rejectUnknown(candidate, ["absent", "content", "contentIncludes", "path", "unchanged"], label);
      if (candidate.content !== undefined && typeof candidate.content !== "string") throw new Error(`${label}.content must be a string.`);
      const absent = optionalBoolean(candidate.absent, `${label}.absent`);
      const unchanged = optionalBoolean(candidate.unchanged, `${label}.unchanged`);
      if (absent === true && (candidate.content !== undefined || candidate.contentIncludes !== undefined || unchanged === true)) {
        throw new Error(`${label} cannot combine absent with content or unchanged assertions.`);
      }
      return Object.freeze({
        path: fixturePath(candidate.path, `${label} path`),
        ...(absent === undefined ? {} : { absent }),
        ...(candidate.content === undefined ? {} : { content: candidate.content }),
        ...(candidate.contentIncludes === undefined ? {} : { contentIncludes: optionalStringArray(candidate.contentIncludes, `${label}.contentIncludes`) }),
        ...(unchanged === undefined ? {} : { unchanged }),
      });
    }));
  }
  let toolResults: readonly ExpectedToolResult[] | undefined;
  if (value.toolResults !== undefined) {
    if (!Array.isArray(value.toolResults)) throw new Error("Fixture expected.toolResults must be an array.");
    toolResults = Object.freeze(value.toolResults.map((candidate, index) => {
      const label = `Expected tool result ${index + 1}`;
      if (!isRecord(candidate)) throw new Error(`${label} must be an object.`);
      rejectUnknown(candidate, ["canonicalToolId", "contentIncludes", "errorCode", "ok", "summaryIncludes", "toolName"], label);
      if (candidate.errorCode !== undefined && candidate.errorCode !== null && typeof candidate.errorCode !== "string") throw new Error(`${label}.errorCode must be a string or null.`);
      for (const key of ["canonicalToolId", "summaryIncludes", "toolName"] as const) {
        if (candidate[key] !== undefined && typeof candidate[key] !== "string") throw new Error(`${label}.${key} must be a string.`);
      }
      const canonicalToolId = typeof candidate.canonicalToolId === "string" ? candidate.canonicalToolId : undefined;
      const contentIncludes = optionalStringArray(candidate.contentIncludes, `${label}.contentIncludes`);
      const summaryIncludes = typeof candidate.summaryIncludes === "string" ? candidate.summaryIncludes : undefined;
      const toolName = typeof candidate.toolName === "string" ? candidate.toolName : undefined;
      return Object.freeze({
        ...(canonicalToolId === undefined ? {} : { canonicalToolId }),
        ...(contentIncludes === undefined ? {} : { contentIncludes }),
        ...(candidate.errorCode === undefined ? {} : { errorCode: candidate.errorCode }),
        ...(candidate.ok === undefined ? {} : { ok: optionalBoolean(candidate.ok, `${label}.ok`) }),
        ...(summaryIncludes === undefined ? {} : { summaryIncludes }),
        ...(toolName === undefined ? {} : { toolName }),
      });
    }));
  }
  const status = enumValue(value.status, ["completed", "failed", "canceled", "paused"] as const, "Fixture expected.status");
  const executionStatuses = value.executionStatuses === undefined ? undefined : (() => {
    if (!Array.isArray(value.executionStatuses)) throw new Error("Fixture expected.executionStatuses must be an array.");
    return Object.freeze(value.executionStatuses.map((item, index) => {
      const parsed = enumValue(item, ["completed", "failed", "canceled", "paused"] as const, `Fixture expected.executionStatuses[${index}]`);
      if (parsed === undefined) throw new Error("Execution status is required.");
      return parsed;
    }));
  })();
  const checkpointReasons = value.checkpointReasons === undefined ? undefined : (() => {
    if (!Array.isArray(value.checkpointReasons)) throw new Error("Fixture expected.checkpointReasons must be an array.");
    const reasons = ["app_shutdown", "context_threshold", "failure", "manual", "milestone", "pause", "provider_overflow", "tool_result_pressure", "tool_round_limit"] as const;
    return Object.freeze(value.checkpointReasons.map((item, index) => {
      const parsed = enumValue(item, reasons, `Fixture expected.checkpointReasons[${index}]`);
      if (parsed === undefined) throw new Error("Checkpoint reason is required.");
      return parsed;
    }));
  })();
  const contextPressures = value.contextPressures === undefined ? undefined : (() => {
    if (!Array.isArray(value.contextPressures)) throw new Error("Fixture expected.contextPressures must be an array.");
    return Object.freeze(value.contextPressures.map((item, index) => {
      const parsed = enumValue(item, ["normal", "tighten", "evict", "compact", "blocked"] as const, `Fixture expected.contextPressures[${index}]`);
      if (parsed === undefined) throw new Error("Context pressure is required.");
      return parsed;
    }));
  })();
  if (value.errorCode !== undefined && value.errorCode !== null && typeof value.errorCode !== "string") throw new Error("Fixture expected.errorCode must be a string or null.");
  const allowedChanges = optionalStringArray(value.allowedChanges, "Fixture expected.allowedChanges");
  const completionIssuesInclude = optionalStringArray(value.completionIssuesInclude, "Fixture expected.completionIssuesInclude");
  const finalResponseExcludes = optionalStringArray(value.finalResponseExcludes, "Fixture expected.finalResponseExcludes");
  const finalResponseIncludes = optionalStringArray(value.finalResponseIncludes, "Fixture expected.finalResponseIncludes");
  const toolSequence = optionalStringArray(value.toolSequence, "Fixture expected.toolSequence");
  const traceKindsInclude = optionalStringArray(value.traceKindsInclude, "Fixture expected.traceKindsInclude");
  const transitionsInclude = optionalStringArray(value.transitionsInclude, "Fixture expected.transitionsInclude");
  const retryDelaysMs = value.retryDelaysMs === undefined ? undefined : (() => {
    if (!Array.isArray(value.retryDelaysMs)) throw new Error("Fixture expected.retryDelaysMs must be an array.");
    return Object.freeze(value.retryDelaysMs.map((item, index) => {
      const parsed = optionalInteger(item, `Fixture expected.retryDelaysMs[${index}]`);
      if (parsed === undefined) throw new Error("Retry delay is required.");
      return parsed;
    }));
  })();
  return Object.freeze({
    ...(allowedChanges === undefined ? {} : { allowedChanges: allowedChanges.map((path, index) => fixturePath(path, `Allowed change ${index + 1}`)) }),
    ...(value.allModelStepsConsumed === undefined ? {} : { allModelStepsConsumed: optionalBoolean(value.allModelStepsConsumed, "Fixture expected.allModelStepsConsumed") }),
    ...(checkpointReasons === undefined ? {} : { checkpointReasons }),
    ...(completionIssuesInclude === undefined ? {} : { completionIssuesInclude }),
    ...(contextPressures === undefined ? {} : { contextPressures }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
    ...(executionStatuses === undefined ? {} : { executionStatuses }),
    ...(files === undefined ? {} : { files }),
    ...(finalResponseExcludes === undefined ? {} : { finalResponseExcludes }),
    ...(finalResponseIncludes === undefined ? {} : { finalResponseIncludes }),
    ...(value.minTraceEvents === undefined ? {} : { minTraceEvents: optionalInteger(value.minTraceEvents, "Fixture expected.minTraceEvents") }),
    ...(value.modelRequestCount === undefined ? {} : { modelRequestCount: optionalInteger(value.modelRequestCount, "Fixture expected.modelRequestCount") }),
    ...(retryDelaysMs === undefined ? {} : { retryDelaysMs }),
    ...(status === undefined ? {} : { status }),
    ...(toolResults === undefined ? {} : { toolResults }),
    ...(toolSequence === undefined ? {} : { toolSequence }),
    ...(traceKindsInclude === undefined ? {} : { traceKindsInclude }),
    ...(transitionsInclude === undefined ? {} : { transitionsInclude }),
  });
}

export function parseDeterministicFixture(input: unknown): DeterministicFixture {
  if (!isRecord(input)) throw new Error("Fixture must be a JSON object.");
  if (input.schemaVersion !== LEGACY_FIXTURE_SCHEMA_VERSION && input.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    throw new Error(`Unsupported fixture schemaVersion: ${String(input.schemaVersion)}.`);
  }
  rejectUnknown(input, [
    "acceptanceCriteria", "approvalDecisions", "constraints", "controls", "expected", "initialFiles", "mode",
    "model", "name", "rounds", "runtime", "schemaVersion", "task", "workspaceInstructions",
  ], "Fixture");
  if (!Array.isArray(input.rounds) || input.rounds.length === 0) throw new Error("Fixture must contain at least one scripted round.");
  const seenToolCallIds = new Set<string>();
  const rounds = Object.freeze(input.rounds.map((round, index) => parseRound(round, index, seenToolCallIds)));
  const initialFiles = parseFiles(input.initialFiles, "Initial file");
  const approvalDecisions = input.approvalDecisions;
  if (approvalDecisions !== undefined && !isRecord(approvalDecisions)) throw new Error("Fixture approvalDecisions must be an object.");
  if (isRecord(approvalDecisions)) {
    for (const [toolId, decision] of Object.entries(approvalDecisions)) {
      if (toolId.length === 0 || (decision !== "allow" && decision !== "deny")) throw new Error(`Invalid approval decision for '${toolId}'.`);
    }
  }
  const mode = enumValue(input.mode, ["auto", "scaffold", "refactor", "review_only", "validate_only"] as const, "Fixture mode");
  return Object.freeze({
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    name: requiredString(input, "name"),
    task: requiredString(input, "task"),
    ...(mode === undefined ? {} : { mode }),
    ...(input.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: parseAcceptanceCriteria(input.acceptanceCriteria) }),
    ...(input.constraints === undefined ? {} : { constraints: optionalStringArray(input.constraints, "Fixture constraints") }),
    ...(input.workspaceInstructions === undefined ? {} : { workspaceInstructions: optionalStringArray(input.workspaceInstructions, "Fixture workspaceInstructions") }),
    rounds,
    ...(initialFiles === undefined ? {} : { initialFiles }),
    ...(approvalDecisions === undefined ? {} : { approvalDecisions: Object.freeze({ ...approvalDecisions }) as Readonly<Record<string, "allow" | "deny">> }),
    ...(input.controls === undefined ? {} : { controls: parseControls(input.controls) }),
    ...(input.model === undefined ? {} : { model: parseModel(input.model) }),
    ...(input.runtime === undefined ? {} : { runtime: parseRuntime(input.runtime) }),
    ...(input.expected === undefined ? {} : { expected: parseExpected(input.expected) }),
  });
}
