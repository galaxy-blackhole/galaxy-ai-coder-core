import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseDeterministicFixture } from "../../src/domain/fixture.js";
import { sha256Text } from "../../src/host/content-hash.js";
import { runDeterministicFixture } from "../../src/lab/run-fixture.js";

async function runScenario(context: test.TestContext, input: unknown) {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-full-flow-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const fixture = parseDeterministicFixture(input);
  const report = await runDeterministicFixture({ fixture, workspacePath: workspace });
  assert.equal(report.passed, true, [
    ...report.failures,
    `Tool results: ${JSON.stringify(report.toolResults.map((item) => ({ name: item.toolName, ok: item.ok, error: item.error })))}`,
    `Completion rejections: ${JSON.stringify(report.completionRejections)}`,
  ].join("\n"));
  return report;
}

test("full flow understands an existing project from structure, manifest, source, and tests", async (context) => {
  await runScenario(context, {
    schemaVersion: 2,
    name: "understand existing project",
    task: "Inspect the project and describe its entry point and test command.",
    initialFiles: [
      { path: "package.json", content: "{\n  \"private\": true,\n  \"scripts\": { \"test\": \"node --test\" }\n}\n" },
      { path: "src/index.ts", content: "export const answer = 42;\n" },
      { path: "test/index.test.ts", content: "// representative test\n" },
    ],
    rounds: [
      { toolCalls: [{ toolCallId: "detect", toolName: "detect_project", arguments: { path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "read-manifest", toolName: "read_file", arguments: { path: "package.json" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "read-source", toolName: "read_file", arguments: { path: "src/index.ts" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "read-test", toolName: "read_file", arguments: { path: "test/index.test.ts" } }], finishReason: "tool_calls" },
      { content: "The TypeScript entry point exports answer, and the declared test command is node --test.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      allModelStepsConsumed: true,
      allowedChanges: [],
      toolSequence: ["detect_project", "read_file", "read_file", "read_file"],
      toolResults: [
        { toolName: "detect_project", canonicalToolId: "project.detect", ok: true, contentIncludes: ["TypeScript", "node --test"] },
        { toolName: "read_file", canonicalToolId: "workspace.read", ok: true, contentIncludes: ["node --test"] },
        { toolName: "read_file", canonicalToolId: "workspace.read", ok: true, contentIncludes: ["answer = 42"] },
        { toolName: "read_file", canonicalToolId: "workspace.read", ok: true, contentIncludes: ["representative test"] },
      ],
      finalResponseIncludes: ["TypeScript", "node --test"],
      traceKindsInclude: ["prompt_snapshot", "tool_call", "tool_result", "completion_gate"],
    },
  });
});

test("full flow paginates a large UTF-8 file with a stable cursor", async (context) => {
  const content = `${"0123456789".repeat(40)}\n`;
  const hash = sha256Text(content);
  const cursor = `text:${hash}:1:2:256`;
  await runScenario(context, {
    schemaVersion: 2,
    name: "read pagination",
    task: "Read the complete large file in bounded pages.",
    initialFiles: [{ path: "large.txt", content }],
    rounds: [
      { toolCalls: [{ toolCallId: "page-1", toolName: "read_file", arguments: { path: "large.txt", maxBytes: 256 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "page-2", toolName: "read_file", arguments: { path: "large.txt", maxBytes: 256, cursor } }], finishReason: "tool_calls" },
      { content: "Read both bounded pages and reached the end of large.txt.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      allowedChanges: [],
      toolSequence: ["read_file", "read_file"],
      toolResults: [
        { canonicalToolId: "workspace.read", ok: true, contentIncludes: [cursor, "\"truncated\":true"] },
        { canonicalToolId: "workspace.read", ok: true, contentIncludes: ["\"truncated\":false"] },
      ],
    },
  });
});

test("default registry executes checkpoint, glob, and grep through the full runtime boundary", async (context) => {
  await runScenario(context, {
    schemaVersion: 2,
    name: "remaining default tool contracts",
    task: "Locate TypeScript files, find the marker, and preserve a bounded checkpoint before reporting.",
    initialFiles: [
      { path: "src/index.ts", content: "export const marker = 'needle';\n" },
      { path: "README.md", content: "fixture\n" },
    ],
    rounds: [
      { toolCalls: [{ toolCallId: "glob", toolName: "glob_files", arguments: { pattern: "**/*.ts", path: ".", kind: "file" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "grep", toolName: "search_text", arguments: { query: "needle", path: ".", glob: "**/*.ts" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "checkpoint", toolName: "update_checkpoint", arguments: {
        action: "update",
        goal: "Understand the marker",
        progress: "Located src/index.ts and verified the marker",
        decisions: ["No workspace mutation is needed"],
        nextStep: "Report verified evidence",
      } }], finishReason: "tool_calls" },
      { content: "Located the TypeScript marker through glob and grep, then saved the bounded checkpoint.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      allModelStepsConsumed: true,
      allowedChanges: [],
      toolSequence: ["glob_files", "search_text", "update_checkpoint"],
      toolResults: [
        { canonicalToolId: "workspace.glob", ok: true, contentIncludes: ["src/index.ts"] },
        { canonicalToolId: "workspace.grep", ok: true, contentIncludes: ["needle", "src/index.ts"] },
        { canonicalToolId: "task.checkpoint", ok: true, contentIncludes: ["Report verified evidence"] },
      ],
      finalResponseIncludes: ["glob", "grep", "checkpoint"],
    },
  });
});

test("full contract profile drives all nine contract doubles through one single-agent run", async (context) => {
  const toolSequence = [
    "list_files",
    "fetch_url",
    "search_tools", "search_web",
    "search_tools", "manage_session",
    "search_tools", "create_artifact",
    "search_tools", "list_artifacts",
    "search_tools", "read_artifact",
    "search_tools", "analyze_artifact",
    "search_tools", "manage_preview",
    "search_tools", "ask_user",
  ];
  await runScenario(context, {
    schemaVersion: 2,
    name: "all optional tool contracts",
    task: "Exercise every optional tool contract and report the deterministic evidence.",
    runtime: { toolProfile: "full_contract" },
    approvalDecisions: {
      "research.fetch": "allow",
      "research.search": "allow",
      "command.session": "allow",
    },
    rounds: [
      { toolCalls: [{ toolCallId: "inspect", toolName: "list_files", arguments: { path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "fetch", toolName: "fetch_url", arguments: { url: "https://example.com/contracts", maxBytes: 256 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "activate-search", toolName: "search_tools", arguments: { query: "research.search", limit: 1 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "search", toolName: "search_web", arguments: { query: "deterministic contracts", maxResults: 2 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "activate-session", toolName: "search_tools", arguments: { query: "command.session", limit: 1 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "session", toolName: "manage_session", arguments: { action: "start", command: "contract-server" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "activate-create", toolName: "search_tools", arguments: { query: "artifact.create", limit: 1 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "create", toolName: "create_artifact", arguments: { name: "evidence.txt", content: "contract artifact", mimeType: "text/plain", retention: "durable" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "activate-list", toolName: "search_tools", arguments: { query: "artifact.list", limit: 1 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "list-artifacts", toolName: "list_artifacts", arguments: { kind: "text", limit: 10 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "activate-read", toolName: "search_tools", arguments: { query: "artifact.read", limit: 1 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "read-artifact", toolName: "read_artifact", arguments: { id: "artifact-0001", maxBytes: 256 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "activate-perception", toolName: "search_tools", arguments: { query: "perception.analyze", limit: 1 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "analyze", toolName: "analyze_artifact", arguments: { artifactId: "artifact-0001", mode: "metadata" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "activate-preview", toolName: "search_tools", arguments: { query: "preview.manage", limit: 1 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "preview", toolName: "manage_preview", arguments: { action: "open", command: "preview-server", expectPort: 4321 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "activate-ask", toolName: "search_tools", arguments: { query: "user.ask", limit: 1 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "ask", toolName: "ask_user", arguments: { questions: [{ id: "ready", question: "Are contracts deterministic?" }] } }], finishReason: "tool_calls" },
      { content: "All nine deterministic contract doubles produced correlated evidence in one single-agent run.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      allModelStepsConsumed: true,
      allowedChanges: [],
      modelRequestCount: 19,
      toolSequence,
      toolResults: [
        { canonicalToolId: "workspace.list", ok: true },
        { canonicalToolId: "research.fetch", ok: true, contentIncludes: ["untrusted_external"] },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "research.search", ok: true, contentIncludes: ["galaxy-code-contract"] },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "command.session", ok: true, contentIncludes: ["session-0001"] },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "artifact.create", ok: true, contentIncludes: ["artifact-0001"] },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "artifact.list", ok: true, contentIncludes: ["artifact-0001"] },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "artifact.read", ok: true, contentIncludes: ["contract artifact"] },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "perception.analyze", ok: true, contentIncludes: ["confidence", "bytes=17"] },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "preview.manage", ok: true, contentIncludes: ["preview-0001", "127.0.0.1:4321"] },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "user.ask", ok: true, contentIncludes: ["Are contracts deterministic?"] },
      ],
      finalResponseIncludes: ["nine deterministic contract doubles", "single-agent"],
      traceKindsInclude: ["prompt_snapshot", "tool_call", "tool_result", "completion_gate"],
    },
  });
});

test("repeated stale edits are circuit-broken and checkpointed without changing the file", async (context) => {
  const editArguments = {
    path: "safe.txt",
    oldText: "safe",
    newText: "unsafe",
    precondition: { kind: "matches_sha256", contentSha256: "0".repeat(64) },
  };
  const report = await runScenario(context, {
    schemaVersion: 2,
    name: "stale edit loop",
    task: "Attempt the requested edit, but never corrupt a file when the precondition is stale.",
    initialFiles: [{ path: "safe.txt", content: "safe\n" }],
    rounds: [1, 2, 3, 4, 5].map((number) => ({
      toolCalls: [{ toolCallId: `stale-${number}`, toolName: "edit_file", arguments: editArguments }],
      finishReason: "tool_calls",
    })),
    expected: {
      status: "paused",
      errorCode: null,
      executionStatuses: ["paused"],
      checkpointReasons: ["pause"],
      allModelStepsConsumed: true,
      modelRequestCount: 5,
      allowedChanges: [],
      files: [{ path: "safe.txt", content: "safe\n", unchanged: true }],
      toolSequence: ["edit_file", "edit_file"],
      toolResults: [
        { canonicalToolId: "workspace.edit", ok: false, errorCode: "PRECONDITION_FAILED" },
        { canonicalToolId: "workspace.edit", ok: false, errorCode: "PRECONDITION_FAILED" },
        { canonicalToolId: "workspace.edit", ok: false, errorCode: "NO_PROGRESS" },
        { canonicalToolId: "workspace.edit", ok: false, errorCode: "NO_PROGRESS" },
        { canonicalToolId: "workspace.edit", ok: false, errorCode: "NO_PROGRESS" },
      ],
      traceKindsInclude: ["tool_result"],
    },
  });
  assert.equal(report.writes.length, 0);
});

test("stale-edit failure families survive pause and resume", async (context) => {
  const rounds = [1, 2, 3, 4].map((number) => ({
    toolCalls: [{
      toolCallId: `resume-stale-${number}`,
      toolName: "edit_file",
      arguments: {
        path: "safe.txt",
        oldText: `stale-fragment-${number}`,
        newText: `replacement-${number}`,
        precondition: { kind: "matches_sha256", contentSha256: "0".repeat(64) },
      },
    }],
    finishReason: "tool_calls",
  }));
  const report = await runScenario(context, {
    schemaVersion: 2,
    name: "stale family across resume",
    task: "Never reset stale-edit circuit breakers when resuming a verified checkpoint.",
    initialFiles: [{ path: "safe.txt", content: "safe\n" }],
    controls: [{ event: "tool_result", occurrence: 2, action: "pause" }],
    runtime: { resume: { on: "paused", maxExecutions: 2 } },
    rounds: [
      ...rounds,
      {
        toolCalls: [{
          toolCallId: "resume-stale-5",
          toolName: "edit_file",
          arguments: {
            path: "safe.txt",
            oldText: "stale-fragment-5",
            newText: "replacement-5",
            precondition: { kind: "matches_sha256", contentSha256: "0".repeat(64) },
          },
        }],
        finishReason: "tool_calls",
      },
    ],
    expected: {
      status: "paused",
      errorCode: null,
      executionStatuses: ["paused", "paused"],
      checkpointReasons: ["pause", "pause"],
      allModelStepsConsumed: true,
      modelRequestCount: 5,
      allowedChanges: [],
      files: [{ path: "safe.txt", content: "safe\n", unchanged: true }],
      toolSequence: ["edit_file", "edit_file", "edit_file", "edit_file", "edit_file"],
      toolResults: [1, 2, 3, 4, 5].map(() => ({
        canonicalToolId: "workspace.edit",
        ok: false,
        errorCode: "PRECONDITION_FAILED",
      })),
    },
  });
  assert.equal(report.writes.length, 0);
});

test("exact repeated-call counters survive pause and resume", async (context) => {
  const staleArguments = {
    path: "safe.txt",
    oldText: "stale",
    newText: "replacement",
    precondition: { kind: "matches_sha256", contentSha256: "0".repeat(64) },
  };
  const report = await runScenario(context, {
    schemaVersion: 2,
    name: "exact repeat across resume",
    task: "Never reset exact repeated-call counters when resuming a verified checkpoint.",
    initialFiles: [{ path: "safe.txt", content: "safe\n" }],
    controls: [{ event: "tool_result", occurrence: 2, action: "pause" }],
    runtime: { resume: { on: "paused", maxExecutions: 2 } },
    rounds: [
      ...[1, 2, 3, 4].map((number) => ({
        toolCalls: [{ toolCallId: `exact-repeat-${number}`, toolName: "edit_file", arguments: staleArguments }],
        finishReason: "tool_calls",
      })),
      {
        toolCalls: [{ toolCallId: "exact-repeat-5", toolName: "edit_file", arguments: staleArguments }],
        finishReason: "tool_calls",
      },
    ],
    expected: {
      status: "paused",
      errorCode: null,
      executionStatuses: ["paused", "paused"],
      checkpointReasons: ["pause", "pause"],
      allModelStepsConsumed: true,
      modelRequestCount: 5,
      allowedChanges: [],
      files: [{ path: "safe.txt", content: "safe\n", unchanged: true }],
      toolSequence: ["edit_file", "edit_file"],
      toolResults: [
        { canonicalToolId: "workspace.edit", ok: false, errorCode: "PRECONDITION_FAILED" },
        { canonicalToolId: "workspace.edit", ok: false, errorCode: "PRECONDITION_FAILED" },
        { canonicalToolId: "workspace.edit", ok: false, errorCode: "NO_PROGRESS" },
        { canonicalToolId: "workspace.edit", ok: false, errorCode: "NO_PROGRESS" },
        { canonicalToolId: "workspace.edit", ok: false, errorCode: "NO_PROGRESS" },
      ],
    },
  });
  assert.equal(report.writes.length, 0);
});

test("real file edits cannot oscillate A to B to A indefinitely", async (context) => {
  const contentA = "A\n";
  const contentB = "B\n";
  const contentC = "C\n";
  const report = await runScenario(context, {
    schemaVersion: 2,
    name: "edit hash cycle",
    task: "Apply a stable change and stop if edits begin toggling between earlier file states.",
    initialFiles: [{ path: "toggle.txt", content: contentA }],
    rounds: [
      { toolCalls: [{ toolCallId: "a-to-b-1", toolName: "edit_file", arguments: {
        path: "toggle.txt", oldText: "A", newText: "B",
        precondition: { kind: "matches_sha256", contentSha256: sha256Text(contentA) },
      } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "b-to-a", toolName: "edit_file", arguments: {
        path: "toggle.txt", oldText: "B", newText: "A",
        precondition: { kind: "matches_sha256", contentSha256: sha256Text(contentB) },
      } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "a-to-b-2", toolName: "edit_file", arguments: {
        path: "toggle.txt", oldText: "A", newText: "B",
        precondition: { kind: "matches_sha256", contentSha256: sha256Text(contentA) },
      } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "stale-recovery-edit", toolName: "edit_file", arguments: {
        path: "toggle.txt", oldText: "B", newText: "C",
        precondition: { kind: "matches_sha256", contentSha256: sha256Text(contentA) },
      } }], finishReason: "tool_calls" },
    ],
    expected: {
      status: "paused",
      errorCode: null,
      executionStatuses: ["paused"],
      checkpointReasons: ["pause"],
      allModelStepsConsumed: true,
      modelRequestCount: 4,
      allowedChanges: ["toggle.txt"],
      files: [{ path: "toggle.txt", content: contentB }],
      toolSequence: ["edit_file", "edit_file", "edit_file", "edit_file"],
      toolResults: [
        { canonicalToolId: "workspace.edit", ok: true },
        { canonicalToolId: "workspace.edit", ok: true },
        { canonicalToolId: "workspace.edit", ok: true },
        { canonicalToolId: "workspace.edit", ok: false, errorCode: "PRECONDITION_FAILED" },
      ],
      traceKindsInclude: ["tool_result"],
    },
  });
  assert.equal(report.writes.length, 3);
});

test("validation fail, focused fix, stable revalidation pass, and final diff can complete", async (context) => {
  const before = "one\n";
  await runScenario(context, {
    schemaVersion: 2,
    name: "validation fail fix pass",
    task: "Fix src/value.txt so the existing test passes.",
    approvalDecisions: { "project.validate": "allow" },
    initialFiles: [
      { path: "package.json", content: "{\n  \"private\": true,\n  \"scripts\": { \"test\": \"node --test test.mjs\" }\n}\n" },
      { path: "src/value.txt", content: before },
      { path: "test.mjs", content: "import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport test from 'node:test';\ntest('value', async () => assert.equal(await readFile(new URL('./src/value.txt', import.meta.url), 'utf8'), 'two\\n'));\n" },
    ],
    rounds: [
      { toolCalls: [{ toolCallId: "inspect", toolName: "list_files", arguments: { path: ".", depth: 3 } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "validate-fail", toolName: "validate_project", arguments: { checks: ["test"], path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "read", toolName: "read_file", arguments: { path: "src/value.txt" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "edit", toolName: "edit_file", arguments: {
        path: "src/value.txt", oldText: "one", newText: "two",
        precondition: { kind: "matches_sha256", contentSha256: sha256Text(before) },
      } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "validate-pass", toolName: "validate_project", arguments: { checks: ["test"], path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "activate-git", toolName: "search_tools", arguments: { query: "review git diff", category: "git" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "diff", toolName: "git_operation", arguments: { action: "diff", paths: ["src/value.txt"] } }], finishReason: "tool_calls" },
      { content: "Changed one to two. The existing test now passes and the final diff was reviewed.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      allModelStepsConsumed: true,
      allowedChanges: ["src/value.txt"],
      files: [{ path: "src/value.txt", content: "two\n" }],
      toolSequence: ["list_files", "validate_project", "read_file", "edit_file", "validate_project", "search_tools", "git_operation"],
      toolResults: [
        { canonicalToolId: "workspace.list", ok: true },
        { canonicalToolId: "project.validate", ok: true, contentIncludes: ["\"passed\":false"] },
        { canonicalToolId: "workspace.read", ok: true },
        { canonicalToolId: "workspace.edit", ok: true },
        { canonicalToolId: "project.validate", ok: true, contentIncludes: ["\"passed\":true"] },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "git.exec", ok: true, contentIncludes: ["-one", "+two"] },
      ],
      finalResponseIncludes: ["test now passes", "diff was reviewed"],
    },
  });
});

test("premature completion after a write receives evidence feedback and recovers", async (context) => {
  await runScenario(context, {
    schemaVersion: 2,
    name: "premature final recovery",
    task: "Create generated.txt, validate the project, and review the final diff.",
    approvalDecisions: { "project.validate": "allow" },
    initialFiles: [
      { path: "package.json", content: "{\n  \"private\": true,\n  \"scripts\": { \"test\": \"node --test test.mjs\" }\n}\n" },
      { path: "test.mjs", content: "import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport test from 'node:test';\ntest('generated', async () => assert.equal(await readFile(new URL('./generated.txt', import.meta.url), 'utf8'), 'generated\\n'));\n" },
    ],
    rounds: [
      { toolCalls: [{ toolCallId: "inspect", toolName: "list_files", arguments: { path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "write", toolName: "write_file", arguments: { path: "generated.txt", content: "generated\n", precondition: { kind: "must_not_exist" } } }], finishReason: "tool_calls" },
      { content: "Done too early.", finishReason: "stop" },
      { toolCalls: [{ toolCallId: "validate", toolName: "validate_project", arguments: { checks: ["test"], path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "activate-git", toolName: "search_tools", arguments: { query: "final git diff", category: "git" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "diff", toolName: "git_operation", arguments: { action: "diff", paths: ["generated.txt"] } }], finishReason: "tool_calls" },
      { content: "Created generated.txt; the project test passed and its untracked diff was reviewed.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      allowedChanges: ["generated.txt"],
      completionIssuesInclude: ["WRITE_NOT_VALIDATED", "DIFF_NOT_REVIEWED"],
      modelRequestCount: 7,
      files: [{ path: "generated.txt", content: "generated\n" }],
      toolSequence: ["list_files", "write_file", "validate_project", "search_tools", "git_operation"],
      toolResults: [
        { canonicalToolId: "workspace.list", ok: true },
        { canonicalToolId: "workspace.write", ok: true },
        { canonicalToolId: "project.validate", ok: true },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "git.exec", ok: true, contentIncludes: ["generated.txt", "+generated"] },
      ],
    },
  });
});

test("provider overflow checkpoints, compacts, and continues without losing the task", async (context) => {
  await runScenario(context, {
    schemaVersion: 2,
    name: "provider overflow compaction",
    task: "Inspect the workspace after provider-side token pressure.",
    model: { tokenCountSteps: [90000, 20000] },
    rounds: [
      { toolCalls: [{ toolCallId: "inspect", toolName: "list_files", arguments: { path: "." } }], finishReason: "tool_calls" },
      { content: "The workspace was inspected after context compaction.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      checkpointReasons: ["provider_overflow"],
      allModelStepsConsumed: true,
      modelRequestCount: 2,
      allowedChanges: [],
      toolSequence: ["list_files"],
      toolResults: [{ canonicalToolId: "workspace.list", ok: true }],
      traceKindsInclude: ["checkpoint", "context_diagnostic"],
    },
  });
});

test("repeated compaction preserves write, validation, lazy registry, diff, and task context", async (context) => {
  const report = await runScenario(context, {
    schemaVersion: 2,
    name: "progressive evidence across repeated compaction",
    task: "Create generated.txt and preserve every verified step across repeated context compaction.",
    approvalDecisions: { "project.validate": "allow" },
    initialFiles: [
      { path: "package.json", content: "{\n  \"private\": true,\n  \"scripts\": { \"test\": \"node --test test.mjs\" }\n}\n" },
      { path: "test.mjs", content: "import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport test from 'node:test';\ntest('generated', async () => assert.equal(await readFile(new URL('./generated.txt', import.meta.url), 'utf8'), 'generated\\n'));\n" },
    ],
    model: { tokenCountSteps: [500, 500, 90000, 20000, 90000, 20000, 90000, 20000, 90000, 20000] },
    rounds: [
      { toolCalls: [{ toolCallId: "compact-inspect", toolName: "list_files", arguments: { path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "compact-write", toolName: "write_file", arguments: { path: "generated.txt", content: "generated\n", precondition: { kind: "must_not_exist" } } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "compact-validate", toolName: "validate_project", arguments: { checks: ["test"], path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "compact-activate-git", toolName: "search_tools", arguments: { query: "final git diff", category: "git" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "compact-diff", toolName: "git_operation", arguments: { action: "diff", paths: ["generated.txt"] } }], finishReason: "tool_calls" },
      { content: "Created generated.txt; validation passed and the final diff was reviewed after repeated compaction.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      checkpointReasons: ["provider_overflow", "provider_overflow", "provider_overflow", "provider_overflow"],
      allModelStepsConsumed: true,
      modelRequestCount: 6,
      allowedChanges: ["generated.txt"],
      files: [{ path: "generated.txt", content: "generated\n" }],
      toolSequence: ["list_files", "write_file", "validate_project", "search_tools", "git_operation"],
      toolResults: [
        { canonicalToolId: "workspace.list", ok: true },
        { canonicalToolId: "workspace.write", ok: true },
        { canonicalToolId: "project.validate", ok: true },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "git.exec", ok: true, contentIncludes: ["generated.txt"] },
      ],
    },
  });

  assert.equal(report.modelContextAudit.allRequestsContainTask, true);
  assert.equal(report.modelContextAudit.observedCheckpointHashes.length, 4);
  assert.deepEqual(report.checkpointAudits.map((item) => item.compactionCount), [1, 2, 3, 4]);
  assert.deepEqual(report.checkpointAudits.map((item) => item.editPaths), [
    ["generated.txt"],
    ["generated.txt"],
    ["generated.txt"],
    ["generated.txt"],
  ]);
  assert.deepEqual(report.checkpointAudits.map((item) => item.validationIds), [
    [],
    ["project.validate:test:."],
    ["project.validate:test:."],
    ["project.validate:test:."],
  ]);
  assert.equal(report.checkpointAudits[2]?.activeToolNames.includes("git_operation"), true);
  assert.deepEqual(report.checkpointAudits.map((item) => item.diffReviewed), [false, false, false, true]);
});

test("hard exhaustion after lazy activation and write resumes on a fresh host without repeating the mutation", async (context) => {
  const report = await runScenario(context, {
    schemaVersion: 2,
    name: "fresh host resume after written context exhaustion",
    task: "Resume on a fresh CLI host with the prior write and activated git tool intact.",
    approvalDecisions: { "project.validate": "allow" },
    initialFiles: [
      { path: "package.json", content: "{\n  \"private\": true,\n  \"scripts\": { \"test\": \"node --test test.mjs\" }\n}\n" },
      { path: "test.mjs", content: "import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport test from 'node:test';\ntest('generated', async () => assert.equal(await readFile(new URL('./generated.txt', import.meta.url), 'utf8'), 'generated\\n'));\n" },
    ],
    model: { tokenCountSteps: [500, 500, 500, 90000, 90000, 500, 500, 500] },
    runtime: { resume: { on: "failed", maxExecutions: 2, recreateHost: true } },
    rounds: [
      { toolCalls: [{ toolCallId: "fresh-inspect", toolName: "list_files", arguments: { path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "fresh-activate-git", toolName: "search_tools", arguments: { query: "final git diff", category: "git" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "fresh-write", toolName: "write_file", arguments: { path: "generated.txt", content: "generated\n", precondition: { kind: "must_not_exist" } } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "fresh-validate", toolName: "validate_project", arguments: { checks: ["test"], path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "fresh-diff", toolName: "git_operation", arguments: { action: "diff", paths: ["generated.txt"] } }], finishReason: "tool_calls" },
      { content: "Fresh-host resume retained the write, validation passed, and the restored git tool reviewed the diff.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      executionStatuses: ["failed", "completed"],
      checkpointReasons: ["provider_overflow", "failure"],
      allModelStepsConsumed: true,
      modelRequestCount: 6,
      allowedChanges: ["generated.txt"],
      files: [{ path: "generated.txt", content: "generated\n" }],
      toolSequence: ["list_files", "search_tools", "write_file", "validate_project", "git_operation"],
      toolResults: [
        { canonicalToolId: "workspace.list", ok: true },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "workspace.write", ok: true },
        { canonicalToolId: "project.validate", ok: true },
        { canonicalToolId: "git.exec", ok: true },
      ],
    },
  });

  assert.equal(report.modelContextAudit.allRequestsContainTask, true);
  assert.deepEqual(report.checkpointAudits.map((item) => item.editPaths), [["generated.txt"], ["generated.txt"]]);
  assert.equal(report.checkpointAudits.every((item) => item.activeToolNames.includes("git_operation")), true);
  assert.equal(report.toolSequence.filter((name) => name === "write_file").length, 1);
  assert.equal(report.modelContextAudit.observedCheckpointHashes.includes(report.checkpointAudits[1]!.contentHash), true);
});

test("task checkpoint tool state survives hard exhaustion and fresh-host reconstruction", async (context) => {
  const report = await runScenario(context, {
    schemaVersion: 2,
    name: "durable task tool checkpoint across fresh host",
    task: "Preserve the bounded task checkpoint across a fresh-host resume.",
    initialFiles: [{ path: "README.md", content: "fixture\n" }],
    model: { tokenCountSteps: [500, 500, 90000, 90000, 500, 500] },
    runtime: { resume: { on: "failed", maxExecutions: 2, recreateHost: true } },
    rounds: [
      { toolCalls: [{ toolCallId: "checkpoint-inspect", toolName: "list_files", arguments: { path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "checkpoint-update", toolName: "update_checkpoint", arguments: {
        action: "update",
        goal: "Keep the verified task state",
        progress: "Workspace inspection completed before exhaustion",
        decisions: ["Do not repeat the completed inspection"],
        nextStep: "Read the durable checkpoint after resume",
      } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "checkpoint-read-after-resume", toolName: "update_checkpoint", arguments: { action: "read" } }], finishReason: "tool_calls" },
      { content: "The fresh host read the exact bounded task checkpoint and continued without repeating inspection.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      executionStatuses: ["failed", "completed"],
      checkpointReasons: ["provider_overflow", "failure"],
      allModelStepsConsumed: true,
      modelRequestCount: 4,
      allowedChanges: [],
      toolSequence: ["list_files", "update_checkpoint", "update_checkpoint"],
      toolResults: [
        { canonicalToolId: "workspace.list", ok: true },
        { canonicalToolId: "task.checkpoint", ok: true },
        { canonicalToolId: "task.checkpoint", ok: true, contentIncludes: [
          "Workspace inspection completed before exhaustion",
          "Do not repeat the completed inspection",
          "Read the durable checkpoint after resume"
        ] },
      ],
    },
  });

  assert.equal(report.modelContextAudit.allRequestsContainTask, true);
  assert.equal(report.toolSequence.filter((name) => name === "list_files").length, 1);
  assert.equal(report.modelContextAudit.observedCheckpointHashes.includes(report.checkpointAudits[1]!.contentHash), true);
});

test("hard token exhaustion creates a failure checkpoint and resumes from it", async (context) => {
  await runScenario(context, {
    schemaVersion: 2,
    name: "token exhaustion resume",
    task: "Resume the current inspection after the provider context limit clears.",
    model: { tokenCountSteps: [90000, 90000, 20000, 20000] },
    runtime: { resume: { on: "failed", maxExecutions: 2 } },
    rounds: [
      { toolCalls: [{ toolCallId: "inspect-after-resume", toolName: "list_files", arguments: { path: "." } }], finishReason: "tool_calls" },
      { content: "Resumed from the verified checkpoint and completed the inspection.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      executionStatuses: ["failed", "completed"],
      checkpointReasons: ["provider_overflow", "failure"],
      allModelStepsConsumed: true,
      modelRequestCount: 2,
      allowedChanges: [],
      toolSequence: ["list_files"],
      toolResults: [{ canonicalToolId: "workspace.list", ok: true }],
      finalResponseIncludes: ["verified checkpoint"],
    },
  });
});

test("resume rejects workspace divergence instead of continuing from stale assumptions", async (context) => {
  await runScenario(context, {
    schemaVersion: 2,
    name: "resume workspace divergence",
    task: "Never resume against a workspace that changed after checkpointing.",
    model: { tokenCountSteps: [90000, 90000] },
    runtime: { resume: { on: "failed", maxExecutions: 2, mutateBeforeResume: [{ path: "external-change.txt", content: "changed\n" }] } },
    rounds: [{ content: "This model round must never execute.", finishReason: "stop" }],
    expected: {
      status: "failed",
      errorCode: "CHECKPOINT_INCOMPATIBLE",
      executionStatuses: ["failed", "failed"],
      checkpointReasons: ["provider_overflow", "failure", "failure"],
      modelRequestCount: 0,
      allowedChanges: ["external-change.txt"],
      files: [{ path: "external-change.txt", content: "changed\n" }],
      toolSequence: [],
      toolResults: [],
    },
  });
});

test("resume rejects a tampered checkpoint before any model or tool work", async (context) => {
  await runScenario(context, {
    schemaVersion: 2,
    name: "tampered checkpoint",
    task: "Reject any checkpoint whose content no longer matches its integrity hash.",
    model: { tokenCountSteps: [90000, 90000] },
    runtime: { resume: { on: "failed", maxExecutions: 2, tamperCheckpoint: true } },
    rounds: [{ content: "This model round must never execute.", finishReason: "stop" }],
    expected: {
      status: "failed",
      errorCode: "CHECKPOINT_INCOMPATIBLE",
      executionStatuses: ["failed", "failed"],
      checkpointReasons: ["provider_overflow", "failure"],
      modelRequestCount: 0,
      allowedChanges: [],
      toolSequence: [],
      toolResults: [],
    },
  });
});

test("host cancellation interrupts an active model turn without claiming completion", async (context) => {
  await runScenario(context, {
    schemaVersion: 2,
    name: "cancel active model",
    task: "Cancel while the provider stream is active.",
    controls: [{ event: "model", occurrence: 1, action: "cancel" }],
    rounds: [{ events: [
      { type: "started" },
      { type: "content", delta: "must not complete" },
      { type: "done", content: "must not complete", stopReason: "completed" },
    ] }],
    expected: {
      status: "canceled",
      errorCode: "CANCELED",
      executionStatuses: ["canceled"],
      checkpointReasons: [],
      modelRequestCount: 1,
      allowedChanges: [],
      finalResponseExcludes: ["must not complete"],
      toolSequence: [],
      toolResults: [],
    },
  });
});

test("malformed model protocol fails closed and retryable provider errors retry once", async (context) => {
  await context.test("missing started event", async (subtest) => {
    await runScenario(subtest, {
      schemaVersion: 2,
      name: "missing model started",
      task: "Reject malformed provider streams.",
      rounds: [{ events: [
        { type: "content", delta: "invalid" },
        { type: "done", content: "invalid", stopReason: "completed" },
      ] }],
      expected: {
        status: "failed",
        errorCode: "INVALID_MODEL_STREAM",
        checkpointReasons: ["failure"],
        modelRequestCount: 1,
        allowedChanges: [],
        toolSequence: [],
        toolResults: [],
      },
    });
  });

  await context.test("bounded provider retry", async (subtest) => {
    const report = await runScenario(subtest, {
      schemaVersion: 2,
      name: "provider retry success",
      task: "Retry a transient provider error without duplicating a tool call.",
      runtime: { budget: { maxModelRetries: 1 } },
      rounds: [
        { events: [
          { type: "started" },
          { type: "error", code: "RATE_LIMITED", message: "temporary quota", retryable: true },
        ] },
        { toolCalls: [{ toolCallId: "inspect-once", toolName: "list_files", arguments: { path: "." } }], finishReason: "tool_calls" },
        { content: "The transient error was retried and the workspace was inspected once.", finishReason: "stop" },
      ],
      expected: {
        status: "completed",
        errorCode: null,
        allModelStepsConsumed: true,
        modelRequestCount: 3,
        retryDelaysMs: [1000],
        allowedChanges: [],
        toolSequence: ["list_files"],
        toolResults: [{ canonicalToolId: "workspace.list", ok: true }],
      },
    });
    assert.deepEqual(report.retryDelaysMs, [1000]);
  });
});

test("schema-invalid calls and denied commands stay observable without mutating the workspace", async (context) => {
  await runScenario(context, {
    schemaVersion: 2,
    name: "invalid and denied tools",
    task: "Inspect the workspace and report why unsafe or malformed operations did not run.",
    approvalDecisions: { "command.run": "deny" },
    rounds: [
      { toolCalls: [{ toolCallId: "inspect", toolName: "list_files", arguments: { path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "invalid-read", toolName: "read_file", arguments: {} }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "denied-command", toolName: "run_command", arguments: { command: "printf should-not-run > forbidden.txt" } }], finishReason: "tool_calls" },
      { content: "The malformed read and denied command were reported; no forbidden file was created.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      allowedChanges: [],
      files: [{ path: "forbidden.txt", absent: true }],
      toolSequence: ["list_files", "read_file", "run_command"],
      toolResults: [
        { canonicalToolId: "workspace.list", ok: true },
        { canonicalToolId: "workspace.read", ok: false, errorCode: "INVALID_TOOL_ARGUMENTS" },
        { canonicalToolId: "command.run", ok: false, errorCode: "DENIED_BY_HOST" },
      ],
    },
  });
});

test("command-created directories and files remain typed, checkpointable, and completable", async (context) => {
  const report = await runScenario(context, {
    schemaVersion: 2,
    name: "command creates typed filesystem entries",
    task: "Create generated/file.txt with a command, validate it, review the diff, and never lose mutation evidence.",
    approvalDecisions: { "command.run": "allow", "project.validate": "allow" },
    initialFiles: [
      { path: "package.json", content: "{\n  \"private\": true,\n  \"scripts\": { \"test\": \"node --test test.mjs\" }\n}\n" },
      { path: "test.mjs", content: "import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport test from 'node:test';\ntest('generated', async () => assert.equal(await readFile(new URL('./generated/file.txt', import.meta.url), 'utf8'), 'x'));\n" },
    ],
    rounds: [
      { toolCalls: [{ toolCallId: "inspect", toolName: "list_files", arguments: { path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "create-tree", toolName: "run_command", arguments: { command: "node -e \"require('node:fs').mkdirSync('generated',{recursive:true});require('node:fs').writeFileSync('generated/file.txt','x')\"" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "validate", toolName: "validate_project", arguments: { checks: ["test"], path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "activate-git", toolName: "search_tools", arguments: { query: "review final diff", category: "git" } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "diff", toolName: "git_operation", arguments: { action: "diff", paths: ["generated/file.txt"] } }], finishReason: "tool_calls" },
      { content: "Created the typed directory and file; validation passed and the final diff was reviewed.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      allModelStepsConsumed: true,
      allowedChanges: ["generated", "generated/file.txt"],
      files: [{ path: "generated/file.txt", content: "x" }],
      toolSequence: ["list_files", "run_command", "validate_project", "search_tools", "git_operation"],
      toolResults: [
        { canonicalToolId: "workspace.list", ok: true },
        { canonicalToolId: "command.run", ok: true },
        { canonicalToolId: "project.validate", ok: true, contentIncludes: ["\"passed\":true"] },
        { canonicalToolId: "catalog.search", ok: true },
        { canonicalToolId: "git.exec", ok: true, contentIncludes: ["generated/file.txt", "+x"] },
      ],
    },
  });
  assert.deepEqual(report.writes.map((write) => ({
    afterKind: write.afterKind,
    beforeKind: write.beforeKind,
    path: write.path,
  })), [
    { afterKind: "directory", beforeKind: "missing", path: "generated" },
    { afterKind: "file", beforeKind: "missing", path: "generated/file.txt" },
  ]);
});

test("required command containment fails before an approved command can spawn", async (context) => {
  const report = await runScenario(context, {
    schemaVersion: 2,
    name: "required containment fail closed",
    task: "Prove that an unverified containment backend cannot execute a command.",
    runtime: { commandContainment: "required" },
    approvalDecisions: { "command.run": "allow" },
    rounds: [
      { toolCalls: [{ toolCallId: "inspect", toolName: "list_files", arguments: { path: "." } }], finishReason: "tool_calls" },
      { toolCalls: [{ toolCallId: "must-not-spawn", toolName: "run_command", arguments: { command: "printf spawned > forbidden.txt" } }], finishReason: "tool_calls" },
      { content: "The approved command was still blocked because verified containment is unavailable.", finishReason: "stop" },
    ],
    expected: {
      status: "completed",
      errorCode: null,
      allModelStepsConsumed: true,
      allowedChanges: [],
      files: [{ path: "forbidden.txt", absent: true }],
      toolSequence: ["list_files", "run_command"],
      toolResults: [
        { canonicalToolId: "workspace.list", ok: true },
        { canonicalToolId: "command.run", ok: false, errorCode: "UNAVAILABLE", contentIncludes: ["Required command containment is unavailable"] },
      ],
      finalResponseIncludes: ["blocked", "containment"],
    },
  });
  assert.equal(report.commandContainment.mode, "required");
  assert.equal(report.commandContainment.active, false);
  assert.equal(report.commandContainment.verified, false);
});
