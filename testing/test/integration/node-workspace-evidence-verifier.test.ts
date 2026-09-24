import type { RunExecutionContext } from "@galaxy-stack/ai-coder-core";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256Text } from "../../src/host/content-hash.js";
import { NodeWorkspaceEvidenceVerifier } from "../../src/host/node-workspace-evidence-verifier.js";

function context(workspaceRoot: string, signal = new AbortController().signal): RunExecutionContext {
  return Object.freeze({
    deadline: Date.now() + 10_000,
    mode: "auto",
    runId: "run-evidence",
    signal,
    taskId: "task-evidence",
    workspaceRoot,
  });
}

test("NodeWorkspaceEvidenceVerifier is deterministic, bounded to relevant state, and detects changes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-evidence-"));
  try {
    await writeFile(join(workspaceRoot, "tracked.txt"), "first\n", "utf8");
    const verifier = await NodeWorkspaceEvidenceVerifier.create(workspaceRoot);
    const input = Object.freeze({ activeFiles: Object.freeze([]), dirtyStateSummary: null });
    const first = await verifier.capture(input, context(workspaceRoot));
    const second = await verifier.capture(input, context(workspaceRoot));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.data.stateFingerprint, second.data.stateFingerprint);

    await mkdir(join(workspaceRoot, "node_modules"));
    await writeFile(join(workspaceRoot, "node_modules", "ignored.txt"), "ignored\n", "utf8");
    const ignored = await verifier.capture(input, context(workspaceRoot));
    assert.equal(ignored.ok, true);
    if (ignored.ok) assert.equal(ignored.data.stateFingerprint, first.data.stateFingerprint);

    await writeFile(join(workspaceRoot, "tracked.txt"), "second\n", "utf8");
    const verification = await verifier.verify(first.data, context(workspaceRoot));
    assert.equal(verification.ok, true);
    if (verification.ok) {
      assert.equal(verification.data.matches, false);
      assert.notEqual(verification.data.currentFingerprint, first.data.stateFingerprint);
    }

    const controller = new AbortController();
    controller.abort();
    const canceled = await verifier.capture(input, context(workspaceRoot, controller.signal));
    assert.equal(canceled.ok, false);
    if (!canceled.ok) assert.equal(canceled.error.code, "CANCELED");
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test("NodeWorkspaceEvidenceVerifier verifies active hashes inside ignored directories", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-evidence-active-"));
  try {
    await mkdir(join(workspaceRoot, "dist"));
    await writeFile(join(workspaceRoot, "dist", "active.txt"), "first\n", "utf8");
    const verifier = await NodeWorkspaceEvidenceVerifier.create(workspaceRoot);
    const observed = await verifier.capture(Object.freeze({
      activeFiles: Object.freeze([Object.freeze({ contentHash: null, path: "dist/active.txt" })]),
      dirtyStateSummary: null,
    }), context(workspaceRoot));
    assert.equal(observed.ok, true);
    if (!observed.ok) return;
    await writeFile(join(workspaceRoot, "dist", "active.txt"), "changed without a pinned hash\n", "utf8");
    const observedChange = await verifier.verify(observed.data, context(workspaceRoot));
    assert.equal(observedChange.ok, true);
    if (observedChange.ok) assert.equal(observedChange.data.matches, false);

    await writeFile(join(workspaceRoot, "dist", "active.txt"), "first\n", "utf8");
    const input = Object.freeze({
      activeFiles: Object.freeze([Object.freeze({
        contentHash: sha256Text("first\n"),
        path: "dist/active.txt",
      })]),
      dirtyStateSummary: null,
    });
    const captured = await verifier.capture(input, context(workspaceRoot));
    assert.equal(captured.ok, true);
    if (!captured.ok) return;

    await writeFile(join(workspaceRoot, "dist", "active.txt"), "second\n", "utf8");
    const verified = await verifier.verify(captured.data, context(workspaceRoot));
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.error.code, "PRECONDITION_FAILED");

    const staleCapture = await verifier.capture(input, context(workspaceRoot));
    assert.equal(staleCapture.ok, false);
    if (!staleCapture.ok) assert.equal(staleCapture.error.code, "PRECONDITION_FAILED");
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test("NodeWorkspaceEvidenceVerifier fingerprints listed dependency trees from metadata without reading package contents", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-evidence-derived-"));
  try {
    await mkdir(join(workspaceRoot, "node_modules", "large-package"), { recursive: true });
    const dependencyFile = join(workspaceRoot, "node_modules", "large-package", "bundle.js");
    await writeFile(dependencyFile, "x".repeat(4_096), "utf8");
    const verifier = await NodeWorkspaceEvidenceVerifier.create(workspaceRoot, { maxHashedBytes: 64 });
    const listedDirectory = Object.freeze({
      activeFiles: Object.freeze([Object.freeze({ contentHash: null, kind: "directory" as const, path: "node_modules" })]),
      dirtyStateSummary: null,
    });
    const captured = await verifier.capture(listedDirectory, context(workspaceRoot));
    assert.equal(captured.ok, true, JSON.stringify(captured));
    if (!captured.ok) return;

    await writeFile(dependencyFile, "changed".repeat(1_024), "utf8");
    const changed = await verifier.verify(captured.data, context(workspaceRoot));
    assert.equal(changed.ok, true, JSON.stringify(changed));
    if (changed.ok) assert.equal(changed.data.matches, false);

    const directlyReadFile = await verifier.capture(Object.freeze({
      activeFiles: Object.freeze([Object.freeze({ contentHash: null, kind: "file" as const, path: "node_modules/large-package/bundle.js" })]),
      dirtyStateSummary: null,
    }), context(workspaceRoot));
    assert.equal(directlyReadFile.ok, false);
    if (!directlyReadFile.ok) assert.equal(directlyReadFile.error.code, "LIMIT_EXCEEDED");
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test("NodeWorkspaceEvidenceVerifier rejects active symlinks that escape the workspace", async () => {
  const base = await mkdtemp(join(tmpdir(), "galaxy-evidence-scope-"));
  const workspaceRoot = join(base, "workspace");
  const outside = join(base, "outside");
  try {
    await Promise.all([mkdir(workspaceRoot), mkdir(outside)]);
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(join(outside, "secret.txt"), join(workspaceRoot, "escape.txt"));
    const verifier = await NodeWorkspaceEvidenceVerifier.create(workspaceRoot);
    const captured = await verifier.capture(Object.freeze({
      activeFiles: Object.freeze([Object.freeze({ contentHash: null, path: "escape.txt" })]),
      dirtyStateSummary: null,
    }), context(workspaceRoot));
    assert.equal(captured.ok, false);
    if (!captured.ok) assert.equal(captured.error.code, "PERMISSION_DENIED");
  } finally {
    await rm(base, { force: true, recursive: true });
  }
});
