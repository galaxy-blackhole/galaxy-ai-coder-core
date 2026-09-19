import type { AiCoderAttachment } from "../context/attachment-types.js";
import type {
  AiCoderCheckpointFile,
  AiCoderCheckpointReason,
  AiCoderRunCheckpoint,
  AiCoderWorkspaceEntryKind,
} from "../context/checkpoint.js";
import type { AiCoderContextPressure } from "../context/context-profile.js";
import type { AiCoderToolOutputLimits, AiCoderToolOutputSpill } from "../context/tool-output.js";
import type { CodingModelAdapter, CodingRoundEvent, CodingToolCall, CodingToolDefinition } from "../tools/coding-messages.js";
import type { AiCoderToolEffectCapability } from "../tools/tool-effect-profile.js";
import type { AiCoderTokenProfile } from "../tools/settings-types.js";
import type { AiCoderPromptConfiguration } from "../prompt/prompt-assembler.js";
import type { AiCoderTaskMode, RunExecutionContext, ToolExecutionContext } from "../ports/execution-context.js";
import type { PortResult } from "../ports/port-result.js";
import type { TracePort } from "../ports/trace-port.js";
import type {
  AiCoderAcceptanceCriterion,
  AiCoderCompletionDiffReview,
  AiCoderCompletionRequirements,
  AiCoderCompletionValidation,
  AiCoderCompletionWrite,
} from "./completion-gate.js";
import type { AiCoderRunState, AiCoderStateTransition } from "./state-machine.js";

export type AiCoderRuntimeToolError = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  suggestedAction?: string;
}>;

export type AiCoderRuntimeResearchSource = Readonly<{
  contentHash: string | null;
  kind: "fetch" | "search";
  summary: string;
  title?: string;
  truncated: boolean;
  url: string;
}>;

export type AiCoderRuntimeToolEffects = Readonly<{
  acceptanceCriteriaSatisfied?: readonly string[];
  acceptanceCriteriaWaived?: readonly string[];
  approval?: "denied" | "granted" | "not_required" | "pending";
  approvalRequestId?: string;
  diffReview?: Readonly<{ diffHash: string }>;
  inspectedPaths?: readonly string[];
  nextAction?: string;
  plan?: Readonly<{
    completed: readonly string[];
    decisions?: readonly string[];
    inProgress: string | null;
    pending: readonly string[];
  }>;
  researchSources?: readonly AiCoderRuntimeResearchSource[];
  stateVersion?: string;
  validations?: readonly Readonly<{
    detail: string;
    id: string;
    paths?: readonly string[];
    scope: "paths" | "workspace";
    status: "failed" | "not_run" | "passed";
  }>[];
  writes?: readonly Readonly<{
    afterHash: string | null;
    afterKind?: AiCoderWorkspaceEntryKind;
    beforeHash: string | null;
    beforeKind?: AiCoderWorkspaceEntryKind;
    path: string;
  }>[];
}>;

/** @deprecated Prefer AiCoderToolEffectCapability from the tools contract. */
export type AiCoderRuntimeEffectCapability = AiCoderToolEffectCapability;

type AiCoderRuntimeToolResultBase = Readonly<{
  artifactRef?: string;
  canonicalToolId: string;
  content: string;
  outputLimits?: AiCoderToolOutputLimits;
  summary: string;
  trust: "external" | "trusted" | "workspace";
}>;

export type AiCoderRuntimeFailureEffects = Readonly<{
  acceptanceCriteriaSatisfied?: never;
  acceptanceCriteriaWaived?: never;
  approval: "denied";
  approvalRequestId?: string;
  diffReview?: never;
  inspectedPaths?: never;
  nextAction?: never;
  plan?: never;
  researchSources?: never;
  stateVersion?: never;
  validations?: never;
  writes?: never;
}>;

type AiCoderRuntimeEffectAttestation<Effects> = Readonly<
  | { effects?: never; effectsAuthority?: never }
  | { effects: Effects; effectsAuthority: "host" }
>;

/**
 * Tool output text may be untrusted. Runtime effects cross the correctness
 * boundary only when the host adapter explicitly attests that it produced
 * them; model/tool text is never parsed into trusted effects by the core.
 */
export type AiCoderRuntimeToolResult = Readonly<
  | (AiCoderRuntimeToolResultBase
    & Readonly<{ error?: never; ok: true }>
    & AiCoderRuntimeEffectAttestation<AiCoderRuntimeToolEffects>)
  | (AiCoderRuntimeToolResultBase
    & Readonly<{ error: AiCoderRuntimeToolError; ok: false }>
    & AiCoderRuntimeEffectAttestation<AiCoderRuntimeFailureEffects>)
>;

export type AiCoderRuntimeToolSet = Readonly<{
  canonicalToolIds: Readonly<Record<string, string>>;
  definitions: readonly CodingToolDefinition[];
  effectCapabilities: Readonly<Record<string, readonly AiCoderRuntimeEffectCapability[]>>;
  snapshotHash: string;
}>;

export interface AiCoderRuntimeToolExecutor {
  execute(call: CodingToolCall, context: ToolExecutionContext): Promise<AiCoderRuntimeToolResult>;
  getToolSet(context: RunExecutionContext): Promise<AiCoderRuntimeToolSet>;
  restoreToolSet?(
    input: Readonly<{ names: readonly string[]; snapshotHash: string }>,
    context: RunExecutionContext,
  ): Promise<void>;
}

export interface AiCoderRunStore {
  /** Checkpoints must be isolated from workspace/model-controlled writes. */
  readonly checkpointTrust: "trusted_host";
  loadLatestCheckpoint(runId: string, context: RunExecutionContext): Promise<AiCoderRunCheckpoint | null>;
  saveCheckpoint(checkpoint: AiCoderRunCheckpoint, context: RunExecutionContext): Promise<Readonly<{ artifactRef?: string }>>;
  saveFinalReport(report: AiCoderFinalReport, context: RunExecutionContext): Promise<void>;
}

export type AiCoderWorkspaceCheckpointSnapshot = Readonly<{
  activeFiles: readonly AiCoderCheckpointFile[];
  dirtyStateSummary: string | null;
  /** Opaque, deterministic digest over all workspace state relevant to the task. */
  stateFingerprint: string;
}>;

/**
 * Host boundary for binding durable evidence to workspace state. `capture`
 * runs while a checkpoint is created. `verify` must re-read the workspace and
 * fail closed unless the complete snapshot still matches byte-for-byte.
 */
export interface AiCoderResumeWorkspaceVerifier {
  /** Host serializes AI Coder mutations with capture/verify boundaries. */
  readonly consistency: "serialized_workspace";
  capture(
    input: Readonly<{
      activeFiles: readonly AiCoderCheckpointFile[];
      dirtyStateSummary: string | null;
    }>,
    context: RunExecutionContext,
  ): Promise<PortResult<AiCoderWorkspaceCheckpointSnapshot>>;
  verify(
    snapshot: AiCoderWorkspaceCheckpointSnapshot,
    context: RunExecutionContext,
  ): Promise<PortResult<Readonly<{ currentFingerprint: string; matches: boolean }>>>;
}

export type AiCoderFinalReport = Readonly<{
  content: string;
  completedAt: string;
  runId: string;
  taskId: string;
  validation: readonly AiCoderCompletionValidation[];
  writes: readonly AiCoderCompletionWrite[];
}>;

export type AiCoderRuntimeClock = Readonly<{
  now: () => number;
  timestamp: () => string;
}>;

/**
 * Observation no-progress handling. `advisory` dispatches repeated read-only
 * observations with escalating nudges at `observationNudgeThresholds` and
 * blocks only beyond the final threshold. `strict` preserves the older
 * behavior where the first exceedance nudges and counts a no-progress episode.
 */
export type AiCoderNoProgressPolicy = "advisory" | "strict";

export type AiCoderRunBudget = Readonly<{
  deadlineMs: number;
  maxCompletionRejections: number;
  maxNoProgressEpisodes: number;
  maxObservationRepeats: number;
  maxModelRetries: number;
  maxRepeatedToolRequests: number;
  maxToolCalls: number;
  maxTurns: number;
  noProgressPolicy: AiCoderNoProgressPolicy;
  /** Attempt counts that trigger an advisory observation nudge; strictly increasing after normalization. */
  observationNudgeThresholds: readonly number[];
  persistenceGraceMs: number;
  toolOutput: AiCoderToolOutputLimits;
}>;

export type AiCoderRunRequest = Readonly<{
  acceptanceCriteria?: readonly Readonly<{
    id: string;
    required?: boolean;
    text: string;
  }>[];
  attachments?: readonly AiCoderAttachment[];
  budget?: Partial<AiCoderRunBudget>;
  completion?: AiCoderCompletionRequirements;
  constraints?: readonly string[];
  goal: string;
  mode?: AiCoderTaskMode;
  prompt: AiCoderPromptConfiguration;
  runId?: string;
  taskId: string;
  tokenProfile?: AiCoderTokenProfile;
  workspaceRoot: string;
}>;

export type AiCoderResumeRequest = Omit<AiCoderRunRequest, "runId"> & Readonly<{
  checkpoint?: AiCoderRunCheckpoint;
  checkpointTrust?: "trusted_host";
  runId: string;
}>;

export type AiCoderRuntimeEventPayload =
  | Readonly<{ event: CodingRoundEvent; type: "model" }>
  | Readonly<{ call: CodingToolCall; type: "tool_start" }>
  | Readonly<{ call: CodingToolCall; result: AiCoderRuntimeToolResult; type: "tool_result" }>
  | Readonly<{ attempt: number; delayMs: number; message: string; type: "model_retry" }>
  | Readonly<{ checkpoint: AiCoderRunCheckpoint; reason: AiCoderCheckpointReason; type: "checkpoint" }>
  | Readonly<{ issues: readonly string[]; type: "completion_rejected" }>
  | Readonly<{ pressure: AiCoderContextPressure; tokens: number; type: "context_pressure" }>
  | Readonly<{ transition: AiCoderStateTransition; type: "state" }>;

export type AiCoderRuntimeEvent = AiCoderRuntimeEventPayload & Readonly<{
  executionId: string;
  modelTurn: number;
  runId: string;
  taskId: string;
}>;

export type AiCoderRunDependencies = Readonly<{
  clock?: AiCoderRuntimeClock;
  executionIdFactory?: () => string;
  idFactory?: () => string;
  model: CodingModelAdapter;
  onEvent?: (event: AiCoderRuntimeEvent, context: RunExecutionContext) => Promise<void> | void;
  resumeWorkspaceVerifier?: AiCoderResumeWorkspaceVerifier;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  store?: AiCoderRunStore;
  toolExecutor: AiCoderRuntimeToolExecutor;
  toolOutputSpill?: AiCoderToolOutputSpill;
  trace?: TracePort;
}>;

export type AiCoderRunResult = Readonly<{
  checkpoint: AiCoderRunCheckpoint | null;
  content: string;
  error: Readonly<{ code: string; message: string }> | null;
  runId: string;
  state: Extract<AiCoderRunState, "cancelled" | "completed" | "failed" | "paused">;
  taskId: string;
  transitions: readonly AiCoderStateTransition[];
  validation: readonly AiCoderCompletionValidation[];
  writes: readonly AiCoderCompletionWrite[];
}>;

export type AiCoderRunHandle = Readonly<{
  cancel: (reason?: string) => void;
  pause: (reason?: string) => void;
  resolveApproval: (requestId: string, decision: "denied" | "granted") => Promise<boolean>;
  result: Promise<AiCoderRunResult>;
  runId: string;
  state: () => AiCoderRunState;
}>;

export type AiCoderMutableRunEvidence = {
  acceptanceCriteria: AiCoderAcceptanceCriterion[];
  approvals: string[];
  decisions: string[];
  diffReview: AiCoderCompletionDiffReview | null;
  inspectedPaths: Set<string>;
  lastToolCalls: Array<{
    argumentsHash: string;
    idempotencyKey: string;
    name: string;
    outcome: "canceled" | "failed" | "succeeded" | "unknown";
    toolCallId: string;
  }>;
  nextAction: string;
  openProblems: string[];
  pendingApprovals: Map<string, {
    returnState: AiCoderRunState;
    toolCallId: string;
    toolName: string;
  }>;
  plan: {
    completed: string[];
    inProgress: string | null;
    pending: string[];
  };
  researchSources: Array<AiCoderRuntimeResearchSource & Readonly<{
    sequence: number;
    toolCallId: string;
  }>>;
  seenToolCallIds: Set<string>;
  validations: AiCoderCompletionValidation[];
  writes: AiCoderCompletionWrite[];
};
