import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeCommandPort } from "../src/adapters/node/host/node-command-port.js";
import type { ToolExecutionContext } from "../src/ports/execution-context.js";

function toolContext(workspaceRoot: string): ToolExecutionContext {
  return Object.freeze({
    deadline: Date.now() + 60_000,
    idempotencyKey: "test",
    mode: "auto" as const,
    runId: "run-persistent-shell",
    signal: new AbortController().signal,
    taskId: "task-persistent-shell",
    toolCallId: "call-persistent-shell",
    workspaceRoot,
  });
}

test("the shared shell keeps cwd, exports and background jobs between commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-shell-"));
  await mkdir(join(root, "sub"), { recursive: true });
  const port = await NodeCommandPort.create(root);
  const context = toolContext(root);
  try {
    const first = await port.run({ command: "cd sub && export GX_MARK=kept && pwd" }, context);
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;
    assert.match(first.data.stdout, /sub/, "the first command changed directory");

    // No cwd argument on purpose: the shell itself must still be inside sub/ and keep GX_MARK.
    const second = await port.run({ command: "pwd; echo mark=\$GX_MARK; (sleep 5; echo background-ran) & echo spawned" }, context);
    assert.equal(second.ok, true, JSON.stringify(second));
    if (!second.ok) return;
    assert.match(second.data.stdout, /sub/, "the working directory persisted");
    assert.match(second.data.stdout, /mark=kept/, "the exported variable persisted");
    assert.match(second.data.stdout, /spawned/, "a background job can be started");

    const third = await port.run({ command: "sleep 5; echo never" }, { ...context, signal: context.signal });
    assert.equal(third.ok, true);
    if (!third.ok) return;
  } finally {
    await port.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a command that hits its maximum is killed with its partial output, and the shell resets", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-shell-timeout-"));
  await mkdir(join(root, "sub"), { recursive: true });
  const port = await NodeCommandPort.create(root);
  const context = toolContext(root);
  try {
    await port.run({ command: "cd sub" }, context);
    const started = Date.now();
    const result = await port.run({ command: "echo partial; sleep 30; echo never", timeoutMs: 400 }, context);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.data.status, "timed_out", "the command was stopped at its maximum");
    assert.equal(result.data.exitCode, null);
    assert.match(result.data.stdout, /partial/, "the partial output is returned");
    assert.ok(Date.now() - started < 20_000, "the call returns at the maximum, not after the command");

    // The shell was reset, as the harness does: the next command starts from the root again.
    const after = await port.run({ command: "pwd" }, context);
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.ok(!/sub/.test(after.data.stdout), "the killed shell was replaced");
  } finally {
    await port.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
