import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceScope } from "../../src/host/path-scope.js";

test("WorkspaceScope rejects lexical and symlink escapes", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "galaxy-code-scope-"));
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(workspace, "escape"));
  context.after(() => rm(base, { recursive: true, force: true }));

  const scope = await WorkspaceScope.create(workspace);
  assert.throws(
    () => scope.resolveLexical("../outside/secret.txt"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PERMISSION_DENIED",
  );
  await assert.rejects(
    () => scope.resolveExisting("escape/secret.txt"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PERMISSION_DENIED",
  );
  await assert.rejects(
    () => scope.resolveForWrite("escape/new.txt"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PERMISSION_DENIED",
  );
  assert.equal(await scope.resolveForDelete("escape"), join(await realpath(workspace), "escape"));
});

test("WorkspaceScope permits new nested paths inside the root", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-scope-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const scope = await WorkspaceScope.create(workspace);
  assert.equal(await scope.resolveForWrite("src/nested/file.ts"), join(await realpath(workspace), "src/nested/file.ts"));
  await assert.rejects(
    () => scope.resolveForWrite("."),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PERMISSION_DENIED",
  );
});

test("WorkspaceScope rejects a non-directory mutation parent", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "galaxy-code-scope-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "file"), "content");
  const scope = await WorkspaceScope.create(workspace);
  await assert.rejects(
    () => scope.resolveForWrite("file/child"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_INPUT",
  );
});
