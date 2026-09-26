import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS,
  NodeWorkspaceSnapshotter,
  diffNodeWorkspaceSnapshots,
} from "../src/adapters/node/host/node-workspace-snapshot.js";
import { NodeWorkspaceEvidenceVerifier } from "../src/adapters/node/host/node-workspace-evidence-verifier.js";
import {
  isGeneratedWorkspacePath,
} from "../src/adapters/node/host/workspace-generated-state.js";
import type { RunExecutionContext } from "../src/ports/execution-context.js";

function context(workspaceRoot: string): RunExecutionContext {
  return Object.freeze({
    deadline: Date.now() + 60_000,
    mode: "auto" as const,
    runId: "run-generated-state",
    signal: new AbortController().signal,
    taskId: "task-generated-state",
    workspaceRoot,
  });
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "galaxy-generated-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dist", "assets"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(join(root, "dist", "assets", "bundle.js"), "generated-v1\n");
  await writeFile(join(root, "tsconfig.tsbuildinfo"), "{\"v\":1}\n");
  return root;
}

test("generated path predicate covers build output and incremental metadata", () => {
  assert.equal(isGeneratedWorkspacePath(["frontend", "dist", "index.html"]), true);
  assert.equal(isGeneratedWorkspacePath(["frontend", "dist"]), true);
  assert.equal(isGeneratedWorkspacePath(["frontend", "tsconfig.tsbuildinfo"]), true);
  assert.equal(isGeneratedWorkspacePath(["node_modules", "x", "index.js"]), true);
  assert.equal(isGeneratedWorkspacePath(["src", "index.ts"]), false);
  assert.equal(isGeneratedWorkspacePath(["README.md"]), false);
});

test("mutation snapshotter never reports generated output as durable writes", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = context(root);
  const snapshotter = await NodeWorkspaceSnapshotter.create(root, DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS);
  const before = await snapshotter.capture(ctx);
  await writeFile(join(root, "dist", "assets", "bundle.js"), "generated-v2\n");
  await writeFile(join(root, "tsconfig.tsbuildinfo"), "{\"v\":2}\n");
  await writeFile(join(root, "src", "index.ts"), "export const value = 2;\n");
  const after = await snapshotter.capture(ctx);
  const diff = diffNodeWorkspaceSnapshots(before, after);
  assert.deepEqual(diff.writes.map(write => write.path), ["src/index.ts"]);
  const derived = diff.observedMutations.filter(m => m.evidenceClass === "derived").map(m => m.path).sort();
  assert.deepEqual(derived, ["dist/assets/bundle.js", "tsconfig.tsbuildinfo"]);
});

test("workspace evidence fingerprint ignores generated output but tracks authored source", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = context(root);
  const verifier = await NodeWorkspaceEvidenceVerifier.create(root);
  const first = await verifier.capture({ activeFiles: [], dirtyStateSummary: null }, ctx);
  assert.equal(first.ok, true);
  const fingerprint = first.ok ? first.data.stateFingerprint : "";
  await writeFile(join(root, "dist", "assets", "bundle.js"), "generated-v2\n");
  await writeFile(join(root, "tsconfig.tsbuildinfo"), "{\"v\":2}\n");
  const second = await verifier.capture({ activeFiles: [], dirtyStateSummary: null }, ctx);
  assert.equal(second.ok, true);
  assert.equal(second.ok ? second.data.stateFingerprint : "different", fingerprint);
  await writeFile(join(root, "src", "index.ts"), "export const value = 2;\n");
  const third = await verifier.capture({ activeFiles: [], dirtyStateSummary: null }, ctx);
  assert.equal(third.ok, true);
  assert.notEqual(third.ok ? third.data.stateFingerprint : "", fingerprint);
});
