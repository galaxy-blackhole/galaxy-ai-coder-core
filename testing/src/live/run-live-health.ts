import {
  AiCoderRunController,
  redactAiCoderCheckpointText,
  type AiCoderHostEnvironment,
  type AiCoderRunCheckpoint,
  type AiCoderRunHandle,
  type AiCoderRunRequest,
  type AiCoderRunResult,
  type AiCoderRuntimeEvent,
  type ModelCapabilities,
  type RunExecutionContext,
  type ToolExecutionContext,
} from "@galaxy-stack/ai-coder-core";
import type { AiCoderFinalReport, AiCoderRunStore } from "@galaxy-stack/ai-coder-core/runtime";
import { portSuccess, type CodingModelAdapter, type CodingRoundRequest } from '@galaxy-stack/ai-coder-core/ports';
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ResolvedOllamaConnection } from "../config/manual-provider-config.js";
import { publicOllamaConnection } from "../config/manual-provider-config.js";
import type { LiveHealthFile, LiveHealthScenario } from "../domain/live-health-scenario.js";
import { NodeCommandPort } from "../host/node-command-port.js";
import { NodeWorkspaceEvidenceVerifier } from "../host/node-workspace-evidence-verifier.js";
import { NodeWorkspacePort } from "../host/node-workspace-port.js";
import { sha256Text } from "../host/content-hash.js";
import {
  DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS,
  diffNodeWorkspaceSnapshots,
  NodeWorkspaceSnapshotter,
} from "../host/node-workspace-snapshot.js";
import { MemoryTracePort } from "../host/memory-trace-port.js";
import { createFixtureApprovalPort } from "../lab/fixture-approval.js";
import { MemoryRunStore } from "../lab/memory-run-store.js";
import { LabToolExecutor, type LabTaskCheckpointState } from "../lab/tool-executor.js";
import { OllamaCodingModel, type OllamaModelDiagnostics } from "../provider/ollama-coding-model.js";
import { OllamaResearchPort } from "../provider/ollama-research-port.js";
import { observeResearch, type ResearchObservations } from "./research-observations.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type LiveStatus = "canceled" | "completed" | "failed" | "paused";

class RecordingRunStore implements AiCoderRunStore {
  readonly checkpointTrust = "trusted_host" as const;
  private readonly recordedCheckpoints: AiCoderRunCheckpoint[] = [];

  constructor(private readonly delegate: AiCoderRunStore) {}

  get checkpointHistory(): readonly AiCoderRunCheckpoint[] {
    return Object.freeze(structuredClone(this.recordedCheckpoints));
  }

  async loadLatestCheckpoint(runId: string, context: RunExecutionContext): Promise<AiCoderRunCheckpoint | null> {
    return await this.delegate.loadLatestCheckpoint(runId, context);
  }

  async saveCheckpoint(
    checkpoint: AiCoderRunCheckpoint,
    context: RunExecutionContext,
  ): Promise<Readonly<{ artifactRef?: string }>> {
    const result = await this.delegate.saveCheckpoint(checkpoint, context);
    this.recordedCheckpoints.push(structuredClone(checkpoint));
    return result;
  }

  async saveFinalReport(report: AiCoderFinalReport, context: RunExecutionContext): Promise<void> {
    await this.delegate.saveFinalReport(report, context);
  }
}

export interface LiveHealthRunOptions {
  /** Laboratory-only hooks. Real provider requests are unchanged; pressure is explicitly injected. */
  readonly harness?: Readonly<{
    forceCompaction?: boolean;
    onEvent?: (event: AiCoderRuntimeEvent) => Promise<void> | void;
    onRequest?: (request: CodingRoundRequest) => Promise<void> | void;
  }>;
  readonly connection: ResolvedOllamaConnection;
  readonly fetch?: FetchLike;
  readonly researchFetch?: FetchLike;
  readonly pauseAfterToolCalls?: number;
  readonly scenario: LiveHealthScenario;
  readonly signal?: AbortSignal;
  readonly resume?: boolean;
  readonly runId?: string;
  readonly store?: AiCoderRunStore;
  readonly workspacePath: string;
}

export interface LiveHealthReport {
  readonly changedPaths: readonly string[];
  readonly checkpointReasons: readonly string[];
  readonly commandContainment: NodeCommandPort["containmentStatus"];
  readonly completionRejections: readonly (readonly string[])[];
  readonly completionRejectionDetails: readonly Readonly<{
    candidate: string;
    issues: readonly string[];
    researchEvidence: Readonly<{
      fetchedUrls: readonly string[];
      searchOnlyUrls: readonly string[];
      sources: readonly Readonly<{
        contentHash: string | null;
        kind: "fetch" | "search";
        toolCallId: string;
        url: string;
      }>[];
      unsupportedCitations: readonly string[];
    }>;
  }>[];
  readonly connection: ReturnType<typeof publicOllamaConnection>;
  readonly contextPressures: readonly string[];
  readonly dependencySetup: Readonly<{
    command: string;
    durationMs: number;
    exitCode: number | null;
    ok: boolean;
    packageManager: "npm";
    status: string;
    stderrTail: string;
    stdoutTail: string;
  }> | null;
  /** Generated dependency-state changes observed by the host, never durable source evidence. */
  readonly derivedMutations: Readonly<{
    count: number;
    paths: readonly string[];
    truncated: boolean;
  }>;
  readonly error: AiCoderRunResult["error"];
  /** The effective run budget, recorded so stability failures state their tuning. */
  readonly effectiveBudget: Readonly<{
    deadlineMs: number;
    maxCompletionRejections: number;
    maxNoProgressEpisodes: number;
    maxObservationRepeats: number;
    maxModelRetries: number;
    modelRetryDelaysMs: readonly number[];
    maxRepeatedToolRequests: number;
    maxToolCalls: number;
    maxTurns: number;
    noProgressPolicy: "advisory" | "strict";
    observationNudgeThresholds: readonly number[];
  }>;
  readonly failures: readonly string[];
  readonly finalResponse: string;
  readonly modelDiagnostics: OllamaModelDiagnostics;
  readonly modelEventCounts: Readonly<Record<string, number>>;
  readonly modelRetries: readonly Readonly<{ attempt: number; delayMs: number; message: string }>[];
  readonly openProblems: readonly string[];
  readonly passed: boolean;
  readonly preflight: Readonly<{
    contextWindow: number | null;
    maxOutputTokens: number | null;
    preserveThinking: string;
    streaming: string;
    toolCalling: string;
  }> | null;
  readonly persistence: Readonly<{
    kind: "durable" | "memory";
    resumed: boolean;
    resumedCheckpointHash: string | null;
  }>;
  /** Host-observable pause cause; null unless the run ended in the paused state. */
  readonly pauseReason: string | null;
  readonly runId: string;
  readonly research: ResearchObservations | null;
  readonly scenario: string;
  readonly status: LiveStatus;
  readonly toolResults: readonly Readonly<{
    canonicalToolId: string;
    errorCode: string | null;
    ok: boolean;
    summary: string;
    toolName: string;
  }>[];
  readonly toolJournal: readonly Readonly<{
    argumentsHash: string;
    argumentsExcerpt: string;
    canonicalToolId: string;
    errorCode: string | null;
    errorMessage: string | null;
    ok: boolean;
    resultExcerpt: string;
    toolCallId: string;
    toolName: string;
  }>[];
  readonly toolSequence: readonly string[];
  readonly traceEvents: number;
  readonly traceFlushes: number;
  readonly transitions: readonly string[];
  readonly validation: AiCoderRunResult["validation"];
  readonly warnings: readonly string[];
  readonly workspacePath: string;
  readonly writes: AiCoderRunResult["writes"];
}

function runtimeStatus(state: AiCoderRunResult["state"]): LiveStatus {
  return state === "cancelled" ? "canceled" : state;
}

function setupContext(
  runContext: RunExecutionContext,
): ToolExecutionContext {
  return Object.freeze({
    ...runContext,
    idempotencyKey: `${runContext.runId}:setup`,
    toolCallId: `${runContext.runId}:setup`,
  });
}

async function arrangeFiles(
  files: readonly LiveHealthFile[],
  workspace: NodeWorkspacePort,
  context: ToolExecutionContext,
): Promise<void> {
  for (const file of files) {
    const state = await workspace.stat({ path: file.path }, context);
    if (!state.ok) throw new Error(`Unable to stat '${file.path}': ${state.error.code}: ${state.error.message}`);
    if (state.data.kind === "file" && state.data.contentSha256 === sha256Text(file.content)) continue;
    const precondition = state.data.kind === "missing"
      ? { kind: "must_not_exist" as const }
      : state.data.kind === "file" && state.data.contentSha256 !== undefined
        ? { kind: "matches_sha256" as const, contentSha256: state.data.contentSha256 }
        : null;
    if (precondition === null) throw new Error(`Unable to arrange '${file.path}': target is ${state.data.kind}.`);
    const result = await workspace.writeText({ path: file.path, content: file.content, precondition }, context);
    if (!result.ok) throw new Error(`Unable to arrange '${file.path}': ${result.error.code}: ${result.error.message}`);
  }
}

async function initializeGitBaseline(
  workspace: NodeWorkspacePort,
  command: NodeCommandPort,
  context: ToolExecutionContext,
): Promise<boolean> {
  const gitState = await workspace.stat({ path: ".git" }, context);
  if (gitState.ok && gitState.data.kind === "directory") return true;
  for (const gitCommand of [
    "git init --quiet",
    "git add -A",
    "git -c user.name=GalaxyLiveHealth -c user.email=live-health@local.invalid commit --quiet --allow-empty -m live-health-baseline",
  ]) {
    const result = await command.run({ command: gitCommand, cwd: ".", timeoutMs: 20_000 }, context);
    if (!result.ok || result.data.exitCode !== 0) return false;
  }
  return true;
}

function preflightSummary(capabilities: ModelCapabilities): NonNullable<LiveHealthReport["preflight"]> {
  return Object.freeze({
    contextWindow: capabilities.contextWindow ?? null,
    maxOutputTokens: capabilities.maxOutputTokens ?? null,
    preserveThinking: capabilities.preserveThinking,
    streaming: capabilities.streaming,
    toolCalling: capabilities.toolCalling,
  });
}

function boundedJournalText(value: unknown, maxCodePoints = 2_000): string {
  const serialized = JSON.stringify(value, (key, item) => (
    /^(?:api[_-]?key|authorization|password|secret|token)$/i.test(key) ? "[REDACTED]" : item
  ));
  const redacted = redactAiCoderCheckpointText(serialized ?? "null");
  const points = Array.from(redacted);
  if (points.length <= maxCodePoints) return redacted;
  const head = Math.floor(maxCodePoints * 0.75);
  return `${points.slice(0, head).join("")}\n...[journal excerpt truncated]...\n${points.slice(-(maxCodePoints - head)).join("")}`;
}

function createBudgetSummary(scenario: LiveHealthScenario): Readonly<{
  deadlineMs: number;
  maxCompletionRejections: number;
  maxNoProgressEpisodes: number;
    maxObservationRepeats: number;
    maxRepeatedToolRequests: number;
    maxModelRetries: number;
    modelRetryDelaysMs: readonly number[];
    maxToolCalls: number;
  maxTurns: number;
  noProgressPolicy: "advisory" | "strict";
  observationNudgeThresholds: readonly number[];
}> {
  const budget = scenario.runtime?.budget ?? {};
  return Object.freeze({
    deadlineMs: budget.deadlineMs ?? 900_000,
    maxCompletionRejections: budget.maxCompletionRejections ?? 2,
    maxNoProgressEpisodes: budget.maxNoProgressEpisodes ?? 2,
    maxObservationRepeats: budget.maxObservationRepeats ?? 2,
    maxModelRetries: budget.maxModelRetries ?? 1,
    modelRetryDelaysMs: budget.modelRetryDelaysMs ?? Object.freeze([1_000, 3_000, 8_000]),
    maxRepeatedToolRequests: budget.maxRepeatedToolRequests ?? 2,
    maxToolCalls: budget.maxToolCalls ?? 24,
    maxTurns: budget.maxTurns ?? 20,
    noProgressPolicy: budget.noProgressPolicy ?? "advisory",
    observationNudgeThresholds: budget.observationNudgeThresholds ?? Object.freeze([3, 5, 8]),
  });
}

function createRequest(
  scenario: LiveHealthScenario,
  runId: string,
  workspacePath: string,
  networkAccess: "allowed" | "denied",
  hostEnvironment: AiCoderHostEnvironment,
): AiCoderRunRequest {
  const mode = scenario.mode ?? "auto";
  return Object.freeze({
    ...(scenario.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: scenario.acceptanceCriteria }),
    budget: createBudgetSummary(scenario),
    completion: Object.freeze({
      requireFinalReportPersistence: true,
      requireInspection: true,
      requireTokenLedger: true,
      requireTrace: true,
      requireValidation: scenario.expected.requirePassedValidation ?? false,
      ...(scenario.expected.research === undefined ? {} : {
        research: Object.freeze({
          minFetchCalls: scenario.expected.research.minFetchCalls ?? 0,
          minSearchCalls: scenario.expected.research.minSearchCalls ?? 0,
          requireCitations: scenario.expected.research.requireCitations ?? false,
          requiredDomains: Object.freeze([...(scenario.expected.research.requiredDomains ?? [])]),
        }),
      }),
    }),
    ...(scenario.constraints === undefined ? {} : { constraints: scenario.constraints }),
    goal: scenario.task,
    mode,
    prompt: Object.freeze({
      approvalProfile: scenario.runtime?.approvalProfile ?? "balanced",
      complexity: "standard" as const,
      dirtyStateSummary: "Isolated live-health workspace prepared from the checked-in scenario.",
      hostEnvironment,
      networkAccess,
      ...(scenario.workspaceInstructions === undefined ? {} : {
        trustedWorkspaceInstructions: Object.freeze(scenario.workspaceInstructions.map((content, index) => Object.freeze({
          content,
          source: `liveHealth.workspaceInstructions[${index}]`,
        }))),
      }),
      writeAccess: mode === "review_only" || mode === "validate_only" ? "denied" as const : "allowed" as const,
    }),
    runId,
    taskId: `live:${scenario.name}`,
    tokenProfile: scenario.runtime?.tokenProfile ?? "balanced",
    workspaceRoot: workspacePath,
  });
}

async function findLockFiles(root: string): Promise<readonly string[]> {
  const locks: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.name.endsWith(".galaxy-code.lock")) locks.push(relative);
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
    }
  };
  await visit(root, "");
  return Object.freeze(locks.sort());
}

async function assertScenario(
  scenario: LiveHealthScenario,
  status: LiveStatus,
  changedPaths: readonly string[],
  toolResults: LiveHealthReport["toolResults"],
  restoredCanonicalTools: ReadonlySet<string>,
  validation: AiCoderRunResult["validation"],
  workspace: NodeWorkspacePort,
  context: ToolExecutionContext,
  workspacePath: string,
): Promise<Readonly<{ failures: readonly string[]; warnings: readonly string[] }>> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const expectedStatus = scenario.expected.status ?? "completed";
  if (status !== expectedStatus) failures.push(`Expected status ${expectedStatus}, received ${status}.`);
  if (JSON.stringify(changedPaths) !== JSON.stringify([...scenario.expected.allowedChanges].sort())) {
    failures.push(`Expected changed paths ${JSON.stringify([...scenario.expected.allowedChanges].sort())}, received ${JSON.stringify(changedPaths)}.`);
  }
  for (const expected of scenario.expected.files) {
    const read = await workspace.readText({ path: expected.path, maxBytes: 128_000 }, context);
    if (!read.ok) {
      failures.push(`Expected file '${expected.path}' is unreadable: ${read.error.code}.`);
      continue;
    }
    if (expected.content !== undefined && read.data.content !== expected.content) {
      failures.push(`File '${expected.path}' content does not match the scenario.`);
    }
    for (const fragment of expected.contentIncludes ?? []) {
      if (!read.data.content.includes(fragment)) failures.push(`File '${expected.path}' lacks ${JSON.stringify(fragment)}.`);
    }
  }
  const usedCanonicalTools = new Set([
    ...restoredCanonicalTools,
    ...toolResults.map((item) => item.canonicalToolId),
  ]);
  for (const canonicalToolId of scenario.expected.requiredCanonicalTools ?? []) {
    if (!usedCanonicalTools.has(canonicalToolId)) failures.push(`Required tool '${canonicalToolId}' was not used.`);
  }
  for (const alternatives of scenario.expected.requiredAnyCanonicalTools ?? []) {
    if (!alternatives.some((canonicalToolId) => usedCanonicalTools.has(canonicalToolId))) {
      failures.push(`None of the required alternative tools were used: ${alternatives.join(", ")}.`);
    }
  }
  if (scenario.expected.maxToolCalls !== undefined && toolResults.length > scenario.expected.maxToolCalls) {
    warnings.push(`Efficiency target exceeded: expected at most ${scenario.expected.maxToolCalls} tool calls, received ${toolResults.length}.`);
  }
  if (scenario.expected.requirePassedValidation === true && !validation.some((item) => item.status === "passed")) {
    failures.push("No trusted validation passed.");
  }
  for (const path of await findLockFiles(workspacePath)) failures.push(`Leaked workspace lock file '${path}'.`);
  return Object.freeze({ failures: Object.freeze(failures), warnings: Object.freeze(warnings) });
}

function emptyResult(runId: string, taskId: string, message: string): AiCoderRunResult {
  return Object.freeze({
    checkpoint: null,
    content: "",
    error: Object.freeze({ code: "CAPABILITY_PREFLIGHT_FAILED", message }),
    runId,
    state: "failed",
    taskId,
    transitions: Object.freeze([]),
    validation: Object.freeze([]),
    writes: Object.freeze([]),
  });
}

type DependencySetupReport = LiveHealthReport["dependencySetup"];

async function installScenarioDependencies(
  scenario: LiveHealthScenario,
  command: NodeCommandPort,
  context: ToolExecutionContext,
): Promise<DependencySetupReport> {
  const setup = scenario.runtime?.dependencySetup;
  if (setup === undefined) return null;
  const installCommand = "npm install --ignore-scripts --no-audit --no-fund";
  const result = await command.run({
    command: installCommand,
    cwd: ".",
    maxOutputBytes: 16_384,
    timeoutMs: setup.timeoutMs ?? 300_000,
  }, context);
  if (!result.ok) {
    return Object.freeze({
      command: installCommand,
      durationMs: 0,
      exitCode: null,
      ok: false,
      packageManager: setup.packageManager,
      status: result.error.code,
      stderrTail: result.error.message,
      stdoutTail: "",
    });
  }
  return Object.freeze({
    command: installCommand,
    durationMs: result.data.durationMs,
    exitCode: result.data.exitCode,
    ok: result.data.status === "exited" && result.data.exitCode === 0,
    packageManager: setup.packageManager,
    status: result.data.status,
    stderrTail: result.data.stderr,
    stdoutTail: result.data.stdout,
  });
}

export async function runLiveHealth(options: LiveHealthRunOptions): Promise<LiveHealthReport> {
  const scenario = options.scenario;
  if (scenario.runtime?.research !== undefined && !options.connection.apiKey?.trim()) {
    throw new Error("Ollama web research requires the configured manual API key or OLLAMA_API_KEY.");
  }
  const mode = scenario.mode ?? "auto";
  const runId = options.runId ?? `live-${randomUUID()}`;
  const taskId = `live:${scenario.name}`;
  const effectiveBudget = createBudgetSummary(scenario);
  const signal = options.signal ?? new AbortController().signal;
  const deadline = Date.now() + (scenario.runtime?.budget?.deadlineMs ?? 900_000);
  const runContext: RunExecutionContext = Object.freeze({
    deadline,
    mode,
    runId,
    signal,
    taskId,
    workspaceRoot: options.workspacePath,
  });
  const setup = setupContext(runContext);
  const model = new OllamaCodingModel({
    ...(options.connection.apiKey === undefined ? {} : { apiKey: options.connection.apiKey }),
    baseUrl: options.connection.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    model: options.connection.model,
    ...(scenario.runtime?.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: scenario.runtime.requestTimeoutMs }),
  });
  const capabilityResult = await model.capabilities(runContext);
  let capabilities: ModelCapabilities | null = null;
  let result: AiCoderRunResult;
  let dependencySetup: DependencySetupReport = null;
  const restoredCanonicalTools = new Set<string>();
  const events: AiCoderRuntimeEvent[] = [];
  const trace = new MemoryTracePort();
  const store = new RecordingRunStore(options.store ?? new MemoryRunStore());
  const workspace = await NodeWorkspacePort.create(options.workspacePath);
  const command = await NodeCommandPort.create(options.workspacePath, {
    containment: scenario.runtime?.commandContainment ?? "best_effort",
  });
  const snapshotter = await NodeWorkspaceSnapshotter.create(
    options.workspacePath,
    DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS,
  );
  let initialSnapshot = await snapshotter.capture(runContext);
  const existingCheckpoint = options.store !== undefined && options.runId !== undefined
    ? await store.loadLatestCheckpoint(runId, runContext)
    : null;
  if (options.resume !== true && existingCheckpoint !== null) {
    throw new Error(`Run '${runId}' already has a durable checkpoint; use --resume or choose a new --run-id.`);
  }
  const resumedCheckpoint = options.resume === true ? existingCheckpoint : null;

  if (!capabilityResult.ok) {
    result = emptyResult(runId, taskId, capabilityResult.error.message);
  } else if (capabilityResult.data.toolCalling !== "supported") {
    result = emptyResult(runId, taskId, `Ollama model tool calling is ${capabilityResult.data.toolCalling}, not supported.`);
  } else {
    capabilities = capabilityResult.data;
    if (options.resume !== true) {
      await arrangeFiles(scenario.initialFiles ?? [], workspace, setup);
      dependencySetup = await installScenarioDependencies(scenario, command, setup);
    }
    if (dependencySetup !== null && !dependencySetup.ok) {
      result = emptyResult(
        runId,
        taskId,
        `Dependency setup failed (${dependencySetup.status}, exit ${dependencySetup.exitCode ?? "unavailable"}): ${dependencySetup.stderrTail || dependencySetup.stdoutTail}`,
      );
    } else {
      const resumedGitState = options.resume === true
        ? await workspace.stat({ path: ".git" }, setup)
        : null;
      const enableGit = resumedGitState === null
        ? await initializeGitBaseline(workspace, command, setup)
        : resumedGitState.ok && resumedGitState.data.kind === "directory";
      if (options.resume !== true) initialSnapshot = await snapshotter.capture(runContext);
      const taskCheckpointStore = new Map<string, LabTaskCheckpointState>();
      if (resumedCheckpoint !== null) {
        taskCheckpointStore.set(runId, Object.freeze({
          decisions: Object.freeze([...resumedCheckpoint.decisions]),
          goal: resumedCheckpoint.goal,
          nextStep: resumedCheckpoint.nextAction,
          progress: JSON.stringify(resumedCheckpoint.plan),
          updatedAt: resumedCheckpoint.createdAt,
        }));
      }
      const executor = new LabToolExecutor({
      approval: createFixtureApprovalPort(scenario.approvalDecisions),
      approvalProfile: scenario.runtime?.approvalProfile ?? "balanced",
      capabilities,
      command,
      enableGit,
      ...(scenario.runtime?.research === undefined ? {} : {
        research: new OllamaResearchPort({
          apiKey: options.connection.apiKey!,
          ...(options.researchFetch === undefined ? {} : { fetch: options.researchFetch }),
        }),
      }),
      taskCheckpointStore,
      workspace,
      workspaceSnapshot: DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS,
      });
      const toolSet = await executor.getToolSet(runContext);
      if (resumedCheckpoint !== null) {
        for (const call of resumedCheckpoint.lastToolCalls) {
          const canonicalToolId = call.outcome === "succeeded"
            ? toolSet.canonicalToolIds[call.name]
            : undefined;
          if (canonicalToolId !== undefined) restoredCanonicalTools.add(canonicalToolId);
        }
      }
      const verifier = await NodeWorkspaceEvidenceVerifier.create(options.workspacePath);
      let handle: AiCoderRunHandle | null = null;
      let observedToolResults = 0;
      let realCountAfterInjection = false;
      const runtimeModel: CodingModelAdapter = {
        identity: model.identity,
        capabilities: context => model.capabilities(context),
        countTokens: async (input, context) => {
          if (options.harness?.forceCompaction && model.diagnostics.chatRequests > 0 && !realCountAfterInjection) {
            realCountAfterInjection = true;
            return portSuccess({ exact: false, source: 'estimate' as const, tokens: (capabilities?.contextWindow ?? 262144) + 1 });
          }
          realCountAfterInjection = false;
          return model.countTokens(input, context);
        },
        async *streamRound(input, context) {
          await options.harness?.onRequest?.(input);
          yield* model.streamRound(input, context);
        },
      };
      const controller = new AiCoderRunController({
        model: runtimeModel,
        onEvent: async (event) => {
          events.push(event);
          await options.harness?.onEvent?.(event);
          if (event.type === "tool_result" && options.pauseAfterToolCalls !== undefined) {
            observedToolResults += 1;
            if (observedToolResults === options.pauseAfterToolCalls) {
              handle?.pause(`Live health pause after ${options.pauseAfterToolCalls} tool results.`);
            }
          }
        },
        resumeWorkspaceVerifier: verifier,
        store,
        toolExecutor: executor,
        trace,
      });
      const request = createRequest(
        scenario,
        runId,
        options.workspacePath,
        scenario.runtime?.research !== undefined || command.containmentStatus.network !== "denied" ? "allowed" : "denied",
        command.hostEnvironment,
      );
      handle = options.resume === true
        ? controller.resume(Object.freeze({ ...request, runId }))
        : controller.start(request);
      const cancel = () => handle.cancel("Live health run canceled by the CLI host.");
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      try {
        result = await handle.result;
      } finally {
        options.signal?.removeEventListener("abort", cancel);
      }
    }
  }

  const finalSnapshot = await snapshotter.capture(Object.freeze({
    ...runContext,
    deadline: Math.max(runContext.deadline, Date.now() + 30_000),
    signal: new AbortController().signal,
  }));
  const auditContext = setupContext(Object.freeze({
    ...runContext,
    deadline: Math.max(runContext.deadline, Date.now() + 30_000),
    signal: new AbortController().signal,
  }));
  const finalMutationDiff = options.resume === true
    ? null
    : diffNodeWorkspaceSnapshots(initialSnapshot, finalSnapshot);
  const changedPaths = options.resume === true
    ? Object.freeze([...new Set(result.writes.map((write) => write.path))].sort())
    : Object.freeze(finalMutationDiff!.writes.map((write) => write.path));
  const allDerivedChangedPaths = finalMutationDiff?.observedMutations
    .filter((mutation) => mutation.evidenceClass === "derived")
    .map((mutation) => mutation.path) ?? [];
  const derivedMutations = Object.freeze({
    count: allDerivedChangedPaths.length,
    paths: Object.freeze(allDerivedChangedPaths.slice(0, 256)),
    truncated: allDerivedChangedPaths.length > 256,
  });
  const toolSequence = Object.freeze(events
    .filter((event): event is Extract<AiCoderRuntimeEvent, { type: "tool_start" }> => event.type === "tool_start")
    .map((event) => event.call.name));
  const toolResults = Object.freeze(events
    .filter((event): event is Extract<AiCoderRuntimeEvent, { type: "tool_result" }> => event.type === "tool_result")
    .map((event) => Object.freeze({
      canonicalToolId: event.result.canonicalToolId,
      errorCode: event.result.error?.code ?? null,
      ok: event.result.ok,
      summary: event.result.summary,
      toolName: event.call.name,
    })));
  const toolJournal = Object.freeze(events
    .filter((event): event is Extract<AiCoderRuntimeEvent, { type: "tool_result" }> => event.type === "tool_result")
    .map((event) => Object.freeze({
      argumentsHash: sha256Text(JSON.stringify(event.call.arguments)),
      argumentsExcerpt: boundedJournalText(event.call.arguments),
      canonicalToolId: event.result.canonicalToolId,
      errorCode: event.result.error?.code ?? null,
      errorMessage: event.result.error?.message ?? null,
      ok: event.result.ok,
      resultExcerpt: boundedJournalText(event.result.content),
      toolCallId: event.call.toolCallId,
      toolName: event.call.name,
    })));
  const status = runtimeStatus(result.state);
  const pauseTransition = [...result.transitions].reverse().find((transition) => transition.to === "paused");
  const pauseReason = status === "paused"
    ? pauseTransition?.reason ?? result.error?.message ?? "Paused without a recorded reason."
    : null;
  const checkpointSeed = resumedCheckpoint?.researchSources ?? [];
  const research = scenario.runtime?.research === undefined ? null
    : observeResearch(events, result.content, scenario.expected.research, options.resume === true
      ? checkpointSeed
      : undefined);
  const scenarioAssessment = capabilities === null
    ? Object.freeze({
        failures: Object.freeze([result.error?.message ?? "Ollama capability preflight failed."]),
        warnings: Object.freeze([]),
      })
    : await assertScenario(
        scenario,
        status,
        changedPaths,
        toolResults,
        restoredCanonicalTools,
        result.validation,
        workspace,
        auditContext,
        options.workspacePath,
      );
  const failures = Object.freeze([...scenarioAssessment.failures, ...(research?.failures ?? [])]);
  const modelEventCounts: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "model") continue;
    modelEventCounts[event.event.type] = (modelEventCounts[event.event.type] ?? 0) + 1;
  }
  return Object.freeze({
    changedPaths,
    checkpointReasons: Object.freeze(store.checkpointHistory.map((checkpoint) => checkpoint.reason)),
    commandContainment: command.containmentStatus,
    completionRejections: Object.freeze(events
      .filter((event): event is Extract<AiCoderRuntimeEvent, { type: "completion_rejected" }> => event.type === "completion_rejected")
      .map((event) => Object.freeze([...event.issues]))),
    completionRejectionDetails: Object.freeze(events
      .filter((event): event is Extract<AiCoderRuntimeEvent, { type: "completion_rejected" }> => event.type === "completion_rejected")
      .map((event) => Object.freeze({
        candidate: event.candidate,
        issues: Object.freeze([...event.issues]),
        researchEvidence: event.researchEvidence,
      }))),
    connection: publicOllamaConnection(options.connection),
    contextPressures: Object.freeze(events
      .filter((event): event is Extract<AiCoderRuntimeEvent, { type: "context_pressure" }> => event.type === "context_pressure")
      .map((event) => event.pressure)),
    dependencySetup,
    derivedMutations,
    error: result.error,
    effectiveBudget,
    failures,
    finalResponse: result.content,
    modelDiagnostics: model.diagnostics,
    modelEventCounts: Object.freeze(modelEventCounts),
    modelRetries: Object.freeze(events
      .filter((event): event is Extract<AiCoderRuntimeEvent, { type: "model_retry" }> => event.type === "model_retry")
      .map((event) => Object.freeze({ attempt: event.attempt, delayMs: event.delayMs, message: event.message }))),
    openProblems: Object.freeze([...(result.checkpoint?.openProblems ?? [])]),
    passed: failures.length === 0,
    persistence: Object.freeze({
      kind: options.store === undefined ? "memory" : "durable",
      resumed: options.resume === true,
      resumedCheckpointHash: resumedCheckpoint?.contentHash ?? null,
    }),
    preflight: capabilities === null ? null : preflightSummary(capabilities),
    pauseReason,
    runId,
    research,
    scenario: scenario.name,
    status,
    toolResults,
    toolJournal,
    toolSequence,
    traceEvents: trace.events.length,
    traceFlushes: trace.flushCount,
    transitions: Object.freeze(result.transitions.map((transition) => `${transition.from}->${transition.to}`)),
    validation: result.validation,
    warnings: scenarioAssessment.warnings,
    workspacePath: options.workspacePath,
    writes: result.writes,
  });
}
