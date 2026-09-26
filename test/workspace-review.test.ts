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
test("binary or oversized files are reviewed by hash without failing the whole review", async t => {
  const { root, context, workspace } = await setup(t);
  await writeFile(join(root, "seed.txt"), "seed");
  const review = await NodeWorkspaceReviewExecutor.create(workspace, context);
  await writeFile(join(root, "image.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81, 0x82]));
  const result = await review.execute(call, context);
  assert.equal(result.ok, true, result.summary);
  assert.ok(result.effects?.diffReview?.diffHash, "an opaque review still grants diff evidence");
  const content = JSON.parse(result.content) as { mode: string; opaquePaths: string[]; changes: { path: string; textReviewed?: boolean }[] };
  assert.ok(content.opaquePaths.includes("image.bin"));
  assert.equal(content.changes.find(change => change.path === "image.bin")?.textReviewed, false);
  assert.match(content.mode, /opaque/);
});

test("incomplete or special-entry reviews never attest successful completion evidence", async t => {
  const { root, context, workspace } = await setup(t);
  const review = await NodeWorkspaceReviewExecutor.create(workspace, context);
  await writeFile(join(root, "large.txt"), "x".repeat(25000));
  const bounded = await review.execute(call, context); assert.equal(bounded.ok, true, bounded.summary);
  assert.equal(bounded.effects?.diffReview?.diffHash !== undefined, true, "a bounded review still grants diff evidence");
  const boundedContent = JSON.parse(bounded.content) as { mode: string; changes: { path: string; preview: string | null; previewTruncated: boolean }[] };
  assert.equal(boundedContent.mode, "bounded-summary");
  assert.ok(boundedContent.changes.some((change) => change.previewTruncated === true), "the oversized file must appear with a truncated preview");
  assert.match(bounded.summary, /Đã kiểm tra/);
  await rm(join(root, "large.txt")); await symlink("missing", join(root, "link"));
  const link = await review.execute(call, context); assert.equal(link.ok, false); assert.equal(link.effects, undefined);
  const controller = new AbortController(); controller.abort();
  assert.equal((await review.execute(call, { ...context, signal: controller.signal })).ok, false);
});
