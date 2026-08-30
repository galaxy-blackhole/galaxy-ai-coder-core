import type { RunExecutionContext } from "../ports/execution-context.js";
import type { TraceEventKind, TracePort } from "../ports/trace-port.js";

export class AiCoderTraceEmitter {
  private sequence = 0;
  private healthyValue = true;
  private finalizedValue = false;

  constructor(
    private readonly port: TracePort | undefined,
    private readonly context: RunExecutionContext,
    private readonly timestamp: () => string,
    private readonly executionId: string,
  ) {}

  get healthy(): boolean {
    return this.healthyValue;
  }

  get finalized(): boolean {
    return !this.port || (this.healthyValue && this.finalizedValue);
  }

  async emit(kind: TraceEventKind, payload: Readonly<Record<string, unknown>>): Promise<void> {
    if (!this.port) return;
    this.finalizedValue = false;
    const sequence = this.sequence += 1;
    try {
      const pending = this.port.emit(Object.freeze({
        eventId: `${this.context.runId}:${this.executionId}:${sequence}`,
        executionId: this.executionId,
        kind,
        payload,
        runId: this.context.runId,
        sequence,
        taskId: this.context.taskId,
        timestamp: this.timestamp(),
      }), this.context);
      const result = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          this.context.signal.removeEventListener("abort", aborted);
          action();
        };
        const aborted = () => finish(() => reject(this.context.signal.reason));
        this.context.signal.addEventListener("abort", aborted, { once: true });
        pending.then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
        if (this.context.signal.aborted) aborted();
      });
      if (!result.ok) this.healthyValue = false;
    } catch {
      this.healthyValue = false;
    }
  }

  async flush(): Promise<void> {
    if (!this.port) {
      this.finalizedValue = true;
      return;
    }
    try {
      const pending = this.port.flush(this.context);
      const result = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          this.context.signal.removeEventListener("abort", aborted);
          action();
        };
        const aborted = () => finish(() => reject(this.context.signal.reason));
        this.context.signal.addEventListener("abort", aborted, { once: true });
        pending.then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
        if (this.context.signal.aborted) aborted();
      });
      if (!result.ok) this.healthyValue = false;
      this.finalizedValue = result.ok && this.healthyValue;
    } catch {
      this.healthyValue = false;
      this.finalizedValue = false;
    }
  }
}
