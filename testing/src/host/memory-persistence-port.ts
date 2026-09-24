import type {
  PaginationResult,
  PersistenceListResult,
  PersistencePort,
  PersistenceRecord,
  PortFailure,
  PortResult,
  RunExecutionContext,
} from "@galaxy-stack/ai-coder-core/ports";

type Stored = { revision: number; value: unknown };

function failure(
  code: "CANCELED" | "CONFLICT" | "DEADLINE_EXCEEDED" | "NOT_FOUND" | "INVALID_INPUT",
  message: string,
): PortFailure {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message, retryable: false }) });
}

function cloneValue(value: unknown): PortResult<unknown> {
  try {
    return { ok: true, data: structuredClone(value) };
  } catch {
    return failure("INVALID_INPUT", "Persistence values must be structured-cloneable.");
  }
}

function validKeyPart(value: string): boolean {
  return value.length > 0 && !value.includes("\0");
}

function parseRevision(revision: string | undefined): number | undefined {
  if (revision === undefined) return undefined;
  const match = /^r(0|[1-9]\d*)$/.exec(revision);
  if (match?.[1] === undefined) return Number.NaN;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function pagination(total: number, offset: number, count: number): PaginationResult {
  const nextOffset = offset + count;
  const hasMore = nextOffset < total;
  return Object.freeze({ hasMore, ...(hasMore ? { nextCursor: `offset:${nextOffset}` } : {}) });
}

function pageOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

export class MemoryPersistencePort implements PersistencePort {
  private readonly recordValues = new Map<string, Stored>();
  private readonly storageValues = new Map<string, Stored>();

  readonly records: PersistencePort["records"];
  readonly storage: PersistencePort["storage"];

  constructor() {
    this.records = Object.freeze({
      upsert: async (input, context) => {
        const blocked = this.checkContext(context);
        if (blocked !== undefined) return blocked;
        if (!validKeyPart(input.collection) || !validKeyPart(input.id)) {
          return failure("INVALID_INPUT", "Persistence collection and id must be non-empty and contain no null byte.");
        }
        const key = `${input.collection}\u0000${input.id}`;
        const current = this.recordValues.get(key);
        const conflict = this.checkRevision(current, input.expectedRevision);
        if (conflict !== undefined) return conflict;
        const cloned = cloneValue(input.value);
        if (!cloned.ok) return cloned;
        const next = { revision: (current?.revision ?? 0) + 1, value: cloned.data };
        this.recordValues.set(key, next);
        return { ok: true, data: Object.freeze({ id: input.id, revision: `r${next.revision}` }) };
      },
      list: async (input, context) => {
        const blocked = this.checkContext(context);
        if (blocked !== undefined) return blocked;
        if (!validKeyPart(input.collection)) return failure("INVALID_INPUT", "Persistence collection is invalid.");
        const offset = pageOffset(input.cursor);
        const limit = input.limit ?? 100;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
          return failure("INVALID_INPUT", "Invalid persistence pagination.");
        }
        const prefix = `${input.collection}\u0000`;
        const all = [...this.recordValues.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([key, stored]): PersistenceRecord => Object.freeze({
            collection: input.collection,
            id: key.slice(prefix.length),
            revision: `r${stored.revision}`,
            value: structuredClone(stored.value),
          }));
        const records = Object.freeze(all.slice(offset, offset + Math.min(limit, 1_000)));
        const result: PersistenceListResult = Object.freeze({
          records,
          pagination: pagination(all.length, offset, records.length),
        });
        return { ok: true, data: result };
      },
      delete: async (input, context) => {
        const blocked = this.checkContext(context);
        if (blocked !== undefined) return blocked;
        if (!validKeyPart(input.collection) || !validKeyPart(input.id)) {
          return failure("INVALID_INPUT", "Persistence collection and id are invalid.");
        }
        const key = `${input.collection}\u0000${input.id}`;
        const current = this.recordValues.get(key);
        if (current === undefined) return { ok: true, data: Object.freeze({ deleted: false }) };
        const conflict = this.checkRevision(current, input.expectedRevision);
        if (conflict !== undefined) return conflict;
        this.recordValues.delete(key);
        return { ok: true, data: Object.freeze({ deleted: true }) };
      },
    });
    this.storage = Object.freeze({
      get: async (input, context) => {
        const blocked = this.checkContext(context);
        if (blocked !== undefined) return blocked;
        if (!validKeyPart(input.key)) return failure("INVALID_INPUT", "Storage key is invalid.");
        const stored = this.storageValues.get(input.key);
        if (stored === undefined) return failure("NOT_FOUND", `Storage key '${input.key}' does not exist.`);
        return { ok: true, data: Object.freeze({ revision: `r${stored.revision}`, value: structuredClone(stored.value) }) };
      },
      set: async (input, context) => {
        const blocked = this.checkContext(context);
        if (blocked !== undefined) return blocked;
        if (!validKeyPart(input.key)) return failure("INVALID_INPUT", "Storage key is invalid.");
        const current = this.storageValues.get(input.key);
        const conflict = this.checkRevision(current, input.expectedRevision);
        if (conflict !== undefined) return conflict;
        const cloned = cloneValue(input.value);
        if (!cloned.ok) return cloned;
        const next = { revision: (current?.revision ?? 0) + 1, value: cloned.data };
        this.storageValues.set(input.key, next);
        return { ok: true, data: Object.freeze({ revision: `r${next.revision}` }) };
      },
    });
  }

  private checkContext(context: RunExecutionContext): PortFailure | undefined {
    if (context.signal.aborted) return failure("CANCELED", "Persistence operation canceled.");
    return Date.now() >= context.deadline
      ? failure("DEADLINE_EXCEEDED", "Persistence operation deadline elapsed.")
      : undefined;
  }

  private checkRevision(current: Stored | undefined, expectedRevision: string | undefined): PortFailure | undefined {
    const expected = parseRevision(expectedRevision);
    if (Number.isNaN(expected)) return failure("INVALID_INPUT", "Revision must use r<number> format.");
    if (expected === undefined) return undefined;
    return current?.revision === expected
      ? undefined
      : failure("CONFLICT", `Revision mismatch; expected r${expected}, current is ${current === undefined ? "missing" : `r${current.revision}`}.`);
  }
}
