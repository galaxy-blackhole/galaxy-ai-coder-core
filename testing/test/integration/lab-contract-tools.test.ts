import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AI_CODER_CORE_TOOL_CATALOG,
  type AiCoderRuntimeToolResult,
  type CodingToolCall,
  type ToolExecutionContext,
} from "@galaxy-stack/ai-coder-core";

import { sha256Text } from "../../src/host/content-hash.js";
import { NodeCommandPort } from "../../src/host/node-command-port.js";
import { NodeWorkspacePort } from "../../src/host/node-workspace-port.js";
import { createFixtureApprovalPort } from "../../src/lab/fixture-approval.js";
import { SCRIPTED_MODEL_CAPABILITIES } from "../../src/lab/scripted-model.js";
import {
  LAB_AVAILABLE_TOOL_IDS,
  LAB_FULL_CONTRACT_TOOL_IDS,
  LAB_OPTIONAL_CONTRACT_TOOL_IDS,
  LabToolExecutor,
} from "../../src/lab/tool-executor.js";

function context(workspaceRoot: string, id: string): ToolExecutionContext {
  return Object.freeze({
    deadline: Date.now() + 30_000,
    idempotencyKey: id,
    mode: "auto",
    runId: "run-contract-tools",
    signal: new AbortController().signal,
    taskId: "task-contract-tools",
    toolCallId: id,
    workspaceRoot,
  });
}

async function executor(
  workspaceRoot: string,
  options: Readonly<{
    approvals?: Readonly<Record<string, "allow" | "deny">>;
    profile?: "default" | "flag" | "named";
  }> = {},
): Promise<LabToolExecutor> {
  const workspace = await NodeWorkspacePort.create(workspaceRoot);
  const command = await NodeCommandPort.create(workspaceRoot);
  const profile = options.profile ?? "flag";
  const result = new LabToolExecutor({
    approval: createFixtureApprovalPort(options.approvals),
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    command,
    enableGit: true,
    ...(profile === "flag" ? { enableContractTools: true } : {}),
    ...(profile === "named" ? { toolProfile: "full_contract" as const } : {}),
    workspace,
  });
  await result.getToolSet(context(workspaceRoot, `initialize-${profile}`));
  return result;
}

async function execute(
  target: LabToolExecutor,
  workspaceRoot: string,
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
  id: string,
): Promise<AiCoderRuntimeToolResult> {
  const call: CodingToolCall = Object.freeze({ arguments: argumentsValue, name, toolCallId: id });
  return target.execute(call, context(workspaceRoot, id));
}

async function activate(
  target: LabToolExecutor,
  workspaceRoot: string,
  canonicalToolId: string,
): Promise<void> {
  const activation = await execute(target, workspaceRoot, "search_tools", {
    query: canonicalToolId,
    limit: 1,
  }, `activate-${canonicalToolId}`);
  assert.equal(activation.ok, true, activation.error?.message);
  const output = JSON.parse(activation.content) as { activated: string[]; matches: { id: string }[] };
  assert.equal(output.matches[0]?.id, canonicalToolId);
  assert.equal(output.activated.includes(canonicalToolId), true);
}

function modelName(canonicalToolId: string): string {
  const descriptor = AI_CODER_CORE_TOOL_CATALOG.find((tool) => tool.id === canonicalToolId);
  assert.ok(descriptor, `Missing core descriptor for ${canonicalToolId}.`);
  return descriptor.modelName;
}

async function activateAll(
  target: LabToolExecutor,
  workspaceRoot: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) await activate(target, workspaceRoot, id);
}

function output<T>(result: AiCoderRuntimeToolResult): T {
  assert.equal(result.ok, true, result.error?.message);
  return JSON.parse(result.content) as T;
}

test("contract tools are opt-in and the named full profile covers all 21 canonical IDs", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-contract-profile-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const defaultExecutor = await executor(workspaceRoot, { profile: "default" });
  await activateAll(defaultExecutor, workspaceRoot, LAB_AVAILABLE_TOOL_IDS);
  const defaultSet = await defaultExecutor.getToolSet(context(workspaceRoot, "default-set"));
  assert.deepEqual(
    [...Object.values(defaultSet.canonicalToolIds)].sort(),
    [...LAB_AVAILABLE_TOOL_IDS].sort(),
  );
  const unavailable = await execute(defaultExecutor, workspaceRoot, "search_tools", {
    query: "artifact.create",
    limit: 1,
  }, "default-artifact-search");
  assert.deepEqual(output<{ matches: unknown[] }>(unavailable).matches, []);

  const fullExecutor = await executor(workspaceRoot, { profile: "named" });
  await activateAll(fullExecutor, workspaceRoot, LAB_FULL_CONTRACT_TOOL_IDS);
  const fullSet = await fullExecutor.getToolSet(context(workspaceRoot, "full-set"));
  const canonicalIds = [...Object.values(fullSet.canonicalToolIds)].sort();
  assert.equal(new Set(canonicalIds).size, 21);
  assert.deepEqual(canonicalIds, AI_CODER_CORE_TOOL_CATALOG.map((tool) => tool.id).sort());
  assert.deepEqual(canonicalIds, [...LAB_FULL_CONTRACT_TOOL_IDS].sort());
  assert.equal(LAB_OPTIONAL_CONTRACT_TOOL_IDS.length, 9);
});

test("research and user contract doubles return deterministic provenance and preserve approval denial", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-contract-research-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const allowed = await executor(workspaceRoot, {
    approvals: { "research.fetch": "allow", "research.search": "allow" },
  });
  await activateAll(allowed, workspaceRoot, ["research.fetch", "research.search", "user.ask"]);

  const fetched = await execute(allowed, workspaceRoot, modelName("research.fetch"), {
    url: "https://example.com/docs",
    maxBytes: 256,
  }, "fetch-success");
  const fetchedOutput = output<{
    content: string;
    contentHash: string;
    provenance: { contentHash: string; source: string; trust: string };
    truncated: boolean;
    url: string;
  }>(fetched);
  assert.equal(fetched.effects?.approval, "granted");
  assert.equal(fetchedOutput.truncated, true);
  assert.match(fetchedOutput.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(fetchedOutput.provenance.contentHash, fetchedOutput.contentHash);
  assert.equal(fetchedOutput.provenance.source, fetchedOutput.url);
  assert.equal(fetchedOutput.provenance.trust, "untrusted_external");

  const searched = await execute(allowed, workspaceRoot, modelName("research.search"), {
    query: "deterministic contracts",
    maxResults: 2,
  }, "search-success");
  const searchedOutput = output<{
    provenance: { trust: string };
    results: { provenance: { contentHash: string; trust: string }; provider: string; url: string }[];
  }>(searched);
  assert.equal(searched.effects?.approval, "granted");
  assert.equal(searchedOutput.results.length, 2);
  assert.equal(searchedOutput.provenance.trust, "untrusted_external");
  assert.equal(searchedOutput.results.every((item) => item.provenance.trust === "untrusted_external"), true);
  assert.equal(searchedOutput.results.every((item) => item.provider === "galaxy-code-contract"), true);

  const asked = await execute(allowed, workspaceRoot, modelName("user.ask"), {
    questions: [{ id: "choice", question: "Which deterministic option?" }],
  }, "ask-success");
  const askedOutput = output<{ answers: { answer: string; id: string }[]; cancelled: boolean }>(asked);
  assert.equal(askedOutput.cancelled, false);
  assert.deepEqual(askedOutput.answers, [{
    id: "choice",
    answer: "Deterministic contract answer for 'choice': Which deterministic option?",
  }]);

  const invalidCases = [
    [modelName("research.fetch"), { url: "ftp://invalid.test" }, "invalid-fetch", "INVALID_TOOL_ARGUMENTS"],
    [modelName("research.fetch"), { url: "http://localhost/private" }, "localhost-fetch", "INVALID_INPUT"],
    [modelName("research.fetch"), { url: "http://127.0.0.1/private" }, "loopback-v4-fetch", "INVALID_INPUT"],
    [modelName("research.fetch"), { url: "http://10.2.3.4/private" }, "private-v4-fetch", "INVALID_INPUT"],
    [modelName("research.fetch"), { url: "http://169.254.1.2/private" }, "link-local-v4-fetch", "INVALID_INPUT"],
    [modelName("research.fetch"), { url: "http://[::1]/private" }, "loopback-v6-fetch", "INVALID_INPUT"],
    [modelName("research.fetch"), { url: "http://[fc00::1]/private" }, "private-v6-fetch", "INVALID_INPUT"],
    [modelName("research.fetch"), { url: "http://[fe80::1]/private" }, "link-local-v6-fetch", "INVALID_INPUT"],
    [modelName("research.fetch"), { url: "https://intranet/private" }, "single-label-fetch", "INVALID_INPUT"],
    [modelName("research.search"), { query: "" }, "invalid-search", "INVALID_TOOL_ARGUMENTS"],
    [modelName("user.ask"), { questions: [] }, "invalid-ask", "INVALID_TOOL_ARGUMENTS"],
  ] as const;
  for (const [name, argumentsValue, id, expectedCode] of invalidCases) {
    const invalid = await execute(allowed, workspaceRoot, name, argumentsValue, id);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error?.code, expectedCode);
  }

  const denied = await executor(workspaceRoot, { approvals: {} });
  await activateAll(denied, workspaceRoot, ["research.fetch", "research.search"]);
  for (const [canonicalId, argumentsValue] of [
    ["research.fetch", { url: "https://example.com/denied" }],
    ["research.search", { query: "denied search" }],
  ] as const) {
    const result = await execute(
      denied,
      workspaceRoot,
      modelName(canonicalId),
      argumentsValue,
      `denied-${canonicalId}`,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "DENIED_BY_HOST");
    assert.equal(result.effects?.approval, "denied");
  }
});

test("artifact and perception doubles enforce hashes, pagination, idempotency, and lookup failures", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-contract-artifacts-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const target = await executor(workspaceRoot);
  await activateAll(target, workspaceRoot, [
    "artifact.create",
    "artifact.list",
    "artifact.read",
    "perception.analyze",
  ]);

  const firstContent = "x".repeat(400);
  const createCall = Object.freeze({
    arguments: Object.freeze({ name: "first.txt", content: firstContent, mimeType: "text/plain", retention: "durable" }),
    name: modelName("artifact.create"),
    toolCallId: "create-first",
  });
  const createContext = context(workspaceRoot, "artifact-create-key");
  const created = await target.execute(createCall, createContext);
  const replay = await target.execute(createCall, createContext);
  assert.equal(replay, created);
  const first = output<{ bytes: number; contentHash: string; id: string; mimeType: string }>(created);
  assert.equal(first.bytes, 400);
  assert.equal(first.contentHash, sha256Text(firstContent));
  assert.equal(first.mimeType, "text/plain");
  assert.match(created.effects?.stateVersion ?? "", /^sha256:[a-f0-9]{64}$/);

  const second = output<{ id: string }>(await execute(target, workspaceRoot, modelName("artifact.create"), {
    name: "second.txt",
    content: "second artifact",
    mimeType: "text/plain",
  }, "create-second"));
  assert.notEqual(second.id, first.id);

  const firstList = output<{
    artifacts: { contentHash: string; createdAt: string; id: string; kind: string }[];
    nextCursor?: string;
  }>(await execute(target, workspaceRoot, modelName("artifact.list"), {
    kind: "text",
    limit: 1,
  }, "list-first-page"));
  assert.equal(firstList.artifacts.length, 1);
  assert.equal(firstList.artifacts[0]?.id, first.id);
  assert.equal(firstList.artifacts[0]?.contentHash, first.contentHash);
  assert.equal(firstList.artifacts[0]?.createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal(firstList.nextCursor, "offset:1");
  const secondList = output<{ artifacts: { id: string }[] }>(await execute(
    target,
    workspaceRoot,
    modelName("artifact.list"),
    { kind: "text", limit: 1, cursor: firstList.nextCursor },
    "list-second-page",
  ));
  assert.equal(secondList.artifacts[0]?.id, second.id);

  const readFirst = output<{
    content: string;
    contentHash: string;
    nextCursor?: string;
    provenance: { contentHash: string; trust: string };
    truncated: boolean;
  }>(await execute(target, workspaceRoot, modelName("artifact.read"), {
    id: first.id,
    maxBytes: 256,
  }, "read-first-page"));
  assert.equal(readFirst.truncated, true);
  assert.equal(readFirst.contentHash, first.contentHash);
  assert.equal(readFirst.provenance.contentHash, first.contentHash);
  assert.equal(readFirst.provenance.trust, "untrusted_tool_output");
  const readSecond = output<{ content: string; truncated: boolean }>(await execute(
    target,
    workspaceRoot,
    modelName("artifact.read"),
    { id: first.id, maxBytes: 256, cursor: readFirst.nextCursor },
    "read-second-page",
  ));
  assert.equal(readSecond.truncated, false);
  assert.equal(`${readFirst.content}${readSecond.content}`, firstContent);

  const analyzed = output<{
    analyzer: string;
    artifactId: string;
    confidence: number;
    observations: string[];
    provenance: { contentHash: string; trust: string };
  }>(await execute(target, workspaceRoot, modelName("perception.analyze"), {
    artifactId: first.id,
    mode: "metadata",
    languages: ["en"],
  }, "analyze-success"));
  assert.equal(analyzed.artifactId, first.id);
  assert.equal(analyzed.confidence, 1);
  assert.equal(analyzed.observations.some((item) => item === "bytes=400"), true);
  assert.equal(analyzed.provenance.contentHash, first.contentHash);

  const invalidCases = [
    [modelName("artifact.create"), { name: "", content: "", mimeType: "text/plain" }, "INVALID_TOOL_ARGUMENTS"],
    [modelName("artifact.list"), { cursor: "invalid" }, "INVALID_INPUT"],
    [modelName("artifact.read"), { id: "missing" }, "NOT_FOUND"],
    [modelName("perception.analyze"), { artifactId: "missing", mode: "ocr" }, "NOT_FOUND"],
  ] as const;
  for (const [name, argumentsValue, expectedCode] of invalidCases) {
    const invalid = await execute(target, workspaceRoot, name, argumentsValue, `invalid-${name}`);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error?.code, expectedCode);
  }
});

test("session and preview doubles keep deterministic state, cursors, semantic errors, and high-risk denial", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-contract-session-preview-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const target = await executor(workspaceRoot, { approvals: { "command.session": "allow" } });
  await activateAll(target, workspaceRoot, ["command.session", "preview.manage"]);

  const startedResult = await execute(target, workspaceRoot, modelName("command.session"), {
    action: "start",
    command: "deterministic-server",
    maxChars: 64,
  }, "session-start");
  const started = output<{
    sessionId: string;
    status: string;
    stdout: string;
    stdoutCursor: string;
  }>(startedResult);
  assert.equal(startedResult.effects?.approval, "granted");
  assert.match(startedResult.effects?.stateVersion ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(started.sessionId, "session-0001");
  assert.equal(started.status, "running");
  assert.equal(started.stdout, "started:deterministic-server\n");

  const writtenResult = await execute(target, workspaceRoot, modelName("command.session"), {
    action: "write",
    sessionId: started.sessionId,
    input: "hello",
    stdoutAfter: started.stdoutCursor,
    maxChars: 64,
  }, "session-write");
  const written = output<{ stdout: string; stdoutCursor: string }>(writtenResult);
  assert.equal(written.stdout, "input:hello\n");
  assert.notEqual(writtenResult.effects?.stateVersion, startedResult.effects?.stateVersion);

  const read = output<{ stdout: string; stdoutCursor: string }>(await execute(
    target,
    workspaceRoot,
    modelName("command.session"),
    {
      action: "read",
      sessionId: started.sessionId,
      stdoutAfter: started.stdoutCursor,
      maxChars: 64,
    },
    "session-read",
  ));
  assert.equal(read.stdout, "input:hello\n");
  assert.equal(read.stdoutCursor, written.stdoutCursor);

  const openedResult = await execute(target, workspaceRoot, modelName("preview.manage"), {
    action: "open",
    command: "preview-server",
    expectPort: 4_321,
    captureArtifact: true,
  }, "preview-open");
  const opened = output<{ artifactId: string; sessionId: string; status: string; url: string }>(openedResult);
  assert.equal(opened.status, "open");
  assert.equal(opened.url, "http://127.0.0.1:4321");
  assert.match(opened.artifactId, /^artifact-\d{4}$/);
  assert.match(openedResult.effects?.stateVersion ?? "", /^sha256:[a-f0-9]{64}$/);
  const closedResult = await execute(target, workspaceRoot, modelName("preview.manage"), {
    action: "close",
    sessionId: opened.sessionId,
  }, "preview-close");
  const closed = output<{ status: string }>(closedResult);
  assert.equal(closed.status, "closed");
  assert.notEqual(closedResult.effects?.stateVersion, openedResult.effects?.stateVersion);

  for (const [name, argumentsValue, expectedCode] of [
    [modelName("command.session"), { action: "read", sessionId: "missing" }, "NOT_FOUND"],
    [modelName("preview.manage"), { action: "close", sessionId: "missing" }, "NOT_FOUND"],
  ] as const) {
    const invalid = await execute(target, workspaceRoot, name, argumentsValue, `invalid-${name}`);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error?.code, expectedCode);
  }

  const denied = await executor(workspaceRoot, { approvals: {} });
  await activate(denied, workspaceRoot, "command.session");
  const denial = await execute(denied, workspaceRoot, modelName("command.session"), {
    action: "start",
    command: "must-not-start",
  }, "session-denied");
  assert.equal(denial.ok, false);
  assert.equal(denial.error?.code, "DENIED_BY_HOST");
  assert.equal(denial.effects?.approval, "denied");
});
