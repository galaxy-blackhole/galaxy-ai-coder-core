import {
  AiCoderRunController,
  type AiCoderRunHandle,
  type AiCoderRunRequest,
  type AiCoderRuntimeEvent,
  type ToolExecutionContext,
} from "@galaxy-stack/ai-coder-core";

import { FileRunStore } from "../../src/host/file-run-store.js";
import { MemoryTracePort } from "../../src/host/memory-trace-port.js";
import { NodeCommandPort } from "../../src/host/node-command-port.js";
import { NodeWorkspaceEvidenceVerifier } from "../../src/host/node-workspace-evidence-verifier.js";
import { NodeWorkspacePort } from "../../src/host/node-workspace-port.js";
import { createFixtureApprovalPort } from "../../src/lab/fixture-approval.js";
import { ScriptedCodingModel } from "../../src/lab/scripted-model.js";
import { LabToolExecutor } from "../../src/lab/tool-executor.js";

const [stage, workspacePath, storePath] = process.argv.slice(2);
if (!(stage === "pause" || stage === "resume") || !workspacePath || !storePath) {
  throw new Error("Usage: compaction-resume-worker <pause|resume> <workspace> <store>");
}

const runId = "long-compaction-cross-process";
const taskId = "long-compaction-cross-process-task";
const signal = new AbortController().signal;
const setup: ToolExecutionContext = Object.freeze({
  deadline: Date.now() + 180_000,
  idempotencyKey: "long-compaction-setup",
  mode: "auto",
  runId,
  signal,
  taskId,
  toolCallId: "long-compaction-setup",
  workspaceRoot: workspacePath,
});
const workspace = await NodeWorkspacePort.create(workspacePath);
const command = await NodeCommandPort.create(workspacePath, { containment: "best_effort" });

if (stage === "pause") {
  for (const file of [
    {
      path: "SPEC.md",
      content: "Implement calculateTotal(lines): validate positive integer quantity and integer unitPriceCents, then return the integer sum.\n",
    },
    {
      path: "package.json",
      content: "{\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"node --test test.mjs\" }\n}\n",
    },
    {
      path: "test.mjs",
      content: "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { calculateTotal } from './src/order.mjs';\ntest('total', () => { assert.equal(calculateTotal([{ quantity: 2, unitPriceCents: 4950 }, { quantity: 1, unitPriceCents: 990 }]), 10890); assert.throws(() => calculateTotal([{ quantity: 0, unitPriceCents: 1 }]), /quantity/i); });\n",
    },
  ]) {
    const result = await workspace.writeText({ ...file, precondition: { kind: "must_not_exist" } }, setup);
    if (!result.ok) throw new Error(`Unable to arrange ${file.path}: ${result.error.message}`);
  }
  for (const value of [
    "git init --quiet",
    "git add -A",
    "git -c user.name=GalaxyFixture -c user.email=fixture@local.invalid commit --quiet -m baseline",
  ]) {
    const result = await command.run({ command: value, cwd: ".", timeoutMs: 20_000 }, setup);
    if (!result.ok || result.data.exitCode !== 0) throw new Error(`Unable to create Git baseline: ${value}`);
  }
}

const pauseRounds = [
  { toolCalls: [{ toolCallId: "detect", toolName: "detect_project", arguments: { path: "." } }], finishReason: "tool_calls" as const },
  { toolCalls: [{ toolCallId: "spec", toolName: "read_file", arguments: { path: "SPEC.md" } }], finishReason: "tool_calls" as const },
  { toolCalls: [{ toolCallId: "tests", toolName: "read_file", arguments: { path: "test.mjs" } }], finishReason: "tool_calls" as const },
  { toolCalls: [{
    toolCallId: "write", toolName: "write_file",
    arguments: {
      path: "src/order.mjs",
      content: "export function calculateTotal(lines) {\n  return lines.reduce((sum, line) => {\n    if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new Error('quantity must be a positive integer');\n    if (!Number.isInteger(line.unitPriceCents)) throw new Error('unitPriceCents must be an integer');\n    return sum + line.quantity * line.unitPriceCents;\n  }, 0);\n}\n",
      precondition: { kind: "must_not_exist" },
    },
  }], finishReason: "tool_calls" as const },
  { toolCalls: [{ toolCallId: "verify", toolName: "read_file", arguments: { path: "src/order.mjs" } }], finishReason: "tool_calls" as const },
  { toolCalls: [{
    toolCallId: "validate", toolName: "validate_project",
    arguments: { path: ".", checks: ["test"], timeoutMs: 30_000 },
  }], finishReason: "tool_calls" as const },
];
const resumeRounds = [
  { toolCalls: [{ toolCallId: "search", toolName: "search_text", arguments: { path: ".", query: "calculateTotal", maxResults: 20 } }], finishReason: "tool_calls" as const },
  { toolCalls: [{ toolCallId: "diff", toolName: "git_operation", arguments: { action: "diff", paths: ["src/order.mjs"] } }], finishReason: "tool_calls" as const },
  { content: "Resumed after repeated compaction. The implementation, passing validation, and final structured Git diff are verified.", finishReason: "stop" as const },
];
const rounds = stage === "pause" ? pauseRounds : resumeRounds;
const tokenCountSteps = rounds.flatMap(() => [110_000, 20_000]);
const model = new ScriptedCodingModel(rounds, { tokenCountSteps });
const store = await FileRunStore.create(storePath);
const trace = new MemoryTracePort();
const verifier = await NodeWorkspaceEvidenceVerifier.create(workspacePath);
const executor = new LabToolExecutor({
  approval: createFixtureApprovalPort({ "project.validate": "allow" }),
  approvalProfile: "trusted-workspace",
  capabilities: model.capabilitiesSnapshot,
  command,
  enableGit: true,
  workspace,
});
const request: AiCoderRunRequest = Object.freeze({
  budget: Object.freeze({
    deadlineMs: 180_000,
    maxCompletionRejections: 2,
    maxModelRetries: 0,
    maxToolCalls: 12,
    maxTurns: 12,
    persistenceGraceMs: 10_000,
  }),
  completion: Object.freeze({
    requireFinalReportPersistence: true,
    requireInspection: true,
    requireTokenLedger: true,
    requireTrace: true,
    requireValidation: true,
  }),
  constraints: Object.freeze(["Create only src/order.mjs, preserve the specification and tests, validate, and review the final Git diff."]),
  goal: "Inspect the existing project and specification, implement src/order.mjs, validate it, review the final Git diff, and preserve progress across context compaction and process restart.",
  mode: "auto",
  prompt: Object.freeze({
    approvalProfile: "trusted-workspace",
    complexity: "complex",
    dirtyStateSummary: "Committed test fixture baseline.",
    hostEnvironment: command.hostEnvironment,
    networkAccess: "denied",
    writeAccess: "allowed",
  }),
  runId,
  taskId,
  tokenProfile: "conservative",
  workspaceRoot: workspacePath,
});
const events: AiCoderRuntimeEvent[] = [];
let handle: AiCoderRunHandle | null = null;
const controller = new AiCoderRunController({
  executionIdFactory: () => `long-compaction-${stage}-${process.pid}`,
  model,
  onEvent: (event) => {
    events.push(event);
    if (stage === "pause" && event.type === "tool_result" && event.call.toolCallId === "validate") {
      handle?.pause("Intentional process interruption after repeated compaction and current validation.");
    }
  },
  resumeWorkspaceVerifier: verifier,
  store,
  toolExecutor: executor,
  trace,
});
handle = stage === "pause"
  ? controller.start(request)
  : controller.resume(Object.freeze({ ...request, runId }));
const result = await handle.result;
const checkpoint = await store.loadLatestCheckpoint(runId, Object.freeze({
  deadline: Date.now() + 30_000,
  mode: "auto",
  runId,
  signal: new AbortController().signal,
  taskId,
  workspaceRoot: workspacePath,
}));
const finalReport = await store.loadFinalReport(runId);

process.stdout.write(JSON.stringify({
  checkpointCompactions: checkpoint?.totals.compactionCount ?? null,
  checkpointHash: checkpoint?.contentHash ?? null,
  checkpointReason: checkpoint?.reason ?? null,
  compactTransitions: result.transitions.filter((transition) => transition.to === "compacting").length,
  errorCode: result.error?.code ?? null,
  finalReportStored: finalReport !== null,
  firstRequestContainsOriginalTask: model.requests[0]?.messages.some((message) => message.content.includes(request.goal)) ?? false,
  firstRequestContainsCheckpoint: model.requests[0]?.messages.some((message) => message.content.includes("[GALAXY VERIFIED TASK CHECKPOINT")) ?? false,
  modelRequests: model.requests.length,
  pid: process.pid,
  state: result.state,
  tokenCountSteps: model.consumedTokenCountSteps,
  toolSequence: events.filter((event) => event.type === "tool_start").map((event) => event.call.name),
  validation: result.validation.map((item) => ({ id: item.id, status: item.status })),
  writes: result.writes.map((item) => item.path),
}));
