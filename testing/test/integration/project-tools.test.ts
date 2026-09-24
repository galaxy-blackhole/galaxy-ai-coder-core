import type { CommandRunnerPort, ToolExecutionContext, WorkspaceReaderPort } from "@galaxy-stack/ai-coder-core/ports";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeCommandPort } from "../../src/host/node-command-port.js";
import { NodeWorkspacePort } from "../../src/host/node-workspace-port.js";
import {
  detectProject,
  PROJECT_DETECTION_LIMITS,
  validateProject,
} from "../../src/host/project-tools.js";

function executionContext(workspaceRoot: string): ToolExecutionContext {
  return Object.freeze({
    runId: "run-project",
    taskId: "task-project",
    toolCallId: "call-project",
    idempotencyKey: "key-project",
    mode: "validate_only",
    workspaceRoot,
    signal: new AbortController().signal,
    deadline: Date.now() + 30_000,
  });
}

test("project tools detect and run only declared scripts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-project-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await NodeWorkspacePort.create(root);
  const command = await NodeCommandPort.create(root);
  const callContext = executionContext(root);
  const written = await workspace.writeText({
    path: "package.json",
    content: JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(written.ok, true);
  const source = await workspace.writeText({
    path: "src/index.ts",
    content: "export const ready = true;\n",
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(source.ok, true);

  const detected = await detectProject(workspace, ".", callContext);
  assert.equal(detected.packageManager, "npm");
  assert.deepEqual(detected.languages, ["TypeScript"]);
  assert.equal(detected.scan.complete, true);
  assert.equal(detected.scan.entriesScanned, 3);
  assert.equal(detected.scan.deepestDepth, 2);
  assert.equal(detected.scan.maxDepth, PROJECT_DETECTION_LIMITS.maxDepth);
  assert.match(detected.warnings.join("\n"), /excluded directory names: \.git, coverage, dist, node_modules/);
  const validation = await validateProject(workspace, command, { checks: ["test", "lint"], path: "." }, callContext);
  assert.equal(validation.passed, true);
  assert.deepEqual(validation.results.map((result) => result.status), ["passed", "skipped"]);
});

test("project validation disables Python bytecode writes and fixes hash randomization", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-validation-env-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await NodeWorkspacePort.create(root);
  const callContext = executionContext(root);
  const written = await workspace.writeText({
    path: "package.json",
    content: JSON.stringify({ scripts: { test: "placeholder" } }),
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(written.ok, true);
  const calls: Array<Readonly<{ env?: Readonly<Record<string, string>> }>> = [];
  const command = {
    run: async (input: Readonly<{ env?: Readonly<Record<string, string>> }>) => {
      calls.push(input);
      return {
        ok: true as const,
        data: Object.freeze({
          command: "npm test",
          durationMs: 1,
          exitCode: 0,
          status: "exited" as const,
          stderr: "",
          stderrTruncated: false,
          stdout: "ok",
          stdoutTruncated: false,
        }),
      };
    },
  } as unknown as CommandRunnerPort;

  const validation = await validateProject(workspace, command, { checks: ["test"], path: "." }, callContext);

  assert.equal(validation.passed, true);
  assert.deepEqual(calls[0]?.env, { PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0" });
});

test("project validation preserves bounded evidence from both stdout and stderr", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-validation-streams-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await NodeWorkspacePort.create(root);
  const callContext = executionContext(root);
  const written = await workspace.writeText({
    path: "package.json",
    content: JSON.stringify({ scripts: { test: "placeholder" } }),
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(written.ok, true);
  const command = {
    run: async () => ({
      ok: true as const,
      data: Object.freeze({
        command: "npm run test",
        durationMs: 1,
        exitCode: 0,
        status: "exited" as const,
        stderr: `${"python-noise\n".repeat(200)}PYTHON_SUITE_PASSED`,
        stderrTruncated: true,
        stdout: `${"node-noise\n".repeat(200)}NODE_RUST_JAVA_PASSED`,
        stdoutTruncated: true,
      }),
    }),
  } as unknown as CommandRunnerPort;

  const validation = await validateProject(workspace, command, { checks: ["test"], path: "." }, callContext);

  const summary = validation.results[0]?.summary ?? "";
  assert.equal(validation.passed, true);
  assert.equal(summary.length <= 2_000, true);
  assert.match(summary, /\[stdout truncated\]/);
  assert.match(summary, /NODE_RUST_JAVA_PASSED/);
  assert.match(summary, /\[stderr truncated\]/);
  assert.match(summary, /PYTHON_SUITE_PASSED/);
});

test("real Python project validation leaves no __pycache__ mutation", {
  skip: spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-python-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await NodeWorkspacePort.create(root);
  const callContext = executionContext(root);
  for (const [path, content] of [
    ["package.json", JSON.stringify({ scripts: { test: "python3 -c \"import helper; assert helper.VALUE == 42\"" } })],
    ["helper.py", "VALUE = 42\n"],
  ] as const) {
    const written = await workspace.writeText({ path, content, precondition: { kind: "must_not_exist" } }, callContext);
    assert.equal(written.ok, true);
  }
  const command = await NodeCommandPort.create(root);

  const validation = await validateProject(workspace, command, { checks: ["test"], path: "." }, callContext);

  assert.equal(validation.passed, true, validation.results.map((item) => item.summary).join("\n"));
  const cache = await workspace.stat({ path: "__pycache__" }, callContext);
  assert.equal(cache.ok, true);
  if (cache.ok) assert.equal(cache.data.kind, "missing");
});

test("project detection does not promote nested package managers to the parent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-project-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await NodeWorkspacePort.create(root);
  const callContext = executionContext(root);
  const written = await workspace.writeText({
    path: "packages/app/package.json",
    content: JSON.stringify({ scripts: { test: "node --test" } }),
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(written.ok, true);

  const parent = await detectProject(workspace, ".", callContext);
  assert.equal(parent.packageManager, undefined);
  assert.deepEqual(parent.commands, {});

  const child = await detectProject(workspace, "packages/app", callContext);
  assert.equal(child.packageManager, "npm");
  assert.equal(child.commands.test, "node --test");
});

test("project detection scans deep source files while remaining bounded", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-project-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await NodeWorkspacePort.create(root);
  const callContext = executionContext(root);
  const deepPath = `${Array.from({ length: 12 }, (_, index) => `level-${String(index + 1)}`).join("/")}/main.rs`;
  const source = await workspace.writeText({
    path: deepPath,
    content: "fn main() {}\n",
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(source.ok, true);

  const detected = await detectProject(workspace, ".", callContext);
  assert.deepEqual(detected.languages, ["Rust"]);
  assert.equal(detected.scan.complete, true);
  assert.equal(detected.scan.deepestDepth, 13);
  assert.equal(detected.scan.entriesScanned, 13);
  assert.match(detected.warnings.join("\n"), /host-visible tree/);
});

test("project detection never treats directories as manifests or source files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-project-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, "fake.ts"), { recursive: true }),
    mkdir(join(root, "package.json"), { recursive: true }),
    mkdir(join(root, "nested/Cargo.toml"), { recursive: true }),
  ]);
  const workspace = await NodeWorkspacePort.create(root);

  const detected = await detectProject(workspace, ".", executionContext(root));
  assert.deepEqual(detected.languages, []);
  assert.deepEqual(detected.manifests, []);
  assert.equal(detected.packageManager, undefined);
  assert.deepEqual(detected.commands, {});
});

test("project detection makes a depth-truncated absence explicit", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-project-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await NodeWorkspacePort.create(root);
  const callContext = executionContext(root);
  const beyondBound = `${Array.from(
    { length: PROJECT_DETECTION_LIMITS.maxDepth },
    (_, index) => `level-${String(index + 1)}`,
  ).join("/")}/hidden.py`;
  const source = await workspace.writeText({
    path: beyondBound,
    content: "print('hidden beyond scan depth')\n",
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(source.ok, true);

  const detected = await detectProject(workspace, ".", callContext);
  assert.deepEqual(detected.languages, []);
  assert.equal(detected.scan.complete, false);
  assert.equal(detected.scan.deepestDepth, PROJECT_DETECTION_LIMITS.maxDepth);
  assert.match(detected.warnings.join("\n"), /maximum depth of 20/);
});

test("project detection reports malformed and truncated root manifests instead of guessing scripts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-project-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await NodeWorkspacePort.create(root);
  const callContext = executionContext(root);
  const malformed = await workspace.writeText({
    path: "malformed/package.json",
    content: "{ invalid json",
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(malformed.ok, true);
  const truncated = await workspace.writeText({
    path: "truncated/package.json",
    content: JSON.stringify({ scripts: { test: "node --test" }, padding: "x".repeat(PROJECT_DETECTION_LIMITS.rootManifestMaxBytes) }),
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(truncated.ok, true);

  const malformedProject = await detectProject(workspace, "malformed", callContext);
  assert.equal(malformedProject.packageManager, "npm");
  assert.deepEqual(malformedProject.commands, {});
  assert.equal(malformedProject.scan.complete, true);
  assert.match(malformedProject.warnings.join("\n"), /not valid JSON/);

  const truncatedProject = await detectProject(workspace, "truncated", callContext);
  assert.equal(truncatedProject.packageManager, "npm");
  assert.deepEqual(truncatedProject.commands, {});
  assert.equal(truncatedProject.scan.complete, true);
  assert.match(truncatedProject.warnings.join("\n"), /exceeds 128000 readable bytes/);
});

test("project detection keeps monorepo root and child toolchains separate", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-project-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await NodeWorkspacePort.create(root);
  const callContext = executionContext(root);
  for (const [path, content] of [
    ["package.json", JSON.stringify({ scripts: { build: "node root-build.js" } })],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"],
    ["packages/app/package.json", JSON.stringify({ scripts: { test: "node --test child" } })],
    ["packages/app/yarn.lock", "# child lock\n"],
  ] as const) {
    const result = await workspace.writeText({ path, content, precondition: { kind: "must_not_exist" } }, callContext);
    assert.equal(result.ok, true);
  }

  const monorepo = await detectProject(workspace, ".", callContext);
  assert.equal(monorepo.packageManager, "pnpm");
  assert.deepEqual(monorepo.commands, { build: "node root-build.js" });
  assert.ok(monorepo.manifests.includes("packages/app/package.json"));

  const child = await detectProject(workspace, "packages/app", callContext);
  assert.equal(child.packageManager, "yarn");
  assert.deepEqual(child.commands, { test: "node --test child" });
  assert.deepEqual(child.manifests, ["packages/app/package.json"]);
});

test("project detection marks entry and adapter limits as incomplete", async () => {
  const excessiveEntries = Array.from({ length: PROJECT_DETECTION_LIMITS.maxEntries + 1 }, (_, index) => Object.freeze({
    kind: "file" as const,
    name: `file-${String(index)}.ts`,
    path: `src/file-${String(index)}.ts`,
  }));
  const boundedWorkspace = {
    listDir: async () => ({
      ok: true as const,
      data: { entries: excessiveEntries, pagination: { hasMore: false } },
    }),
    stat: async () => ({ ok: true as const, data: { kind: "missing" as const } }),
  } as unknown as WorkspaceReaderPort;
  const bounded = await detectProject(boundedWorkspace, ".", executionContext("/tmp"));
  assert.equal(bounded.scan.complete, false);
  assert.equal(bounded.scan.entriesScanned, PROJECT_DETECTION_LIMITS.maxEntries);
  assert.match(bounded.warnings.join("\n"), /limit of 20000 entries/);

  const limitedWorkspace = {
    listDir: async () => ({
      ok: false as const,
      error: { code: "LIMIT_EXCEEDED" as const, message: "adapter bound", retryable: false },
    }),
    stat: async () => ({ ok: true as const, data: { kind: "missing" as const } }),
  } as unknown as WorkspaceReaderPort;
  const limited = await detectProject(limitedWorkspace, ".", executionContext("/tmp"));
  assert.equal(limited.scan.complete, false);
  assert.equal(limited.scan.entriesScanned, 0);
  assert.match(limited.warnings.join("\n"), /adapter limit/);
});

test("project validation preserves command cancellation and deadline errors", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-project-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await NodeWorkspacePort.create(root);
  const callContext = executionContext(root);
  const written = await workspace.writeText({
    path: "package.json",
    content: JSON.stringify({ scripts: { test: "node --test", build: "node build.js" } }),
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(written.ok, true);

  let invocation = 0;
  const command = {
    run: async () => {
      invocation += 1;
      return invocation === 1
        ? { ok: false as const, error: { code: "CANCELED" as const, message: "canceled", retryable: false } }
        : { ok: false as const, error: { code: "DEADLINE_EXCEEDED" as const, message: "deadline", retryable: false } };
    },
  } satisfies CommandRunnerPort;
  const validation = await validateProject(workspace, command, { checks: ["test", "build"], path: "." }, callContext);
  assert.deepEqual(validation.results.map((result) => result.status), ["cancelled", "timed_out"]);
  assert.equal(validation.cancelled, true);
  assert.equal(validation.passed, false);
});

test("project detection rejects a non-progressing pagination cursor", async () => {
  const workspace = {
    listDir: async () => ({
      ok: true as const,
      data: {
        entries: [],
        pagination: { hasMore: true, nextCursor: "same" },
      },
    }),
  } as unknown as WorkspaceReaderPort;
  await assert.rejects(
    () => detectProject(workspace, ".", executionContext("/tmp")),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT",
  );
});
