/**
 * Child agents, and who is allowed to run them.
 *
 * A delegation is a piece of work handed to an agent of its own: its own context, its own budget, its own stop
 * button. This file is the seam, not the machinery — a provider is registered under a name, and the registry keeps
 * the book that lets a caller ask what is running, send a word to one of them, or end one.
 *
 * The shape follows the reference's four tools one for one, because those are the four questions anyone actually
 * asks: start one, list them, say something to one, stop one. Adding a fifth question without a fifth need is how
 * a seam becomes a framework.
 */
export type SubagentKind = "spawn" | "fork";
export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentRequest {
  /** Three to five words, for a list that has to be readable at a glance. */
  readonly description: string;
  /** The whole task: a child sees none of its parent's conversation. */
  readonly prompt: string;
  readonly kind: SubagentKind;
  /** Where this child sits in the tree; the root's children are one deep. */
  readonly parentId: string | null;
}

export interface SubagentRecord {
  readonly depth: number;
  readonly description: string;
  readonly id: string;
  readonly kind: SubagentKind;
  readonly parentId: string | null;
  readonly startedAt: number;
  readonly status: SubagentStatus;
}

/** What a backend must offer to be usable as one. */
export interface SubagentProvider {
  readonly name: string;
  /** Runs the child. The record is returned at once; the work may outlive the call. */
  readonly start: (record: SubagentRecord, prompt: string) => Promise<void> | void;
  /** A word to a running child; false when it is no longer running. */
  readonly send?: (id: string, message: string) => boolean;
  readonly interrupt?: (id: string) => boolean;
}

export type SubagentList = readonly SubagentRecord[];

/**
 * Two limits, both from the reference's own settings: how deep children may nest, and how many may run at once.
 * A tree with no depth limit is a fork bomb; a tree with no width limit is a machine that stops answering.
 */
export interface SubagentLimits {
  readonly maxConcurrent: number;
  readonly maxDepth: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = Object.freeze({ maxConcurrent: 4, maxDepth: 2 });

export type SpawnResult =
  | Readonly<{ ok: true; record: SubagentRecord }>
  | Readonly<{ ok: false; reason: "depth" | "capacity" | "unknown_provider" }>;

export class SubagentRegistry {
  private readonly records = new Map<string, SubagentRecord>();
  private readonly providers = new Map<string, SubagentProvider>();
  private next = 1;

  constructor(private readonly limits: SubagentLimits = DEFAULT_SUBAGENT_LIMITS) {}

  register(provider: SubagentProvider): void {
    this.providers.set(provider.name, provider);
  }

  providerNames(): readonly string[] {
    return [...this.providers.keys()];
  }

  list(): SubagentList {
    return [...this.records.values()];
  }

  get(id: string): SubagentRecord | null {
    return this.records.get(id) ?? null;
  }

  /**
   * Starts a child, or explains why not. Refusing is a first-class answer: a caller that hits a limit is told
   * which one, instead of being handed a child that the machine cannot carry.
   */
  async spawn(request: Readonly<{ description: string; kind: SubagentKind; parentId?: string | null; prompt: string; provider: string }>): Promise<SpawnResult> {
    const provider = this.providers.get(request.provider);
    if (provider === undefined) return Object.freeze({ ok: false as const, reason: "unknown_provider" as const });
    const parentId = request.parentId ?? null;
    const parent = parentId === null ? null : this.records.get(parentId) ?? null;
    const depth = parent === null ? 1 : parent.depth + 1;
    if (depth > this.limits.maxDepth) return Object.freeze({ ok: false as const, reason: "depth" as const });
    if (this.runningCount() >= this.limits.maxConcurrent) return Object.freeze({ ok: false as const, reason: "capacity" as const });

    const id = "agent-" + String(this.next);
    this.next += 1;
    const record: SubagentRecord = Object.freeze({
      depth,
      description: request.description,
      id,
      kind: request.kind,
      parentId,
      startedAt: Date.now(),
      status: "running" as const,
    });
    this.records.set(id, record);
    try {
      await provider.start(record, request.prompt);
    } catch (error) {
      this.finish(id, "failed");
      throw error;
    }
    return Object.freeze({ ok: true as const, record });
  }

  /** Ends a child, or says it was not there. */
  interrupt(id: string): boolean {
    const provider = this.providerOf(id);
    if (provider === null || provider.interrupt === undefined) return false;
    return provider.interrupt(id);
  }

  /** A word to a child, forwarded to whoever runs it. */
  send(id: string, message: string): boolean {
    const provider = this.providerOf(id);
    if (provider === null || provider.send === undefined) return false;
    return provider.send(id, message);
  }

  /** The backend that owns this child, if any. */
  private providerOf(id: string): SubagentProvider | null {
    const record = this.records.get(id);
    if (record === undefined) return null;
    for (const provider of this.providers.values()) {
      if (provider.name === record.kind || provider.name === "in-process") return provider;
    }
    return null;
  }

  /** Records the end of a child; the provider calls this when its work finishes. */
  finish(id: string, status: Exclude<SubagentStatus, "running">): SubagentRecord | null {
    const record = this.records.get(id);
    if (record === undefined) return null;
    const next: SubagentRecord = Object.freeze({ ...record, status });
    this.records.set(id, next);
    return next;
  }

  private runningCount(): number {
    let running = 0;
    for (const record of this.records.values()) if (record.status === "running") running += 1;
    return running;
  }
}
