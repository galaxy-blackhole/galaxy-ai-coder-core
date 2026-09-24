import type { ToolExecutionContext } from "@galaxy-stack/ai-coder-core/ports";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256Text } from "../../src/host/content-hash.js";
import { NodeWorkspacePort } from "../../src/host/node-workspace-port.js";

function executionContext(workspaceRoot: string, signal = new AbortController().signal): ToolExecutionContext {
  return Object.freeze({
    runId: "run-test",
    taskId: "task-test",
    toolCallId: "call-test",
    idempotencyKey: "idempotency-test",
    mode: "auto",
    workspaceRoot,
    signal,
    deadline: Date.now() + 60_000,
  });
}

test("NodeWorkspacePort writes and patches with content preconditions", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-workspace-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const port = await NodeWorkspacePort.create(workspace);
  const callContext = executionContext(workspace);

  const created = await port.writeText({
    path: "src/value.ts",
    content: "export const value = 1;\n",
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const stalePatch = await port.applyPatch({
    path: "src/value.ts",
    oldText: "value = 1",
    newText: "value = 2",
    precondition: { kind: "matches_sha256", contentSha256: sha256Text("stale") },
  }, callContext);
  assert.equal(stalePatch.ok, false);
  if (!stalePatch.ok) assert.equal(stalePatch.error.code, "PRECONDITION_FAILED");

  const patched = await port.applyPatch({
    path: "src/value.ts",
    oldText: "value = 1",
    newText: "value = 2",
    precondition: { kind: "matches_sha256", contentSha256: created.data.afterContentSha256 },
  }, callContext);
  assert.equal(patched.ok, true);
  assert.equal(await readFile(join(workspace, "src/value.ts"), "utf8"), "export const value = 2;\n");
});

test("seeded workspace mutation fuzz never bypasses compare-and-swap", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-workspace-fuzz-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const port = await NodeWorkspacePort.create(workspace);
  const callContext = executionContext(workspace);
  const unicode = ["ASCII", "Tiếng Việt", "日本語", "emoji 🛰️", "quote '\" \\ slash"];

  for (let seed = 1; seed <= 64; seed += 1) {
    const depth = seed % 4;
    const prefix = Array.from({ length: depth }, (_, index) => `d${index}`).join("/");
    const path = `${prefix ? `${prefix}/` : ""}case-${String(seed).padStart(3, "0")}.txt`;
    const marker = `TOKEN-${seed}`;
    const replacement = `UPDATED-${seed}`;
    const before = `seed=${seed}\n${marker}\n${unicode[seed % unicode.length]}\n`;
    const after = before.replace(marker, replacement);
    const created = await port.writeText({
      path,
      content: before,
      precondition: { kind: "must_not_exist" },
    }, callContext);
    assert.equal(created.ok, true, `create seed ${seed}`);
    if (!created.ok) continue;

    const stale = await port.applyPatch({
      path,
      oldText: marker,
      newText: replacement,
      precondition: { kind: "matches_sha256", contentSha256: sha256Text(`${before}:stale`) },
    }, callContext);
    assert.equal(stale.ok, false, `stale patch seed ${seed}`);
    if (!stale.ok) assert.equal(stale.error.code, "PRECONDITION_FAILED", `stale patch seed ${seed}`);
    assert.equal(await readFile(join(workspace, path), "utf8"), before, `stale patch changed seed ${seed}`);

    const patched = await port.applyPatch({
      path,
      oldText: marker,
      newText: replacement,
      precondition: { kind: "matches_sha256", contentSha256: created.data.afterContentSha256 },
    }, callContext);
    assert.equal(patched.ok, true, `valid patch seed ${seed}`);
    if (!patched.ok) continue;
    assert.equal(patched.data.afterContentSha256, sha256Text(after), `result hash seed ${seed}`);

    const staleOverwrite = await port.writeText({
      path,
      content: `${after}unexpected\n`,
      precondition: { kind: "matches_sha256", contentSha256: created.data.afterContentSha256 },
    }, callContext);
    assert.equal(staleOverwrite.ok, false, `stale overwrite seed ${seed}`);
    if (!staleOverwrite.ok) assert.equal(staleOverwrite.error.code, "PRECONDITION_FAILED", `stale overwrite seed ${seed}`);
    assert.equal(await readFile(join(workspace, path), "utf8"), after, `stale overwrite changed seed ${seed}`);
  }
});

test("NodeWorkspacePort rejects no-op writes and patches before replacing the file", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-workspace-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, "stable.txt");
  const content = "stable\n";
  await writeFile(path, content, "utf8");
  const port = await NodeWorkspacePort.create(workspace);
  const callContext = executionContext(workspace);
  const before = await stat(path, { bigint: true });

  const write = await port.writeText({
    path: "stable.txt",
    content,
    precondition: { kind: "matches_sha256", contentSha256: sha256Text(content) },
  }, callContext);
  assert.equal(write.ok, false);
  if (!write.ok) assert.equal(write.error.code, "CONFLICT");

  const patch = await port.applyPatch({
    path: "stable.txt",
    oldText: "stable",
    newText: "stable",
    precondition: { kind: "matches_sha256", contentSha256: sha256Text(content) },
  }, callContext);
  assert.equal(patch.ok, false);
  if (!patch.ok) assert.equal(patch.error.code, "INVALID_INPUT");

  const after = await stat(path, { bigint: true });
  assert.equal(after.ino, before.ino, "a rejected no-op must not replace the target inode");
  assert.equal(await readFile(path, "utf8"), content);
});

test("NodeWorkspacePort rejects invalid UTF-8 without mutating the original bytes", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-workspace-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, "binary.dat");
  const original = Buffer.from([0xc3, 0x28, 0x00, 0xff]);
  await writeFile(path, original);
  const port = await NodeWorkspacePort.create(workspace);
  const callContext = executionContext(workspace);

  const read = await port.readText({ path: "binary.dat" }, callContext);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error.code, "INVALID_INPUT");
  const metadata = await port.stat({ path: "binary.dat" }, callContext);
  assert.equal(metadata.ok, true);
  if (metadata.ok) {
    assert.equal(metadata.data.contentSha256, createHash("sha256").update(original).digest("hex"));
  }

  const patch = await port.applyPatch({
    path: "binary.dat",
    oldText: "(",
    newText: "changed",
    precondition: { kind: "matches_sha256", contentSha256: "0".repeat(64) },
  }, callContext);
  assert.equal(patch.ok, false);
  if (!patch.ok) assert.equal(patch.error.code, "INVALID_INPUT");

  const write = await port.writeText({
    path: "binary.dat",
    content: "replacement",
    precondition: { kind: "matches_sha256", contentSha256: "0".repeat(64) },
  }, callContext);
  assert.equal(write.ok, false);
  if (!write.ok) assert.equal(write.error.code, "INVALID_INPUT");
  assert.deepEqual(await readFile(path), original);
});

test("NodeWorkspacePort does not create parents for a missing hash-bound target", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-workspace-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const port = await NodeWorkspacePort.create(workspace);

  const result = await port.writeText({
    path: "new/nested/child.txt",
    content: "must not appear",
    precondition: { kind: "matches_sha256", contentSha256: "0".repeat(64) },
  }, executionContext(workspace));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PRECONDITION_FAILED");
  await assert.rejects(readFile(join(workspace, "new/nested/child.txt")));
  await assert.rejects(stat(join(workspace, "new")));
});

test("NodeWorkspacePort fails closed after cancellation", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-workspace-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const port = await NodeWorkspacePort.create(workspace);
  const controller = new AbortController();
  controller.abort();

  const result = await port.listDir({ path: "." }, executionContext(workspace, controller.signal));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CANCELED");
});

test("NodeWorkspacePort scopes every mutation around symlinks", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "galaxy-code-workspace-"));
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await writeFile(join(workspace, "source.txt"), "inside");
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(workspace, "escape"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const port = await NodeWorkspacePort.create(workspace);
  const callContext = executionContext(workspace);

  const readEscape = await port.readText({ path: "escape/secret.txt" }, callContext);
  assert.equal(readEscape.ok, false);
  if (!readEscape.ok) assert.equal(readEscape.error.code, "PERMISSION_DENIED");

  const writeEscape = await port.writeText({
    path: "escape/new.txt",
    content: "outside",
    precondition: { kind: "must_not_exist" },
  }, callContext);
  assert.equal(writeEscape.ok, false);
  if (!writeEscape.ok) assert.equal(writeEscape.error.code, "PERMISSION_DENIED");

  const copyEscape = await port.copy({ sourcePath: "source.txt", destinationPath: "escape/copy.txt" }, callContext);
  assert.equal(copyEscape.ok, false);
  if (!copyEscape.ok) assert.equal(copyEscape.error.code, "PERMISSION_DENIED");

  const deleteLink = await port.delete({ path: "escape" }, callContext);
  assert.equal(deleteLink.ok, true);
  if (deleteLink.ok) assert.equal(deleteLink.data.deleted, true);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");

  const deleteRoot = await port.delete({ path: ".", recursive: true }, callContext);
  assert.equal(deleteRoot.ok, false);
  if (!deleteRoot.ok) assert.equal(deleteRoot.error.code, "PERMISSION_DENIED");
});

test("NodeWorkspacePort paginates UTF-8 reads and invalidates stale cursors", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-workspace-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "unicode.txt"), "ééé\nline two\n");
  const port = await NodeWorkspacePort.create(workspace);
  const callContext = executionContext(workspace);

  const first = await port.readText({ path: "unicode.txt", maxBytes: 4 }, callContext);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.data.content, "éé");
  assert.equal(Buffer.byteLength(first.data.content, "utf8"), 4);
  assert.equal(first.data.pagination.hasMore, true);
  assert.ok(first.data.pagination.nextCursor);

  const updated = await port.writeText({
    path: "unicode.txt",
    content: "changed\ncontent\n",
    precondition: { kind: "matches_sha256", contentSha256: first.data.contentSha256 },
  }, callContext);
  assert.equal(updated.ok, true);

  const stale = await port.readText({
    path: "unicode.txt",
    maxBytes: 4,
    cursor: first.data.pagination.nextCursor ?? "",
  }, callContext);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "CONFLICT");
});

test("NodeWorkspacePort applies base paths, globs, case sensitivity, and cursors", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-workspace-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(workspace, "src/nested"), { recursive: true }),
    mkdir(join(workspace, "other"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspace, "src/a.ts"), "const value = 'Needle';\n"),
    writeFile(join(workspace, "src/nested/b.ts"), "const value = 'needle';\n"),
    writeFile(join(workspace, "other/c.ts"), "const value = 'needle';\n"),
  ]);
  const port = await NodeWorkspacePort.create(workspace);
  const callContext = executionContext(workspace);

  const direct = await port.searchPaths({ path: "src", query: "*.ts", mode: "glob" }, callContext);
  assert.equal(direct.ok, true);
  if (direct.ok) assert.deepEqual(direct.data.matches, ["src/a.ts"]);

  const recursive = await port.searchPaths({ path: "src", query: "**/*.ts", mode: "glob" }, callContext);
  assert.equal(recursive.ok, true);
  if (recursive.ok) assert.deepEqual(recursive.data.matches, ["src/a.ts", "src/nested/b.ts"]);

  const first = await port.searchText({
    path: "src",
    glob: "**/*.ts",
    query: "needle",
    caseSensitive: false,
    limit: 1,
  }, callContext);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.data.matches.map((match) => match.path), ["src/a.ts"]);
  assert.equal(first.data.pagination.hasMore, true);
  const nextCursor = first.data.pagination.nextCursor;
  assert.ok(nextCursor);
  if (nextCursor === undefined) return;

  const second = await port.searchText({
    path: "src",
    glob: "**/*.ts",
    query: "needle",
    caseSensitive: false,
    limit: 1,
    cursor: nextCursor,
  }, callContext);
  assert.equal(second.ok, true);
  if (second.ok) assert.deepEqual(second.data.matches.map((match) => match.path), ["src/nested/b.ts"]);
});

test("NodeWorkspacePort streams large logs and returns only bounded matching evidence", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-large-log-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const logPath = join(workspace, "service.log");
  const handle = await open(logPath, "w");
  const hash = createHash("sha256");
  const noise = Buffer.from("2026-09-05T00:00:00Z INFO request completed status=200\n".repeat(2_048));
  try {
    for (let index = 0; index < 192; index += 1) {
      await handle.write(noise);
      hash.update(noise);
    }
    const marker = Buffer.from("2026-09-05T00:01:00Z ERROR checkout failed correlation=order-needle-42\n");
    await handle.write(marker);
    hash.update(marker);
    for (let index = 0; index < 32; index += 1) {
      await handle.write(noise);
      hash.update(noise);
    }
  } finally {
    await handle.close();
  }
  assert.equal((await stat(logPath)).size > 20 * 1024 * 1024, true);

  const port = await NodeWorkspacePort.create(workspace);
  const result = await port.searchText({
    path: ".",
    glob: "**/*.log",
    query: "order-needle-42",
    limit: 5,
  }, executionContext(workspace));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.matches.length, 1);
  assert.equal(result.data.matches[0]?.path, "service.log");
  assert.match(result.data.matches[0]?.preview ?? "", /ERROR checkout failed/);
  assert.equal(result.data.matches[0]?.contentSha256, hash.digest("hex"));
  assert.equal((result.data.matches[0]?.preview.length ?? 0) <= 500, true);
  assert.equal(Buffer.byteLength(JSON.stringify(result.data), "utf8") < 2_000, true);
  assert.equal(result.data.pagination.hasMore, false);
});

test("NodeWorkspacePort serializes competing CAS writes", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-workspace-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "value.txt"), "before");
  const port = await NodeWorkspacePort.create(workspace);
  const callContext = executionContext(workspace);
  const precondition = { kind: "matches_sha256", contentSha256: sha256Text("before") } as const;

  const results = await Promise.all([
    port.writeText({ path: "value.txt", content: "left", precondition }, callContext),
    port.writeText({ path: "value.txt", content: "right", precondition }, callContext),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const rejected = results.find((result) => !result.ok);
  assert.ok(rejected && !rejected.ok);
  if (rejected && !rejected.ok) assert.ok(["PRECONDITION_FAILED", "UNAVAILABLE"].includes(rejected.error.code));
  assert.ok(["left", "right"].includes(await readFile(join(workspace, "value.txt"), "utf8")));
});
