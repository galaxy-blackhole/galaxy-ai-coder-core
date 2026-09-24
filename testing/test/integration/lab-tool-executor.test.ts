import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandRunnerPort, ToolExecutionContext, WorkspacePort } from "@galaxy-stack/ai-coder-core";

import { sha256Text } from "../../src/host/content-hash.js";
import { NodeCommandPort } from "../../src/host/node-command-port.js";
import { NodeWorkspacePort } from "../../src/host/node-workspace-port.js";
import {
  DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS,
  diffNodeWorkspaceSnapshots,
  NodeWorkspaceSnapshotter,
} from "../../src/host/node-workspace-snapshot.js";
import { createFixtureApprovalPort } from "../../src/lab/fixture-approval.js";
import { SCRIPTED_MODEL_CAPABILITIES } from "../../src/lab/scripted-model.js";
import { LabToolExecutor } from "../../src/lab/tool-executor.js";

function context(
  workspaceRoot: string,
  input: Partial<Pick<ToolExecutionContext, "idempotencyKey" | "mode" | "toolCallId">> = {},
): ToolExecutionContext {
  return Object.freeze({
    deadline: Date.now() + 30_000,
    idempotencyKey: input.idempotencyKey ?? "idem-1",
    mode: input.mode ?? "auto",
    runId: "run-tool-executor",
    signal: new AbortController().signal,
    taskId: "task-tool-executor",
    toolCallId: input.toolCallId ?? "call-1",
    workspaceRoot,
  });
}

async function fixtureExecutor(
  workspaceRoot: string,
  mode: ToolExecutionContext["mode"] = "auto",
  enableGit = false,
  approvalDecisions: Readonly<Record<string, "allow" | "deny">> = Object.freeze({}),
) {
  const workspace = await NodeWorkspacePort.create(workspaceRoot);
  const command = await NodeCommandPort.create(workspaceRoot);
  const executor = new LabToolExecutor({
    approval: createFixtureApprovalPort(approvalDecisions),
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    command,
    enableGit,
    workspace,
  });
  await executor.getToolSet(context(workspaceRoot, { mode }));
  return executor;
}

async function runSetupCommand(
  command: NodeCommandPort,
  workspaceRoot: string,
  input: string,
): Promise<string> {
  const result = await command.run({ command: input, cwd: ".", timeoutMs: 20_000 }, context(workspaceRoot));
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  if (!result.ok) return "";
  assert.equal(result.data.status, "exited", result.data.stderr);
  assert.equal(result.data.exitCode, 0, result.data.stderr || result.data.stdout);
  return result.data.stdout;
}

test("LabToolExecutor rejects unknown, inactive, and schema-invalid calls before dispatch", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-registry-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const executor = await fixtureExecutor(workspaceRoot);
  const execution = context(workspaceRoot);

  const unknown = await executor.execute({
    arguments: {},
    name: "git_operation",
    toolCallId: "inactive-git",
  }, { ...execution, toolCallId: "inactive-git", idempotencyKey: "inactive-git" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error?.code, "UNKNOWN_TOOL");

  const invalid = await executor.execute({
    arguments: {},
    name: "read_file",
    toolCallId: "invalid-read",
  }, { ...execution, toolCallId: "invalid-read", idempotencyKey: "invalid-read" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, "INVALID_TOOL_ARGUMENTS");
});

test("LabToolExecutor preserves structured port failures", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-errors-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const executor = await fixtureExecutor(workspaceRoot);
  const result = await executor.execute({
    arguments: { path: "missing.txt" },
    name: "read_file",
    toolCallId: "missing-read",
  }, context(workspaceRoot, { idempotencyKey: "missing-read", toolCallId: "missing-read" }));

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "NOT_FOUND");
  assert.equal(result.error?.retryable, false);
});

test("mutation tools share a dependency-aware snapshot policy across edit, write, command, and validation", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-dependency-snapshot-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await mkdir(join(workspaceRoot, "node_modules/example"), { recursive: true });
  await writeFile(join(workspaceRoot, "node_modules/example/payload.bin"), "x".repeat(4_096));
  await writeFile(join(workspaceRoot, "editable.txt"), "before\n", "utf8");
  await writeFile(join(workspaceRoot, "command-mutation.cjs"), [
    "const fs = require('node:fs');",
    "fs.writeFileSync('command-created.txt', 'command\\n');",
    "fs.writeFileSync('node_modules/example/payload.bin', 'dependency changed\\n');",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(workspaceRoot, "validation-mutation.cjs"), [
    "require('node:fs').writeFileSync('validation-created.txt', 'validation\\n');",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(workspaceRoot, "package.json"), `${JSON.stringify({
    private: true,
    scripts: { test: "node validation-mutation.cjs" },
  })}\n`, "utf8");

  const workspace = await NodeWorkspacePort.create(workspaceRoot);
  const command = await NodeCommandPort.create(workspaceRoot);
  const executor = new LabToolExecutor({
    approval: createFixtureApprovalPort({ "command.run": "allow", "project.validate": "allow" }),
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    command,
    workspace,
    workspaceSnapshot: { maxHashedBytes: 1_024, derivedDirectories: ["node_modules"] },
  });
  await executor.getToolSet(context(workspaceRoot));

  const edit = await executor.execute({
    arguments: {
      newText: "after\n",
      oldText: "before\n",
      path: "editable.txt",
      precondition: { kind: "matches_sha256", contentSha256: sha256Text("before\n") },
    },
    name: "edit_file",
    toolCallId: "dependency-edit",
  }, context(workspaceRoot, { idempotencyKey: "dependency-edit", toolCallId: "dependency-edit" }));
  assert.equal(edit.ok, true, edit.error?.message);

  const write = await executor.execute({
    arguments: { content: "written\n", path: "written.txt", precondition: { kind: "must_not_exist" } },
    name: "write_file",
    toolCallId: "dependency-write",
  }, context(workspaceRoot, { idempotencyKey: "dependency-write", toolCallId: "dependency-write" }));
  assert.equal(write.ok, true, write.error?.message);

  const run = await executor.execute({
    arguments: { command: `${JSON.stringify(process.execPath)} command-mutation.cjs` },
    name: "run_command",
    toolCallId: "dependency-command",
  }, context(workspaceRoot, { idempotencyKey: "dependency-command", toolCallId: "dependency-command" }));
  assert.equal(run.ok, true, run.error?.message);
  assert.deepEqual(run.effects?.writes?.map((item) => item.path), ["command-created.txt"]);
  assert.deepEqual((JSON.parse(run.content) as {
    derivedMutations?: { count: number; paths: string[]; truncated: boolean };
  }).derivedMutations, {
    count: 1,
    paths: ["node_modules/example/payload.bin"],
    truncated: false,
  });

  const validation = await executor.execute({
    arguments: { checks: ["test"], path: "." },
    name: "validate_project",
    toolCallId: "dependency-validation",
  }, context(workspaceRoot, { idempotencyKey: "dependency-validation", toolCallId: "dependency-validation" }));
  assert.equal(validation.ok, true, validation.error?.message);
  assert.equal(validation.effects?.validations?.[0]?.status, "passed");
  assert.deepEqual(validation.effects?.writes?.map((item) => item.path), ["validation-created.txt"]);
});

test("a failed pre-mutation snapshot returns a structured error without calling the write adapter", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-baseline-failure-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(join(workspaceRoot, "editable.txt"), "before\n", "utf8");
  const actualWorkspace = await NodeWorkspacePort.create(workspaceRoot);
  let applyPatchCalls = 0;
  const workspace = new Proxy(actualWorkspace, {
    get(target, property) {
      if (property === "applyPatch") {
        return async () => {
          applyPatchCalls += 1;
          throw new Error("write adapter must not be called");
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as WorkspacePort;
  const executor = new LabToolExecutor({
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    command: await NodeCommandPort.create(workspaceRoot),
    workspace,
    workspaceSnapshot: { maxHashedBytes: 1 },
  });
  await executor.getToolSet(context(workspaceRoot));

  const result = await executor.execute({
    arguments: {
      newText: "after\n",
      oldText: "before\n",
      path: "editable.txt",
      precondition: { kind: "matches_sha256", contentSha256: sha256Text("before\n") },
    },
    name: "edit_file",
    toolCallId: "baseline-failure",
  }, context(workspaceRoot, { idempotencyKey: "baseline-failure", toolCallId: "baseline-failure" }));

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "LIMIT_EXCEEDED");
  assert.match(result.error?.message ?? "", /before tool side effects/);
  assert.equal(applyPatchCalls, 0);
  assert.equal(await readFile(join(workspaceRoot, "editable.txt"), "utf8"), "before\n");
});

test("read-only adapter coded failures remain structured and recoverable", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-read-error-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const delegate = await NodeWorkspacePort.create(workspaceRoot);
  const workspace = new Proxy(delegate, {
    get(target, property) {
      if (property === "listDir") {
        return async () => Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "PERMISSION_DENIED" as const, message: "bounded read rejected", retryable: false }),
        });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as WorkspacePort;
  const executor = new LabToolExecutor({
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    command: await NodeCommandPort.create(workspaceRoot),
    workspace,
  });
  await executor.getToolSet(context(workspaceRoot));

  const result = await executor.execute({
    arguments: { path: "." },
    name: "detect_project",
    toolCallId: "detect-read-error",
  }, context(workspaceRoot, { idempotencyKey: "detect-read-error", toolCallId: "detect-read-error" }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "PERMISSION_DENIED");
  assert.match(result.summary, /bounded read rejected/);
});

test("LabToolExecutor throws unknown outcome after malformed or thrown workspace mutations", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-malformed-write-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(workspaceRoot, "edit.txt"), "before\n", "utf8"),
    writeFile(join(workspaceRoot, "failed-edit.txt"), "before\n", "utf8"),
  ]);
  const delegate = await NodeWorkspacePort.create(workspaceRoot);
  const workspace = Object.freeze({
    async applyPatch(input) {
      const resolvedPath = join(workspaceRoot, input.path);
      await writeFile(resolvedPath, input.newText, "utf8");
      if (input.path === "failed-edit.txt") {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "IO_ERROR" as const, message: "adapter failed after edit commit", retryable: false }),
        });
      }
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          afterContentSha256: sha256Text(input.newText),
          beforeContentSha256: input.precondition.kind === "matches_sha256"
            ? input.precondition.contentSha256
            : sha256Text("before\n"),
          path: input.path,
          replacements: "malformed-replacements",
          resolvedPath,
        }),
      }) as unknown as ReturnType<WorkspacePort["applyPatch"]> extends Promise<infer T> ? T : never;
    },
    listDir: delegate.listDir.bind(delegate),
    mkdir: delegate.mkdir.bind(delegate),
    readText: delegate.readText.bind(delegate),
    searchPaths: delegate.searchPaths.bind(delegate),
    searchText: delegate.searchText.bind(delegate),
    stat: delegate.stat.bind(delegate),
    async writeText(input) {
      const resolvedPath = join(workspaceRoot, input.path);
      await writeFile(resolvedPath, input.content, "utf8");
      if (input.path === "thrown.txt") throw new Error("adapter transport collapsed after commit");
      if (input.path === "failed-write.txt") {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "IO_ERROR" as const, message: "adapter failed after write commit", retryable: false }),
        });
      }
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          afterContentSha256: sha256Text(input.content),
          length: "malformed-length",
          path: input.path,
          resolvedPath,
        }),
      }) as unknown as ReturnType<WorkspacePort["writeText"]> extends Promise<infer T> ? T : never;
    },
  } satisfies WorkspacePort);
  const executor = new LabToolExecutor({
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    command: await NodeCommandPort.create(workspaceRoot),
    workspace,
  });
  await executor.getToolSet(context(workspaceRoot));

  await assert.rejects(
    executor.execute({
      arguments: { content: "SIDE EFFECT\n", path: "lost.txt", precondition: { kind: "must_not_exist" } },
      name: "write_file",
      toolCallId: "malformed-write",
    }, context(workspaceRoot, { idempotencyKey: "malformed-write", toolCallId: "malformed-write" })),
    /Adapter output violated workspace\.write after dispatch; side-effect evidence cannot be trusted/,
  );
  assert.equal(await readFile(join(workspaceRoot, "lost.txt"), "utf8"), "SIDE EFFECT\n");

  await assert.rejects(
    executor.execute({
      arguments: {
        newText: "after\n",
        oldText: "before\n",
        path: "edit.txt",
        precondition: { kind: "matches_sha256", contentSha256: sha256Text("before\n") },
      },
      name: "edit_file",
      toolCallId: "malformed-edit",
    }, context(workspaceRoot, { idempotencyKey: "malformed-edit", toolCallId: "malformed-edit" })),
    /Adapter output violated workspace\.edit after dispatch; side-effect evidence cannot be trusted/,
  );
  assert.equal(await readFile(join(workspaceRoot, "edit.txt"), "utf8"), "after\n");

  await assert.rejects(
    executor.execute({
      arguments: { content: "THROWN SIDE EFFECT\n", path: "thrown.txt", precondition: { kind: "must_not_exist" } },
      name: "write_file",
      toolCallId: "thrown-write",
    }, context(workspaceRoot, { idempotencyKey: "thrown-write", toolCallId: "thrown-write" })),
    /Adapter failed after dispatching workspace\.write; side-effect outcome is unknown/,
  );
  assert.equal(await readFile(join(workspaceRoot, "thrown.txt"), "utf8"), "THROWN SIDE EFFECT\n");

  await assert.rejects(
    executor.execute({
      arguments: { content: "FAILED SIDE EFFECT\n", path: "failed-write.txt", precondition: { kind: "must_not_exist" } },
      name: "write_file",
      toolCallId: "failed-write",
    }, context(workspaceRoot, { idempotencyKey: "failed-write", toolCallId: "failed-write" })),
    /workspace\.write returned IO_ERROR after changing 1 workspace path\(s\); side-effect outcome is unknown/,
  );
  assert.equal(await readFile(join(workspaceRoot, "failed-write.txt"), "utf8"), "FAILED SIDE EFFECT\n");

  await assert.rejects(
    executor.execute({
      arguments: {
        newText: "failed after\n",
        oldText: "before\n",
        path: "failed-edit.txt",
        precondition: { kind: "matches_sha256", contentSha256: sha256Text("before\n") },
      },
      name: "edit_file",
      toolCallId: "failed-edit",
    }, context(workspaceRoot, { idempotencyKey: "failed-edit", toolCallId: "failed-edit" })),
    /workspace\.edit returned IO_ERROR after changing 1 workspace path\(s\); side-effect outcome is unknown/,
  );
  assert.equal(await readFile(join(workspaceRoot, "failed-edit.txt"), "utf8"), "failed after\n");
});

test("LabToolExecutor caches with-key mutations and fails high-risk approval closed", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-idempotency-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const executor = await fixtureExecutor(workspaceRoot);
  const writeCall = Object.freeze({
    arguments: Object.freeze({
      content: "stable\n",
      path: "nested/stable.txt",
      precondition: Object.freeze({ kind: "must_not_exist" }),
    }),
    name: "write_file",
    toolCallId: "write-stable",
  });
  const writeContext = context(workspaceRoot, { idempotencyKey: "write-stable-key", toolCallId: "write-stable" });
  const first = await executor.execute(writeCall, writeContext);
  const replay = await executor.execute(writeCall, writeContext);

  assert.equal(first.ok, true);
  assert.equal(replay, first);
  assert.equal(await readFile(join(workspaceRoot, "nested/stable.txt"), "utf8"), "stable\n");
  assert.deepEqual(first.effects?.writes, [
    {
      afterHash: null,
      afterKind: "directory",
      beforeHash: null,
      beforeKind: "missing",
      path: "nested",
    },
    {
      afterHash: sha256Text("stable\n"),
      afterKind: "file",
      beforeHash: null,
      beforeKind: "missing",
      path: "nested/stable.txt",
    },
  ]);

  const command = await executor.execute({
    arguments: { command: "printf should-not-run" },
    name: "run_command",
    toolCallId: "denied-command",
  }, context(workspaceRoot, { idempotencyKey: "denied-command", toolCallId: "denied-command" }));
  assert.equal(command.ok, false);
  assert.equal(command.error?.code, "DENIED_BY_HOST");
});

test("review_only mode removes mutation tools from the model-visible registry", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-review-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const executor = await fixtureExecutor(workspaceRoot, "review_only");
  const toolSet = await executor.getToolSet(context(workspaceRoot, { mode: "review_only" }));
  const names = toolSet.definitions.map((definition) => definition.function.name);

  assert.equal(names.includes("write_file"), false);
  assert.equal(names.includes("run_command"), false);
  assert.equal(names.includes("read_file"), true);
});

test("read_file forwards a stable text cursor and returns the next cursor", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-read-cursor-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(
    join(workspaceRoot, "large.txt"),
    `${"a".repeat(300)}${"b".repeat(300)}${"c".repeat(300)}\n`,
    "utf8",
  );
  const executor = await fixtureExecutor(workspaceRoot);

  const first = await executor.execute({
    arguments: { path: "large.txt", maxBytes: 256 },
    name: "read_file",
    toolCallId: "read-page-1",
  }, context(workspaceRoot, { idempotencyKey: "read-page-1", toolCallId: "read-page-1" }));
  assert.equal(first.ok, true);
  const firstOutput = JSON.parse(first.content) as {
    content: string;
    contentHash: string;
    nextCursor?: string;
    truncated: boolean;
  };
  assert.equal(firstOutput.truncated, true);
  assert.equal(typeof firstOutput.nextCursor, "string");

  const second = await executor.execute({
    arguments: { path: "large.txt", maxBytes: 256, cursor: firstOutput.nextCursor },
    name: "read_file",
    toolCallId: "read-page-2",
  }, context(workspaceRoot, { idempotencyKey: "read-page-2", toolCallId: "read-page-2" }));
  assert.equal(second.ok, true);
  const secondOutput = JSON.parse(second.content) as {
    content: string;
    contentHash: string;
    nextCursor?: string;
    truncated: boolean;
  };
  assert.notEqual(secondOutput.content, firstOutput.content);
  assert.equal(secondOutput.contentHash, firstOutput.contentHash);
  assert.notEqual(secondOutput.nextCursor, firstOutput.nextCursor);
});

test("validate_project emits semantic validation ids independent of tool call ids", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-validation-id-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await mkdir(join(workspaceRoot, "nested"), { recursive: true });
  await writeFile(join(workspaceRoot, "nested/package.json"), `${JSON.stringify({
    private: true,
    scripts: { test: "node -e \"process.exit(0)\"" },
  })}\n`, "utf8");
  const executor = await fixtureExecutor(workspaceRoot, "auto", false, { "project.validate": "allow" });

  const first = await executor.execute({
    arguments: { checks: ["test"], path: "nested/." },
    name: "validate_project",
    toolCallId: "validation-first-call",
  }, context(workspaceRoot, { idempotencyKey: "validation-first-call", toolCallId: "validation-first-call" }));
  const second = await executor.execute({
    arguments: { checks: ["test"], path: "nested" },
    name: "validate_project",
    toolCallId: "validation-second-call",
  }, context(workspaceRoot, { idempotencyKey: "validation-second-call", toolCallId: "validation-second-call" }));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const firstId = first.effects?.validations?.[0]?.id;
  const secondId = second.effects?.validations?.[0]?.id;
  assert.equal(firstId, "project.validate:test:nested");
  assert.equal(secondId, firstId);
  assert.doesNotMatch(firstId ?? "", /validation-(?:first|second)-call/);
});

test("validate_project requires explicit approval before repository scripts execute", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-validation-approval-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(join(workspaceRoot, "package.json"), `${JSON.stringify({
    private: true,
    scripts: { test: "node -e \"require('node:fs').writeFileSync('forbidden.txt','ran')\"" },
  })}\n`, "utf8");
  const executor = await fixtureExecutor(workspaceRoot);

  const result = await executor.execute({
    arguments: { checks: ["test"], path: "." },
    name: "validate_project",
    toolCallId: "denied-validation",
  }, context(workspaceRoot, { idempotencyKey: "denied-validation", toolCallId: "denied-validation" }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DENIED_BY_HOST");
  await assert.rejects(access(join(workspaceRoot, "forbidden.txt")));
});

test("run_command proves file creation, modification, and deletion even when the command exits nonzero", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-command-mutations-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(workspaceRoot, ".git"), { recursive: true }),
    mkdir(join(workspaceRoot, "coverage"), { recursive: true }),
    mkdir(join(workspaceRoot, "dist"), { recursive: true }),
    mkdir(join(workspaceRoot, "node_modules"), { recursive: true }),
  ]);
  await writeFile(join(workspaceRoot, "coverage/deleted.txt"), "delete me\n", "utf8");
  await writeFile(join(workspaceRoot, "node_modules/modified.txt"), "before\n", "utf8");
  await writeFile(join(workspaceRoot, "mutate-command.cjs"), [
    "const fs = require('node:fs');",
    "fs.writeFileSync('dist/created.txt', 'created\\n');",
    "fs.writeFileSync('node_modules/modified.txt', 'after\\n');",
    "fs.unlinkSync('coverage/deleted.txt');",
    "fs.writeFileSync('.git/ignored.txt', 'git internal\\n');",
    "fs.writeFileSync('transient.galaxy-code.lock', 'lock\\n');",
    "process.exitCode = 7;",
    "",
  ].join("\n"), "utf8");
  const snapshotter = await NodeWorkspaceSnapshotter.create(
    workspaceRoot,
    DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS,
  );
  const beforeSnapshot = await snapshotter.capture(context(workspaceRoot));
  const executor = await fixtureExecutor(workspaceRoot, "auto", false, { "command.run": "allow" });

  const result = await executor.execute({
    arguments: { command: `${JSON.stringify(process.execPath)} mutate-command.cjs` },
    name: "run_command",
    toolCallId: "mutating-command",
  }, context(workspaceRoot, { idempotencyKey: "mutating-command", toolCallId: "mutating-command" }));

  assert.equal(result.ok, true, result.error?.message);
  assert.equal((JSON.parse(result.content) as { exitCode: number }).exitCode, 7);
  assert.equal(result.effects?.approval, "granted");
  const afterSnapshot = await snapshotter.capture(context(workspaceRoot));
  const independentlyObserved = diffNodeWorkspaceSnapshots(beforeSnapshot, afterSnapshot);
  assert.deepEqual(result.effects?.writes, [
    {
      afterHash: null,
      afterKind: "missing",
      beforeHash: sha256Text("delete me\n"),
      beforeKind: "file",
      path: "coverage/deleted.txt",
    },
    {
      afterHash: sha256Text("created\n"),
      afterKind: "file",
      beforeHash: null,
      beforeKind: "missing",
      path: "dist/created.txt",
    },
  ]);
  assert.deepEqual(independentlyObserved.observedMutations
    .filter((mutation) => mutation.evidenceClass === "derived")
    .map((mutation) => mutation.path), ["node_modules/modified.txt"]);
  assert.deepEqual((JSON.parse(result.content) as {
    derivedMutations?: { count: number; paths: string[]; truncated: boolean };
  }).derivedMutations, {
    count: 1,
    paths: ["node_modules/modified.txt"],
    truncated: false,
  });
  assert.match(result.effects?.stateVersion ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.effects?.stateVersion, afterSnapshot.stateVersion);
  assert.equal(await readFile(join(workspaceRoot, ".git/ignored.txt"), "utf8"), "git internal\n");
  assert.equal(await readFile(join(workspaceRoot, "transient.galaxy-code.lock"), "utf8"), "lock\n");
});

test("run_command preserves observed mutations when its command port returns a failure", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-command-port-failure-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const workspace = await NodeWorkspacePort.create(workspaceRoot);
  const command = Object.freeze({
    async run() {
      await writeFile(join(workspaceRoot, "partial-output.txt"), "written before failure\n", "utf8");
      return Object.freeze({
        ok: false as const,
        error: Object.freeze({ code: "IO_ERROR" as const, message: "supervisor channel failed", retryable: false }),
      });
    },
  } satisfies CommandRunnerPort);
  const executor = new LabToolExecutor({
    approval: createFixtureApprovalPort({ "command.run": "allow" }),
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    command,
    workspace,
  });
  await executor.getToolSet(context(workspaceRoot));

  const result = await executor.execute({
    arguments: { command: "synthetic partial failure" },
    name: "run_command",
    toolCallId: "partial-failure",
  }, context(workspaceRoot, { idempotencyKey: "partial-failure", toolCallId: "partial-failure" }));
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(result.effects?.writes, [{
    afterHash: sha256Text("written before failure\n"),
    afterKind: "file",
    beforeHash: null,
    beforeKind: "missing",
    path: "partial-output.txt",
  }]);
  const output = JSON.parse(result.content) as { exitCode: number; stderr: string };
  assert.equal(output.exitCode, -1);
  assert.match(output.stderr, /IO_ERROR: supervisor channel failed/);
});

test("run_command reports a derived-only mutation after a command port failure without fabricating a core write", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-derived-port-failure-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await mkdir(join(workspaceRoot, "node_modules/example"), { recursive: true });
  await writeFile(join(workspaceRoot, "node_modules/example/state.txt"), "before\n", "utf8");
  const workspace = await NodeWorkspacePort.create(workspaceRoot);
  const command = Object.freeze({
    async run() {
      await writeFile(join(workspaceRoot, "node_modules/example/state.txt"), "after!\n", "utf8");
      return Object.freeze({
        ok: false as const,
        error: Object.freeze({ code: "IO_ERROR" as const, message: "supervisor channel failed", retryable: false }),
      });
    },
  } satisfies CommandRunnerPort);
  const executor = new LabToolExecutor({
    approval: createFixtureApprovalPort({ "command.run": "allow" }),
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    command,
    workspace,
  });
  await executor.getToolSet(context(workspaceRoot));

  const result = await executor.execute({
    arguments: { command: "synthetic derived-only partial failure" },
    name: "run_command",
    toolCallId: "derived-partial-failure",
  }, context(workspaceRoot, { idempotencyKey: "derived-partial-failure", toolCallId: "derived-partial-failure" }));

  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.effects?.writes, undefined);
  assert.match(result.effects?.stateVersion ?? "", /^sha256:[a-f0-9]{64}$/);
  const output = JSON.parse(result.content) as {
    derivedMutations?: { count: number; paths: string[]; truncated: boolean };
    stderr: string;
  };
  assert.deepEqual(output.derivedMutations, {
    count: 1,
    paths: ["node_modules/example/state.txt"],
    truncated: false,
  });
  assert.match(output.stderr, /IO_ERROR: supervisor channel failed/);
});

test("validate_project preserves validation evidence and proves files created by validation scripts", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-validation-mutations-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(join(workspaceRoot, "validation-mutation.cjs"), [
    "const fs = require('node:fs');",
    "fs.writeFileSync('validation-generated.txt', 'generated by validation\\n');",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(workspaceRoot, "package.json"), `${JSON.stringify({
    private: true,
    scripts: { test: "node validation-mutation.cjs" },
  })}\n`, "utf8");
  const executor = await fixtureExecutor(workspaceRoot, "auto", false, { "project.validate": "allow" });

  const result = await executor.execute({
    arguments: { checks: ["test"], path: "." },
    name: "validate_project",
    toolCallId: "mutating-validation",
  }, context(workspaceRoot, { idempotencyKey: "mutating-validation", toolCallId: "mutating-validation" }));

  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.effects?.validations?.length, 1);
  assert.equal(result.effects?.validations?.[0]?.id, "project.validate:test:.");
  assert.equal(result.effects?.validations?.[0]?.scope, "workspace");
  assert.equal(result.effects?.validations?.[0]?.status, "passed");
  assert.match(result.effects?.validations?.[0]?.detail ?? "", /^test:/);
  assert.deepEqual(result.effects?.writes, [{
    afterHash: sha256Text("generated by validation\n"),
    afterKind: "file",
    beforeHash: null,
    beforeKind: "missing",
    path: "validation-generated.txt",
  }]);
  assert.match(result.effects?.stateVersion ?? "", /^sha256:[a-f0-9]{64}$/);
  const output = JSON.parse(result.content) as { passed: boolean };
  assert.equal(output.passed, true);
});

test("git diff combines working-tree, staged, and safely quoted untracked changes without mutating the index", async (testContext) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-tool-git-diff-"));
  testContext.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const command = await NodeCommandPort.create(workspaceRoot);
  await writeFile(join(workspaceRoot, "tracked.txt"), "tracked baseline\n", "utf8");
  await writeFile(join(workspaceRoot, "staged.txt"), "staged baseline\n", "utf8");
  await runSetupCommand(command, workspaceRoot, "git init --quiet");
  await runSetupCommand(command, workspaceRoot, "git add -- tracked.txt staged.txt");
  await runSetupCommand(
    command,
    workspaceRoot,
    "git -c user.name=GalaxyTest -c user.email=test@local.invalid commit --quiet -m baseline",
  );

  await writeFile(join(workspaceRoot, "tracked.txt"), "tracked working tree\n", "utf8");
  await writeFile(join(workspaceRoot, "staged.txt"), "staged index\n", "utf8");
  await runSetupCommand(command, workspaceRoot, "git add -- staged.txt");
  const untrackedPath = "untracked %PATH%! '$(touch injected-marker)' file.txt";
  await writeFile(join(workspaceRoot, untrackedPath), "untracked content\n", "utf8");
  const indexBefore = await runSetupCommand(command, workspaceRoot, "git diff --cached --binary");

  const executor = await fixtureExecutor(workspaceRoot, "auto", true);
  const activation = await executor.execute({
    arguments: { query: "inspect git diff", category: "git", limit: 5 },
    name: "search_tools",
    toolCallId: "activate-git",
  }, context(workspaceRoot, { idempotencyKey: "activate-git", toolCallId: "activate-git" }));
  assert.equal(activation.ok, true);
  const diff = await executor.execute({
    arguments: { action: "diff", paths: ["tracked.txt", "staged.txt", untrackedPath] },
    name: "git_operation",
    toolCallId: "full-git-diff",
  }, context(workspaceRoot, { idempotencyKey: "full-git-diff", toolCallId: "full-git-diff" }));

  assert.equal(diff.ok, true, diff.error?.message);
  const output = JSON.parse(diff.content) as { stdout: string; truncated: boolean };
  assert.equal(output.truncated, false);
  assert.match(output.stdout, /tracked working tree/);
  assert.match(output.stdout, /staged index/);
  assert.match(output.stdout, /untracked content/);
  assert.equal(typeof diff.effects?.diffReview?.diffHash, "string");
  assert.equal(await runSetupCommand(command, workspaceRoot, "git diff --cached --binary"), indexBefore);
  await assert.rejects(access(join(workspaceRoot, "injected-marker")));

  await writeFile(join(workspaceRoot, "large-untracked.txt"), "x".repeat(80_000), "utf8");
  const truncated = await executor.execute({
    arguments: { action: "diff", paths: ["large-untracked.txt"] },
    name: "git_operation",
    toolCallId: "truncated-git-diff",
  }, context(workspaceRoot, { idempotencyKey: "truncated-git-diff", toolCallId: "truncated-git-diff" }));
  assert.equal(truncated.ok, true, truncated.error?.message);
  const truncatedOutput = JSON.parse(truncated.content) as { truncated: boolean };
  assert.equal(truncatedOutput.truncated, true);
  assert.equal(truncated.effects?.diffReview, undefined);
});
