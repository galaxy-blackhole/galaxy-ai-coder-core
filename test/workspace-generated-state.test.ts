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
import { NodeWorkspaceReviewExecutor } from "../src/adapters/node/tools/workspace-review.js";
import { NodeWorkspacePort } from "../src/adapters/node/host/node-workspace-port.js";
import type { ToolExecutionContext } from "../src/index.js";
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

test("a background write to a generated path does not invalidate the review baseline", async () => {
  const root = await fixture();
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  const generated = join(root, "node_modules", "pkg", "index.js");
  await writeFile(generated, "v1\n");
  const workspace = await NodeWorkspacePort.create(root);
  const runContext = context(root);

  // A dependency install or build keeps rewriting generated paths while the review
  // baseline is captured. Only durable entries may invalidate that baseline; before the
  // fix, any such write made the factory throw and killed the whole run.
  const writer = setInterval(() => { void writeFile(generated, String(Date.now()) + "\n").catch(() => undefined); }, 5);
  try {
    const executor = await NodeWorkspaceReviewExecutor.create(workspace, runContext);
    assert.ok(executor, "the review executor is created while a generated path is being rewritten");
  } finally {
    clearInterval(writer);
    await rm(root, { recursive: true, force: true });
  }
});

test("generated path predicate covers build output and incremental metadata", () => {
  assert.equal(isGeneratedWorkspacePath(["frontend", "dist", "index.html"]), true);
  assert.equal(isGeneratedWorkspacePath(["frontend", "dist"]), true);
  assert.equal(isGeneratedWorkspacePath(["frontend", "tsconfig.tsbuildinfo"]), true);
  assert.equal(isGeneratedWorkspacePath(["node_modules", "x", "index.js"]), true);
  assert.equal(isGeneratedWorkspacePath(["src", "index.ts"]), false);
  assert.equal(isGeneratedWorkspacePath(["README.md"]), false);
});

test("mutation snapshotter treats build output as derived generated state", async t => {
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
  // Build output is generated state: it never enters authored write evidence,
  // so a build that regenerates dist/ cannot void validation or diff review.
  assert.deepEqual(diff.writes.map(write => write.path), ["src/index.ts"]);
  const derived = diff.observedMutations.filter(m => m.evidenceClass === "derived").map(m => m.path).sort();
  assert.deepEqual(derived, ["dist/assets/bundle.js", "tsconfig.tsbuildinfo"]);
  // The runtime, not the snapshot, decides authored progress from these paths.
  assert.equal(isGeneratedWorkspacePath(["dist", "assets", "bundle.js"]), true);
  assert.equal(isGeneratedWorkspacePath(["src", "index.ts"]), false);
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

test("dependency trees allow ground-truth reads but refuse search and glob", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "node_modules", "@galaxy-stack", "orbit-core");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), '{"name":"@galaxy-stack/orbit-core"}\n');
  await writeFile(join(packageRoot, "index.d.ts"), "export declare function Controller(prefix?: string): ClassDecorator;\n");
  await writeFile(join(packageRoot, "index.js"), "export function Controller() {}\n");
  const context: ToolExecutionContext = {
    workspaceRoot: root, runId: "deps", taskId: "deps", toolCallId: "deps", idempotencyKey: "deps",
    mode: "auto", deadline: Date.now() + 30_000, signal: new AbortController().signal,
  };
  const workspace = await NodeWorkspacePort.create(root);
  // The installed API is cheap ground truth: declarations and manifests stay readable.
  assert.equal((await workspace.readText({ maxBytes: 4096, path: "node_modules/@galaxy-stack/orbit-core/index.d.ts" }, context)).ok, true);
  assert.equal((await workspace.readText({ maxBytes: 4096, path: "node_modules/@galaxy-stack/orbit-core/package.json" }, context)).ok, true);
  assert.equal((await workspace.readText({ maxBytes: 4096, path: "node_modules/@galaxy-stack/orbit-core/index.js" }, context)).ok, false);
  // A refused search must name the read that is allowed, or the model repeats it.
  const search = await workspace.searchText({ path: "node_modules/@galaxy-stack/orbit-core", query: "Controller" }, context);
  assert.equal(search.ok, false);
  if (!search.ok) assert.match(search.error.message, /read_file/);
  assert.equal((await workspace.searchPaths({ path: "node_modules/@galaxy-stack/orbit-core", query: "**/*.d.ts" }, context)).ok, false);
});
