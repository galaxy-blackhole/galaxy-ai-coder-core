import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ResolvedOllamaConnection } from "../../src/config/manual-provider-config.js";
import { parseLiveHealthScenario } from "../../src/domain/live-health-scenario.js";
import { nodeCommandHostEnvironment } from "../../src/host/host-environment.js";
import { loadLiveHealthScenario } from "../../src/io/load-live-health-scenario.js";
import { runLiveHealth } from "../../src/live/run-live-health.js";

function ndjsonResponse(value: unknown): Response {
  return ndjsonResponses([value]);
}

function ndjsonResponses(values: readonly unknown[]): Response {
  return new Response(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

function terminalTool(name: string, argumentsValue: Readonly<Record<string, unknown>>, id: string): Response {
  return terminalTools([{ argumentsValue, id, name }]);
}

function terminalTools(calls: readonly Readonly<{
  argumentsValue: Readonly<Record<string, unknown>>;
  id: string;
  name: string;
}>[]): Response {
  return ndjsonResponse({
    message: {
      role: "assistant",
      content: "",
      thinking: "",
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.argumentsValue },
      })),
    },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 100,
    eval_count: 10,
  });
}

const connection: ResolvedOllamaConnection = Object.freeze({
  apiKey: "integration-secret-never-report",
  baseUrl: "https://ollama.example",
  configPath: "/private/manual.json",
  credentialSource: "manual-config",
  model: "kimi-k2.7-code:cloud",
});

test("live runner installs declared npm dependencies before the mutation baseline", async (testContext) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "galaxy-live-dependencies-"));
  testContext.after(async () => rm(workspacePath, { recursive: true, force: true }));
  const scenario = parseLiveHealthScenario({
    schemaVersion: 1,
    name: "dependency-baseline",
    task: "Inspect the prepared dependency-backed project and report without changing it.",
    runtime: { dependencySetup: { packageManager: "npm", timeoutMs: 30_000 } },
    initialFiles: [{
      path: "package.json",
      content: `${JSON.stringify({ name: "dependency-baseline", private: true, version: "1.0.0" }, null, 2)}\n`,
    }],
    expected: {
      allowedChanges: [],
      files: [],
      requiredAnyCanonicalTools: [["workspace.list", "workspace.grep"]],
    },
  });
  const chatResponses = [
    terminalTool("list_files", { path: ".", depth: 2 }, "inspect-dependencies"),
    ndjsonResponse({
      message: { role: "assistant", content: "Inspected the dependency-backed project without modifying it.", thinking: "", tool_calls: [] },
      done: true,
      done_reason: "stop",
    }),
  ];

  const report = await runLiveHealth({
    connection,
    scenario,
    workspacePath,
    fetch: async (input) => String(input).endsWith("/api/show")
      ? Response.json({ capabilities: ["completion", "tools", "thinking"], model_info: { "kimi.context_length": 262_144 } })
      : chatResponses.shift() ?? Response.json({ error: "unexpected extra chat request" }, { status: 500 }),
  });

  assert.equal(report.passed, true, JSON.stringify(report.failures));
  assert.equal(report.dependencySetup?.ok, true);
  assert.equal(report.dependencySetup?.command, "npm install --ignore-scripts --no-audit --no-fund");
  assert.deepEqual(report.changedPaths, []);
  assert.equal(chatResponses.length, 0);
});

test("live runner drives the real core and tool adapters through an Ollama wire mock", async (testContext) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "galaxy-live-flow-"));
  testContext.after(async () => rm(workspacePath, { recursive: true, force: true }));
  const loadedScenario = await loadLiveHealthScenario("live/scenarios/01-write-and-validate.json");
  const scenario = Object.freeze({
    ...loadedScenario,
    expected: Object.freeze({ ...loadedScenario.expected, maxToolCalls: 4 }),
  });
  const chatResponses = [
    terminalTools([
      { name: "detect_project", argumentsValue: { path: "/absolute/path/from-model", password: "journal-private-value" }, id: "invalid-absolute-path" },
      { name: "list_files", argumentsValue: { path: ".", depth: 2 }, id: "inspect" },
    ]),
    terminalTool("write_file", {
      path: "hello.txt",
      content: "hello\n",
      precondition: { kind: "must_not_exist" },
    }, "write"),
    terminalTool("validate_project", { checks: ["test"], path: ".", timeoutMs: 30_000 }, "validate"),
    terminalTool("git_operation", { action: "diff", paths: ["hello.txt"] }, "diff"),
    ndjsonResponse({
      message: {
        role: "assistant",
        content: "Created hello.txt. The declared test passed and the final Git diff was reviewed.",
        thinking: "",
        tool_calls: [],
      },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 120,
      eval_count: 20,
    }),
  ];
  const requestBodies: string[] = [];
  const fetchMock = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer integration-secret-never-report");
    const body = String(init?.body ?? "");
    requestBodies.push(body);
    if (String(input).endsWith("/api/show")) {
      return Response.json({
        capabilities: ["completion", "tools", "thinking"],
        model_info: { "kimi.context_length": 262_144 },
      });
    }
    return chatResponses.shift() ?? Response.json({ error: "unexpected extra chat request" }, { status: 500 });
  };

  const report = await runLiveHealth({ connection, fetch: fetchMock, scenario, workspacePath });

  assert.equal(report.passed, true, JSON.stringify(report.failures));
  assert.equal(report.status, "completed");
  assert.deepEqual(report.changedPaths, ["hello.txt"]);
  assert.deepEqual(report.toolSequence, ["detect_project", "list_files", "write_file", "validate_project", "git_operation"]);
  assert.deepEqual(report.toolResults.map((item) => item.canonicalToolId), [
    "project.detect", "workspace.list", "workspace.write", "project.validate", "git.exec",
  ]);
  assert.equal(report.toolResults[0]?.errorCode, "INVALID_TOOL_ARGUMENTS");
  assert.deepEqual(report.warnings, ["Efficiency target exceeded: expected at most 4 tool calls, received 5."]);
  assert.equal(report.toolJournal.length, 5);
  assert.match(report.toolJournal[0]?.toolCallId ?? "", /provider:invalid-absolute-path$/);
  assert.match(report.toolJournal[0]?.argumentsExcerpt ?? "", /REDACTED/);
  assert.doesNotMatch(JSON.stringify(report.toolJournal), /journal-private-value/);
  assert.match(report.toolJournal[0]?.resultExcerpt ?? "", /INVALID_TOOL_ARGUMENTS/);
  assert.equal(report.validation.some((item) => item.status === "passed"), true);
  assert.equal(report.preflight?.toolCalling, "supported");
  assert.equal(report.modelDiagnostics.chatRequests, 5);
  assert.equal(chatResponses.length, 0);
  const firstChat = JSON.parse(requestBodies[1] ?? "{}") as {
    messages?: Array<{ content?: string; role?: string }>;
    tools?: Array<{ function?: { name?: string } }>;
  };
  assert.equal(firstChat.tools?.some((tool) => tool.function?.name === "git_operation"), true);
  const systemPrompt = firstChat.messages?.find((message) => message.role === "system")?.content ?? "";
  assert.equal(systemPrompt.includes(JSON.stringify(nodeCommandHostEnvironment().command)), true);
  const finalChat = JSON.parse(requestBodies.at(-1) ?? "{}") as { tools?: unknown[] };
  assert.equal(Object.hasOwn(finalChat, "tools"), false);
  assert.equal(requestBodies.every((body) => !body.includes("integration-secret-never-report")), true);
  assert.equal(JSON.stringify(report).includes("integration-secret-never-report"), false);
});

test("derived dependency mutations stay observable without crossing the durable core evidence boundary", async (testContext) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "galaxy-live-derived-evidence-"));
  testContext.after(async () => rm(workspacePath, { recursive: true, force: true }));
  const scenario = parseLiveHealthScenario({
    schemaVersion: 1,
    name: "derived-dependency-evidence",
    task: "Run the prepared mutation, validate the authored result, review its diff, and report completion.",
    mode: "auto",
    runtime: { approvalProfile: "trusted-workspace" },
    initialFiles: [
      { path: ".gitignore", content: "node_modules/\n" },
      {
        path: "package.json",
        content: `${JSON.stringify({
          name: "derived-dependency-evidence",
          private: true,
          type: "module",
          scripts: { test: "node --test tests/result.test.mjs" },
        }, null, 2)}\n`,
      },
      {
        path: "mutate.mjs",
        content: [
          "import { mkdir, writeFile } from 'node:fs/promises';",
          "await mkdir('node_modules/example', { recursive: true });",
          "await writeFile('result.txt', 'durable result\\n', 'utf8');",
          "await writeFile('node_modules/example/payload.txt', 'derived dependency state\\n', 'utf8');",
          "",
        ].join("\n"),
      },
      {
        path: "tests/result.test.mjs",
        content: "import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport test from 'node:test';\ntest('authored result', async () => assert.equal(await readFile('result.txt', 'utf8'), 'durable result\\n'));\n",
      },
    ],
    expected: {
      status: "completed",
      allowedChanges: ["result.txt"],
      files: [{ path: "result.txt", content: "durable result\n" }],
      requirePassedValidation: true,
      requiredCanonicalTools: ["command.run", "project.validate", "git.exec"],
    },
  });
  const chatResponses = [
    terminalTool("list_files", { path: ".", depth: 3 }, "inspect-derived"),
    terminalTool("run_command", {
      command: `${JSON.stringify(process.execPath)} mutate.mjs`,
      cwd: ".",
      timeoutMs: 30_000,
    }, "mutate-derived"),
    terminalTool("validate_project", { checks: ["test"], path: ".", timeoutMs: 30_000 }, "validate-derived"),
    terminalTool("git_operation", { action: "diff", paths: ["result.txt"] }, "diff-derived"),
    ndjsonResponse({
      message: {
        role: "assistant",
        content: "The authored result was created, its test passed, and the structured diff was reviewed.",
        thinking: "",
        tool_calls: [],
      },
      done: true,
      done_reason: "stop",
    }),
  ];

  const report = await runLiveHealth({
    connection,
    scenario,
    workspacePath,
    fetch: async (input) => String(input).endsWith("/api/show")
      ? Response.json({ capabilities: ["completion", "tools", "thinking"], model_info: { "kimi.context_length": 262_144 } })
      : chatResponses.shift() ?? Response.json({ error: "unexpected extra chat request" }, { status: 500 }),
  });

  assert.equal(report.passed, true, JSON.stringify(report.failures));
  assert.equal(report.status, "completed");
  assert.deepEqual(report.changedPaths, ["result.txt"]);
  assert.deepEqual(report.writes.map((write) => write.path), ["result.txt"]);
  assert.deepEqual(report.derivedMutations, {
    count: 3,
    paths: ["node_modules", "node_modules/example", "node_modules/example/payload.txt"],
    truncated: false,
  });
  assert.equal(report.error, null);
  assert.equal(chatResponses.length, 0);
});

test("live runner retries one empty Ollama terminal response and completes the same core run", async (testContext) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "galaxy-live-empty-retry-"));
  testContext.after(async () => rm(workspacePath, { recursive: true, force: true }));
  const scenario = await loadLiveHealthScenario("live/scenarios/01-write-and-validate.json");
  const chatResponses = [
    ndjsonResponse({
      message: { role: "assistant", content: "", thinking: "", tool_calls: [] },
      done: true,
      done_reason: "stop",
    }),
    terminalTool("list_files", { path: ".", depth: 2 }, "inspect-after-empty"),
    terminalTool("write_file", {
      path: "hello.txt",
      content: "hello\n",
      precondition: { kind: "must_not_exist" },
    }, "write-after-empty"),
    terminalTool("validate_project", { checks: ["test"], path: ".", timeoutMs: 30_000 }, "validate-after-empty"),
    terminalTool("git_operation", { action: "diff", paths: ["hello.txt"] }, "diff-after-empty"),
    ndjsonResponse({
      message: {
        role: "assistant",
        content: "Created hello.txt after a bounded provider retry; validation passed and the final diff was reviewed.",
        thinking: "",
        tool_calls: [],
      },
      done: true,
      done_reason: "stop",
    }),
  ];
  const report = await runLiveHealth({
    connection,
    scenario,
    workspacePath,
    fetch: async (input) => String(input).endsWith("/api/show")
      ? Response.json({ capabilities: ["completion", "tools", "thinking"], model_info: { "kimi.context_length": 262_144 } })
      : chatResponses.shift() ?? Response.json({ error: "unexpected extra chat request" }, { status: 500 }),
  });

  assert.equal(report.passed, true, JSON.stringify(report.failures));
  assert.equal(report.status, "completed");
  assert.equal(report.modelRetries.length, 1);
  assert.equal(report.modelRetries[0]?.attempt, 1);
  assert.match(report.modelRetries[0]?.message ?? "", /empty content and no tool_calls/);
  assert.equal(report.modelDiagnostics.chatRequests, 6);
  assert.deepEqual(report.toolSequence, ["list_files", "write_file", "validate_project", "git_operation"]);
  assert.equal(chatResponses.length, 0);
});

test("live runner sends retry feedback and preserves required Kimi thinking after a thinking-only turn", async (testContext) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "galaxy-live-thinking-retry-"));
  testContext.after(async () => rm(workspacePath, { recursive: true, force: true }));
  const scenario = await loadLiveHealthScenario("live/scenarios/01-write-and-validate.json");
  const chatBodies: Record<string, unknown>[] = [];
  const chatResponses = [
    ndjsonResponses([
      { message: { role: "assistant", thinking: "reasoning until the response ends" }, done: false },
      {
        message: { role: "assistant", content: "", thinking: "", tool_calls: [] },
        done: true,
        done_reason: "length",
        prompt_eval_count: 512,
        eval_count: 8192,
      },
    ]),
    terminalTool("list_files", { path: ".", depth: 2 }, "inspect-after-thinking"),
    terminalTool("write_file", {
      path: "hello.txt",
      content: "hello\n",
      precondition: { kind: "must_not_exist" },
    }, "write-after-thinking"),
    terminalTool("validate_project", { checks: ["test"], path: ".", timeoutMs: 30_000 }, "validate-after-thinking"),
    terminalTool("git_operation", { action: "diff", paths: ["hello.txt"] }, "diff-after-thinking"),
    ndjsonResponse({
      message: {
        role: "assistant",
        content: "Recovered from a thinking-only response; created hello.txt, validated it, and reviewed the diff.",
        thinking: "",
        tool_calls: [],
      },
      done: true,
      done_reason: "stop",
    }),
  ];
  const report = await runLiveHealth({
    connection,
    scenario,
    workspacePath,
    fetch: async (input, init) => {
      if (String(input).endsWith("/api/show")) {
        return Response.json({ capabilities: ["completion", "tools", "thinking"], model_info: { "kimi.context_length": 262_144 } });
      }
      chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return chatResponses.shift() ?? Response.json({ error: "unexpected extra chat request" }, { status: 500 });
    },
  });

  assert.equal(report.passed, true, JSON.stringify(report.failures));
  assert.equal(report.modelRetries.length, 1);
  assert.equal(chatBodies[0]?.think, true);
  assert.equal(chatBodies[1]?.think, true);
  const retryMessages = chatBodies[1]?.messages;
  assert.equal(Array.isArray(retryMessages), true);
  assert.match(JSON.stringify(retryMessages), /preserving required or unverified thinking behavior/);
  assert.equal(chatResponses.length, 0);
});

test("repeated empty Ollama terminal responses stop at the retry budget and create a failure checkpoint", async (testContext) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "galaxy-live-empty-exhausted-"));
  testContext.after(async () => rm(workspacePath, { recursive: true, force: true }));
  const scenario = await loadLiveHealthScenario("live/scenarios/01-write-and-validate.json");
  let chatRequests = 0;
  const emptyTerminal = () => ndjsonResponse({
    message: { role: "assistant", content: "", thinking: "", tool_calls: [] },
    done: true,
    done_reason: "stop",
  });
  const report = await runLiveHealth({
    connection,
    scenario,
    workspacePath,
    fetch: async (input) => {
      if (String(input).endsWith("/api/show")) {
        return Response.json({ capabilities: ["completion", "tools", "thinking"], model_info: { "kimi.context_length": 262_144 } });
      }
      chatRequests += 1;
      return emptyTerminal();
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.status, "failed");
  assert.equal(chatRequests, 2, "one initial request plus exactly one configured retry");
  assert.equal(report.modelRetries.length, 1);
  assert.deepEqual(report.checkpointReasons, ["failure"]);
  assert.equal(report.error?.code, "PROVIDER_ERROR");
  assert.match(report.error?.message ?? "", /empty content and no tool_calls/);
  assert.deepEqual(report.changedPaths, []);
});

test("live runner rejects generic Git shell output and gives actionable recovery feedback", async (testContext) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "galaxy-live-git-evidence-"));
  testContext.after(async () => rm(workspacePath, { recursive: true, force: true }));
  const scenario = await loadLiveHealthScenario("live/scenarios/01-write-and-validate.json");
  const chatResponses = [
    terminalTool("list_files", { path: ".", depth: 2 }, "inspect"),
    terminalTool("write_file", {
      path: "hello.txt",
      content: "hello\n",
      precondition: { kind: "must_not_exist" },
    }, "write"),
    terminalTool("validate_project", { checks: ["test"], path: "." }, "validate"),
    terminalTool("run_command", { command: "git diff -- hello.txt", cwd: "." }, "generic-git"),
    ndjsonResponse({ message: { role: "assistant", content: "Done after shell diff.", thinking: "", tool_calls: [] }, done: true, done_reason: "stop" }),
    terminalTool("git_operation", { action: "diff", paths: ["hello.txt"] }, "trusted-diff"),
    ndjsonResponse({ message: { role: "assistant", content: "Created hello.txt; tests passed and the structured final diff was reviewed.", thinking: "", tool_calls: [] }, done: true, done_reason: "stop" }),
  ];
  const requestBodies: string[] = [];
  const report = await runLiveHealth({
    connection,
    scenario,
    workspacePath,
    fetch: async (input, init) => {
      const body = String(init?.body ?? "");
      requestBodies.push(body);
      if (String(input).endsWith("/api/show")) {
        return Response.json({ capabilities: ["completion", "tools", "thinking"], model_info: { "kimi.context_length": 262_144 } });
      }
      return chatResponses.shift() ?? Response.json({ error: "unexpected extra chat request" }, { status: 500 });
    },
  });

  assert.equal(report.passed, true, JSON.stringify(report.failures));
  assert.deepEqual(report.completionRejections, [["DIFF_NOT_REVIEWED: The final diff has not been reviewed after workspace mutation."]]);
  assert.deepEqual(report.toolResults.map((item) => item.canonicalToolId), [
    "workspace.list", "workspace.write", "project.validate", "command.run", "git.exec",
  ]);
  assert.equal(requestBodies.some((body) => body.includes("DIFF_NOT_REVIEWED next action")), true);
  assert.equal(requestBodies.some((body) => body.includes("run_command, including git diff or git status, does not provide trusted diff_review evidence")), true);
  const finalChat = JSON.parse(requestBodies.at(-1) ?? "{}") as { tools?: unknown[] };
  assert.equal(Object.hasOwn(finalChat, "tools"), false);
  assert.equal(chatResponses.length, 0);
});

test("live runner fails capability preflight before arranging workspace and redacts the API key", async (testContext) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "galaxy-live-preflight-"));
  testContext.after(async () => rm(workspacePath, { recursive: true, force: true }));
  const scenario = await loadLiveHealthScenario("live/scenarios/01-write-and-validate.json");
  let calls = 0;
  const report = await runLiveHealth({
    connection,
    scenario,
    workspacePath,
    fetch: async () => {
      calls += 1;
      return Response.json({ error: "invalid Bearer integration-secret-never-report" }, { status: 401 });
    },
  });

  assert.equal(calls, 1);
  assert.equal(report.passed, false);
  assert.equal(report.status, "failed");
  assert.equal(report.preflight, null);
  assert.deepEqual(report.changedPaths, []);
  assert.deepEqual(await readdir(workspacePath), []);
  assert.equal(JSON.stringify(report).includes("integration-secret-never-report"), false);
});
