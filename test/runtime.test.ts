import assert from "node:assert/strict";
import test from "node:test";
import type { AiCoderRunCheckpoint } from "../src/context/checkpoint.js";
import type { ModelCapabilities, ModelIdentity } from "../src/ports/capability-port.js";
import type { RunExecutionContext, ToolExecutionContext } from "../src/ports/execution-context.js";
import { portFailure, portSuccess } from "../src/ports/port-result.js";
import type {
  CodingModelAdapter,
  CodingRoundEvent,
  CodingRoundRequest,
  CodingTokenCountInput,
  CodingToolCall,
} from "../src/tools/coding-messages.js";
import { evaluateAiCoderCompletion } from "../src/runtime/completion-gate.js";
import { AiCoderRunController } from "../src/runtime/run-controller.js";
import {
  AiCoderRunStateMachine,
  type AiCoderRunState,
} from "../src/runtime/state-machine.js";
import type {
  AiCoderFinalReport,
  AiCoderResumeWorkspaceVerifier,
  AiCoderRunRequest,
  AiCoderRunStore,
  AiCoderRuntimeToolExecutor,
  AiCoderRuntimeToolResult,
} from "../src/runtime/runtime-types.js";

const IDENTITY: ModelIdentity = Object.freeze({
  baseUrl: "https://user:password@model.invalid/v1?api_key=super-secret#fragment",
  model: "deterministic-model",
  provider: "test",
});

const CAPABILITIES: ModelCapabilities = Object.freeze({
  contextWindow: 65_536,
  evidence: Object.freeze([]),
  identity: IDENTITY,
  input: Object.freeze({ audio: "unsupported", image: "unsupported", text: "supported", video: "unsupported" }),
  maxOutputTokens: 4_096,
  output: Object.freeze({ image: "unsupported", text: "supported" }),
  parallelToolCalling: "unsupported",
  preserveThinking: "supported",
  streaming: "supported",
  structuredOutput: "supported",
  thinking: "optional",
  tokenCounting: "supported",
  toolCalling: "supported",
});

type ScriptedRound = readonly CodingRoundEvent[] | ((context: RunExecutionContext) => AsyncIterable<CodingRoundEvent>);

class ScriptedModel implements CodingModelAdapter {
  readonly identity = IDENTITY;
  readonly requests: CodingRoundRequest[] = [];
  readonly tokenCounts: CodingTokenCountInput[] = [];

  constructor(
    private readonly rounds: ScriptedRound[],
    private readonly counts: number[] = [],
  ) {}

  async capabilities() {
    return portSuccess(CAPABILITIES);
  }

  async countTokens(input: CodingTokenCountInput) {
    this.tokenCounts.push(input);
    return portSuccess(Object.freeze({
      exact: true,
      source: "provider" as const,
      tokens: this.counts.shift() ?? 500,
    }));
  }

  async *streamRound(request: CodingRoundRequest, context: RunExecutionContext): AsyncIterable<CodingRoundEvent> {
    this.requests.push(request);
    const round = this.rounds.shift();
    if (typeof round === "function") {
      yield* round(context);
      return;
    }
    yield Object.freeze({ type: "started" as const });
    for (const event of round ?? []) yield event;
  }
}

function done(content: string, stopReason: "completed" | "tool_calls" = "completed"): CodingRoundEvent {
  return Object.freeze({
    content,
    identity: IDENTITY,
    stopReason,
    thinking: "",
    type: "done",
  });
}

function tool(name: string, toolCallId: string): CodingRoundEvent {
  return Object.freeze({
    call: Object.freeze({ arguments: Object.freeze({ path: "src/a.ts" }), name, toolCallId }),
    type: "tool_call",
  });
}

class DeterministicExecutor implements AiCoderRuntimeToolExecutor {
  readonly calls: CodingToolCall[] = [];
  readonly definitions = Object.freeze([
    ...["git_diff", "project_validate", "workspace_list", "workspace_write"].map((name) => Object.freeze({
      function: Object.freeze({ description: "deterministic test tool", name, parameters: Object.freeze({ type: "object" }) }),
      type: "function" as const,
    })),
  ]);

  async getToolSet() {
    return Object.freeze({
      canonicalToolIds: Object.freeze({
        git_diff: "git.diff",
        project_validate: "project_validate",
        workspace_list: "workspace_list",
        workspace_write: "workspace_write",
      }),
      definitions: this.definitions,
      effectCapabilities: Object.freeze({
        "git.diff": Object.freeze(["diff_review" as const]),
        project_validate: Object.freeze(["validate" as const]),
        workspace_list: Object.freeze(["inspect" as const]),
        workspace_write: Object.freeze(["write" as const]),
      }),
      snapshotHash: "sha256:tool-set",
    });
  }

  async execute(call: CodingToolCall, _context: ToolExecutionContext): Promise<AiCoderRuntimeToolResult> {
    this.calls.push(call);
    const effects = call.name === "workspace_list"
      ? Object.freeze({ inspectedPaths: Object.freeze(["src"]) })
      : call.name === "workspace_write"
        ? Object.freeze({ writes: Object.freeze([Object.freeze({ afterHash: "after", beforeHash: "before", path: "src/a.ts" })]) })
        : call.name === "project_validate"
          ? Object.freeze({ validations: Object.freeze([Object.freeze({ detail: "unit tests pass", id: "unit", scope: "workspace" as const, status: "passed" as const })]) })
          : call.name === "git_diff"
            ? Object.freeze({ diffReview: Object.freeze({ diffHash: "sha256:final-diff" }) })
            : undefined;
    return Object.freeze({
      canonicalToolId: call.name === "git_diff" ? "git.diff" : call.name,
      content: JSON.stringify({ ok: true, tool: call.name }),
      ...(effects ? { effects, effectsAuthority: "host" as const } : {}),
      ok: true,
      summary: `${call.name} succeeded`,
      trust: "workspace",
    });
  }
}

class MemoryStore implements AiCoderRunStore {
  readonly checkpointTrust = "trusted_host" as const;
  readonly checkpoints: AiCoderRunCheckpoint[] = [];
  readonly reports: AiCoderFinalReport[] = [];

  async loadLatestCheckpoint(runId: string) {
    return [...this.checkpoints].reverse().find((item) => item.runId === runId) ?? null;
  }

  async saveCheckpoint(checkpoint: AiCoderRunCheckpoint) {
    this.checkpoints.push(checkpoint);
    return Object.freeze({ artifactRef: `memory://${checkpoint.contentHash}` });
  }

  async saveFinalReport(report: AiCoderFinalReport) {
    this.reports.push(report);
  }
}

const deterministicWorkspaceVerifier: AiCoderResumeWorkspaceVerifier = Object.freeze({
  consistency: "serialized_workspace" as const,
  async capture(input: Parameters<AiCoderResumeWorkspaceVerifier["capture"]>[0]) {
    return portSuccess(Object.freeze({
      activeFiles: input.activeFiles,
      dirtyStateSummary: input.dirtyStateSummary,
      stateFingerprint: "sha256:deterministic-workspace",
    }));
  },
  async verify(snapshot: Parameters<AiCoderResumeWorkspaceVerifier["verify"]>[0]) {
    return portSuccess(Object.freeze({
      currentFingerprint: snapshot.stateFingerprint,
      matches: snapshot.stateFingerprint === "sha256:deterministic-workspace",
    }));
  },
});

function request(runId = "run-test"): AiCoderRunRequest {
  return Object.freeze({
    budget: Object.freeze({ maxCompletionRejections: 3, maxModelRetries: 0, maxToolCalls: 20, maxTurns: 12 }),
    goal: "Inspect and complete the deterministic task",
    promptHash: "sha256:prompt",
    promptVersion: "1.0.0",
    runId,
    systemPrompt: "You are the deterministic Galaxy AI Coder test agent.",
    taskId: "task-test",
    workspaceRoot: "/workspace",
  });
}

test("operational states allow evidence-driven phase changes and terminals remain closed", () => {
  const operational: AiCoderRunState[] = ["inspecting", "planning", "executing", "validating", "reviewing"];
  for (const from of operational) {
    for (const to of operational) {
      const machine = new AiCoderRunStateMachine(from, () => "2026-08-28T00:00:00.000Z");
      assert.doesNotThrow(() => machine.transition(to, "table test"), `${from} -> ${to}`);
    }
  }
  for (const terminal of ["completed", "failed", "cancelled", "paused"] as const) {
    const machine = new AiCoderRunStateMachine(terminal);
    assert.throws(() => machine.transition("inspecting", "invalid"));
  }
});

test("completion gate permits inspected read-only work and requires validation plus final diff review after writes", () => {
  const base = {
    acceptanceCriteria: Object.freeze([]),
    finalReport: "Done",
    finalReportStored: true,
    inspectedWorkspace: true,
    pendingApprovals: 0,
    runningToolCalls: 0,
    tokenLedgerFinalized: true,
    traceFinalized: true,
    finalWorkspaceFingerprint: "sha256:workspace-final",
  } as const;
  assert.equal(evaluateAiCoderCompletion({
    ...base,
    finalDiffReview: null,
    validations: Object.freeze([]),
    writes: Object.freeze([]),
  }).ok, true);

  const write = Object.freeze({
    afterHash: "after",
    beforeHash: "before",
    path: "src/a.ts",
    sequence: 2,
    toolCallId: "write-1",
    workspaceFingerprint: "sha256:workspace-after-write",
  });
  const missing = evaluateAiCoderCompletion({
    ...base,
    finalDiffReview: null,
    validations: Object.freeze([]),
    writes: Object.freeze([write]),
  });
  assert.deepEqual(new Set(missing.issues.map((item) => item.code)), new Set(["WRITE_NOT_VALIDATED", "DIFF_NOT_REVIEWED"]));
  const complete = evaluateAiCoderCompletion({
    ...base,
    finalDiffReview: Object.freeze({
      diffHash: "sha256:final-diff",
      sequence: 4,
      workspaceFingerprint: "sha256:workspace-final",
    }),
    validations: Object.freeze([Object.freeze({
      detail: "pass",
      id: "unit",
      scope: "workspace" as const,
      sequence: 3,
      status: "passed" as const,
      workspaceFingerprint: "sha256:workspace-final",
    })]),
    writes: Object.freeze([write]),
  });
  assert.equal(complete.ok, true);
});

test("completion gate rejects waived required criteria, stale evidence, and later same-sequence failures", () => {
  const fingerprint = "sha256:workspace-final";
  const base = Object.freeze({
    acceptanceCriteria: Object.freeze([Object.freeze({
      evidenceIds: Object.freeze(["waiver"]),
      id: "required-behavior",
      required: true,
      status: "waived" as const,
      text: "Required behavior exists",
    })]),
    finalDiffReview: null,
    finalReport: "Done",
    finalReportStored: true,
    finalWorkspaceFingerprint: fingerprint,
    inspectedWorkspace: true,
    pendingApprovals: 0,
    runningToolCalls: 0,
    tokenLedgerFinalized: true,
    traceFinalized: true,
    writes: Object.freeze([]),
  });
  const sameSequence = evaluateAiCoderCompletion({
    ...base,
    validations: Object.freeze([
      Object.freeze({ detail: "pass", id: "unit", scope: "workspace" as const, sequence: 3, status: "passed" as const, workspaceFingerprint: fingerprint }),
      Object.freeze({ detail: "fail", id: "unit", scope: "workspace" as const, sequence: 3, status: "failed" as const, workspaceFingerprint: fingerprint }),
    ]),
  });
  assert.deepEqual(
    new Set(sameSequence.issues.map((item) => item.code)),
    new Set(["ACCEPTANCE_CRITERIA_OPEN", "VALIDATION_FAILED"]),
  );

  const stale = evaluateAiCoderCompletion({
    ...base,
    acceptanceCriteria: Object.freeze([]),
    validations: Object.freeze([Object.freeze({
      detail: "pass",
      id: "unit",
      scope: "workspace" as const,
      sequence: 3,
      status: "passed" as const,
      workspaceFingerprint: "sha256:stale",
    })]),
  }, Object.freeze({ requireValidation: true }));
  assert.deepEqual(
    new Set(stale.issues.map((item) => item.code)),
    new Set(["VALIDATION_MISSING", "WORKSPACE_EVIDENCE_STALE"]),
  );
});

test("runtime rejects host effects outside the canonical tool capability policy", async () => {
  class ForgedEffectExecutor extends DeterministicExecutor {
    override async execute(_call: CodingToolCall): Promise<AiCoderRuntimeToolResult> {
      return Object.freeze({
        canonicalToolId: "workspace_list",
        content: "forged",
        effects: Object.freeze({
          writes: Object.freeze([Object.freeze({ afterHash: "after", beforeHash: "before", path: "src/a.ts" })]),
        }),
        effectsAuthority: "host",
        ok: true,
        summary: "forged write",
        trust: "trusted",
      });
    }
  }
  const model = new ScriptedModel([
    Object.freeze([tool("workspace_list", "forged"), done("", "tool_calls")]),
  ]);
  const result = await new AiCoderRunController({ model, toolExecutor: new ForgedEffectExecutor() })
    .start(request("run-forged-effects")).result;
  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "TOOL_EXECUTION");
});

test("runtime rejects multiple tool calls until batch and approval semantics are explicit", async () => {
  const model = new ScriptedModel([
    Object.freeze([
      tool("workspace_list", "first"),
      tool("workspace_list", "second"),
      done("", "tool_calls"),
    ]),
  ]);
  const result = await new AiCoderRunController({ model, toolExecutor: new DeterministicExecutor() })
    .start(request("run-multiple-tools")).result;
  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "INVALID_MODEL_STREAM");
});

test("run controller completes a correlated read-only tool loop", async () => {
  const model = new ScriptedModel([
    Object.freeze([tool("workspace_list", "call-inspect"), done("", "tool_calls")]),
    Object.freeze([done("Workspace inspected successfully.")]),
  ]);
  const executor = new DeterministicExecutor();
  const controller = new AiCoderRunController({ model, toolExecutor: executor });
  const result = await controller.start(request()).result;
  assert.equal(result.state, "completed");
  assert.equal(result.content, "Workspace inspected successfully.");
  assert.ok(result.transitions.some((item) => item.to === "reviewing"));
  assert.equal(model.requests[1]?.messages.some((message) => message.role === "tool" && message.toolCallId === "call-inspect"), true);
});

test("configured trace must durably flush before completion", async () => {
  const model = new ScriptedModel([
    Object.freeze([tool("workspace_list", "inspect-trace"), done("", "tool_calls")]),
    Object.freeze([done("Should not complete with an unflushed trace.")]),
  ]);
  const baseRequest = request("run-trace-flush");
  const controller = new AiCoderRunController({
    model,
    toolExecutor: new DeterministicExecutor(),
    trace: Object.freeze({
      async emit() { return portSuccess(undefined); },
      async flush() {
        return portFailure({ code: "IO_ERROR", message: "flush failed", retryable: false });
      },
    }),
  });
  const result = await controller.start({
    ...baseRequest,
    budget: Object.freeze({ ...baseRequest.budget, maxCompletionRejections: 1 }),
  }).result;
  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "NO_PROGRESS");
});

test("mutation cannot complete until a later validation and final diff review", async () => {
  const rejected: string[][] = [];
  const model = new ScriptedModel([
    Object.freeze([tool("workspace_list", "inspect"), done("", "tool_calls")]),
    Object.freeze([tool("workspace_write", "write"), done("", "tool_calls")]),
    Object.freeze([done("Premature")]),
    Object.freeze([tool("project_validate", "validate"), done("", "tool_calls")]),
    Object.freeze([done("Still premature")]),
    Object.freeze([tool("git_diff", "diff"), done("", "tool_calls")]),
    Object.freeze([done("Implemented, validated, and reviewed.")]),
  ]);
  const controller = new AiCoderRunController({
    model,
    onEvent(event) {
      if (event.type === "completion_rejected") rejected.push([...event.issues]);
    },
    resumeWorkspaceVerifier: deterministicWorkspaceVerifier,
    toolExecutor: new DeterministicExecutor(),
  });
  const result = await controller.start(request("run-mutation")).result;
  assert.equal(result.state, "completed");
  assert.equal(result.writes.length, 1);
  assert.equal(result.validation.at(-1)?.status, "passed");
  assert.equal(rejected.length, 2);
  assert.ok(rejected[0]?.some((item) => item.startsWith("WRITE_NOT_VALIDATED")));
  assert.ok(rejected[0]?.some((item) => item.startsWith("DIFF_NOT_REVIEWED")));
  assert.deepEqual(rejected[1]?.map((item) => item.split(":")[0]), ["DIFF_NOT_REVIEWED"]);
});

test("pause creates a checkpoint and resume uses a fresh state machine", async () => {
  let waitingResolve: (() => void) | null = null;
  const waiting = new Promise<void>((resolve) => { waitingResolve = resolve; });
  const waitRound = (context: RunExecutionContext): AsyncIterable<CodingRoundEvent> => (async function* stream() {
    waitingResolve?.();
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(context.signal.reason);
      if (context.signal.aborted) abort();
      else context.signal.addEventListener("abort", abort, { once: true });
    });
  })();
  const store = new MemoryStore();
  const executor = new DeterministicExecutor();
  const firstModel = new ScriptedModel([
    Object.freeze([tool("workspace_list", "inspect-before-pause"), done("", "tool_calls")]),
    waitRound,
  ]);
  const firstController = new AiCoderRunController({
    model: firstModel,
    resumeWorkspaceVerifier: deterministicWorkspaceVerifier,
    store,
    toolExecutor: executor,
  });
  const handle = firstController.start(request("run-resume"));
  await waiting;
  handle.pause("test pause");
  const paused = await handle.result;
  assert.equal(paused.state, "paused");
  assert.ok(paused.checkpoint);
  assert.doesNotMatch(JSON.stringify(paused.checkpoint), /password|super-secret|api_key|user@/i);
  assert.equal(store.checkpoints.length, 1);

  const resumedModel = new ScriptedModel([Object.freeze([done("Resumed from durable state.")])]);
  const resumedController = new AiCoderRunController({
    model: resumedModel,
    resumeWorkspaceVerifier: deterministicWorkspaceVerifier,
    store,
    toolExecutor: executor,
  });
  const resumed = await resumedController.resume({ ...request("run-resume"), runId: "run-resume" }).result;
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.content, "Resumed from durable state.");
  assert.ok(resumed.transitions.some((item) => item.to === "resuming"));
  assert.equal(resumed.transitions.some((item) => item.from === "paused"), false);

  const untrustedDirectResume = await new AiCoderRunController({
    model: new ScriptedModel([Object.freeze([done("must not run")])]),
    resumeWorkspaceVerifier: deterministicWorkspaceVerifier,
    toolExecutor: executor,
  }).resume({
    ...request("run-resume"),
    checkpoint: paused.checkpoint!,
    runId: "run-resume",
  }).result;
  assert.equal(untrustedDirectResume.state, "failed");
  assert.equal(untrustedDirectResume.error?.code, "CHECKPOINT_INCOMPATIBLE");
});

test("provider token count triggers checkpoint compaction before a model request", async () => {
  const store = new MemoryStore();
  const events: string[] = [];
  const model = new ScriptedModel([
    Object.freeze([tool("workspace_list", "inspect-after-compact"), done("", "tool_calls")]),
    Object.freeze([done("Completed after compaction.")]),
  ], [1_000_000, 500, 500]);
  const controller = new AiCoderRunController({
    model,
    onEvent(event) { if (event.type === "checkpoint") events.push(event.reason); },
    store,
    toolExecutor: new DeterministicExecutor(),
  });
  const result = await controller.start(request("run-compact")).result;
  assert.equal(result.state, "completed");
  assert.ok(events.includes("provider_overflow"));
  assert.ok(store.checkpoints.some((item) => item.reason === "provider_overflow"));
});

test("cancel propagates to an active model stream", async () => {
  let startedResolve: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const blockingRound = (context: RunExecutionContext): AsyncIterable<CodingRoundEvent> => (async function* stream() {
    startedResolve?.();
    await new Promise<never>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    });
  })();
  const model = new ScriptedModel([blockingRound]);
  const controller = new AiCoderRunController({ model, toolExecutor: new DeterministicExecutor() });
  const handle = controller.start(request("run-cancel"));
  await started;
  handle.cancel("test cancellation");
  const result = await handle.result;
  assert.equal(result.state, "cancelled");
  assert.equal(result.error?.code, "CANCELED");
});
