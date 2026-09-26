import type { AiCoderRuntimeToolExecutor, AiCoderRuntimeToolResult, AiCoderRuntimeToolSet, CodingToolCall, RunExecutionContext, ToolExecutionContext, WorkspacePort } from "../../../index.js";
import { sha256Text } from "../host/content-hash.js";
import { DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS, diffNodeWorkspaceSnapshots, NodeWorkspaceSnapshotter, type NodeWorkspaceSnapshot } from "../host/node-workspace-snapshot.js";

const MAX_BASELINE_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_BYTES = 24000;
const definition = { type: "function" as const, function: { name: "review_changes", description: "Review final workspace changes against the start of this task, without Git. Returns verified before/after file contents and hashes. Call after all writes and validation, before the final report. If truncated, no review evidence is granted.", parameters: { type: "object", properties: {}, additionalProperties: false } } };

/** Host-owned comparison for scratch projects. Never creates .git or weakens the completion gate. */
export class NodeWorkspaceReviewExecutor implements AiCoderRuntimeToolExecutor {
  private constructor(private readonly workspace: WorkspacePort, private readonly snapshotter: NodeWorkspaceSnapshotter, private readonly baseline: NodeWorkspaceSnapshot, private readonly contents: ReadonlyMap<string, string>) {}
  static async create(workspace: WorkspacePort, context: RunExecutionContext): Promise<NodeWorkspaceReviewExecutor> {
    const snapshotter = await NodeWorkspaceSnapshotter.create(context.workspaceRoot, DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS);
    const baseline = await snapshotter.capture(context);
    const contents = new Map<string, string>();
    let bytes = 0;
    for (const entry of baseline.entries) {
      if (entry.evidenceClass !== "durable" || entry.kind !== "file" || bytes >= MAX_BASELINE_BYTES) continue;
      const read = await workspace.readText({ path: entry.path, maxBytes: 128 * 1024 }, { ...context, toolCallId: "host-baseline", idempotencyKey: "host-baseline" });
      if (read.ok && !read.data.truncated && read.data.contentSha256 === entry.comparisonFingerprint && bytes + Buffer.byteLength(read.data.content) <= MAX_BASELINE_BYTES) {
        bytes += Buffer.byteLength(read.data.content); contents.set(entry.path, read.data.content);
      }
    }
    if ((await snapshotter.capture(context)).stateVersion !== baseline.stateVersion) throw new Error("Workspace changed while capturing review baseline. Retry when files are stable.");
    return new NodeWorkspaceReviewExecutor(workspace, snapshotter, baseline, contents);
  }
  async getToolSet(): Promise<AiCoderRuntimeToolSet> {
    return { definitions: [definition], canonicalToolIds: { review_changes: "workspace.review" }, effectCapabilities: { "workspace.review": ["inspect", "diff_review"] }, snapshotHash: sha256Text(JSON.stringify(definition)) };
  }
  async execute(call: CodingToolCall, context: ToolExecutionContext): Promise<AiCoderRuntimeToolResult> {
    try {
      context.signal.throwIfAborted();
      if (call.name !== "review_changes" || Object.keys(call.arguments).length) throw new Error("review_changes accepts no arguments.");
      const current = await this.snapshotter.capture(context);
      const changes = diffNodeWorkspaceSnapshots(this.baseline, current).writes;
      const reviewed: unknown[] = [];
      let bytes = 0;
      let degraded = false;
      for (const change of changes) {
        let before: string | null = null; let after: string | null = null;
        if (!["file", "directory", "missing"].includes(change.beforeKind) || !["file", "directory", "missing"].includes(change.afterKind)) throw new Error(`Cannot fully review special entry ${change.path}; use a Git repository for this workspace.`);
        if (change.beforeKind === "file") {
          before = this.contents.get(change.path) ?? null;
          if (before === null) throw new Error(`Baseline text unavailable for ${change.path}; no review evidence was granted.`);
        }
        if (change.afterKind === "file") {
          const read = await this.workspace.readText({ path: change.path, maxBytes: 128 * 1024 }, context);
          if (!read.ok || read.data.truncated || read.data.contentSha256 !== change.afterHash) throw new Error(`Cannot fully review stable text for ${change.path}; no review evidence was granted.`);
          after = read.data.content;
        }
        const full = { ...change, before, after };
        // Scaffold-scale changes overflow the 24 KiB full-text cap. Degrade to a
        // bounded per-file summary (hashes + previews) instead of refusing: in a
        // non-Git workspace there is no alternative review evidence path.
        if (bytes + Buffer.byteLength(JSON.stringify(full)) > MAX_REVIEW_BYTES) {
          degraded = true;
          const afterSize = after === null ? 0 : Buffer.byteLength(after, "utf8");
          const preview = (text: string | null) => {
            if (text === null) return { preview: null, previewTruncated: false };
            const cut = text.length > 600 ? `${text.slice(0, 600)}…` : text;
            return { preview: cut, previewTruncated: text.length > 600 };
          };
          const beforePreview = preview(before); const afterPreview = preview(after);
          const entry = {
            path: change.path,
            beforeKind: change.beforeKind, afterKind: change.afterKind,
            beforeHash: change.beforeHash, afterHash: change.afterHash,
            afterSize, ...beforePreview, ...afterPreview,
          };
          bytes += Buffer.byteLength(JSON.stringify(entry));
          if (bytes > MAX_REVIEW_BYTES) continue;
          reviewed.push(entry);
          continue;
        }
        bytes += Buffer.byteLength(JSON.stringify(full));
        reviewed.push(full);
      }
      if ((await this.snapshotter.capture(context)).stateVersion !== current.stateVersion) throw new Error("Workspace changed during review. Run review_changes again.");
      const content = JSON.stringify({ comparison: "task-start-to-current", mode: degraded ? "bounded-summary" : "full-text", changes: reviewed });
      return { ok: true, canonicalToolId: "workspace.review", content, summary: `Đã kiểm tra ${changes.length} thay đổi so với đầu tác vụ (không cần Git).`, trust: "workspace", effectsAuthority: "host", effects: { inspectedPaths: ["."], diffReview: { diffHash: sha256Text(content) } }, outputLimits: { maxBytes: 32768, maxTokens: 16384 } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, canonicalToolId: "workspace.review", content: JSON.stringify({ error: message }), summary: message, trust: "trusted", error: { code: "WORKSPACE_REVIEW_FAILED", message, retryable: false } };
    }
  }
}
