import {
  AiCoderTokenEstimator,
  AiCoderToolRegistry,
  createAiCoderCoreToolEffectMetadata,
  createAiCoderApprovalPolicy,
  createAiCoderToolRegistrySnapshot,
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
import { posix } from "node:path";

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
export class ContractToolError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly suggestedAction?: string) { super(message); }
}
export interface ContractToolPort {
  execute(id: string, args: Readonly<Record<string, unknown>>, context: RunExecutionContext): Promise<DispatchResult>;
}

export const LAB_AVAILABLE_TOOL_IDS = Object.freeze([
  "catalog.search",
  "task.checkpoint",
  "workspace.list",
  "workspace.glob",
  "workspace.grep",
  "workspace.read",
  "workspace.edit",
  "workspace.write",
  "command.run",
  "project.detect",
  "project.validate",
  "git.exec",
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

class UnknownSideEffectOutcomeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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
  const target = mutations.writes.find((write) => write.path === expected.path);
  const expectedBeforeKind = expected.beforeHash === null ? "missing" : "file";
  if (target === undefined
    || target.beforeKind !== expectedBeforeKind
    || target.afterKind !== "file"
    || target.beforeHash !== expected.beforeHash
    || target.afterHash !== expected.afterHash) {
    throw new UnknownSideEffectOutcomeError(
      `${canonicalToolId} returned success, but its target mutation does not match the independent workspace snapshot.`,
    );
  }
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
  readonly capabilities: ModelCapabilities;
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
    this.grantedPermissions = new Set([
      ...(this.contractToolsEnabled ? LAB_FULL_CONTRACT_PERMISSIONS : LAB_GRANTED_PERMISSIONS),
      ...(options.research === undefined ? [] : ["network.outbound"]),
    ]);
    this.taskCheckpointStore = options.taskCheckpointStore ?? new Map<string, LabTaskCheckpointState>();
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

  async execute(call: CodingToolCall, context: ToolExecutionContext): Promise<AiCoderRuntimeToolResult> {
    const registry = this.ensureRegistry(context);
    const descriptor = registry.resolveModelName(call.name);
    if (descriptor === null) {
      return errorResult(call, call.name, "UNKNOWN_TOOL", `Tool '${call.name}' is not active in this turn.`);
    }
    const argumentsValidation = validateAiCoderJsonSchema(descriptor.inputSchema, call.arguments);
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

    const policy = await this.approvalPolicy(descriptor, call.arguments, context);
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
      dispatched = await this.dispatch(descriptor, call.arguments, context);
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
      summary: dispatched.summary,
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
      case "task.checkpoint": {
        const action = stringArgument(argumentsValue, "action") as "read" | "update";
        let checkpoint = this.taskCheckpointStore.get(context.runId);
        if (action === "update") {
          checkpoint = Object.freeze({
            goal: stringArgument(argumentsValue, "goal", checkpoint?.goal ?? `Task ${context.taskId}`),
            progress: stringArgument(argumentsValue, "progress", checkpoint?.progress ?? ""),
            decisions: Object.freeze(stringArray(argumentsValue, "decisions")),
            nextStep: stringArgument(argumentsValue, "nextStep", checkpoint?.nextStep ?? ""),
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
        const result = await this.options.workspace.applyPatch({
          path: stringArgument(argumentsValue, "path"),
          oldText: stringArgument(argumentsValue, "oldText"),
          newText: stringArgument(argumentsValue, "newText"),
          ...(replaceAll === undefined ? {} : { replaceAll }),
          precondition: argumentsValue.precondition as { kind: "matches_sha256"; contentSha256: string },
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
      case "command.run": {
        const cwd = optionalString(argumentsValue, "cwd") ?? ".";
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
          summary: `Command ${data.status} with exit code ${String(data.exitCode)}.`,
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
              scope: "workspace" as const,
              status: item.status === "passed" ? "passed" : item.status === "skipped" ? "not_run" : "failed",
            }))),
          }),
        });
      }
      case "research.fetch":
      case "research.search":
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
