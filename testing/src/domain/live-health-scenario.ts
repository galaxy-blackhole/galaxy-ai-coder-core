export const LIVE_HEALTH_SCENARIO_VERSION = 1 as const;

export type LiveHealthMode = "auto" | "scaffold" | "refactor" | "review_only" | "validate_only";

export interface LiveHealthFile {
  readonly content: string;
  readonly path: string;
}

export interface LiveHealthExpectedFile {
  readonly content?: string;
  readonly contentIncludes?: readonly string[];
  readonly path: string;
}

export interface LiveHealthResearchExpected {
  readonly minSearchCalls?: number;
  readonly minFetchCalls?: number;
  readonly requiredDomains?: readonly string[];
  readonly requireCitations?: boolean;
  readonly beforeFirstWrite?: boolean;
}

export interface LiveHealthScenario {
  readonly acceptanceCriteria?: readonly Readonly<{ id: string; required?: boolean; text: string }>[];
  readonly approvalDecisions?: Readonly<Record<string, "allow" | "deny">>;
  readonly constraints?: readonly string[];
  readonly expected: Readonly<{
    allowedChanges: readonly string[];
    files: readonly LiveHealthExpectedFile[];
    maxToolCalls?: number;
    requirePassedValidation?: boolean;
    research?: LiveHealthResearchExpected;
    requiredAnyCanonicalTools?: readonly (readonly string[])[];
    requiredCanonicalTools?: readonly string[];
    status?: "completed" | "failed" | "paused" | "canceled";
  }>;
  readonly initialFiles?: readonly LiveHealthFile[];
  readonly mode?: LiveHealthMode;
  readonly name: string;
  readonly runtime?: Readonly<{
    approvalProfile?: "strict" | "balanced" | "trusted-workspace";
    budget?: Readonly<{
      deadlineMs?: number;
      maxCompletionRejections?: number;
      maxNoProgressEpisodes?: number;
      maxObservationRepeats?: number;
      maxModelRetries?: number;
      modelRetryDelaysMs?: readonly number[];
      maxRepeatedToolRequests?: number;
      maxToolCalls?: number;
      maxTurns?: number;
      noProgressPolicy?: "advisory" | "strict";
      observationNudgeThresholds?: readonly number[];
    }>;
    commandContainment?: "best_effort" | "required";
    dependencySetup?: Readonly<{
      packageManager: "npm";
      timeoutMs?: number;
    }>;
    research?: Readonly<{ provider: "ollama" }>;
    requestTimeoutMs?: number;
    tokenProfile?: "conservative" | "balanced" | "extended";
  }>;
  readonly schemaVersion: typeof LIVE_HEALTH_SCENARIO_VERSION;
  readonly task: string;
  readonly workspaceInstructions?: readonly string[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(value: JsonObject, allowed: readonly string[], label: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key)).sort();
  if (unknown.length > 0) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}.`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be an array of strings.`);
  return Object.freeze([...value] as string[]);
}

function integer(value: unknown, label: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label} must be an integer >= ${minimum}.`);
  return Number(value);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${label} is invalid.`);
  return value as T;
}

function scenarioPath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`${label} must be a portable workspace-relative POSIX path.`);
  }
  if (path.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`${label} must not contain empty, '.' or '..' segments.`);
  }
  return path;
}

function files(value: unknown, label: string): readonly LiveHealthFile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const seen = new Set<string>();
  return Object.freeze(value.map((item, index) => {
    if (!isObject(item)) throw new Error(`${label}[${index}] must be an object.`);
    rejectUnknown(item, ["content", "path"], `${label}[${index}]`);
    const path = scenarioPath(item.path, `${label}[${index}].path`);
    if (seen.has(path)) throw new Error(`${label} contains duplicate path '${path}'.`);
    seen.add(path);
    if (typeof item.content !== "string") throw new Error(`${label}[${index}].content must be a string.`);
    return Object.freeze({ content: item.content, path });
  }));
}

function expectedFiles(value: unknown): readonly LiveHealthExpectedFile[] {
  if (!Array.isArray(value)) throw new Error("Live health expected.files must be an array.");
  const seen = new Set<string>();
  return Object.freeze(value.map((item, index) => {
    if (!isObject(item)) throw new Error(`Live health expected.files[${index}] must be an object.`);
    rejectUnknown(item, ["content", "contentIncludes", "path"], `Live health expected.files[${index}]`);
    const path = scenarioPath(item.path, `Live health expected.files[${index}].path`);
    if (seen.has(path)) throw new Error(`Live health expected.files contains duplicate path '${path}'.`);
    seen.add(path);
    if (item.content !== undefined && typeof item.content !== "string") throw new Error(`Live health expected.files[${index}].content must be a string.`);
    const contentIncludes = stringArray(item.contentIncludes, `Live health expected.files[${index}].contentIncludes`);
    return Object.freeze({
      path,
      ...(item.content === undefined ? {} : { content: item.content }),
      ...(contentIncludes === undefined ? {} : { contentIncludes }),
    });
  }));
}

function toolAlternatives(value: unknown): readonly (readonly string[])[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Live health expected.requiredAnyCanonicalTools must be an array.");
  return Object.freeze(value.map((group, index) => {
    if (!Array.isArray(group) || group.length === 0 || group.some((item) => typeof item !== "string" || item.trim().length === 0)) {
      throw new Error(`Live health expected.requiredAnyCanonicalTools[${index}] must be a non-empty array of non-empty strings.`);
    }
    if (new Set(group).size !== group.length) {
      throw new Error(`Live health expected.requiredAnyCanonicalTools[${index}] contains duplicate tool IDs.`);
    }
    return Object.freeze([...group] as string[]);
  }));
}

function researchExpected(value: unknown): LiveHealthResearchExpected | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error("Live health expected.research must be an object.");
  rejectUnknown(value, ["minSearchCalls", "minFetchCalls", "requiredDomains", "requireCitations", "beforeFirstWrite"], "Live health expected.research");
  const minSearchCalls = integer(value.minSearchCalls, "research.minSearchCalls", 0);
  const minFetchCalls = integer(value.minFetchCalls, "research.minFetchCalls", 0);
  const requiredDomains = stringArray(value.requiredDomains, "research.requiredDomains");
  for (const domain of requiredDomains ?? []) {
    if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
      throw new Error("research.requiredDomains must contain lowercase public DNS names, without URLs or ports.");
    }
  }
  for (const key of ["requireCitations", "beforeFirstWrite"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`research.${key} must be boolean.`);
  }
  return Object.freeze({
    ...(minSearchCalls === undefined ? {} : { minSearchCalls }),
    ...(minFetchCalls === undefined ? {} : { minFetchCalls }),
    ...(requiredDomains === undefined ? {} : { requiredDomains }),
    ...(value.requireCitations === undefined ? {} : { requireCitations: value.requireCitations as boolean }),
    ...(value.beforeFirstWrite === undefined ? {} : { beforeFirstWrite: value.beforeFirstWrite as boolean }),
  });
}

export function parseLiveHealthScenario(input: unknown): LiveHealthScenario {
  if (!isObject(input)) throw new Error("Live health scenario must be an object.");
  rejectUnknown(input, [
    "acceptanceCriteria", "approvalDecisions", "constraints", "expected", "initialFiles", "mode",
    "name", "runtime", "schemaVersion", "task", "workspaceInstructions",
  ], "Live health scenario");
  if (input.schemaVersion !== LIVE_HEALTH_SCENARIO_VERSION) throw new Error("Live health scenario schemaVersion must be 1.");
  const mode = enumValue(input.mode, ["auto", "scaffold", "refactor", "review_only", "validate_only"] as const, "Live health mode");
  const initialFiles = files(input.initialFiles, "Live health initialFiles");
  const constraints = stringArray(input.constraints, "Live health constraints");
  const workspaceInstructions = stringArray(input.workspaceInstructions, "Live health workspaceInstructions");

  let acceptanceCriteria: LiveHealthScenario["acceptanceCriteria"];
  if (input.acceptanceCriteria !== undefined) {
    if (!Array.isArray(input.acceptanceCriteria)) throw new Error("Live health acceptanceCriteria must be an array.");
    acceptanceCriteria = Object.freeze(input.acceptanceCriteria.map((item, index) => {
      if (!isObject(item)) throw new Error(`Live health acceptanceCriteria[${index}] must be an object.`);
      rejectUnknown(item, ["id", "required", "text"], `Live health acceptanceCriteria[${index}]`);
      if (item.required !== undefined && typeof item.required !== "boolean") throw new Error(`Live health acceptanceCriteria[${index}].required must be boolean.`);
      return Object.freeze({
        id: requiredString(item.id, `Live health acceptanceCriteria[${index}].id`),
        text: requiredString(item.text, `Live health acceptanceCriteria[${index}].text`),
        ...(item.required === undefined ? {} : { required: item.required }),
      });
    }));
  }

  let approvalDecisions: Readonly<Record<string, "allow" | "deny">> | undefined;
  if (input.approvalDecisions !== undefined) {
    if (!isObject(input.approvalDecisions)) throw new Error("Live health approvalDecisions must be an object.");
    if (Object.values(input.approvalDecisions).some((decision) => decision !== "allow" && decision !== "deny")) {
      throw new Error("Live health approvalDecisions values must be allow or deny.");
    }
    approvalDecisions = Object.freeze({ ...input.approvalDecisions }) as Readonly<Record<string, "allow" | "deny">>;
  }

  if (!isObject(input.runtime ?? {})) throw new Error("Live health runtime must be an object.");
  const rawRuntime = (input.runtime ?? {}) as JsonObject;
  rejectUnknown(rawRuntime, ["approvalProfile", "budget", "commandContainment", "dependencySetup", "research", "requestTimeoutMs", "tokenProfile"], "Live health runtime");
  let research: NonNullable<LiveHealthScenario["runtime"]>["research"];
  const requestTimeoutMs = integer(rawRuntime.requestTimeoutMs, "requestTimeoutMs", 1000);
  if (rawRuntime.research !== undefined) {
    if (!isObject(rawRuntime.research)) throw new Error("Live health runtime.research must be an object.");
    rejectUnknown(rawRuntime.research, ["provider"], "Live health runtime.research");
    if (rawRuntime.research.provider !== "ollama") throw new Error("Live health research.provider must be ollama.");
    research = Object.freeze({ provider: "ollama" });
  }
  if (!isObject(rawRuntime.budget ?? {})) throw new Error("Live health runtime.budget must be an object.");
  const rawBudget = (rawRuntime.budget ?? {}) as JsonObject;
  rejectUnknown(rawBudget, ["deadlineMs", "maxCompletionRejections", "maxNoProgressEpisodes", "maxObservationRepeats", "maxModelRetries", "modelRetryDelaysMs", "maxRepeatedToolRequests", "maxToolCalls", "maxTurns", "noProgressPolicy", "observationNudgeThresholds"], "Live health runtime.budget");
  const deadlineMs = integer(rawBudget.deadlineMs, "deadlineMs", 1);
  const maxCompletionRejections = integer(rawBudget.maxCompletionRejections, "maxCompletionRejections", 0);
  const maxNoProgressEpisodes = integer(rawBudget.maxNoProgressEpisodes, "maxNoProgressEpisodes", 1);
  const maxObservationRepeats = integer(rawBudget.maxObservationRepeats, "maxObservationRepeats", 1);
  const maxModelRetries = integer(rawBudget.maxModelRetries, "maxModelRetries", 0);
  const maxRepeatedToolRequests = integer(rawBudget.maxRepeatedToolRequests, "maxRepeatedToolRequests", 1);
  const maxRuntimeToolCalls = integer(rawBudget.maxToolCalls, "maxToolCalls", 1);
  const maxTurns = integer(rawBudget.maxTurns, "maxTurns", 1);
  const noProgressPolicy = enumValue(rawBudget.noProgressPolicy, ["advisory", "strict"] as const, "Live health runtime.budget.noProgressPolicy");
  let observationNudgeThresholds: readonly number[] | undefined;
  let modelRetryDelaysMs: readonly number[] | undefined;
  if (rawBudget.modelRetryDelaysMs !== undefined) {
    const rawDelays = rawBudget.modelRetryDelaysMs;
    if (!Array.isArray(rawDelays) || rawDelays.length === 0) {
      throw new Error("Live health runtime.budget.modelRetryDelaysMs must be a non-empty array.");
    }
    if (rawDelays.length > 8) {
      throw new Error("Live health runtime.budget.modelRetryDelaysMs must contain at most 8 delays.");
    }
    for (const delay of rawDelays) {
      if (!Number.isSafeInteger(Number(delay)) || Number(delay) < 1 || Number(delay) > 600_000) {
        throw new Error("Live health runtime.budget.modelRetryDelaysMs entries must be integers between 1 and 600000.");
      }
    }
    modelRetryDelaysMs = Object.freeze(rawDelays.map((delay) => Number(delay)));
  }
  if (rawBudget.observationNudgeThresholds !== undefined) {
    const rawThresholds = rawBudget.observationNudgeThresholds;
    if (!Array.isArray(rawThresholds) || rawThresholds.length === 0) {
      throw new Error("Live health runtime.budget.observationNudgeThresholds must be a non-empty array.");
    }
    if (rawThresholds.length > 8) throw new Error("Live health runtime.budget.observationNudgeThresholds must contain at most 8 thresholds.");
    const seen = new Set<number>();
    for (const threshold of rawThresholds) {
      if (!Number.isSafeInteger(threshold) || Number(threshold) < 2) {
        throw new Error("Live health runtime.budget.observationNudgeThresholds entries must be integers >= 2.");
      }
      if (seen.has(Number(threshold))) {
        throw new Error(`Live health runtime.budget.observationNudgeThresholds must not contain duplicate threshold ${Number(threshold)}.`);
      }
      seen.add(Number(threshold));
    }
    observationNudgeThresholds = Object.freeze([...seen].sort((left, right) => left - right));
  }
  const budget = Object.freeze({
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    ...(maxCompletionRejections === undefined ? {} : { maxCompletionRejections }),
    ...(maxNoProgressEpisodes === undefined ? {} : { maxNoProgressEpisodes }),
    ...(maxObservationRepeats === undefined ? {} : { maxObservationRepeats }),
    ...(maxModelRetries === undefined ? {} : { maxModelRetries }),
    ...(modelRetryDelaysMs === undefined ? {} : { modelRetryDelaysMs }),
    ...(maxRepeatedToolRequests === undefined ? {} : { maxRepeatedToolRequests }),
    ...(maxRuntimeToolCalls === undefined ? {} : { maxToolCalls: maxRuntimeToolCalls }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(noProgressPolicy === undefined ? {} : { noProgressPolicy }),
    ...(observationNudgeThresholds === undefined ? {} : { observationNudgeThresholds }),
  });
  let dependencySetup: NonNullable<LiveHealthScenario["runtime"]>["dependencySetup"];
  if (rawRuntime.dependencySetup !== undefined) {
    if (!isObject(rawRuntime.dependencySetup)) throw new Error("Live health runtime.dependencySetup must be an object.");
    rejectUnknown(rawRuntime.dependencySetup, ["packageManager", "timeoutMs"], "Live health runtime.dependencySetup");
    const packageManager = enumValue(rawRuntime.dependencySetup.packageManager, ["npm"] as const, "dependencySetup.packageManager");
    if (packageManager === undefined) throw new Error("dependencySetup.packageManager is required.");
    const timeoutMs = integer(rawRuntime.dependencySetup.timeoutMs, "dependencySetup.timeoutMs", 1);
    dependencySetup = Object.freeze({
      packageManager,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }
  const runtime = Object.freeze({
    ...(research === undefined ? {} : { research }),
    ...(enumValue(rawRuntime.approvalProfile, ["strict", "balanced", "trusted-workspace"] as const, "approvalProfile") === undefined ? {} : { approvalProfile: rawRuntime.approvalProfile as "strict" | "balanced" | "trusted-workspace" }),
    ...(Object.keys(budget).length === 0 ? {} : { budget }),
    ...(enumValue(rawRuntime.commandContainment, ["best_effort", "required"] as const, "commandContainment") === undefined ? {} : { commandContainment: rawRuntime.commandContainment as "best_effort" | "required" }),
    ...(dependencySetup === undefined ? {} : { dependencySetup }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(enumValue(rawRuntime.tokenProfile, ["conservative", "balanced", "extended"] as const, "tokenProfile") === undefined ? {} : { tokenProfile: rawRuntime.tokenProfile as "conservative" | "balanced" | "extended" }),
  });

  if (!isObject(input.expected)) throw new Error("Live health expected must be an object.");
  rejectUnknown(input.expected, ["allowedChanges", "files", "maxToolCalls", "requirePassedValidation", "research", "requiredAnyCanonicalTools", "requiredCanonicalTools", "status"], "Live health expected");
  const expectedResearch = researchExpected(input.expected.research);
  if (expectedResearch !== undefined && research === undefined) throw new Error("Research assertions require runtime.research.");
  const allowedChanges = stringArray(input.expected.allowedChanges, "Live health expected.allowedChanges");
  if (allowedChanges === undefined) throw new Error("Live health expected.allowedChanges is required.");
  const maxExpectedToolCalls = integer(input.expected.maxToolCalls, "Live health expected.maxToolCalls", 0);
  const requiredAnyCanonicalTools = toolAlternatives(input.expected.requiredAnyCanonicalTools);
  const requiredCanonicalTools = stringArray(input.expected.requiredCanonicalTools, "Live health expected.requiredCanonicalTools");
  const expectedStatus = enumValue(input.expected.status, ["completed", "failed", "paused", "canceled"] as const, "Live health expected.status");
  const expected = Object.freeze({
    ...(expectedResearch === undefined ? {} : { research: expectedResearch }),
    allowedChanges: Object.freeze(allowedChanges.map((path, index) => scenarioPath(path, `Live health expected.allowedChanges[${index}]`))),
    files: expectedFiles(input.expected.files),
    ...(maxExpectedToolCalls === undefined ? {} : { maxToolCalls: maxExpectedToolCalls }),
    ...(input.expected.requirePassedValidation === undefined ? {} : (() => {
      if (typeof input.expected.requirePassedValidation !== "boolean") throw new Error("Live health expected.requirePassedValidation must be boolean.");
      return { requirePassedValidation: input.expected.requirePassedValidation };
    })()),
    ...(requiredAnyCanonicalTools === undefined ? {} : { requiredAnyCanonicalTools }),
    ...(requiredCanonicalTools === undefined ? {} : { requiredCanonicalTools }),
    ...(expectedStatus === undefined ? {} : { status: expectedStatus }),
  });

  return Object.freeze({
    schemaVersion: 1,
    name: requiredString(input.name, "Live health name"),
    task: requiredString(input.task, "Live health task"),
    expected,
    ...(mode === undefined ? {} : { mode }),
    ...(initialFiles === undefined ? {} : { initialFiles }),
    ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
    ...(approvalDecisions === undefined ? {} : { approvalDecisions }),
    ...(constraints === undefined ? {} : { constraints }),
    ...(workspaceInstructions === undefined ? {} : { workspaceInstructions }),
    ...(Object.keys(runtime).length === 0 ? {} : { runtime }),
  });
}
