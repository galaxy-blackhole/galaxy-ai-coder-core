import type { ToolExecutionContext } from "@galaxy-stack/ai-coder-core/ports";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { nodeCommandHostEnvironment } from "../../src/host/host-environment.js";
import { NodeCommandPort } from "../../src/host/node-command-port.js";

function executionContext(
  workspaceRoot: string,
  signal = new AbortController().signal,
  deadline = Date.now() + 30_000,
): ToolExecutionContext {
  return Object.freeze({
    runId: "run-command",
    taskId: "task-command",
    toolCallId: "call-command",
    idempotencyKey: "idempotency-command",
    mode: "validate_only",
    workspaceRoot,
    signal,
    deadline,
  });
}

test("NodeCommandPort captures deterministic output and exit status", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-command-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const port = await NodeCommandPort.create(workspace);
  assert.deepEqual(port.hostEnvironment, nodeCommandHostEnvironment());

  const result = await port.run({ command: "node -e \"process.stdout.write('ok')\"" }, executionContext(workspace));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.status, "exited");
  assert.equal(result.data.exitCode, 0);
  assert.equal(result.data.stdout, "ok");
});

test("NodeCommandPort supports a complete local Git commit, push, clone, and pull lifecycle", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-local-git-lifecycle-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const port = await NodeCommandPort.create(workspace);
  const run = async (command: string, cwd = ".") => {
    const result = await port.run({ command, cwd, timeoutMs: 30_000 }, executionContext(workspace));
    if (!result.ok) assert.fail(result.error.message);
    assert.equal(result.data.exitCode, 0, `${command}\n${result.data.stderr}`);
    return result.data;
  };

  await run("git init --quiet --initial-branch=main");
  await run("git config user.name GalaxyLifecycle");
  await run("git config user.email lifecycle@local.invalid");
  await writeFile(join(workspace, "version.txt"), "v1\n", "utf8");
  await run("git add version.txt");
  await run("git commit --quiet -m initial");
  await run("git init --quiet --bare remote.git");
  await run("git remote add origin remote.git");
  await run("git push --quiet --set-upstream origin main");
  await run("git clone --quiet remote.git consumer");
  await writeFile(join(workspace, "version.txt"), "v2\n", "utf8");
  await run("git add version.txt");
  await run("git commit --quiet -m update");
  await run("git push --quiet origin main");
  await run("git pull --quiet --ff-only origin main", "consumer");

  assert.equal(await readFile(join(workspace, "consumer/version.txt"), "utf8"), "v2\n");
});

test("NodeCommandPort executes the exact advertised shell dialect without a TTY", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-shell-contract-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const port = await NodeCommandPort.create(workspace);
  const windows = process.platform === "win32";
  const dialectCommand = windows
    ? 'set "GALAXY_LOCAL_VALUE=cmd value" && if "%GALAXY_LOCAL_VALUE%"=="cmd value" (echo cmd-ok) else (exit /b 9)'
    : "GALAXY_LOCAL_VALUE='sh value'; test \"$GALAXY_LOCAL_VALUE\" = 'sh value' && printf '%s' sh-ok";
  const inheritedCommand = windows
    ? 'if "%GALAXY_INHERITED_VALUE%"=="from-host" (echo env-ok) else (exit /b 10)'
    : "test \"$GALAXY_INHERITED_VALUE\" = 'from-host' && printf '%s' env-ok";
  const redirectCommand = windows
    ? 'echo shell-ok>"space ü.txt" && type "space ü.txt"'
    : "printf '%s' shell-ok > 'space ü.txt' && cat 'space ü.txt'";

  const dialect = await port.run({ command: dialectCommand }, executionContext(workspace));
  assert.equal(dialect.ok, true);
  if (!dialect.ok) return;
  assert.equal(dialect.data.exitCode, 0);
  assert.equal(dialect.data.stdout.trim(), windows ? "cmd-ok" : "sh-ok");

  const inherited = await port.run({
    command: inheritedCommand,
    env: { GALAXY_INHERITED_VALUE: "from-host" },
  }, executionContext(workspace));
  assert.equal(inherited.ok, true);
  if (!inherited.ok) return;
  assert.equal(inherited.data.exitCode, 0);
  assert.equal(inherited.data.stdout.trim(), "env-ok");

  const redirected = await port.run({ command: redirectCommand }, executionContext(workspace));
  assert.equal(redirected.ok, true);
  if (!redirected.ok) return;
  assert.equal(redirected.data.exitCode, 0);
  assert.equal((await readFile(join(workspace, "space ü.txt"), "utf8")).trim(), "shell-ok");

  const tty = await port.run({
    command: 'node -e "process.stdout.write(JSON.stringify([Boolean(process.stdin.isTTY),Boolean(process.stdout.isTTY)]))"',
  }, executionContext(workspace));
  assert.equal(tty.ok, true);
  if (!tty.ok) return;
  assert.deepEqual(JSON.parse(tty.data.stdout), [false, false]);
});

test("NodeCommandPort propagates cancellation to the child", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-command-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const port = await NodeCommandPort.create(workspace);
  const controller = new AbortController();
  const resultPromise = port.run(
    {
      command: "node -e \"setTimeout(() => require('node:fs').writeFileSync('late.txt', 'bad'), 350); setInterval(() => {}, 1000)\"",
      timeoutMs: 20_000,
    },
    executionContext(workspace, controller.signal),
  );
  setTimeout(() => controller.abort(), 50);

  const result = await resultPromise;
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.status, "canceled");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(() => readFile(join(workspace, "late.txt"), "utf8"), { code: "ENOENT" });
});

test("NodeCommandPort enforces UTF-8 output caps independently per stream", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-command-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const port = await NodeCommandPort.create(workspace);
  const result = await port.run({
    command: "node -e \"process.stdout.write('é'.repeat(100)); process.stderr.write('x'.repeat(100))\"",
    maxOutputBytes: 7,
  }, executionContext(workspace));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.stdoutTruncated, true);
  assert.equal(result.data.stderrTruncated, true);
  assert.ok(Buffer.byteLength(result.data.stdout, "utf8") <= 7);
  assert.ok(Buffer.byteLength(result.data.stderr, "utf8") <= 7);
});

test("NodeCommandPort rejects invalid input and paths with canonical errors", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-command-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const port = await NodeCommandPort.create(workspace);

  const invalidEnvironment = await port.run({
    command: "node --version",
    env: { "BAD-NAME": "value" },
  }, executionContext(workspace));
  assert.equal(invalidEnvironment.ok, false);
  if (!invalidEnvironment.ok) assert.equal(invalidEnvironment.error.code, "INVALID_INPUT");

  const escapedCwd = await port.run({ command: "node --version", cwd: ".." }, executionContext(workspace));
  assert.equal(escapedCwd.ok, false);
  if (!escapedCwd.ok) assert.equal(escapedCwd.error.code, "PERMISSION_DENIED");

  const expired = await port.run({ command: "node --version" }, executionContext(
    workspace,
    new AbortController().signal,
    Date.now() - 1,
  ));
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error.code, "DEADLINE_EXCEEDED");
});

test("NodeCommandPort required containment is enforced or fails closed before spawning", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-command-"));
  const outside = await mkdtemp(join(tmpdir(), "galaxy-code-outside-"));
  const sentinelPath = join(outside, "sentinel.txt");
  await writeFile(sentinelPath, "original", "utf8");
  context.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const port = await NodeCommandPort.create(workspace, { containment: "required" });
  const result = await port.run({
    command: "node -e \"require('node:fs').writeFileSync(process.env.OUTSIDE_SENTINEL, 'changed')\"",
    env: { OUTSIDE_SENTINEL: sentinelPath },
  }, executionContext(workspace));
  if (port.containmentStatus.active) {
    assert.equal(port.containmentStatus.verified, true);
    assert.equal(port.containmentStatus.filesystemWrites, "workspace_and_private_temp");
    assert.equal(port.containmentStatus.network, "denied");
    assert.equal(result.ok, true);
  } else {
    assert.equal(port.containmentStatus.verified, false);
    assert.equal(port.containmentStatus.filesystemWrites, "uncontained");
    assert.equal(port.containmentStatus.network, "uncontained");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "UNAVAILABLE");
  }
  assert.equal(await readFile(sentinelPath, "utf8"), "original");
});

test("macOS containment probe records hard-link and detached-descendant failures", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("macOS Seatbelt conformance is host-specific.");
    return;
  }
  const probe = await NodeCommandPort.probeContainment();
  assert.equal(probe.backend, "macos_sandbox_exec");
  if (!probe.available) {
    context.skip(probe.reason ?? "macOS Seatbelt is unavailable on this runner.");
    return;
  }
  if (/listen (?:EACCES|EPERM)/.test(probe.reason ?? "")) {
    assert.equal(probe.verified, false);
    assert.equal(probe.toolchainExecution, false);
    assert.equal(probe.networkDenied, false);
    context.skip(`The enclosing test sandbox denied the probe's loopback listener: ${probe.reason}`);
    return;
  }
  assert.equal(probe.systemRead, true);
  assert.equal(probe.toolchainExecution, true);
  assert.equal(probe.workspaceWrite, true);
  assert.equal(probe.privateTempWrite, true);
  assert.equal(probe.outsideWriteDenied, true);
  assert.equal(probe.networkDenied, true);
  assert.equal(probe.descendantChildSpawned, true);
  assert.equal(probe.hardLinkWriteDenied, false);
  assert.equal(probe.descendantQuiescent, false);
  assert.equal(probe.verified, false);
  assert.match(probe.reason ?? "", /hardLinkWriteDenied/);
  assert.match(probe.reason ?? "", /descendantQuiescent/);
});

test("an available verified containment backend enforces workspace-only writes and denied network", async (context) => {
  const probe = await NodeCommandPort.probeContainment();
  if (process.platform !== "linux" || !probe.verified) {
    context.skip(`No verified Linux containment backend on this host: ${probe.reason ?? probe.backend}`);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "galaxy-contained-command-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace);
  await writeFile(outside, "sentinel", "utf8");
  context.after(async () => rm(root, { force: true, recursive: true }));
  const port = await NodeCommandPort.create(workspace, { containment: "required" });
  assert.equal(port.containmentStatus.active, true);
  assert.equal(port.containmentStatus.network, "denied");
  const result = await port.run({
    command: "printf 'inside' > inside.txt; printf 'escape' > \"$OUTSIDE_FILE\" 2>/dev/null || true",
    env: { OUTSIDE_FILE: outside },
  }, executionContext(workspace));
  assert.equal(result.ok, true);
  assert.equal(await readFile(join(workspace, "inside.txt"), "utf8"), "inside");
  assert.equal(await readFile(outside, "utf8"), "sentinel");
});
