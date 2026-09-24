import type {
  PortErrorCode,
  PortFailure,
  PortResult,
  RunExecutionContext,
  TraceEvent,
  TracePort,
} from "@galaxy-stack/ai-coder-core/ports";

function failure(code: PortErrorCode, message: string): PortFailure {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message, retryable: false }),
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export class MemoryTracePort implements TracePort {
  private readonly recorded: TraceEvent[] = [];
  private readonly eventIds = new Set<string>();
  private readonly lastSequenceByExecution = new Map<string, number>();
  private completedFlushes = 0;

  get events(): readonly TraceEvent[] {
    // Never expose the stored payload graph. Object.freeze does not make Map,
    // Set, ArrayBuffer, and other structured-cloneable objects immutable.
    return deepFreeze(structuredClone(this.recorded));
  }

  get flushCount(): number {
    return this.completedFlushes;
  }

  async flush(context: RunExecutionContext): Promise<PortResult<void>> {
    if (context.signal.aborted) return failure("CANCELED", "Trace flush canceled.");
    if (Date.now() >= context.deadline) return failure("DEADLINE_EXCEEDED", "Trace flush deadline elapsed.");
    this.completedFlushes += 1;
    return { ok: true, data: undefined };
  }

  async emit(event: TraceEvent, context: RunExecutionContext): Promise<PortResult<void>> {
    if (context.signal.aborted) {
      return failure("CANCELED", "Trace emission canceled.");
    }
    if (Date.now() >= context.deadline) {
      return failure("DEADLINE_EXCEEDED", "Trace emission deadline elapsed.");
    }
    if (event.runId !== context.runId || event.taskId !== context.taskId) {
      return failure("INVALID_INPUT", "Trace event correlation does not match the run.");
    }
    if (
      event.eventId.length === 0 ||
      event.executionId.length === 0 ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 0 ||
      !Number.isFinite(Date.parse(event.timestamp))
    ) {
      return failure("INVALID_INPUT", "Trace event id, sequence, or timestamp is invalid.");
    }
    if (this.eventIds.has(event.eventId)) {
      return failure("CONFLICT", `Trace event id '${event.eventId}' already exists.`);
    }
    const executionKey = `${event.runId}\u0000${event.taskId}\u0000${event.executionId}`;
    const previousSequence = this.lastSequenceByExecution.get(executionKey);
    if (previousSequence !== undefined && event.sequence <= previousSequence) {
      return failure("CONFLICT", "Trace sequences must increase monotonically within one execution.");
    }
    let snapshot: TraceEvent;
    try {
      snapshot = deepFreeze(structuredClone(event));
    } catch {
      return failure("INVALID_INPUT", "Trace payload must be structured-cloneable.");
    }
    this.recorded.push(snapshot);
    this.eventIds.add(event.eventId);
    this.lastSequenceByExecution.set(executionKey, event.sequence);
    return { ok: true, data: undefined };
  }
}
