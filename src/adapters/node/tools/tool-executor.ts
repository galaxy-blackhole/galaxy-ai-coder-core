import { DEFAULT_CODE_RUN_LIMITS, type CodeRunEvent, type CodeRunLimits, type CodeRuntimePort } from "../../../ports/code-runtime-port.js";
import {
  AiCoderTokenEstimator,
  AiCoderToolRegistry,
  createAiCoderCoreToolEffectMetadata,
  createAiCoderApprovalPolicy,
  createAiCoderToolRegistrySnapshot,
  clampAiCoderJsonSchemaNumbers,
  validateAiCoderJsonSchema,
  type AiCoderApprovalProfile,
  type AiCoderRuntimeFailureEffects,
  type AiCoderRuntimeToolEffects,
  type AiCoderRuntimeToolExecutor,
  type AiCoderRuntimeToolResult,
  type AiCoderToolDescriptor,
  type ApprovalPort,
  type CodingToolCall,
  type CommandRunnerPort,
  type ModelCapabilities,
  type PortError,
  type PortErrorCode,
  type PortResult,
  type ResearchPort,
  type RunExecutionContext,
  type ToolExecutionContext,
  type WorkspacePort,
} from "../../../index.js";
import { posix, resolve } from "node:path";
import { JobRegistry, type JobRow } from "../host/job-registry.js";
import { GoalStore } from "../../../runtime/goal-store.js";
import { SubagentRegistry } from "../../../runtime/subagent-registry.js";
import { readHookConfig, runToolHooks, type HookConfig } from "../../../runtime/hooks.js";
import { addReminder, readReminders, removeReminder, writeReminders } from "../../../runtime/reminders.js";
import { formatSkillList, readWorkspaceSkills } from "../../../runtime/skills.js";
import type { AiCoderPlanStep } from "../../../runtime/runtime-types.js";
import { parsePlanSteps } from "../../../runtime/plan.js";
import type { PlanStepInput } from "../../../runtime/plan.js";

import { sha256Text } from "../host/content-hash.js";
import {
  DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS,
  diffNodeWorkspaceSnapshots,
  NodeWorkspaceSnapshotter,
  type NodeWorkspaceMutationDiff,
  type NodeWorkspaceSnapshot,
  type NodeWorkspaceSnapshotOptions,
} from "../host/node-workspace-snapshot.js";
import { detectProject, validateProject, type ProjectCheck } from "../host/project-tools.js";
import { dependencyShellReadAdvisory, serverCommandAdvisory, validationCommandAdvisory } from "../../../tools/command-shape.js";
import { validationScopeForProjectPath } from "../../../tools/validation-scope.js";
export class ContractToolError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly suggestedAction?: string) { super(message); }
}
export interface ContractToolPort {
  execute(id: string, args: Readonly<Record<string, unknown>>, context: RunExecutionContext): Promise<DispatchResult>;
}

export const LAB_AVAILABLE_TOOL_IDS = Object.freeze([
  "catalog.search",
  "task.checkpoint",
  /*
   * The reference gives its agent a shell and a writer; ours also carries a reader, a searcher and a git tool.
   * Removing them was tried and had to be undone: the completion gate expects a run to have looked at the project,
   * so a tool set that can only write fails the gate with NO_PROGRESS. The trim belongs with the gate, not before it.
   */
  "workspace.list",
  "workspace.glob",
  "workspace.grep",
  "workspace.read",
  "workspace.edit",
  "workspace.write",
  "command.run",
  "job.list",
  "job.output",
  "job.kill",
  "goal.create",
  "goal.get",
  "goal.update",
  "subagent.spawn",
  "subagent.list",
  "subagent.send",
  "subagent.interrupt",
  "project.detect",
  "project.validate",
  /*
   * No git tool. The reference has none: inspecting a repository is a command, and a tool that guesses which
   * directory to run in guesses wrong — which is exactly how `fatal: not a git repository` reached the transcript
   * of a workspace whose repositories live one level down.
   */
] as const);

export const LAB_GRANTED_PERMISSIONS = Object.freeze([
  "core.storage",
  "fs.workspace",
  "process.execute",
] as const);

export const LAB_RESEARCH_TOOL_IDS = Object.freeze(["research.search", "research.fetch"] as const);

export const LAB_OPTIONAL_CONTRACT_TOOL_IDS = Object.freeze([
  "research.fetch",
  "research.search",
  "command.session",
  "preview.manage",
  "perception.analyze",
  "artifact.create",
  "artifact.list",
  "artifact.read",
  "user.ask",
] as const);

export const LAB_FULL_CONTRACT_TOOL_IDS = Object.freeze([
  ...LAB_AVAILABLE_TOOL_IDS,
  ...LAB_OPTIONAL_CONTRACT_TOOL_IDS,
] as const);

export const LAB_FULL_CONTRACT_PERMISSIONS = Object.freeze([
  ...LAB_GRANTED_PERMISSIONS,
  "core.artifacts",
  "network.outbound",
  "preview.local",
  "user.interaction",
] as const);

type JsonObject = Readonly<Record<string, unknown>>;

const RECOVERABLE_READ_ERROR_CODES: ReadonlySet<PortErrorCode> = new Set([
  "ALREADY_EXISTS", "CANCELED", "CONFLICT", "DEADLINE_EXCEEDED", "INVALID_INPUT",
  "IO_ERROR", "LIMIT_EXCEEDED", "NOT_FOUND", "PERMISSION_DENIED", "PRECONDITION_FAILED",
  "UNAVAILABLE", "UNSUPPORTED",
]);

function recoverableReadError(error: unknown): Readonly<{
  code: PortErrorCode;
  message: string;
  retryable: boolean;
}> | null {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return null;
  const code = error.code as PortErrorCode;
  if (!RECOVERABLE_READ_ERROR_CODES.has(code)) return null;
  return Object.freeze({
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: code === "IO_ERROR" || code === "UNAVAILABLE",
  });
}

export interface LabTaskCheckpointState {
  readonly decisions: readonly string[];
  readonly goal: string;
  readonly nextStep: string;
  readonly steps?: readonly AiCoderPlanStep[];
  readonly progress: string;
  readonly updatedAt: string;
}

export interface LabTaskCheckpointStore {
  get(runId: string): LabTaskCheckpointState | undefined;
  set(runId: string, checkpoint: LabTaskCheckpointState): unknown;
}

type DispatchResult = Readonly<{
  effects?: AiCoderRuntimeToolEffects;
  output: JsonObject;
  summary: string;
  trust: AiCoderRuntimeToolResult["trust"];
}>;

class ToolAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly suggestedAction?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ToolAdapterError";
  }
}

/**
 * A mutation could not be verified: the write may have landed, but its evidence did not apply.
 *
 * This used to be a plain Error, which the runtime reads as an unknown outcome and turns into a
 * fatal stop. Measured: a NestJS run lost steps 2, 5 and 11 that way (validate_project, write_file,
 * edit_file) while a background npm install kept rewriting the workspace. It is now a retryable
 * ToolAdapterError with an explicit instruction, so the model reads the failure, checks the file
 * and decides whether to retry instead of the whole run dying.
 */
class UnknownSideEffectOutcomeError extends ToolAdapterError {
  constructor(message: string, options?: ErrorOptions) {
    super(
      "CONFLICT",
      message + " Việc ghi có thể đã xảy ra một phần: hãy đọc lại file để kiểm tra rồi thử lại.",
      true,
    );
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    this.name = "UnknownSideEffectOutcomeError";
  }
}

function assertTargetMutation(
  canonicalToolId: "workspace.edit" | "workspace.write",
  mutations: NodeWorkspaceMutationDiff,
  expected: Readonly<{
    afterHash: string;
    beforeHash: string | null;
    path: string;
  }>,
): void {
  const expectedBeforeKind = expected.beforeHash === null ? "missing" : "file";
  const durable = mutations.writes.find((write) => write.path === expected.path);
  if (durable !== undefined
    && durable.beforeKind === expectedBeforeKind
    && durable.afterKind === "file"
    && durable.beforeHash === expected.beforeHash
    && durable.afterHash === expected.afterHash) {
    return;
  }
  // A write into generated state (for example .galaxy/workspace.json) is observed
  // as a derived mutation: the snapshot keeps metadata fingerprints instead of a
  // content hash, so attest the observed change rather than a durable write.
  const derived = mutations.observedMutations.find(
    (mutation) => mutation.path === expected.path && mutation.evidenceClass === "derived",
  );
  if (derived !== undefined
    && derived.afterKind === "file"
    && derived.beforeFingerprint !== derived.afterFingerprint) {
    return;
  }
  throw new UnknownSideEffectOutcomeError(
    `${canonicalToolId} returned success, but its target mutation does not match the independent workspace snapshot.`,
  );
}

function structuredMutationFailure(
  canonicalToolId: "workspace.edit" | "workspace.write",
  mutations: NodeWorkspaceMutationDiff,
  error: PortError,
): never {
  if (mutations.observedMutations.length > 0) {
    throw new UnknownSideEffectOutcomeError(
      `${canonicalToolId} returned ${error.code} after changing ${mutations.observedMutations.length} workspace path(s); side-effect outcome is unknown.`,
    );
  }
  throw new ToolAdapterError(error.code, error.message, error.retryable, error.suggestedAction);
}

const MAX_REPORTED_DERIVED_MUTATIONS = 32;

function derivedMutationObservation(mutations: NodeWorkspaceMutationDiff): JsonObject | undefined {
  const paths = mutations.observedMutations
    .filter((mutation) => mutation.evidenceClass === "derived")
    .map((mutation) => mutation.path);
  if (paths.length === 0) return undefined;
  return Object.freeze({
    count: paths.length,
    paths: Object.freeze(paths.slice(0, MAX_REPORTED_DERIVED_MUTATIONS)),
    truncated: paths.length > MAX_REPORTED_DERIVED_MUTATIONS,
  });
}

function mutationEffects(mutations: NodeWorkspaceMutationDiff): AiCoderRuntimeToolEffects | undefined {
  if (mutations.observedMutations.length === 0) return undefined;
  return Object.freeze({
    stateVersion: mutations.stateVersion,
    ...(mutations.writes.length === 0 ? {} : { writes: mutations.writes }),
  });
}

function portData<T>(result: PortResult<T>): T {
  if (result.ok) return result.data;
  const error: PortError = result.error;
  const status = error.details && typeof error.details === "object"
    && Number.isInteger((error.details as Readonly<{ status?: unknown }>).status)
    ? (error.details as Readonly<{ status: number }>).status
    : undefined;
  throw new ToolAdapterError(error.code, error.message, error.retryable, error.suggestedAction, status);
}

export interface NodeToolExecutorOptions {
  readonly approval?: ApprovalPort;
  readonly approvalProfile?: AiCoderApprovalProfile;
  readonly approvalTimeoutMs?: number;
  /**
   * Permission ids a preset adds on top of the granted baseline. A preset that says it holds the workspace should
   * actually hold it; a name that grants nothing is a label, and labels are how settings drift from behaviour.
   */
  readonly presetPermissions?: readonly string[];
  /** Told whenever the background book changes, so the host can put the list on screen. */
  readonly onJobsChanged?: (rows: readonly JobRow[]) => void;
  /** The child-agent seam, supplied by the host that can build a child run; absent leaves the tools refusing. */
  readonly subagents?: SubagentRegistry;
  readonly capabilities: ModelCapabilities;
  /** Composed by the host when a session may run in tools mode ptc; absent means run_code is unavailable. */
  readonly codeRuntime?: CodeRuntimePort;
  /**
   * How the round presents its tools. It matters here, not only in the controller: a `ptc` round offers the model
   * nothing but `run_code`, and that entry tool is not enabled by default, so the registry has to hold it open or
   * the model is handed a tool the registry then refuses to run.
   */
  readonly toolPresentation?: "native" | "ptc" | "both";
  readonly codeLimits?: Partial<CodeRunLimits>;
  /**
   * Where a program's inner calls are reported. The host turns these into the same transcript rows a direct call
   * would produce, so a `ptc` run is never less visible than a native one.
   */
  readonly onCodeEvent?: (event: CodeRunEvent) => void;
  readonly command: CommandRunnerPort;
  /** Enables deterministic contract doubles; this is not a production integration profile. */
  readonly enableContractTools?: boolean;
  readonly contractTools?: ContractToolPort;
  readonly enableGit?: boolean;
  /** Real public research adapter, available only when explicitly supplied by the host. */
  readonly research?: ResearchPort;
  /** Host-owned durable state used by task.checkpoint across executor recreation. */
  readonly taskCheckpointStore?: LabTaskCheckpointStore;
  /** Must match the host's outer workspace snapshot policy. */
  readonly workspaceSnapshot?: NodeWorkspaceSnapshotOptions;
  /** Alias for hosts that prefer an explicit named lab profile. */
  readonly toolProfile?: "default" | "full_contract";
  readonly workspace: WorkspacePort;
}

function stringArgument(argumentsValue: JsonObject, name: string, fallback?: string): string {
  const value = argumentsValue[name];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing string argument '${name}'.`);
}

function optionalString(argumentsValue: JsonObject, name: string): string | undefined {
  const value = argumentsValue[name];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(argumentsValue: JsonObject, name: string): number | undefined {
  const value = argumentsValue[name];
  return typeof value === "number" ? value : undefined;
}

function optionalBoolean(argumentsValue: JsonObject, name: string): boolean | undefined {
  const value = argumentsValue[name];
  return typeof value === "boolean" ? value : undefined;
}

/** Plan steps may arrive as shorthand strings or as objects; the parser accepts both. */
function planStepInputs(argumentsValue: JsonObject, name: string): readonly PlanStepInput[] {
  const value = argumentsValue[name];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PlanStepInput => typeof item === "string" || (item !== null && typeof item === "object" && !Array.isArray(item)));
}

function stringArray(argumentsValue: JsonObject, name: string): readonly string[] {
  const value = argumentsValue[name];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function errorResult(
  call: CodingToolCall,
  canonicalToolId: string,
  code: string,
  message: string,
  retryable = false,
  effects?: AiCoderRuntimeFailureEffects,
  suggestedAction?: string,
  status?: number,
): AiCoderRuntimeToolResult {
  const error = Object.freeze({
    code,
    message,
    retryable,
    ...(status === undefined ? {} : { status }),
    ...(suggestedAction === undefined ? {} : { suggestedAction }),
  });
  return Object.freeze({
    canonicalToolId,
    content: JSON.stringify({ ok: false, error, toolCallId: call.toolCallId }),
    error,
    ok: false,
    summary: message,
    trust: "trusted",
    ...(effects === undefined ? {} : { effects, effectsAuthority: "host" as const }),
  });
}

function normalizedProjectPath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  const relative = normalized.replace(/^\.\/+/, "").replace(/\/+$/, "");
  return relative.length === 0 ? "." : relative;
}

function gitPathArguments(paths: readonly string[], offset = 0): Readonly<{
  arguments: string;
  environment: Readonly<Record<string, string>>;
  suffix: string;
}> {
  const environment: Record<string, string> = {};
  const references = paths.map((path, index) => {
    if (path.includes("\0")) throw new ToolAdapterError("INVALID_INPUT", "Git paths must not contain a null byte.");
    const name = `GALAXY_GIT_PATH_${offset + index}`;
    environment[name] = path;
    // Environment expansion happens once, so shell metacharacters in a path
    // remain data inside the surrounding quotes instead of becoming syntax.
    return process.platform === "win32" ? `"%${name}%"` : `"\${${name}}"`;
  });
  const commandArguments = references.join(" ");
  return Object.freeze({
    arguments: commandArguments,
    environment: Object.freeze(environment),
    suffix: commandArguments.length === 0 ? "" : ` -- ${commandArguments}`,
  });
}

function gitOutputWouldBeBound(
  descriptor: AiCoderToolDescriptor,
  action: string,
  stdout: string,
  stderr: string,
): boolean {
  return Buffer.byteLength(JSON.stringify({ action, stdout, stderr, exitCode: 0, truncated: false }), "utf8")
    > descriptor.maxOutputBytes;
}

const MAX_UNTRACKED_DIFF_FILES = 256;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

function provenance(source: string, trust: "untrusted_workspace" | "untrusted_external", contentHash?: string): JsonObject {
  return Object.freeze({
    source,
    trust,
    retrievedAt: "1970-01-01T00:00:00.000Z",
    ...(contentHash === undefined ? {} : { contentHash }),
  });
}

const RESEARCH_OUTPUT_ESTIMATOR = new AiCoderTokenEstimator();

function researchOutputFits(output: JsonObject, descriptor: AiCoderToolDescriptor): boolean {
  const serialized = JSON.stringify(output);
  // Core's estimator calibrates as high as 2. Reserve that ceiling here so its
  // generic head/tail limiter never cuts a successful research JSON envelope.
  return Buffer.byteLength(serialized, "utf8") <= descriptor.maxOutputBytes
    && RESEARCH_OUTPUT_ESTIMATOR.estimateText(serialized, "json") * 2 <= descriptor.maxOutputTokens;
}

function shortenResearchText(value: string): string {
  const codePoints = Array.from(value);
  return codePoints.slice(0, Math.floor(codePoints.length * 0.75)).join("");
}

function durableResearchSummary(value: string, maxCharacters: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const bounded = Array.from(normalized).slice(0, maxCharacters).join("");
  return bounded || "Source returned no additional excerpt; retain its URL and provenance only.";
}

function researchCacheUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

export class NodeToolExecutor implements AiCoderRuntimeToolExecutor {
  private readonly approvalPolicy: ReturnType<typeof createAiCoderApprovalPolicy>;
  /** Child agents this session started, when a host gave this executor a seam to start them through. */
  private readonly subagents: SubagentRegistry | null;
  /** Goals this session recorded; they outlive the run that made them, which is the point of them. */
  private readonly goals = new GoalStore();
  /** Background work this executor started, read by the job tools. */
  private readonly jobs: JobRegistry;
  private readonly codeRuntime: CodeRuntimePort | null;
  private readonly toolPresentation: "native" | "ptc" | "both";
  private readonly onCodeEvent: ((event: CodeRunEvent) => void) | null;
  private readonly codeLimits: CodeRunLimits;
  private readonly contractTools: ContractToolPort | null;
  private readonly contractToolsEnabled: boolean;
  private readonly grantedPermissions: ReadonlySet<string>;
  private readonly idempotencyCache = new Map<string, AiCoderRuntimeToolResult>();
  private readonly researchFetchCache = new Map<string, DispatchResult>();
  private readonly researchSearchCache = new Map<string, DispatchResult>();
  private readonly taskCheckpointStore: LabTaskCheckpointStore;
  private registry: AiCoderToolRegistry | null = null;

  private async mutationBaseline(context: ToolExecutionContext): Promise<Readonly<{
    before: NodeWorkspaceSnapshot;
    snapshotter: NodeWorkspaceSnapshotter;
  }>> {
    try {
      const snapshotter = await NodeWorkspaceSnapshotter.create(
        context.workspaceRoot,
        this.options.workspaceSnapshot ?? DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS,
      );
      return Object.freeze({ before: await snapshotter.capture(context), snapshotter });
    } catch (error) {
      const known = recoverableReadError(error);
      throw new ToolAdapterError(
        known?.code ?? "IO_ERROR",
        `Unable to establish the workspace mutation baseline before tool side effects: ${
          error instanceof Error ? error.message : String(error)
        }`,
        known?.retryable ?? false,
      );
    }
  }

  constructor(private readonly options: NodeToolExecutorOptions) {
    this.contractToolsEnabled = options.contractTools !== undefined;
    this.contractTools = options.contractTools ?? null;
    /*
     * The entry tool carries its own permission names, and the profile's set uses a different namespace, so a ptc
     * round dropped the one tool it offers for missing workspace.write. Granting them alongside fs.workspace adds no
     * reach the profile did not already have: the approval policy still decides every actual write.
     */
    this.grantedPermissions = new Set([
      ...(this.contractToolsEnabled ? LAB_FULL_CONTRACT_PERMISSIONS : LAB_GRANTED_PERMISSIONS),
      ...(options.research === undefined ? [] : ["network.outbound"]),
      ...(options.toolPresentation === undefined || options.toolPresentation === "native" ? [] : ["workspace.read", "workspace.write"]),
      ...(options.presetPermissions ?? []),
    ]);
    this.taskCheckpointStore = options.taskCheckpointStore ?? new Map<string, LabTaskCheckpointState>();
    this.codeRuntime = options.codeRuntime ?? null;
    this.subagents = options.subagents ?? null;
    this.jobs = new JobRegistry(options.onJobsChanged ?? null);
    this.toolPresentation = options.toolPresentation ?? "native";
    this.onCodeEvent = options.onCodeEvent ?? null;
    this.codeLimits = Object.freeze({ ...DEFAULT_CODE_RUN_LIMITS, ...options.codeLimits });
    this.approvalPolicy = createAiCoderApprovalPolicy({
      approvalProfile: options.approvalProfile ?? "balanced",
      grantedPermissions: this.grantedPermissions,
      ...(options.approval === undefined ? {} : { approvalCallback: options.approval }),
      ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
    });
  }

  async getToolSet(context: RunExecutionContext) {
    const registry = this.ensureRegistry(context);
    const metadata = createAiCoderCoreToolEffectMetadata(registry.activeDescriptors);
    return Object.freeze({
      canonicalToolIds: metadata.canonicalToolIds,
      definitions: registry.definitions,
      effectCapabilities: metadata.effectCapabilities,
      snapshotHash: registry.activeHash,
    });
  }

  async restoreToolSet(
    input: Readonly<{ names: readonly string[]; snapshotHash: string }>,
    context: RunExecutionContext,
  ): Promise<void> {
    const registry = this.ensureRegistry(context);
    for (const name of input.names) {
      const descriptor = registry.snapshot.descriptors.find((tool) => tool.modelName === name);
      if (descriptor === undefined || !registry.activate(descriptor.id)) {
        throw new Error(`Checkpoint references unavailable tool '${name}'.`);
      }
    }
    if (registry.activeHash !== input.snapshotHash) {
      throw new Error(`Checkpoint tool snapshot mismatch: expected ${input.snapshotHash}, received ${registry.activeHash}.`);
    }
  }

  /** Read once per executor: a workspace that edits its hooks mid-run gets them on the next run. */
  private hookConfig: HookConfig | null | undefined;

  private async hookConfigFor(workspaceRoot: string): Promise<HookConfig | null> {
    if (this.hookConfig !== undefined) return this.hookConfig;
    const config = await readHookConfig(workspaceRoot);
    this.hookConfig = Object.keys(config).length === 0 ? null : config;
    return this.hookConfig;
  }

  /**
   * The file this session keeps reminders in, or null when there is no workspace to keep one in.
   *
   * Reminders live beside the project they are about, so a reminder about this repository is found here and not in
   * some other project's list. The store itself tolerates a missing file, so this only decides where.
   */
  /** The workspace this session is working in, or null when it has none. */
  private workspaceRootOf(context: ToolExecutionContext): string | null {
    const root = (context as { workspaceRoot?: unknown }).workspaceRoot;
    return typeof root === "string" && root.length > 0 ? root : null;
  }

  private reminderStore(context: ToolExecutionContext): string | null {
    const root = (context as { workspaceRoot?: unknown }).workspaceRoot;
    return typeof root === "string" && root.length > 0
      ? root.replace(/[/\\]+$/, "") + "/.galaxy/reminders.json"
      : null;
  }

  /** An ISO timestamp or epoch milliseconds; anything else is refused rather than guessed. */
  private parseReminderWhen(value: string): number | null {
    const trimmed = value.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      const epoch = Number(trimmed);
      return Number.isFinite(epoch) ? epoch : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  async execute(call: CodingToolCall, context: ToolExecutionContext): Promise<AiCoderRuntimeToolResult> {
    const registry = this.ensureRegistry(context);
    const descriptor = registry.resolveModelName(call.name);
    if (descriptor === null) {
      return errorResult(call, call.name, "UNKNOWN_TOOL", `Tool '${call.name}' is not active in this turn.`);
    }
    // Host caps are clamped, not rejected: the work is bounded either way and a
    // rejection costs the model a full round trip.
    const clampedArguments = clampAiCoderJsonSchemaNumbers(descriptor.inputSchema, call.arguments);
    const effectiveArguments = clampedArguments.value as Readonly<Record<string, unknown>>;
    const argumentsValidation = validateAiCoderJsonSchema(descriptor.inputSchema, effectiveArguments);
    if (!argumentsValidation.valid) {
      return errorResult(
        call,
        descriptor.id,
        "INVALID_TOOL_ARGUMENTS",
        argumentsValidation.errors.join(" "),
      );
    }
    const cached = descriptor.idempotency === "with_key" ? this.idempotencyCache.get(context.idempotencyKey) : undefined;
    if (cached !== undefined) return cached;

    /*
     * A workspace's own hooks come first, because they are the project speaking rather than the person at the
     * keyboard. Exit 2 refuses the call and the model is told why; any other failure is written down and the work
     * continues, since a hook that cannot answer must not be able to freeze every tool call in the session.
     */
    const hookRoot = (context as { workspaceRoot?: unknown }).workspaceRoot;
    if (typeof hookRoot === "string") {
      const hooks = await this.hookConfigFor(hookRoot);
      if (hooks !== null) {
        const decision = await runToolHooks(hooks, "PreToolUse", descriptor.id, { arguments: effectiveArguments, tool: descriptor.id });
        if (decision.deny) {
          return errorResult(call, descriptor.id, "PERMISSION_DENIED", "A workspace hook refused this call: " + (decision.reason ?? "no reason given"));
        }
      }
    }
    const policy = await this.approvalPolicy(descriptor, effectiveArguments, context);
    const approvalEffect: AiCoderRuntimeToolEffects["approval"] = policy.allowed
      ? policy.decision === "approved_by_host" ? "granted" : "not_required"
      : "denied";
    if (!policy.allowed) {
      return errorResult(
        call,
        descriptor.id,
        policy.decision.toUpperCase(),
        policy.reason,
        false,
        Object.freeze({ approval: "denied" as const }),
      );
    }

    let dispatched: DispatchResult;
    try {
      dispatched = await this.dispatch(descriptor, effectiveArguments, context);
    } catch (error) {
      if (error instanceof UnknownSideEffectOutcomeError) throw error;
      if (error instanceof ToolAdapterError) {
        return errorResult(call, descriptor.id, error.code, error.message, error.retryable, undefined, error.suggestedAction, error.status);
      }
      const readFailure = descriptor.mutability === "read" ? recoverableReadError(error) : null;
      if (readFailure !== null) {
        return errorResult(call, descriptor.id, readFailure.code, readFailure.message, readFailure.retryable);
      }
      throw new UnknownSideEffectOutcomeError(
        `Adapter failed after dispatching ${descriptor.id}; side-effect outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const outputValidation = validateAiCoderJsonSchema(descriptor.outputSchema, dispatched.output);
    if (!outputValidation.valid) {
      throw new UnknownSideEffectOutcomeError(
        `Adapter output violated ${descriptor.id} after dispatch; side-effect evidence cannot be trusted: ${outputValidation.errors.join(" ")}`,
      );
    }
    const effects = Object.freeze({
      ...(dispatched.effects ?? {}),
      approval: approvalEffect,
    });
    const result: AiCoderRuntimeToolResult = Object.freeze({
      canonicalToolId: descriptor.id,
      content: JSON.stringify(dispatched.output),
      effects,
      effectsAuthority: "host",
      ok: true,
      outputLimits: Object.freeze({
        maxBytes: descriptor.maxOutputBytes,
        maxTokens: descriptor.maxOutputTokens,
        tailFraction: 0.25,
      }),
      summary: clampedArguments.adjustments.length === 0
        ? dispatched.summary
        : `${dispatched.summary} Arguments clamped to host limits: ${clampedArguments.adjustments.join(", ")}.`.trim(),
      trust: dispatched.trust,
    });
    if (descriptor.idempotency === "with_key") this.idempotencyCache.set(context.idempotencyKey, result);
    return result;
  }

  private ensureRegistry(context: RunExecutionContext): AiCoderToolRegistry {
    if (this.registry !== null) return this.registry;
    const profileToolIds = [
      ...(this.contractToolsEnabled ? LAB_FULL_CONTRACT_TOOL_IDS : LAB_AVAILABLE_TOOL_IDS),
      ...(this.options.research === undefined ? [] : LAB_RESEARCH_TOOL_IDS),
      /*
       * The entry tool has to exist in the snapshot before it can be active in it. A ptc round offers the model
       * nothing else, so leaving it out of the profile left the registry unable to run the one tool it advertised.
       */
      ...(this.toolPresentation === "native" ? [] : ["code.run"]),
    ];
    const snapshot = createAiCoderToolRegistrySnapshot({
      availableToolIds: this.options.enableGit === false
        ? new Set(profileToolIds.filter((id) => id !== "git.exec"))
        : new Set(profileToolIds),
      capabilities: this.options.capabilities,
      grantedPermissions: this.grantedPermissions,
      mode: context.mode,
    });
    this.registry = new AiCoderToolRegistry(snapshot);
    /*
     * The entry tool stays open whenever a round is not purely native, so the tool the model is told to call is also
     * a tool this registry will run.
     */
    if (this.toolPresentation !== "native") this.registry.activate("code.run");
    return this.registry;
  }

  private async dispatch(
    descriptor: AiCoderToolDescriptor,
    argumentsValue: JsonObject,
    context: ToolExecutionContext,
  ): Promise<DispatchResult> {
    if (this.options.research !== undefined && descriptor.id === "research.search") {
      const query = stringArgument(argumentsValue, "query");
      const limit = optionalNumber(argumentsValue, "maxResults") ?? 3;
      const cacheKey = JSON.stringify({ limit, query: query.trim() });
      const cached = this.researchSearchCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const data = portData(await this.options.research.search({
        query,
        limit,
      }, context));
      const source = Object.freeze({
        ...provenance("ollama.web_search", "untrusted_external"),
        retrievedAt: new Date().toISOString(),
      });
      const output = {
        results: data.results.map((hit) => Object.freeze({ ...hit, provenance: source })),
        truncated: data.pagination.hasMore,
        provenance: source,
      };
      while (!researchOutputFits(output, descriptor) && output.results.length > 0) {
        output.truncated = true;
        if (output.results.some((hit) => (hit.snippet?.length ?? 0) > 0)) {
          output.results = output.results.map((hit) => Object.freeze({
            ...hit,
            ...(hit.snippet === undefined ? {} : { snippet: shortenResearchText(hit.snippet) }),
          }));
        } else {
          output.results.pop();
        }
      }
      const dispatched = Object.freeze({
        effects: Object.freeze({
          researchSources: Object.freeze(output.results.map((hit) => Object.freeze({
            contentHash: null,
            kind: "search" as const,
            summary: durableResearchSummary(hit.snippet ?? hit.title, 400),
            title: hit.title.slice(0, 512),
            truncated: output.truncated,
            url: hit.url,
          }))),
        }),
        output: Object.freeze(output),
        summary: `Public research returned ${output.results.length} source(s)${output.truncated ? " with bounded or filtered content" : ""}.`,
        trust: "external" as const,
      });
      this.researchSearchCache.set(cacheKey, dispatched);
      return dispatched;
    }
    if (this.options.research !== undefined && descriptor.id === "research.fetch") {
      const requestedUrl = stringArgument(argumentsValue, "url");
      const cacheKey = researchCacheUrl(requestedUrl);
      const cached = this.researchFetchCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const data = portData(await this.options.research.extract({
        url: requestedUrl,
        maxBytes: Math.min(optionalNumber(argumentsValue, "maxBytes") ?? 12_000, 12_000),
      }, context));
      const output = {
        url: data.url,
        content: data.content,
        contentHash: data.contentSha256,
        truncated: data.pagination.hasMore,
        provenance: {
          ...provenance("ollama.web_fetch", "untrusted_external", data.contentSha256),
          contentHash: data.contentSha256,
          retrievedAt: new Date().toISOString(),
        },
      };
      while (!researchOutputFits(output, descriptor) && output.content.length > 0) {
        output.content = shortenResearchText(output.content);
        output.truncated = true;
        output.contentHash = sha256Text(output.content);
        output.provenance.contentHash = output.contentHash;
      }
      if (!researchOutputFits(output, descriptor)) {
        throw new ToolAdapterError("LIMIT_EXCEEDED", "Research source metadata exceeds the structured output budget.", false);
      }
      const dispatched = Object.freeze({
        effects: Object.freeze({
          researchSources: Object.freeze([Object.freeze({
            contentHash: output.contentHash,
            kind: "fetch" as const,
            summary: durableResearchSummary(output.content, 1_000),
            truncated: output.truncated,
            url: output.url,
          })]),
        }),
        output: Object.freeze(output),
        summary: `Fetched bounded public source ${data.url}${output.truncated ? " (truncated)" : ""}.`,
        trust: "external" as const,
      });
      this.researchFetchCache.set(cacheKey, dispatched);
      this.researchFetchCache.set(researchCacheUrl(data.url), dispatched);
      return dispatched;
    }
    switch (descriptor.id) {
      case "catalog.search": {
        const result = this.ensureRegistry(context).search(
          stringArgument(argumentsValue, "query", ""),
          optionalString(argumentsValue, "category"),
          optionalNumber(argumentsValue, "limit"),
          optionalString(argumentsValue, "cursor"),
        );
        return Object.freeze({
          output: result,
          summary: `Activated ${result.activated.length} matching tool(s).`,
          trust: "trusted",
          effects: Object.freeze({ stateVersion: result.activeHash }),
        });
      }
      case "schedule.list": {
        const store = this.reminderStore(context);
        if (store === null) throw new ToolAdapterError("UNAVAILABLE", "This session has no workspace to read reminders from.");
        const reminders = await readReminders(store);
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(JSON.stringify(reminders)) }),
          output: Object.freeze({
            reminders: reminders.map((reminder) => reminder.id + " · " + new Date(reminder.dueAt).toISOString()
              + (reminder.deliveredAt === undefined ? "" : " · đã nói") + " · " + reminder.text),
          }),
          summary: String(reminders.length) + " reminder(s).",
          trust: "trusted" as const,
        });
      }
      case "schedule.delete": {
        const store = this.reminderStore(context);
        if (store === null) throw new ToolAdapterError("UNAVAILABLE", "This session has no workspace to drop a reminder from.");
        const id = stringArgument(argumentsValue, "id");
        const before = await readReminders(store);
        const after = removeReminder(before, id);
        if (after.length === before.length) throw new ToolAdapterError("NOT_FOUND", "No reminder with that id.");
        await writeReminders(store, after);
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(id + "removed") }),
          output: Object.freeze({ removed: true }),
          summary: "Reminder dropped.",
          trust: "trusted" as const,
        });
      }
      case "task.checkpoint": {
        const action = stringArgument(argumentsValue, "action") as "read" | "update";
        let checkpoint = this.taskCheckpointStore.get(context.runId);
        if (action === "update") {
          checkpoint = Object.freeze({
            goal: stringArgument(argumentsValue, "goal", checkpoint?.goal ?? `Task ${context.taskId}`),
            progress: stringArgument(argumentsValue, "progress", checkpoint?.progress ?? ""),
            decisions: Object.freeze(stringArray(argumentsValue, "decisions")),
            nextStep: stringArgument(argumentsValue, "nextStep", checkpoint?.nextStep ?? ""),
            steps: parsePlanSteps(planStepInputs(argumentsValue, "steps")),
            updatedAt: "1970-01-01T00:00:00.000Z",
          });
          this.taskCheckpointStore.set(context.runId, checkpoint);
        }
        if (checkpoint === undefined) {
          checkpoint = Object.freeze({
            goal: `Task ${context.taskId}`,
            progress: "",
            decisions: Object.freeze([]),
            nextStep: "Inspect the workspace.",
            steps: Object.freeze([]),
            updatedAt: "1970-01-01T00:00:00.000Z",
          });
          this.taskCheckpointStore.set(context.runId, checkpoint);
        }
        return Object.freeze({
          output: Object.freeze({ action, checkpointId: context.runId, updated: action === "update", checkpoint }),
          summary: action === "update" ? "Updated the bounded task checkpoint." : "Read the bounded task checkpoint.",
          trust: "trusted",
          effects: Object.freeze({
            nextAction: checkpoint.nextStep,
            plan: Object.freeze({
              completed: checkpoint.progress.trim() ? Object.freeze([checkpoint.progress]) : Object.freeze([]),
              decisions: Object.freeze([...checkpoint.decisions]),
              inProgress: checkpoint.nextStep.trim() || null,
              pending: Object.freeze([]),
              ...(checkpoint.steps?.length ? { steps: checkpoint.steps } : {}),
            }),
            stateVersion: sha256Text(JSON.stringify(checkpoint)),
          }),
        });
      }
      case "workspace.list": {
        const depth = optionalNumber(argumentsValue, "depth");
        const limit = optionalNumber(argumentsValue, "limit");
        const cursor = optionalString(argumentsValue, "cursor");
        const result = await this.options.workspace.listDir({
          path: stringArgument(argumentsValue, "path"),
          ...(depth === undefined ? {} : { depth }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        }, context);
        const data = portData(result);
        const output = Object.freeze({
          entries: data.entries,
          truncated: data.pagination.hasMore,
          ...(data.pagination.nextCursor === undefined ? {} : { nextCursor: data.pagination.nextCursor }),
        });
        return Object.freeze({
          output,
          summary: `Listed ${data.entries.length} workspace entries.`,
          trust: "workspace",
          effects: Object.freeze({ inspectedPaths: Object.freeze([stringArgument(argumentsValue, "path")]) }),
        });
      }
      case "workspace.glob": {
        const kind = optionalString(argumentsValue, "kind");
        const path = optionalString(argumentsValue, "path");
        const limit = optionalNumber(argumentsValue, "limit");
        const cursor = optionalString(argumentsValue, "cursor");
        const result = await this.options.workspace.searchPaths({
          query: stringArgument(argumentsValue, "pattern"),
          mode: "glob",
          ...(kind === undefined || kind === "any" ? {} : { kind: kind as "file" | "directory" }),
          ...(path === undefined ? {} : { path }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        }, context);
        const data = portData(result);
        return Object.freeze({
          output: Object.freeze({
            matches: data.matches,
            truncated: data.pagination.hasMore,
            ...(data.pagination.nextCursor === undefined ? {} : { nextCursor: data.pagination.nextCursor }),
          }),
          summary: `Found ${data.matches.length} matching workspace paths.`,
          trust: "workspace",
          effects: Object.freeze({ inspectedPaths: Object.freeze([optionalString(argumentsValue, "path") ?? "."]) }),
        });
      }
      case "workspace.grep": {
        const regex = optionalBoolean(argumentsValue, "regex");
        const caseSensitive = optionalBoolean(argumentsValue, "caseSensitive");
        const glob = optionalString(argumentsValue, "glob");
        const path = optionalString(argumentsValue, "path");
        const limit = optionalNumber(argumentsValue, "limit");
        const cursor = optionalString(argumentsValue, "cursor");
        const result = await this.options.workspace.searchText({
          query: stringArgument(argumentsValue, "query"),
          ...(regex === undefined ? {} : { regex }),
          ...(caseSensitive === undefined ? {} : { caseSensitive }),
          ...(glob === undefined ? {} : { glob }),
          ...(path === undefined ? {} : { path }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        }, context);
        const data = portData(result);
        const matches = data.matches.map((match) => Object.freeze({
          path: match.path,
          line: match.line,
          ...(match.column === undefined ? {} : { column: match.column }),
          preview: match.preview,
          ...(match.contentSha256 === undefined ? {} : { contentHash: match.contentSha256 }),
        }));
        return Object.freeze({
          output: Object.freeze({
            matches: Object.freeze(matches),
            truncated: data.pagination.hasMore,
            provenance: provenance("workspace.searchText", "untrusted_workspace"),
            ...(data.pagination.nextCursor === undefined ? {} : { nextCursor: data.pagination.nextCursor }),
          }),
          summary: `Found ${matches.length} text matches.`,
          trust: "workspace",
          effects: Object.freeze({ inspectedPaths: Object.freeze([...new Set(matches.map((match) => match.path))]) }),
        });
      }
      case "workspace.read": {
        const startLine = optionalNumber(argumentsValue, "startLine");
        const endLine = optionalNumber(argumentsValue, "endLine");
        const maxBytes = optionalNumber(argumentsValue, "maxBytes");
        const cursor = optionalString(argumentsValue, "cursor");
        const result = await this.options.workspace.readText({
          path: stringArgument(argumentsValue, "path"),
          ...(startLine === undefined ? {} : { startLine }),
          ...(endLine === undefined ? {} : { endLine }),
          ...(maxBytes === undefined ? {} : { maxBytes }),
          ...(cursor === undefined ? {} : { cursor }),
        }, context);
        const data = portData(result);
        return Object.freeze({
          output: Object.freeze({
            path: data.path,
            content: data.content,
            contentHash: data.contentSha256,
            startLine: data.startLine,
            endLine: data.endLine,
            truncated: data.truncated,
            provenance: provenance("workspace.readText", "untrusted_workspace", data.contentSha256),
            ...(data.pagination.nextCursor === undefined ? {} : { nextCursor: data.pagination.nextCursor }),
          }),
          summary: `Read ${data.path}:${data.startLine}-${data.endLine}.`,
          trust: "workspace",
          effects: Object.freeze({ inspectedPaths: Object.freeze([data.path]) }),
        });
      }
      case "workspace.edit": {
        const replaceAll = optionalBoolean(argumentsValue, "replaceAll");
        const { before, snapshotter } = await this.mutationBaseline(context);
        const editPrecondition = argumentsValue.precondition as { kind: "matches_sha256"; contentSha256: string } | undefined;
        const result = await this.options.workspace.applyPatch({
          path: stringArgument(argumentsValue, "path"),
          oldText: stringArgument(argumentsValue, "oldText"),
          newText: stringArgument(argumentsValue, "newText"),
          ...(replaceAll === undefined ? {} : { replaceAll }),
          ...(editPrecondition === undefined ? {} : { precondition: editPrecondition }),
        }, context);
        const after = await snapshotter.capture(context);
        const mutations = diffNodeWorkspaceSnapshots(before, after);
        if (!result.ok) structuredMutationFailure("workspace.edit", mutations, result.error);
        const data = result.data;
        assertTargetMutation("workspace.edit", mutations, {
          afterHash: data.afterContentSha256,
          beforeHash: data.beforeContentSha256,
          path: data.path,
        });
        const derivedMutations = derivedMutationObservation(mutations);
        return Object.freeze({
          output: Object.freeze({
            ...data,
            ...(derivedMutations === undefined ? {} : { derivedMutations }),
          }),
          summary: `Applied ${data.replacements} replacement(s) to ${data.path}.`,
          trust: "trusted",
          effects: Object.freeze({
            writes: mutations.writes,
            stateVersion: mutations.stateVersion,
          }),
        });
      }
      case "workspace.write": {
        const { before, snapshotter } = await this.mutationBaseline(context);
        const result = await this.options.workspace.writeText({
          path: stringArgument(argumentsValue, "path"),
          content: stringArgument(argumentsValue, "content", ""),
          precondition: argumentsValue.precondition as
            | { kind: "must_not_exist" }
            | { kind: "matches_sha256"; contentSha256: string },
        }, context);
        const after = await snapshotter.capture(context);
        const mutations = diffNodeWorkspaceSnapshots(before, after);
        if (!result.ok) structuredMutationFailure("workspace.write", mutations, result.error);
        const data = result.data;
        assertTargetMutation("workspace.write", mutations, {
          afterHash: data.afterContentSha256,
          beforeHash: data.beforeContentSha256 ?? null,
          path: data.path,
        });
        const derivedMutations = derivedMutationObservation(mutations);
        return Object.freeze({
          output: Object.freeze({
            ...data,
            ...(derivedMutations === undefined ? {} : { derivedMutations }),
          }),
          summary: `Wrote ${data.length} characters to ${data.path}.`,
          trust: "trusted",
          effects: Object.freeze({
            writes: mutations.writes,
            stateVersion: mutations.stateVersion,
          }),
        });
      }
      case "skill.list": {
        const root = this.workspaceRootOf(context);
        if (root === null) throw new ToolAdapterError("UNAVAILABLE", "This session has no workspace to read skills from.");
        const skills = await readWorkspaceSkills(root);
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(formatSkillList(skills)) }),
          output: Object.freeze({ skills: skills.map((skill) => skill.name + (skill.description.length === 0 ? "" : " — " + skill.description)) }),
          summary: skills.length === 0 ? "No skills in this workspace." : String(skills.length) + " skill(s).",
          trust: "trusted" as const,
        });
      }
      case "skill.load": {
        const root = this.workspaceRootOf(context);
        if (root === null) throw new ToolAdapterError("UNAVAILABLE", "This session has no workspace to read a skill from.");
        const wanted = stringArgument(argumentsValue, "name");
        const skills = await readWorkspaceSkills(root);
        const skill = skills.find((entry) => entry.name === wanted);
        if (skill === undefined) throw new ToolAdapterError("NOT_FOUND", "No skill named " + wanted + " in this workspace.");
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(skill.source) }),
          output: Object.freeze({ content: skill.body, source: skill.source }),
          summary: "Read the " + skill.name + " skill.",
          trust: "trusted" as const,
        });
      }
      case "schedule.create": {
        const store = this.reminderStore(context);
        if (store === null) throw new ToolAdapterError("UNAVAILABLE", "This session has no workspace to keep a reminder in.");
        const now = Date.now();
        const dueAt = this.parseReminderWhen(stringArgument(argumentsValue, "when"));
        if (dueAt === null || dueAt <= now) {
          throw new ToolAdapterError("INVALID_TOOL_ARGUMENTS", "when must be an ISO timestamp or epoch milliseconds in the future.");
        }
        const existing = await readReminders(store);
        const reminderId = "reminder-" + String(existing.length + 1) + "-" + String(now);
        await writeReminders(store, addReminder(existing, {
          createdAt: now, dueAt, id: reminderId, text: stringArgument(argumentsValue, "text"),
        }));
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(reminderId + String(dueAt)) }),
          output: Object.freeze({ due_at: new Date(dueAt).toISOString(), reminder_id: reminderId }),
          summary: "Reminder set for " + new Date(dueAt).toISOString() + ".",
          trust: "trusted" as const,
        });
      }
      case "subagent.spawn": {
        const seam = this.subagents;
        if (seam === null) throw new ToolAdapterError("UNSUPPORTED", "No child-agent backend is configured.");
        const providerName = optionalString(argumentsValue, "provider") ?? (seam.providerNames()[0] ?? "in-process");
        const spawned = await seam.spawn({
          description: stringArgument(argumentsValue, "description"),
          kind: "spawn",
          prompt: stringArgument(argumentsValue, "prompt"),
          provider: providerName,
        });
        if (spawned.ok === false) {
          throw new ToolAdapterError(spawned.reason === "unknown_provider" ? "NOT_FOUND" : "LIMIT_EXCEEDED", "Cannot start a child agent: " + spawned.reason + ".");
        }
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(spawned.record.id + spawned.record.status) }),
          output: Object.freeze({ agent_id: spawned.record.id, status: spawned.record.status }),
          summary: "Started " + spawned.record.id + ": " + spawned.record.description,
          trust: "trusted" as const,
        });
      }
      case "subagent.list": {
        const seam = this.subagents;
        if (seam === null) throw new ToolAdapterError("UNSUPPORTED", "No child-agent backend is configured.");
        const agents = seam.list();
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(JSON.stringify(agents)) }),
          output: Object.freeze({ agents }),
          summary: agents.length === 0 ? "No child agents." : agents.length + " child agent(s).",
          trust: "trusted" as const,
        });
      }
      case "subagent.fork": {
        const seam = this.subagents;
        if (seam === null) throw new ToolAdapterError("UNSUPPORTED", "No child-agent backend is configured.");
        const providerName = optionalString(argumentsValue, "provider") ?? (seam.providerNames()[0] ?? "in-process");
        const spawned = await seam.spawn({
          description: stringArgument(argumentsValue, "description"),
          kind: "fork",
          prompt: stringArgument(argumentsValue, "prompt"),
          provider: providerName,
        });
        if (spawned.ok === false) {
          throw new ToolAdapterError(spawned.reason === "unknown_provider" ? "NOT_FOUND" : "LIMIT_EXCEEDED", "Cannot start a child agent: " + spawned.reason + ".");
        }
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(spawned.record.id + spawned.record.status) }),
          output: Object.freeze({ agent_id: spawned.record.id, status: spawned.record.status }),
          summary: "Started " + spawned.record.id + ": " + spawned.record.description,
          trust: "trusted" as const,
        });
      }
      case "subagent.send": {
      const seam = this.subagents;
      if (seam === null) throw new ToolAdapterError("UNSUPPORTED", "No child-agent backend is configured.");
      const sent = seam.send(stringArgument(argumentsValue, "target"), stringArgument(argumentsValue, "message"));
      if (!sent) throw new ToolAdapterError("NOT_FOUND", "No running child agent with that id.");
      return Object.freeze({
        effects: Object.freeze({ stateVersion: sha256Text("sent" + Date.now()) }),
        output: Object.freeze({ sent }),
        summary: "Message delivered to the child agent.",
        trust: "trusted" as const,
      });
      }
      case "subagent.interrupt": {
        const seam = this.subagents;
        if (seam === null) throw new ToolAdapterError("UNSUPPORTED", "No child-agent backend is configured.");
        const stopped = seam.interrupt(stringArgument(argumentsValue, "target"));
        if (!stopped) throw new ToolAdapterError("NOT_FOUND", "No running child agent with that id.");
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text("stopped" + Date.now()) }),
          output: Object.freeze({ interrupted: stopped }),
          summary: "Asked the child agent to stop.",
          trust: "trusted" as const,
        });
      }
      case "goal.create": {
        const goal = this.goals.create(
          stringArgument(argumentsValue, "objective"),
          optionalNumber(argumentsValue, "max_goal_rounds"),
        );
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(goal.id + goal.revision) }),
          output: Object.freeze({ goal_id: goal.id, max_goal_rounds: goal.maxGoalRounds, objective: goal.objective, phase: goal.phase, revision: goal.revision }),
          summary: "Goal " + goal.id + " recorded: " + goal.objective,
          trust: "trusted" as const,
        });
      }
      case "goal.get": {
        const named = optionalString(argumentsValue, "goal_id");
        const goal = named === undefined ? this.goals.current() : this.goals.get(named);
        if (goal === null) throw new ToolAdapterError("NOT_FOUND", "No goal recorded yet.");
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(goal.id + goal.revision) }),
          output: Object.freeze({ goal_id: goal.id, objective: goal.objective, phase: goal.phase, revision: goal.revision, rounds_started: goal.roundsStarted }),
          summary: "Goal " + goal.id + " is " + goal.phase + " at revision " + goal.revision + ".",
          trust: "trusted" as const,
        });
      }
      case "goal.update": {
        const updated = this.goals.update(
          stringArgument(argumentsValue, "goal_id"),
          optionalNumber(argumentsValue, "expected_revision") ?? 0,
          stringArgument(argumentsValue, "action") as "edit" | "pause" | "resume" | "complete" | "blocked",
          Object.freeze({
            ...(optionalString(argumentsValue, "objective") === undefined ? {} : { objective: optionalString(argumentsValue, "objective") as string }),
            ...(optionalString(argumentsValue, "blocked_reason") === undefined ? {} : { blockedReason: optionalString(argumentsValue, "blocked_reason") as string }),
            ...(optionalNumber(argumentsValue, "max_goal_rounds") === undefined ? {} : { maxGoalRounds: optionalNumber(argumentsValue, "max_goal_rounds") as number }),
          }),
        );
        if (updated.ok === false) {
          if ("missing" in updated) throw new ToolAdapterError("NOT_FOUND", "No goal with that id.");
          throw new ToolAdapterError("CONFLICT", "The goal moved on: it is at revision " + updated.conflict.revision + ".");
        }
        const goal = updated.goal;
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(goal.id + goal.revision) }),
          output: Object.freeze({ goal_id: goal.id, phase: goal.phase, revision: goal.revision, rounds_started: goal.roundsStarted }),
          summary: "Goal " + goal.id + " is now " + goal.phase + " at revision " + goal.revision + ".",
          trust: "trusted" as const,
        });
      }
      case "job.list": {
        const rows = this.jobs.list();
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(JSON.stringify(rows)) }),
          output: Object.freeze({ jobs: rows }),
          summary: rows.length === 0 ? "No background jobs." : rows.length + " background job(s).",
          trust: "trusted" as const,
        });
      }
      case "job.output": {
        const read = await this.jobs.output(
          stringArgument(argumentsValue, "job_id"),
          optionalBoolean(argumentsValue, "wait") ?? false,
          optionalNumber(argumentsValue, "timeout_ms") ?? 30_000,
        );
        if (read === null) throw new ToolAdapterError("NOT_FOUND", "No background job with that id.");
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(JSON.stringify(read)) }),
          output: Object.freeze({ ...read }),
          summary: "Job " + read.status + " (" + read.text.length + " characters read).",
          trust: "trusted" as const,
        });
      }
      case "job.kill": {
        const id = stringArgument(argumentsValue, "job_id");
        const ended = this.jobs.kill(id);
        const row = this.jobs.list().find((entry: JobRow) => entry.id === id);
        if (row === undefined) throw new ToolAdapterError("NOT_FOUND", "No background job with that id.");
        return Object.freeze({
          effects: Object.freeze({ stateVersion: sha256Text(row.id + row.status + String(ended)) }),
          output: Object.freeze({ ended, status: row.status }),
          summary: ended ? "Asked the job to stop." : "The job had already stopped.",
          trust: "trusted" as const,
        });
      }
      case "command.run": {
        /*
         * Started, not waited on: a build that takes ten minutes goes to the background and is asked about later,
         * instead of holding a tool call until its deadline kills the run.
         */
        if (optionalBoolean(argumentsValue, "run_in_background") === true) {
          const row = this.jobs.start(stringArgument(argumentsValue, "command"), {
            cwd: resolve(context.workspaceRoot, optionalString(argumentsValue, "cwd") ?? "."),
            kind: "command",
          });
          return Object.freeze({
            effects: Object.freeze({ stateVersion: sha256Text(row.id + row.status) }),
            output: Object.freeze({ jobId: row.id, status: row.status }),
            summary: "Started " + row.id + " in the background: " + row.label,
            trust: "trusted" as const,
          });
        }
        const cwd = optionalString(argumentsValue, "cwd") ?? ".";
        // The agent's own timeout is honoured as given; only the run deadline bounds it.
        const timeoutMs = optionalNumber(argumentsValue, "timeoutMs");
        const command = stringArgument(argumentsValue, "command");
        const { before, snapshotter } = await this.mutationBaseline(context);
        const execution = await (async () => {
          try {
            const result = await this.options.command.run({
              command,
              cwd,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              ...(typeof argumentsValue.env === "object" && argumentsValue.env !== null
                ? { env: argumentsValue.env as Readonly<Record<string, string>> }
                : {}),
            }, context);
            const after = await snapshotter.capture(context);
            return Object.freeze({ mutations: diffNodeWorkspaceSnapshots(before, after), result });
          } catch (error) {
            throw new UnknownSideEffectOutcomeError(
              `Unable to execute and verify command.run; side-effect outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
        })();
        const { mutations, result } = execution;
        const derivedMutations = derivedMutationObservation(mutations);
        const observedEffects = mutationEffects(mutations);
        if (!result.ok) {
          if (mutations.observedMutations.length === 0) {
            throw new ToolAdapterError(
              result.error.code,
              result.error.message,
              result.error.retryable,
              result.error.suggestedAction,
            );
          }
          return Object.freeze({
            output: Object.freeze({
              command,
              cwd,
              exitCode: -1,
              stdout: "",
              stderr: `${result.error.code}: ${result.error.message}`,
              timedOut: result.error.code === "DEADLINE_EXCEEDED",
              cancelled: result.error.code === "CANCELED",
              truncated: false,
              ...(derivedMutations === undefined ? {} : { derivedMutations }),
            }),
            summary: `Command adapter returned ${result.error.code} after changing ${mutations.observedMutations.length} workspace path(s).`,
            trust: "external",
            effects: observedEffects!,
          });
        }
        const data = portData(result);
        return Object.freeze({
          output: Object.freeze({
            command: data.command,
            cwd,
            exitCode: data.exitCode ?? -1,
            stdout: data.stdout,
            stderr: data.stderr,
            timedOut: data.status === "timed_out",
            cancelled: data.status === "canceled",
            truncated: data.stdoutTruncated || data.stderrTruncated,
            ...(derivedMutations === undefined ? {} : { derivedMutations }),
          }),
          // Mirror the harness wording for a killed command, so the model reads the same
          // signal it would get from @deepseek-ai/dsh-tool-bash-persistent: the command was
          // stopped at its maximum and what follows is partial output, not a finished run.
          summary: [
            data.status === "timed_out"
              ? `Command timed out after ${Math.round((data.durationMs ?? 0) / 1000)}s. Below is partial output:`
              : `Command ${data.status} with exit code ${String(data.exitCode)}.`,
            serverCommandAdvisory(command), validationCommandAdvisory(command, cwd), dependencyShellReadAdvisory(command),
          ]
            .filter((part): part is string => part !== undefined && part.length > 0)
            .join(" "),
          trust: "external",
          ...(observedEffects === undefined ? {} : { effects: observedEffects }),
        });
      }
      case "project.detect": {
        const detected = await detectProject(this.options.workspace, optionalString(argumentsValue, "path") ?? ".", context);
        return Object.freeze({
          output: detected as unknown as JsonObject,
          summary: `Detected ${detected.manifests.length} manifest(s) and ${detected.languages.length} language(s).`,
          trust: "workspace",
          effects: Object.freeze({ inspectedPaths: Object.freeze([detected.projectRoot]) }),
        });
      }
      case "project.validate": {
        const checks = stringArray(argumentsValue, "checks") as readonly ProjectCheck[];
        const timeoutMs = optionalNumber(argumentsValue, "timeoutMs");
        const projectPath = normalizedProjectPath(optionalString(argumentsValue, "path") ?? ".");
        const { before, snapshotter } = await this.mutationBaseline(context);
        const execution = await (async () => {
          try {
            const result = await validateProject(this.options.workspace, this.options.command, {
              checks,
              path: projectPath,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }, context);
            const after = await snapshotter.capture(context);
            return Object.freeze({ mutations: diffNodeWorkspaceSnapshots(before, after), result });
          } catch (error) {
            throw new UnknownSideEffectOutcomeError(
              `Unable to execute and verify project.validate; side-effect outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
        })();
        const { mutations, result } = execution;
        const derivedMutations = derivedMutationObservation(mutations);
        const outputResults = Object.freeze(result.results.map((item) => Object.freeze({
          check: item.check,
          status: item.status,
          summary: item.summary,
          ...(item.command === undefined ? {} : { command: item.command }),
          ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
        })));
        return Object.freeze({
          output: Object.freeze({
            cancelled: result.cancelled,
            passed: result.passed,
            results: outputResults,
            ...(derivedMutations === undefined ? {} : { derivedMutations }),
          }),
          summary: result.passed ? "Project validation passed." : "Project validation did not pass.",
          trust: "external",
          effects: Object.freeze({
            ...(mutations.observedMutations.length === 0 ? {} : {
              stateVersion: mutations.stateVersion,
              ...(mutations.writes.length === 0 ? {} : { writes: mutations.writes }),
            }),
            validations: Object.freeze(result.results.map((item) => Object.freeze({
              id: `project.validate:${item.check}:${projectPath}`,
              detail: `${item.check}: ${item.summary}`,
              ...validationScopeForProjectPath(projectPath),
              status: item.status === "passed" ? "passed" : item.status === "skipped" ? "not_run" : "failed",
            }))),
          }),
        });
      }
      case "research.fetch":
      case "research.search":
      case "code.run": {
        if (this.codeRuntime === null) {
          throw new ToolAdapterError("UNAVAILABLE", "run_code needs a composed code runtime: start the session with tools mode ptc in a host that provides one.");
        }
        const program = stringArgument(argumentsValue, "program");
        const goal = stringArgument(argumentsValue, "goal");
        /* The program may call exactly the tools this round activated, minus the entry point itself. */
        const toolNames = this.ensureRegistry(context).activeDescriptors
          .map(tool => tool.modelName)
          .filter(name => name !== "run_code");
        let callIndex = 0;
        /*
         * A program's calls are the run's calls. Their reads, writes and validations are evidence exactly like a
         * top-level call's — and returning empty effects here made every read inside a program invisible, so a
         * session that inspected a repository through programs looked like it had never looked at the workspace at
         * all. The gate then refused the report with INSPECTION_MISSING, the model read the refusal as "keep
         * going", and three of those ended the run.
         */
        const nestedEffects: AiCoderRuntimeToolEffects[] = [];
        const outcome = await this.codeRuntime.run({
          callTool: async (name, args) => {
            callIndex += 1;
            const nested = await this.execute(
              { arguments: args, name, toolCallId: `code-${callIndex.toString()}` },
              context,
            );
            if (nested.ok && nested.effects !== undefined) nestedEffects.push(nested.effects);
            return nested.ok
              ? { ok: true as const, value: nested.content }
              : { code: nested.error.code, error: nested.error.message, ok: false as const };
          },
          goal,
          limits: this.codeLimits,
          ...(this.onCodeEvent === null ? {} : { onEvent: this.onCodeEvent }),
          program,
          toolNames,
        }, context.signal);
        /* A failed program is a failed tool call, so the ordinary error path owns retries and reporting. */
        if (!outcome.ok) throw new ToolAdapterError(outcome.code, outcome.error, false);
        return Object.freeze({
          effects: mergeProgramToolEffects(nestedEffects),
          output: Object.freeze({ logs: Object.freeze(outcome.logs), ok: true as const, value: outcome.value }),
          summary: outcome.value.slice(0, 400),
          trust: "workspace",
        });
      }
      case "command.session":
      case "preview.manage":
      case "perception.analyze":
      case "artifact.create":
      case "artifact.list":
      case "artifact.read":
      case "user.ask": {
        if (this.contractTools === null) {
          throw new ToolAdapterError(
            "UNAVAILABLE",
            `${descriptor.id} is available only in the explicit deterministic contract-tool profile.`,
          );
        }
        try {
          return await this.contractTools.execute(descriptor.id, argumentsValue, context);
        } catch (error) {
          if (error instanceof ContractToolError) {
            throw new ToolAdapterError(error.code, error.message, error.retryable, error.suggestedAction);
          }
          throw error;
        }
      }
      case "git.exec": {
        const action = stringArgument(argumentsValue, "action") as "status" | "diff" | "log";
        const paths = stringArray(argumentsValue, "paths");
        const pathArguments = gitPathArguments(paths);
        const limit = Math.max(1, Math.min(1_000, optionalNumber(argumentsValue, "limit") ?? 50));
        let stdout: string;
        let stderr: string;
        let truncated: boolean;
        if (action === "diff") {
          const runGit = async (
            command: string,
            acceptedExitCodes: readonly number[] = [0],
            environment: Readonly<Record<string, string>> = pathArguments.environment,
          ) => {
            const data = portData(await this.options.command.run({
              command,
              cwd: ".",
              env: environment,
              maxOutputBytes: descriptor.maxOutputBytes,
            }, context));
            if (data.status !== "exited" || data.exitCode === null || !acceptedExitCodes.includes(data.exitCode)) {
              throw new ToolAdapterError(
                "GIT_COMMAND_FAILED",
                data.stderr.trim() || data.stdout.trim() || `${command} ended with ${data.status}/${String(data.exitCode)}.`,
              );
            }
            return data;
          };
          const workingTree = await runGit(`git diff --no-ext-diff --binary${pathArguments.suffix}`);
          const staged = await runGit(`git diff --cached --no-ext-diff --binary${pathArguments.suffix}`);
          const untrackedList = await runGit(`git ls-files --others --exclude-standard -z${pathArguments.suffix}`);
          const listedUntracked = untrackedList.stdoutTruncated || untrackedList.stderrTruncated
            ? []
            : untrackedList.stdout.split("\0").filter((path) => path.length > 0);
          const untracked = [];
          for (const path of listedUntracked.slice(0, MAX_UNTRACKED_DIFF_FILES)) {
            const untrackedPath = gitPathArguments([path], paths.length);
            untracked.push(await runGit(
              `git diff --no-index --no-ext-diff --binary -- ${NULL_DEVICE} ${untrackedPath.arguments}`,
              [0, 1],
              untrackedPath.environment,
            ));
          }
          const sections = [
            workingTree.stdout.length ? `[working-tree]\n${workingTree.stdout}` : "",
            staged.stdout.length ? `[staged]\n${staged.stdout}` : "",
            ...untracked.map((item) => item.stdout.length ? `[untracked]\n${item.stdout}` : ""),
          ].filter((section) => section.length > 0);
          stdout = sections.join("\n");
          stderr = [workingTree.stderr, staged.stderr, untrackedList.stderr, ...untracked.map((item) => item.stderr)]
            .filter((value) => value.length > 0)
            .join("\n");
          truncated = listedUntracked.length > MAX_UNTRACKED_DIFF_FILES
            || workingTree.stdoutTruncated || workingTree.stderrTruncated
            || staged.stdoutTruncated || staged.stderrTruncated
            || untrackedList.stdoutTruncated || untrackedList.stderrTruncated
            || untracked.some((item) => item.stdoutTruncated || item.stderrTruncated)
            || gitOutputWouldBeBound(descriptor, action, stdout, stderr);
        } else {
          const command = action === "status"
            ? `git status --short${pathArguments.suffix}`
            : `git log --oneline --no-decorate -n ${limit}${pathArguments.suffix}`;
          const data = portData(await this.options.command.run({
            command,
            cwd: ".",
            env: pathArguments.environment,
          }, context));
          if (data.status !== "exited" || data.exitCode !== 0) {
            throw new ToolAdapterError(
              "GIT_COMMAND_FAILED",
              data.stderr.trim() || data.stdout.trim() || `Git ${action} ended with ${data.status}/${String(data.exitCode)}.`,
            );
          }
          stdout = data.stdout;
          stderr = data.stderr;
          truncated = data.stdoutTruncated || data.stderrTruncated;
        }
        return Object.freeze({
          output: Object.freeze({
            action,
            stdout,
            stderr,
            exitCode: 0,
            truncated,
          }),
          summary: `Git ${action} exited with 0${truncated ? " and returned truncated output" : ""}.`,
          trust: "workspace",
          effects: Object.freeze({
            ...(action === "diff" && !truncated
              ? { diffReview: Object.freeze({ diffHash: sha256Text(JSON.stringify({ action, paths, stdout })) }) }
              : {}),
            inspectedPaths: Object.freeze(paths.length === 0 ? ["."] : paths),
          }),
        });
      }
      default:
        throw new Error(`No deterministic adapter exists for ${descriptor.id}.`);
    }
  }
}

/**
 * Unions what a program's nested calls did into the single effect set the controller sees.
 *
 * Collections are concatenated; scalars take the last value that was set, because a plan or a diff review from
 * later in the program is the one that describes the state the program ended in.
 */
export function mergeProgramToolEffects(effects: readonly AiCoderRuntimeToolEffects[]): AiCoderRuntimeToolEffects {
  if (effects.length === 0) return Object.freeze({});
  const inspectedPaths: string[] = [];
  const writes: NonNullable<AiCoderRuntimeToolEffects["writes"]>[number][] = [];
  const validations: NonNullable<AiCoderRuntimeToolEffects["validations"]>[number][] = [];
  const researchSources: NonNullable<AiCoderRuntimeToolEffects["researchSources"]>[number][] = [];
  const satisfied: string[] = [];
  const waived: string[] = [];
  let plan: AiCoderRuntimeToolEffects["plan"];
  let diffReview: AiCoderRuntimeToolEffects["diffReview"];
  let approval: AiCoderRuntimeToolEffects["approval"];
  let approvalRequestId: string | undefined;
  let nextAction: string | undefined;
  let stateVersion: string | undefined;
  for (const effect of effects) {
    if (effect.inspectedPaths !== undefined) inspectedPaths.push(...effect.inspectedPaths);
    if (effect.writes !== undefined) writes.push(...effect.writes);
    if (effect.validations !== undefined) validations.push(...effect.validations);
    if (effect.researchSources !== undefined) researchSources.push(...effect.researchSources);
    if (effect.acceptanceCriteriaSatisfied !== undefined) satisfied.push(...effect.acceptanceCriteriaSatisfied);
    if (effect.acceptanceCriteriaWaived !== undefined) waived.push(...effect.acceptanceCriteriaWaived);
    if (effect.plan !== undefined) plan = effect.plan;
    if (effect.diffReview !== undefined) diffReview = effect.diffReview;
    if (effect.approval !== undefined) approval = effect.approval;
    if (effect.approvalRequestId !== undefined) approvalRequestId = effect.approvalRequestId;
    if (effect.nextAction !== undefined) nextAction = effect.nextAction;
    if (effect.stateVersion !== undefined) stateVersion = effect.stateVersion;
  }
  return Object.freeze({
    ...(approval === undefined ? {} : { approval }),
    ...(approvalRequestId === undefined ? {} : { approvalRequestId }),
    ...(satisfied.length === 0 ? {} : { acceptanceCriteriaSatisfied: Object.freeze(satisfied) }),
    ...(waived.length === 0 ? {} : { acceptanceCriteriaWaived: Object.freeze(waived) }),
    ...(diffReview === undefined ? {} : { diffReview }),
    ...(inspectedPaths.length === 0 ? {} : { inspectedPaths: Object.freeze(inspectedPaths) }),
    ...(nextAction === undefined ? {} : { nextAction }),
    ...(plan === undefined ? {} : { plan }),
    ...(researchSources.length === 0 ? {} : { researchSources: Object.freeze(researchSources) }),
    ...(stateVersion === undefined ? {} : { stateVersion }),
    ...(validations.length === 0 ? {} : { validations: Object.freeze(validations) }),
    ...(writes.length === 0 ? {} : { writes: Object.freeze(writes) }),
  });
}
