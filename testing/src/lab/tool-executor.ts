import { NodeToolExecutor, type NodeToolExecutorOptions } from "@galaxy-stack/ai-coder-core/adapters/node/tools/tool-executor";
import { DeterministicContractTools } from "./deterministic-contract-tools.js";
import { NodeWorkspaceReviewExecutor } from "@galaxy-stack/ai-coder-core/adapters/node/tools/workspace-review";
import type { RunExecutionContext } from "@galaxy-stack/ai-coder-core/ports";
import type { NodeWorkspacePort } from "../host/node-workspace-port.js";
export * from "@galaxy-stack/ai-coder-core/adapters/node/tools/tool-executor";
export type LabToolExecutorOptions = NodeToolExecutorOptions;
/**
 * The workspace review the completion gate asks for, created the first time a run offers its tools.
 *
 * It cannot be built up front: the review baseline is a fingerprint of the workspace at the start of a run, so it
 * needs that run's context. The CLI wires the same executor the same way - only when the workspace has no Git, where
 * a diff cannot be read with a command.
 */
export class LabWorkspaceReview {
  private inner: NodeWorkspaceReviewExecutor | null = null;

  constructor(private readonly workspace: NodeWorkspacePort) {}

  async getToolSet(context: RunExecutionContext) {
    this.inner ??= await NodeWorkspaceReviewExecutor.create(this.workspace, context);
    return this.inner.getToolSet();
  }

  async execute(call: Parameters<NodeWorkspaceReviewExecutor["execute"]>[0], context: Parameters<NodeWorkspaceReviewExecutor["execute"]>[1]) {
    if (this.inner === null) throw new Error("review_changes was used before the run offered its tools.");
    return this.inner.execute(call, context);
  }
}

export class LabToolExecutor extends NodeToolExecutor {
  private review: LabWorkspaceReview | null = null;

  /** Called once by the fixture runner, which is what holds the workspace port. */
  attachWorkspaceReview(workspace: NodeWorkspacePort): void {
    this.review = new LabWorkspaceReview(workspace);
  }

  /**
   * The lab's tool set plus the review tool the completion gate asks for.
   *
   * The registry is built from the catalogue, and the review tool is not in it - it comes from an executor - so the
   * merge is explicit here rather than implied by the profile list. The snapshot hash stays the registry's: the review
   * is a constant addition to every run, and keeping the base hash is what lets a resumed run match its checkpoint.
   */
  override async getToolSet(context: RunExecutionContext) {
    const base = await super.getToolSet(context);
    if (this.review === null) return base;
    const review = await this.review.getToolSet(context);
    return Object.freeze({
      canonicalToolIds: Object.freeze({ ...base.canonicalToolIds, ...review.canonicalToolIds }),
      definitions: Object.freeze([...base.definitions, ...review.definitions]),
      effectCapabilities: Object.freeze({ ...base.effectCapabilities, ...review.effectCapabilities }),
      snapshotHash: base.snapshotHash,
    });
  }

  override async execute(call: Parameters<NodeToolExecutor["execute"]>[0], context: Parameters<NodeToolExecutor["execute"]>[1]) {
    if (this.review !== null && call.name === "review_changes") return this.review.execute(call, context);
    return super.execute(call, context);
  }
  constructor(options: LabToolExecutorOptions) {
    super({ ...options, ...((options.enableContractTools || options.toolProfile === "full_contract") ? { contractTools: new DeterministicContractTools() } : {}) });
  }
}
