import {
  AiCoderRunController,
  type AiCoderHostEnvironment,
  type AiCoderRunCheckpoint,
  type AiCoderRunHandle,
  type AiCoderRunRequest,
  type AiCoderRunResult,
  type AiCoderRuntimeEvent,
  type RunExecutionContext,
  type ToolExecutionContext,
} from "@galaxy-stack/ai-coder-core";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";

import type {
  DeterministicFixture,
  FixtureFile,
  FixtureStatus,
} from "../domain/fixture.js";
import { NodeCommandPort } from "../host/node-command-port.js";
import type { CommandContainmentStatus } from "../host/command-containment.js";
import { NodeWorkspaceEvidenceVerifier } from "../host/node-workspace-evidence-verifier.js";
import { NodeWorkspacePort } from "../host/node-workspace-port.js";
import { sha256Text } from "../host/content-hash.js";
import { MemoryTracePort } from "../host/memory-trace-port.js";
import { createFixtureApprovalPort } from "./fixture-approval.js";
import { MemoryRunStore } from "./memory-run-store.js";
import { ScriptedCodingModel } from "./scripted-model.js";
import { LabToolExecutor, type LabTaskCheckpointState } from "./tool-executor.js";

export interface DeterministicRunOptions {
  readonly fixture: DeterministicFixture;
  readonly signal?: AbortSignal;
  readonly taskOverride?: string;
  readonly workspacePath: string;
}

export interface DeterministicToolResultReport {
  readonly canonicalToolId: string;
  readonly content: string;
  readonly error: Readonly<{ code: string; message: string }> | null;
  readonly ok: boolean;
  readonly summary: string;
  readonly toolName: string;
}

export interface DeterministicCheckpointAudit {
  readonly activeToolNames: readonly string[];
  readonly compactionCount: number;
  readonly contentHash: string;
  readonly diffReviewed: boolean;
  readonly editPaths: readonly string[];
  readonly modelTurns: number;
  readonly reason: string;
  readonly toolCalls: number;
  readonly validationIds: readonly string[];
}

export interface DeterministicModelContextAudit {
  readonly allRequestsContainTask: boolean;
  readonly observedCheckpointHashes: readonly string[];
}

export interface DeterministicRunReport {
  readonly allModelStepsConsumed: boolean;
  readonly checkpointAudits: readonly DeterministicCheckpointAudit[];
  readonly checkpointReasons: readonly string[];
  readonly checkpointsValid: boolean;
  readonly commandContainment: CommandContainmentStatus;
  readonly completionRejections: readonly (readonly string[])[];
  readonly controlsFired: number;
  readonly contextPressures: readonly string[];
  readonly error: AiCoderRunResult["error"];
  readonly executionStatuses: readonly FixtureStatus[];
  readonly failures: readonly string[];
  readonly finalResponse: string;
  readonly fixture: string;
  readonly modelRequestCount: number;
  readonly modelContextAudit: DeterministicModelContextAudit;
  readonly modelRoundsConsumed: number;
  readonly modelTokenCountStepsConsumed: number;
  readonly passed: boolean;
  readonly replayHash: string;
  readonly retryDelaysMs: readonly number[];
  readonly runId: string;
  readonly status: FixtureStatus;
  readonly toolSequence: readonly string[];
  readonly toolResults: readonly DeterministicToolResultReport[];
  readonly traceEvents: number;
  readonly traceFlushes: number;
  readonly traceKinds: readonly string[];
  readonly transitions: readonly string[];
  readonly validation: AiCoderRunResult["validation"];
  readonly workspacePath: string;
  readonly writes: AiCoderRunResult["writes"];
}

type WorkspaceStateEntry = Readonly<{
  contentHash: string;
  kind: "directory" | "file" | "other" | "symlink";
}>;

type WorkspaceState = ReadonlyMap<string, WorkspaceStateEntry>;

const SNAPSHOT_IGNORED_DIRECTORIES = new Set([".git"]);

function runIdForFixture(fixture: DeterministicFixture): string {
  const slug = fixture.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "fixture";
  return `fixture-${slug}-${sha256Text(`${fixture.schemaVersion}\n${fixture.name}\n${fixture.task}`).slice(0, 12)}`;
}

function setupContext(
  runId: string,
  taskId: string,
  mode: NonNullable<DeterministicFixture["mode"]>,
  workspaceRoot: string,
  signal: AbortSignal,
  deadlineMs: number,
): ToolExecutionContext {
  return Object.freeze({
    runId,
    taskId,
    mode,
    workspaceRoot,
    signal,
    deadline: Date.now() + deadlineMs,
    idempotencyKey: `${runId}:setup`,
    toolCallId: `${runId}:setup`,
  });
}

async function arrangeFiles(
  files: readonly FixtureFile[],
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
    "git -c user.name=GalaxyFixture -c user.email=fixture@local.invalid commit --quiet --allow-empty -m fixture-baseline",
  ]) {
    const result = await command.run({ command: gitCommand, cwd: ".", timeoutMs: 20_000 }, context);
    if (!result.ok || result.data.exitCode !== 0) return false;
  }
  return true;
}

function runtimeStatus(state: AiCoderRunResult["state"]): FixtureStatus {
  return state === "cancelled" ? "canceled" : state;
}

async function snapshotWorkspace(workspaceRoot: string): Promise<WorkspaceState> {
  const entries = new Map<string, WorkspaceStateEntry>();
  const visit = async (absoluteDirectory: string): Promise<void> => {
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      if (child.isDirectory() && SNAPSHOT_IGNORED_DIRECTORIES.has(child.name)) continue;
      if (child.name.endsWith(".galaxy-code.lock")) continue;
      const absolutePath = join(absoluteDirectory, child.name);
      const path = relative(workspaceRoot, absolutePath).split("\\").join("/");
      if (child.isDirectory()) {
        entries.set(path, Object.freeze({ contentHash: sha256Text("directory\0"), kind: "directory" }));
        await visit(absolutePath);
      } else if (child.isFile()) {
        entries.set(path, Object.freeze({
          contentHash: createHash("sha256").update(await readFile(absolutePath)).digest("hex"),
          kind: "file",
        }));
      } else if (child.isSymbolicLink()) {
        entries.set(path, Object.freeze({
          contentHash: sha256Text(`symlink\0${await readlink(absolutePath)}`),
          kind: "symlink",
        }));
      } else {
        const info = await lstat(absolutePath);
        entries.set(path, Object.freeze({
          contentHash: sha256Text(`other\0${String(info.mode)}`),
          kind: "other",
        }));
      }
    }
  };
  await visit(workspaceRoot);
  return entries;
}

function changedWorkspacePaths(before: WorkspaceState, after: WorkspaceState): readonly string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return Object.freeze([...paths].filter((path) => {
    const previous = before.get(path);
    const current = after.get(path);
    return previous?.kind !== current?.kind || previous?.contentHash !== current?.contentHash;
  }).sort());
}

function eventControlKind(event: AiCoderRuntimeEvent): DeterministicFixture["controls"] extends readonly (infer T)[] | undefined
  ? T extends { event: infer E } ? E : never
  : never {
  return event.type === "context_pressure" || event.type === "model" || event.type === "tool_result" || event.type === "tool_start"
    ? event.type
    : "model";
}

function createRunRequest(
  fixture: DeterministicFixture,
  options: DeterministicRunOptions,
  runId: string,
  taskId: string,
  mode: NonNullable<DeterministicFixture["mode"]>,
  networkAccess: "allowed" | "denied",
  hostEnvironment: AiCoderHostEnvironment,
): AiCoderRunRequest {
  const explicitBudget = fixture.runtime?.budget ?? {};
  const derivedMaxTurns = Math.max(1, fixture.rounds.length + Math.max(0, (fixture.runtime?.resume?.maxExecutions ?? 1) - 1));
  const toolCalls = fixture.rounds.reduce((sum, round) => sum + (round.toolCalls?.length ?? 0), 0);
  const complexity = fixture.rounds.length <= 3 ? "simple" as const : fixture.rounds.length <= 8 ? "standard" as const : "complex" as const;
  return Object.freeze({
    ...(fixture.acceptanceCriteria === undefined ? {} : {
      acceptanceCriteria: Object.freeze(fixture.acceptanceCriteria.map((criterion) => Object.freeze({
        id: criterion.id,
        text: criterion.text,
        ...(criterion.required === undefined ? {} : { required: criterion.required }),
      }))),
    }),
    budget: Object.freeze({
      deadlineMs: explicitBudget.deadlineMs ?? 60_000,
      maxCompletionRejections: explicitBudget.maxCompletionRejections ?? 2,
      maxModelRetries: explicitBudget.maxModelRetries ?? 1,
      ...(explicitBudget.modelRetryDelaysMs === undefined ? {} : { modelRetryDelaysMs: explicitBudget.modelRetryDelaysMs }),
      maxToolCalls: explicitBudget.maxToolCalls ?? Math.max(16, toolCalls + 8),
      maxTurns: explicitBudget.maxTurns ?? derivedMaxTurns,
      ...(explicitBudget.persistenceGraceMs === undefined ? {} : { persistenceGraceMs: explicitBudget.persistenceGraceMs }),
      ...(explicitBudget.toolOutput === undefined ? {} : { toolOutput: explicitBudget.toolOutput }),
    }),
    completion: Object.freeze({
      requireFinalReportPersistence: fixture.runtime?.completion?.requireFinalReportPersistence ?? true,
      requireInspection: fixture.runtime?.completion?.requireInspection ?? true,
      requireTokenLedger: fixture.runtime?.completion?.requireTokenLedger ?? true,
      requireTrace: fixture.runtime?.completion?.requireTrace ?? true,
      ...(fixture.runtime?.completion?.requireValidation === undefined
        ? {}
        : { requireValidation: fixture.runtime.completion.requireValidation }),
    }),
    ...(fixture.constraints === undefined ? {} : { constraints: fixture.constraints }),
    goal: options.taskOverride ?? fixture.task,
    mode,
    prompt: Object.freeze({
      approvalProfile: fixture.runtime?.approvalProfile ?? "balanced",
      complexity,
      dirtyStateSummary: "Fixture workspace prepared from deterministic initial files.",
      hostEnvironment,
      networkAccess,
      ...(fixture.workspaceInstructions === undefined ? {} : {
        trustedWorkspaceInstructions: Object.freeze(fixture.workspaceInstructions.map((content, index) => Object.freeze({
          content,
          source: `fixture.workspaceInstructions[${index}]`,
        }))),
      }),
      writeAccess: mode === "review_only" || mode === "validate_only" ? "denied" as const : "allowed" as const,
    }),
    runId,
    taskId,
    tokenProfile: fixture.runtime?.tokenProfile ?? "balanced",
    workspaceRoot: options.workspacePath,
  });
}

function tamperCheckpoint(checkpoint: AiCoderRunCheckpoint): AiCoderRunCheckpoint {
  return Object.freeze({
    ...structuredClone(checkpoint),
    nextAction: `${checkpoint.nextAction} [tampered by fixture]`,
  });
}

async function checkpointsAreValid(checkpoints: readonly AiCoderRunCheckpoint[]): Promise<boolean> {
  const { assertAiCoderRunCheckpoint } = await import("@galaxy-stack/ai-coder-core");
  for (const checkpoint of checkpoints) {
    try {
      await assertAiCoderRunCheckpoint(checkpoint);
    } catch {
      return false;
    }
  }
  return true;
}

async function assertFixture(
  fixture: DeterministicFixture,
  report: Omit<DeterministicRunReport, "failures" | "passed" | "replayHash">,
  workspace: NodeWorkspacePort,
  context: ToolExecutionContext,
  initialState: WorkspaceState,
  finalState: WorkspaceState,
): Promise<readonly string[]> {
  const failures: string[] = [];
  const expectedStatus = fixture.expected?.status ?? "completed";
  if (report.status !== expectedStatus) failures.push(`Expected status ${expectedStatus}, received ${report.status}.`);
  if (fixture.expected?.errorCode !== undefined) {
    const actual = report.error?.code ?? null;
    if (actual !== fixture.expected.errorCode) failures.push(`Expected error ${String(fixture.expected.errorCode)}, received ${String(actual)}.`);
  }
  if (fixture.expected?.executionStatuses !== undefined) {
    const expected = JSON.stringify(fixture.expected.executionStatuses);
    const actual = JSON.stringify(report.executionStatuses);
    if (expected !== actual) failures.push(`Expected execution statuses ${expected}, received ${actual}.`);
  }
  if (fixture.expected?.toolSequence !== undefined) {
    const expected = JSON.stringify(fixture.expected.toolSequence);
    const actual = JSON.stringify(report.toolSequence);
    if (expected !== actual) failures.push(`Expected tool sequence ${expected}, received ${actual}.`);
  }
  if (fixture.expected?.toolResults !== undefined) {
    if (fixture.expected.toolResults.length !== report.toolResults.length) {
      failures.push(`Expected ${fixture.expected.toolResults.length} tool results, received ${report.toolResults.length}.`);
    }
    for (const [index, expected] of fixture.expected.toolResults.entries()) {
      const actual = report.toolResults[index];
      if (actual === undefined) continue;
      if (expected.toolName !== undefined && actual.toolName !== expected.toolName) failures.push(`Tool result ${index + 1} name mismatch.`);
      if (expected.canonicalToolId !== undefined && actual.canonicalToolId !== expected.canonicalToolId) failures.push(`Tool result ${index + 1} canonical id mismatch.`);
      if (expected.ok !== undefined && actual.ok !== expected.ok) failures.push(`Tool result ${index + 1} ok mismatch.`);
      if (expected.errorCode !== undefined && (actual.error?.code ?? null) !== expected.errorCode) failures.push(`Tool result ${index + 1} error code mismatch.`);
      if (expected.summaryIncludes !== undefined && !actual.summary.includes(expected.summaryIncludes)) failures.push(`Tool result ${index + 1} summary lacks ${JSON.stringify(expected.summaryIncludes)}.`);
      for (const fragment of expected.contentIncludes ?? []) {
        if (!actual.content.includes(fragment)) failures.push(`Tool result ${index + 1} content lacks ${JSON.stringify(fragment)}.`);
      }
    }
  }
  for (const expectedFile of fixture.expected?.files ?? []) {
    const read = await workspace.readText({ path: expectedFile.path, maxBytes: 128_000 }, context);
    if (expectedFile.absent === true) {
      if (read.ok || read.error.code !== "NOT_FOUND") failures.push(`Expected file '${expectedFile.path}' to be absent.`);
      continue;
    }
    if (!read.ok) {
      failures.push(`Expected file '${expectedFile.path}' is unreadable: ${read.error.code}.`);
      continue;
    }
    if (expectedFile.content !== undefined && read.data.content !== expectedFile.content) failures.push(`File '${expectedFile.path}' content does not match the fixture.`);
    for (const fragment of expectedFile.contentIncludes ?? []) {
      if (!read.data.content.includes(fragment)) failures.push(`File '${expectedFile.path}' does not include ${JSON.stringify(fragment)}.`);
    }
    if (expectedFile.unchanged === true) {
      const before = initialState.get(expectedFile.path);
      const after = finalState.get(expectedFile.path);
      if (before === undefined || after === undefined || before.kind !== after.kind || before.contentHash !== after.contentHash) {
        failures.push(`File '${expectedFile.path}' was expected to remain byte-identical.`);
      }
    }
  }
  if (fixture.expected?.allowedChanges !== undefined) {
    const expected = JSON.stringify([...fixture.expected.allowedChanges].sort());
    const actual = JSON.stringify(changedWorkspacePaths(initialState, finalState));
    if (expected !== actual) failures.push(`Expected changed paths ${expected}, received ${actual}.`);
  }
  if (report.status === "completed") {
    const latestWriteByPath = new Map(report.writes.map((write) => [write.path, write]));
    for (const path of changedWorkspacePaths(initialState, finalState)) {
      const before = initialState.get(path);
      const after = finalState.get(path);
      const exact = latestWriteByPath.get(path);
      const directoryStructureCovered = (before?.kind === "directory" || after?.kind === "directory")
        && [...latestWriteByPath.keys()].some((writePath) => writePath.startsWith(`${path}/`));
      if (exact === undefined && !directoryStructureCovered) {
        failures.push(`Completed run changed '${path}' without trusted mutation evidence.`);
        continue;
      }
      if (exact === undefined) continue;
      const expectedAfterKind = exact.afterKind ?? (exact.afterHash === null ? "missing" : "file");
      const actualAfterKind = after?.kind ?? "missing";
      if (expectedAfterKind !== actualAfterKind) {
        failures.push(`Mutation evidence for '${path}' ended as ${expectedAfterKind}, workspace ended as ${actualAfterKind}.`);
      }
      if (exact.afterHash !== null && after?.contentHash !== exact.afterHash) {
        failures.push(`Mutation evidence hash for '${path}' does not match final workspace bytes.`);
      }
    }
  }
  for (const fragment of fixture.expected?.finalResponseIncludes ?? []) {
    if (!report.finalResponse.includes(fragment)) failures.push(`Final response does not include ${JSON.stringify(fragment)}.`);
  }
  for (const fragment of fixture.expected?.finalResponseExcludes ?? []) {
    if (report.finalResponse.includes(fragment)) failures.push(`Final response unexpectedly includes ${JSON.stringify(fragment)}.`);
  }
  if (fixture.expected?.checkpointReasons !== undefined) {
    const expected = JSON.stringify(fixture.expected.checkpointReasons);
    const actual = JSON.stringify(report.checkpointReasons);
    if (expected !== actual) failures.push(`Expected checkpoint reasons ${expected}, received ${actual}.`);
  }
  for (const issue of fixture.expected?.completionIssuesInclude ?? []) {
    if (!report.completionRejections.some((rejection) => rejection.some((item) => item.includes(issue)))) {
      failures.push(`Completion rejection does not include ${JSON.stringify(issue)}.`);
    }
  }
  if (fixture.expected?.contextPressures !== undefined) {
    const expected = JSON.stringify(fixture.expected.contextPressures);
    const actual = JSON.stringify(report.contextPressures);
    if (expected !== actual) failures.push(`Expected context pressures ${expected}, received ${actual}.`);
  }
  if (fixture.expected?.modelRequestCount !== undefined && report.modelRequestCount !== fixture.expected.modelRequestCount) {
    failures.push(`Expected ${fixture.expected.modelRequestCount} model requests, received ${report.modelRequestCount}.`);
  }
  if (fixture.expected?.retryDelaysMs !== undefined) {
    const expected = JSON.stringify(fixture.expected.retryDelaysMs);
    const actual = JSON.stringify(report.retryDelaysMs);
    if (expected !== actual) failures.push(`Expected retry delays ${expected}, received ${actual}.`);
  }
  if (fixture.expected?.allModelStepsConsumed !== undefined
    && report.allModelStepsConsumed !== fixture.expected.allModelStepsConsumed) {
    failures.push(
      `Expected allModelStepsConsumed=${String(fixture.expected.allModelStepsConsumed)}, received ${String(report.allModelStepsConsumed)} `
      + `(${report.modelRoundsConsumed}/${fixture.rounds.length} rounds and `
      + `${report.modelTokenCountStepsConsumed}/${fixture.model?.tokenCountSteps?.length ?? 0} token-count steps).`,
    );
  }
  if (report.controlsFired !== (fixture.controls?.length ?? 0)) {
    failures.push(`Expected all ${fixture.controls?.length ?? 0} fixture controls to fire, received ${report.controlsFired}.`);
  }
  if (fixture.expected?.minTraceEvents !== undefined && report.traceEvents < fixture.expected.minTraceEvents) {
    failures.push(`Expected at least ${fixture.expected.minTraceEvents} trace events, received ${report.traceEvents}.`);
  }
  for (const kind of fixture.expected?.traceKindsInclude ?? []) {
    if (!report.traceKinds.includes(kind)) failures.push(`Trace does not include kind '${kind}'.`);
  }
  for (const transition of fixture.expected?.transitionsInclude ?? []) {
    if (!report.transitions.includes(transition)) failures.push(`Transitions do not include '${transition}'.`);
  }
  if (!report.checkpointsValid) failures.push("At least one persisted checkpoint failed integrity validation.");
  return Object.freeze(failures);
}

export async function runDeterministicFixture(options: DeterministicRunOptions): Promise<DeterministicRunReport> {
  const fixture = options.fixture;
  const mode = fixture.mode ?? "auto";
  const runId = runIdForFixture(fixture);
  const taskId = `fixture:${fixture.name}`;
  const workspace = await NodeWorkspacePort.create(options.workspacePath);
  const workspaceEvidenceVerifier = await NodeWorkspaceEvidenceVerifier.create(options.workspacePath);
  const command = await NodeCommandPort.create(options.workspacePath, {
    containment: fixture.runtime?.commandContainment ?? "best_effort",
  });
  const setupSignal = options.signal ?? new AbortController().signal;
  const setup = setupContext(runId, taskId, mode, options.workspacePath, setupSignal, fixture.runtime?.budget?.deadlineMs ?? 60_000);
  await arrangeFiles(fixture.initialFiles ?? [], workspace, setup);
  const enableGit = await initializeGitBaseline(workspace, command, setup);
  const initialState = await snapshotWorkspace(options.workspacePath);
  const model = new ScriptedCodingModel(fixture.rounds, fixture.model ?? {});
  const createExecutor = (checkpoint?: AiCoderRunCheckpoint) => {
    const taskCheckpointStore = new Map<string, LabTaskCheckpointState>();
    if (checkpoint !== undefined) {
      taskCheckpointStore.set(runId, Object.freeze({
        decisions: Object.freeze([...checkpoint.decisions]),
        goal: checkpoint.goal,
        nextStep: checkpoint.nextAction,
        progress: JSON.stringify(checkpoint.plan),
        updatedAt: checkpoint.createdAt,
      }));
    }
    return new LabToolExecutor({
      approval: createFixtureApprovalPort(fixture.approvalDecisions),
      approvalProfile: fixture.runtime?.approvalProfile ?? "balanced",
      capabilities: model.capabilitiesSnapshot,
      command,
      enableGit,
      taskCheckpointStore,
      toolProfile: fixture.runtime?.toolProfile === "full_contract" ? "full_contract" : "default",
      workspace,
    });
  };
  let executor = createExecutor();
  const provisionalContext: RunExecutionContext = Object.freeze({
    deadline: setup.deadline,
    mode,
    runId,
    signal: setup.signal,
    taskId,
    workspaceRoot: options.workspacePath,
  });
  await executor.getToolSet(provisionalContext);
  const events: AiCoderRuntimeEvent[] = [];
  const retryDelays: number[] = [];
  const trace = new MemoryTracePort();
  const store = new MemoryRunStore();
  const controlOccurrences = new Map<string, number>();
  const firedControls = new Set<number>();
  let activeHandle: AiCoderRunHandle | null = null;
  let executionCounter = 0;
  const createController = (toolExecutor: LabToolExecutor) => new AiCoderRunController({
    clock: Object.freeze({ now: Date.now, timestamp: () => "1970-01-01T00:00:00.000Z" }),
    executionIdFactory: () => `fixture-execution-${++executionCounter}`,
    idFactory: () => runId,
    model,
    onEvent: (event) => {
      events.push(event);
      if (!(event.type === "context_pressure" || event.type === "model" || event.type === "tool_result" || event.type === "tool_start")) return;
      const key = eventControlKind(event);
      const occurrence = (controlOccurrences.get(key) ?? 0) + 1;
      controlOccurrences.set(key, occurrence);
      fixture.controls?.forEach((control, index) => {
        if (firedControls.has(index) || control.event !== key || control.occurrence !== occurrence) return;
        firedControls.add(index);
        if (control.action === "cancel") activeHandle?.cancel(`Fixture control ${index + 1} canceled the run.`);
        else activeHandle?.pause(`Fixture control ${index + 1} paused the run.`);
      });
    },
    resumeWorkspaceVerifier: workspaceEvidenceVerifier,
    sleep: async (milliseconds, signal) => {
      retryDelays.push(milliseconds);
      if (signal.aborted) throw signal.reason;
    },
    store,
    toolExecutor,
    trace,
  });
  let controller = createController(executor);
  const request = createRunRequest(
    fixture,
    options,
    runId,
    taskId,
    mode,
    command.containmentStatus.network === "denied" ? "denied" : "allowed",
    command.hostEnvironment,
  );
  const results: AiCoderRunResult[] = [];
  const awaitHandle = async (handle: AiCoderRunHandle): Promise<AiCoderRunResult> => {
    activeHandle = handle;
    const cancel = () => handle.cancel("Fixture run canceled by the CLI host.");
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      return await handle.result;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      activeHandle = null;
    }
  };
  results.push(await awaitHandle(controller.start(request)));
  const resume = fixture.runtime?.resume;
  while (resume !== undefined && results.length < resume.maxExecutions) {
    const previous = results.at(-1);
    if (previous === undefined || runtimeStatus(previous.state) !== resume.on || previous.checkpoint === null) break;
    await arrangeFiles(resume.mutateBeforeResume ?? [], workspace, setup);
    const checkpoint = resume.tamperCheckpoint === true ? tamperCheckpoint(previous.checkpoint) : previous.checkpoint;
    if (resume.recreateHost === true) {
      executor = createExecutor(checkpoint);
      controller = createController(executor);
    }
    const { runId: _runId, ...resumeRequest } = request;
    results.push(await awaitHandle(controller.resume(Object.freeze({
      ...resumeRequest,
      checkpoint,
      checkpointTrust: "trusted_host" as const,
      runId,
    }))));
  }
  const result = results.at(-1);
  if (result === undefined) throw new Error("Fixture produced no run result.");
  const toolSequence = Object.freeze(events
    .filter((event): event is Extract<AiCoderRuntimeEvent, { type: "tool_start" }> => event.type === "tool_start")
    .map((event) => event.call.name));
  const toolResults = Object.freeze(events
    .filter((event): event is Extract<AiCoderRuntimeEvent, { type: "tool_result" }> => event.type === "tool_result")
    .map((event): DeterministicToolResultReport => Object.freeze({
      canonicalToolId: event.result.canonicalToolId,
      content: event.result.content,
      error: event.result.error === undefined
        ? null
        : Object.freeze({ code: event.result.error.code, message: event.result.error.message }),
      ok: event.result.ok,
      summary: event.result.summary,
      toolName: event.call.name,
    })));
  const transitions = Object.freeze(results.flatMap((execution) => execution.transitions.map((transition) => `${transition.from}->${transition.to}`)));
  const checkpointHistory = store.checkpointHistory;
  const traceEvents = trace.events;
  const checkpointReasons = Object.freeze(checkpointHistory.map((checkpoint) => checkpoint.reason));
  const checkpointAudits = Object.freeze(checkpointHistory.map((checkpoint): DeterministicCheckpointAudit => Object.freeze({
    activeToolNames: Object.freeze([...checkpoint.compatibility.activeToolNames]),
    compactionCount: checkpoint.totals.compactionCount,
    contentHash: checkpoint.contentHash,
    diffReviewed: checkpoint.completionEvidence.diffReview !== null,
    editPaths: Object.freeze(checkpoint.edits.map((edit) => edit.path)),
    modelTurns: checkpoint.totals.modelTurns,
    reason: checkpoint.reason,
    toolCalls: checkpoint.totals.toolCalls,
    validationIds: Object.freeze(checkpoint.validation.map((validation) => validation.id)),
  })));
  const requestContainsTask = (requestIndex: number) => model.requests[requestIndex]?.messages
    .some((message) => message.content.includes(request.goal)) === true;
  const modelContextAudit = Object.freeze({
    allRequestsContainTask: model.requests.length > 0
      && model.requests.every((_request, index) => requestContainsTask(index)),
    observedCheckpointHashes: Object.freeze(checkpointHistory
      .filter((checkpoint) => model.requests.some((request) => request.messages
        .some((message) => message.content.includes(checkpoint.contentHash))))
      .map((checkpoint) => checkpoint.contentHash)),
  } satisfies DeterministicModelContextAudit);
  const contextPressures = Object.freeze(events
    .filter((event): event is Extract<AiCoderRuntimeEvent, { type: "context_pressure" }> => event.type === "context_pressure")
    .map((event) => event.pressure));
  const completionRejections = Object.freeze(events
    .filter((event): event is Extract<AiCoderRuntimeEvent, { type: "completion_rejected" }> => event.type === "completion_rejected")
    .map((event) => Object.freeze([...event.issues])));
  const finalState = await snapshotWorkspace(options.workspacePath);
  const preliminary = Object.freeze({
    allModelStepsConsumed: model.consumedRounds === fixture.rounds.length
      && model.consumedTokenCountSteps === (fixture.model?.tokenCountSteps?.length ?? 0),
    checkpointAudits,
    checkpointReasons,
    checkpointsValid: await checkpointsAreValid(checkpointHistory),
    commandContainment: command.containmentStatus,
    completionRejections,
    controlsFired: firedControls.size,
    contextPressures,
    error: result.error,
    executionStatuses: Object.freeze(results.map((execution) => runtimeStatus(execution.state))),
    finalResponse: result.content,
    fixture: fixture.name,
    modelContextAudit,
    modelRequestCount: model.requests.length,
    modelRoundsConsumed: model.consumedRounds,
    modelTokenCountStepsConsumed: model.consumedTokenCountSteps,
    retryDelaysMs: Object.freeze(retryDelays),
    runId: result.runId,
    status: runtimeStatus(result.state),
    toolSequence,
    toolResults,
    traceEvents: traceEvents.length,
    traceFlushes: trace.flushCount,
    traceKinds: Object.freeze(traceEvents.map((event) => event.kind)),
    transitions,
    validation: result.validation,
    workspacePath: options.workspacePath,
    writes: result.writes,
  } satisfies Omit<DeterministicRunReport, "failures" | "passed" | "replayHash">);
  const failures = await assertFixture(fixture, preliminary, workspace, setup, initialState, finalState);
  const checkpointReplayAudits = checkpointAudits.map(({ contentHash: _contentHash, ...audit }) => audit);
  const modelContextReplayAudit = Object.freeze({
    allRequestsContainTask: modelContextAudit.allRequestsContainTask,
    observedCheckpointCount: modelContextAudit.observedCheckpointHashes.length,
  });
  const replayHash = `sha256:${sha256Text(JSON.stringify({
    allModelStepsConsumed: preliminary.allModelStepsConsumed,
    checkpointAudits: checkpointReplayAudits,
    checkpointReasons,
    completionRejections,
    controlsFired: preliminary.controlsFired,
    contextPressures,
    errorCode: result.error?.code ?? null,
    executionStatuses: preliminary.executionStatuses,
    finalResponse: result.content,
    fixture: fixture.name,
    modelContextAudit: modelContextReplayAudit,
    modelRequestCount: model.requests.length,
    modelRoundsConsumed: model.consumedRounds,
    modelTokenCountStepsConsumed: model.consumedTokenCountSteps,
    runId: result.runId,
    status: runtimeStatus(result.state),
    toolResults: toolResults.map((item) => ({
      canonicalToolId: item.canonicalToolId,
      errorCode: item.error?.code ?? null,
      ok: item.ok,
      toolName: item.toolName,
    })),
    transitions,
    validation: result.validation.map((item) => ({ id: item.id, status: item.status })),
    writes: result.writes.map((item) => ({
      afterHash: item.afterHash,
      afterKind: item.afterKind,
      beforeHash: item.beforeHash,
      beforeKind: item.beforeKind,
      path: item.path,
      toolCallId: item.toolCallId,
    })),
  }))}`;
  return Object.freeze({
    ...preliminary,
    failures,
    passed: failures.length === 0,
    replayHash,
  });
}
