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
  throw new Error("Usage: cross-process-resume-worker <pause|resume> <workspace> <store>");
}

const runId = "cross-process-durable-run";
const taskId = "cross-process-durable-task";
const signal = new AbortController().signal;
const setupContext: ToolExecutionContext = Object.freeze({
  deadline: Date.now() + 120_000,
  idempotencyKey: "cross-process-setup",
  mode: "auto",
  runId,
  signal,
  taskId,
  toolCallId: "cross-process-setup",
  workspaceRoot: workspacePath,
});
const workspace = await NodeWorkspacePort.create(workspacePath);
const command = await NodeCommandPort.create(workspacePath, { containment: "best_effort" });

if (stage === "pause") {
  for (const file of [
    { path: "README.md", content: "# Durable resume fixture\n" },
    { path: "package.json", content: "{\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"node --test test.mjs\" }\n}\n" },
    { path: "test.mjs", content: "import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport test from 'node:test';\ntest('durable output', async () => assert.equal(await readFile(new URL('hello.txt', import.meta.url), 'utf8'), 'hello\\n'));\n" },
  ]) {
    const arranged = await workspace.writeText({
      ...file,
      precondition: { kind: "must_not_exist" },
    }, setupContext);
    if (!arranged.ok) throw new Error(`Unable to arrange workspace: ${arranged.error.message}`);
  }
  for (const gitCommand of [
    "git init --quiet",
    "git add -A",
    "git -c user.name=GalaxyFixture -c user.email=fixture@local.invalid commit --quiet -m baseline",
  ]) {
    const result = await command.run({ command: gitCommand, cwd: ".", timeoutMs: 20_000 }, setupContext);
    if (!result.ok || result.data.exitCode !== 0) throw new Error(`Unable to create Git baseline: ${gitCommand}`);
  }
}

const model = new ScriptedCodingModel(stage === "pause" ? [
  { toolCalls: [{ toolCallId: "inspect", toolName: "list_files", arguments: { path: ".", depth: 2 } }], finishReason: "tool_calls" },
  { toolCalls: [{
    toolCallId: "write",
    toolName: "write_file",
    arguments: { path: "hello.txt", content: "hello\n", precondition: { kind: "must_not_exist" } },
  }], finishReason: "tool_calls" },
  { toolCalls: [{
    toolCallId: "validate",
    toolName: "validate_project",
    arguments: { path: ".", checks: ["test"], timeoutMs: 30_000 },
  }], finishReason: "tool_calls" },
  { toolCalls: [{ toolCallId: "diff", toolName: "git_operation", arguments: { action: "diff", paths: ["hello.txt"] } }], finishReason: "tool_calls" },
] : [
  { content: "Resumed from the durable checkpoint. hello.txt was created and the final Git diff was reviewed." },
]);
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
    deadlineMs: 120_000,
    maxCompletionRejections: 2,
    maxModelRetries: 0,
    maxToolCalls: 12,
    maxTurns: 8,
    persistenceGraceMs: 10_000,
  }),
  completion: Object.freeze({
    requireFinalReportPersistence: true,
    requireInspection: true,
    requireTokenLedger: true,
    requireTrace: true,
    requireValidation: false,
  }),
  constraints: Object.freeze(["Create only hello.txt, run the declared project test, and review the final Git diff."]),
  goal: "Inspect the project, create hello.txt containing hello plus one newline, validate the project, review the final Git diff, and report verified results.",
  mode: "auto",
  prompt: Object.freeze({
    approvalProfile: "trusted-workspace",
    complexity: "standard",
    dirtyStateSummary: "Cross-process fixture starts from a committed Git baseline.",
    hostEnvironment: command.hostEnvironment,
    networkAccess: "denied",
    writeAccess: "allowed",
  }),
  runId,
  taskId,
  workspaceRoot: workspacePath,
});
const events: AiCoderRuntimeEvent[] = [];
let handle: AiCoderRunHandle | null = null;
const controller = new AiCoderRunController({
  executionIdFactory: () => `cross-process-${stage}-${process.pid}`,
  model,
  onEvent: (event) => {
    events.push(event);
    if (stage === "pause" && event.type === "tool_result" && event.call.toolCallId === "diff") {
      handle?.pause("Intentional process boundary after complete workspace evidence.");
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
  checkpointDiff: checkpoint?.completionEvidence.diffReview ?? null,
  checkpointHash: checkpoint?.contentHash ?? null,
  checkpointOpenProblems: checkpoint?.openProblems ?? [],
  checkpointWorkspaceFingerprint: checkpoint?.workspace.stateFingerprint ?? null,
  errorCode: result.error?.code ?? null,
  errorMessage: result.error?.message ?? null,
  finalReportStored: finalReport !== null,
  firstRequestToolCount: model.requests[0]?.tools.length ?? null,
  modelRequests: model.requests.length,
  pid: process.pid,
  state: result.state,
  toolStarts: events.filter((event) => event.type === "tool_start").length,
  writes: result.writes.map((write) => write.path),
}));
