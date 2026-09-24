import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWorkspaceReviewExecutor } from "../src/adapters/node/tools/workspace-review.js";
import { NodeWorkspacePort } from "../src/adapters/node/host/node-workspace-port.js";
import type { ToolExecutionContext } from "../src/index.js";
async function setup(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "galaxy-review-")); t.after(() => rm(root, { recursive: true, force: true }));
  const context: ToolExecutionContext = { workspaceRoot: root, runId: "review", taskId: "review", toolCallId: "review", idempotencyKey: "review", mode: "auto", deadline: Date.now() + 30000, signal: new AbortController().signal };
  return { root, context, workspace: await NodeWorkspacePort.create(root) };
}
const call = { name: "review_changes", arguments: {}, toolCallId: "review" };
test("scratch workspace review covers added, edited and deleted text without creating Git", async t => {
  const { root, context, workspace } = await setup(t);
  await writeFile(join(root, "edited.txt"), "original"); await writeFile(join(root, "deleted.txt"), "deleted");
  const review = await NodeWorkspaceReviewExecutor.create(workspace, context);
  await writeFile(join(root, "edited.txt"), "changed"); await rm(join(root, "deleted.txt")); await writeFile(join(root, "new.txt"), "Xin chào");
  const result = await review.execute(call, context); assert.equal(result.ok, true, result.summary);
  const changes = JSON.parse(result.content).changes as { path: string; before: string | null; after: string | null }[];
  assert.deepEqual(changes.map(({path, before, after}) => ({path, before, after})), [
    { path: "deleted.txt", before: "deleted", after: null }, { path: "edited.txt", before: "original", after: "changed" }, { path: "new.txt", before: null, after: "Xin chào" },
  ]);
  assert.ok(result.effects?.diffReview?.diffHash);
  assert.equal(result.effectsAuthority, "host");
  assert.equal((await workspace.stat({ path: ".git" }, context)).ok, true);
  assert.equal((await review.execute({ ...call, arguments: { path: "../outside" } }, context)).ok, false);
});
test("incomplete or special-entry reviews never attest successful completion evidence", async t => {
  const { root, context, workspace } = await setup(t);
  const review = await NodeWorkspaceReviewExecutor.create(workspace, context);
  await writeFile(join(root, "large.txt"), "x".repeat(25000));
  const bounded = await review.execute(call, context); assert.equal(bounded.ok, false); assert.equal(bounded.effects, undefined); assert.match(bounded.summary, /24 KiB/);
  await rm(join(root, "large.txt")); await symlink("missing", join(root, "link"));
  const link = await review.execute(call, context); assert.equal(link.ok, false); assert.equal(link.effects, undefined);
  const controller = new AbortController(); controller.abort();
  assert.equal((await review.execute(call, { ...context, signal: controller.signal })).ok, false);
});
