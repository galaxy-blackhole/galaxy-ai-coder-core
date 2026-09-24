import type { RunExecutionContext } from "@galaxy-stack/ai-coder-core";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS,
  diffNodeWorkspaceSnapshots,
  NodeWorkspaceSnapshotter,
} from "../../src/host/node-workspace-snapshot.js";

function context(workspaceRoot: string): RunExecutionContext {
  return Object.freeze({
    deadline: Date.now() + 10_000,
    mode: "auto",
    runId: "run-workspace-snapshot",
    signal: new AbortController().signal,
    taskId: "task-workspace-snapshot",
    workspaceRoot,
  });
}

test("NodeWorkspaceSnapshotter is deterministic, includes build/dependency files, and never follows symlinks", async () => {
  const base = await mkdtemp(join(tmpdir(), "galaxy-workspace-snapshot-"));
  const workspaceRoot = join(base, "workspace");
  const outside = join(base, "outside");
  try {
    await Promise.all([
      mkdir(join(workspaceRoot, ".git"), { recursive: true }),
      mkdir(join(workspaceRoot, "coverage"), { recursive: true }),
      mkdir(join(workspaceRoot, "dist"), { recursive: true }),
      mkdir(join(workspaceRoot, "node_modules"), { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(workspaceRoot, ".git/config"), "ignored git metadata\n", "utf8"),
      writeFile(join(workspaceRoot, "coverage/result.txt"), "coverage\n", "utf8"),
      writeFile(join(workspaceRoot, "dist/bundle.js"), "bundle\n", "utf8"),
      writeFile(join(workspaceRoot, "node_modules/dependency.js"), "dependency\n", "utf8"),
      writeFile(join(workspaceRoot, "pending.txt.galaxy-code.lock"), "ignored lock\n", "utf8"),
      writeFile(join(outside, "secret.txt"), "outside before\n", "utf8"),
    ]);
    await symlink(outside, join(workspaceRoot, "outside-link"));
    const snapshotter = await NodeWorkspaceSnapshotter.create(workspaceRoot);

    const first = await snapshotter.capture(context(workspaceRoot));
    const second = await snapshotter.capture(context(workspaceRoot));
    assert.deepEqual(second, first);
    assert.deepEqual(first.entries.map((entry) => entry.path), [
      "coverage",
      "coverage/result.txt",
      "dist",
      "dist/bundle.js",
      "node_modules",
      "node_modules/dependency.js",
      "outside-link",
    ]);
    assert.equal(first.entries.find((entry) => entry.path === "outside-link")?.kind, "symlink");
    assert.equal(first.entries.some((entry) => entry.path.startsWith("outside-link/")), false);

    await writeFile(join(outside, "secret.txt"), "outside after\n", "utf8");
    const outsideChanged = await snapshotter.capture(context(workspaceRoot));
    assert.deepEqual(outsideChanged, first);

    await writeFile(join(workspaceRoot, "dist/bundle.js"), "bundle changed\n", "utf8");
    const workspaceChanged = await snapshotter.capture(context(workspaceRoot));
    const mutations = diffNodeWorkspaceSnapshots(first, workspaceChanged);
    assert.deepEqual(mutations.writes, [{
      afterHash: workspaceChanged.entries.find((entry) => entry.path === "dist/bundle.js")?.comparisonFingerprint,
      afterKind: "file",
      beforeHash: first.entries.find((entry) => entry.path === "dist/bundle.js")?.comparisonFingerprint,
      beforeKind: "file",
      path: "dist/bundle.js",
    }]);
    assert.deepEqual(mutations.observedMutations.map((mutation) => mutation.evidenceClass), ["durable"]);
    assert.equal(mutations.stateVersion, workspaceChanged.stateVersion);
  } finally {
    await rm(base, { force: true, recursive: true });
  }
});

test("NodeWorkspaceSnapshotter reports empty-directory creation and deletion", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-workspace-empty-directory-"));
  try {
    const snapshotter = await NodeWorkspaceSnapshotter.create(workspaceRoot);
    const before = await snapshotter.capture(context(workspaceRoot));
    await mkdir(join(workspaceRoot, "generated-empty"));
    const created = await snapshotter.capture(context(workspaceRoot));
    const directory = created.entries.find((entry) => entry.path === "generated-empty");
    assert.equal(directory?.kind, "directory");
    assert.deepEqual(diffNodeWorkspaceSnapshots(before, created).writes, [{
      afterHash: null,
      afterKind: "directory",
      beforeHash: null,
      beforeKind: "missing",
      path: "generated-empty",
    }]);

    await rm(join(workspaceRoot, "generated-empty"), { recursive: true });
    const deleted = await snapshotter.capture(context(workspaceRoot));
    assert.deepEqual(diffNodeWorkspaceSnapshots(created, deleted).writes, [{
      afterHash: null,
      afterKind: "missing",
      beforeHash: null,
      beforeKind: "directory",
      path: "generated-empty",
    }]);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test("NodeWorkspaceSnapshotter detects derived dependency mutation without treating metadata as content evidence", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-workspace-metadata-snapshot-"));
  try {
    await mkdir(join(workspaceRoot, "node_modules/package"), { recursive: true });
    await writeFile(join(workspaceRoot, "node_modules/package/index.js"), "aa");
    const snapshotter = await NodeWorkspaceSnapshotter.create(workspaceRoot, {
      maxHashedBytes: 1,
      derivedDirectories: ["node_modules"],
    });
    const before = await snapshotter.capture(context(workspaceRoot));
    await writeFile(join(workspaceRoot, "node_modules/package/index.js"), "bb");
    const after = await snapshotter.capture(context(workspaceRoot));
    const mutations = diffNodeWorkspaceSnapshots(before, after);
    assert.deepEqual(mutations.writes, []);
    assert.deepEqual(mutations.observedMutations.map((item) => ({
      evidenceClass: item.evidenceClass,
      path: item.path,
    })), [{ evidenceClass: "derived", path: "node_modules/package/index.js" }]);
    assert.notEqual(mutations.stateVersion, before.stateVersion);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test("dependency-aware policy classifies generated build caches as derived evidence", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-workspace-build-cache-"));
  try {
    await mkdir(join(workspaceRoot, ".next/cache/webpack"), { recursive: true });
    await writeFile(join(workspaceRoot, ".next/cache/webpack/pack.json"), "{}", "utf8");
    await mkdir(join(workspaceRoot, "app"), { recursive: true });
    await writeFile(join(workspaceRoot, "app/page.jsx"), "export default () => null;\n", "utf8");
    const snapshotter = await NodeWorkspaceSnapshotter.create(workspaceRoot, DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS);
    const before = await snapshotter.capture(context(workspaceRoot));
    await writeFile(join(workspaceRoot, ".next/cache/webpack/pack.json"), '{"changed":true}', "utf8");
    const after = await snapshotter.capture(context(workspaceRoot));
    const diff = diffNodeWorkspaceSnapshots(before, after);
    assert.deepEqual(diff.writes.map((write) => write.path), [], "build-cache mutations are derived, never authored oracle evidence");
    assert.deepEqual(diff.observedMutations.map((item) => ({
      evidenceClass: item.evidenceClass,
      path: item.path,
    })), [{ evidenceClass: "derived", path: ".next/cache/webpack/pack.json" }]);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test("dependency-aware snapshots keep root manifests as durable byte evidence", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-workspace-dependency-manifest-"));
  try {
    await mkdir(join(workspaceRoot, "node_modules/package"), { recursive: true });
    await Promise.all([
      writeFile(join(workspaceRoot, "package.json"), "{\"private\":true}\n"),
      writeFile(join(workspaceRoot, "package-lock.json"), "{\"lockfileVersion\":3}\n"),
      writeFile(join(workspaceRoot, "node_modules/package/index.js"), "before\n"),
    ]);
    const snapshotter = await NodeWorkspaceSnapshotter.create(workspaceRoot, {
      derivedDirectories: ["node_modules"],
    });
    const before = await snapshotter.capture(context(workspaceRoot));
    await Promise.all([
      writeFile(join(workspaceRoot, "package.json"), "{\"private\":true,\"type\":\"module\"}\n"),
      writeFile(join(workspaceRoot, "package-lock.json"), "{\"lockfileVersion\":3,\"packages\":{}}\n"),
      writeFile(join(workspaceRoot, "node_modules/package/index.js"), "after!\n"),
    ]);
    const mutations = diffNodeWorkspaceSnapshots(before, await snapshotter.capture(context(workspaceRoot)));
    assert.deepEqual(mutations.writes.map((mutation) => mutation.path), ["package-lock.json", "package.json"]);
    assert.deepEqual(mutations.observedMutations.map((mutation) => ({
      evidenceClass: mutation.evidenceClass,
      path: mutation.path,
    })), [
      { evidenceClass: "derived", path: "node_modules/package/index.js" },
      { evidenceClass: "durable", path: "package-lock.json" },
      { evidenceClass: "durable", path: "package.json" },
    ]);
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test("NodeWorkspaceSnapshotter rejects unsafe derived directory paths", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "galaxy-workspace-metadata-path-"));
  try {
    await assert.rejects(
      NodeWorkspaceSnapshotter.create(workspaceRoot, { derivedDirectories: ["../outside"] }),
      /Invalid derived workspace directory/,
    );
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});
