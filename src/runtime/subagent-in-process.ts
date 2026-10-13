/**
 * Child agents that run inside this process.
 *
 * The registry knows what a child is; this knows how one runs. It does not build the run itself, and that is the
 * point: a run needs models, tools, approvals and a workspace, and only the host that owns those can assemble
 * them. So the host hands in a factory, and this file is the part that is the same for every host — start the
 * work, keep the stop button, and tell the book when the child is done.
 */
import type { SubagentProvider, SubagentRecord } from "./subagent-registry.js";

export interface ChildRunRequest {
  /** The whole task. A child inherits no conversation, so everything it needs is here. */
  readonly prompt: string;
  /** Where this child sits, for a host that wants to label it. */
  readonly record: SubagentRecord;
  /** Aborted when the child is interrupted. */
  readonly signal: AbortSignal;
}

export interface ChildRunOutcome {
  /** What the child produced, for the parent to read. */
  readonly text: string;
  readonly ok: boolean;
}

/** What a host must supply: one child run, from prompt to outcome. */
export type ChildRunFactory = (request: ChildRunRequest) => Promise<ChildRunOutcome>;

export interface SubagentReporter {
  /** Records that a child ended, so a slot frees and the list stops calling it running. */
  readonly finish: (id: string, status: "completed" | "failed" | "cancelled") => unknown;
}

export interface InProcessSubagentOptions {
  readonly factory: ChildRunFactory;
  readonly name?: string;
  readonly reporter: SubagentReporter;
}

export class InProcessSubagentProvider implements SubagentProvider {
  readonly name: string;
  private readonly factory: ChildRunFactory;
  private readonly reporter: SubagentReporter;
  private readonly controllers = new Map<string, AbortController>();
  private readonly results = new Map<string, ChildRunOutcome>();

  constructor(options: InProcessSubagentOptions) {
    this.name = options.name ?? "in-process";
    this.factory = options.factory;
    this.reporter = options.reporter;
  }

  /**
   * Starts the child and returns at once: the caller holds an id, not a promise. The work ends by itself, and the
   * book is told either way — a child that throws is a failed child, not a missing one.
   */
  start(record: SubagentRecord, prompt: string): void {
    const controller = new AbortController();
    this.controllers.set(record.id, controller);
    void (async () => {
      try {
        const outcome = await this.factory({ prompt, record, signal: controller.signal });
        this.results.set(record.id, outcome);
        /*
         * Interrupted is interrupted, whatever the factory chose to return: a child that unwinds politely on abort
         * and reports ok:false was still cancelled, and the book has to say so or nobody can tell a stop from a bug.
         */
        this.reporter.finish(record.id, controller.signal.aborted ? "cancelled" : outcome.ok ? "completed" : "failed");
      } catch (error) {
        const aborted = controller.signal.aborted;
        this.results.set(record.id, Object.freeze({
          ok: false,
          text: aborted ? "Đã dừng theo yêu cầu." : error instanceof Error ? error.message : String(error),
        }));
        this.reporter.finish(record.id, aborted ? "cancelled" : "failed");
      } finally {
        this.controllers.delete(record.id);
      }
    })();
  }

  /** The stop button: the factory sees its signal fire and is expected to unwind. */
  interrupt(id: string): boolean {
    const controller = this.controllers.get(id);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  /** What a finished child produced, or null while it is still working. */
  result(id: string): ChildRunOutcome | null {
    return this.results.get(id) ?? null;
  }

  /** Children still holding a slot. */
  running(): readonly string[] {
    return [...this.controllers.keys()];
  }
}
