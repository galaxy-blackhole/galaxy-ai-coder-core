/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Versioned task, run, checkpoint, and token-ledger persistence.
 */

import type { RunExecutionContext } from "./execution-context.js";
import type { PaginationRequest, PaginationResult } from "./pagination.js";
import type { PortResult } from "./port-result.js";

export type PersistenceRecord = Readonly<{
  collection: string;
  id: string;
  revision: string;
  value: unknown;
}>;

export type PersistenceListResult = Readonly<{
  pagination: PaginationResult;
  records: readonly PersistenceRecord[];
}>;

export interface PersistencePort {
  readonly records: Readonly<{
    upsert(
      input: Readonly<{
        collection: string;
        expectedRevision?: string;
        id: string;
        value: unknown;
      }>,
      context: RunExecutionContext,
    ): Promise<PortResult<Readonly<{ id: string; revision: string }>>>;
    list(
      input: PaginationRequest & Readonly<{ collection: string }>,
      context: RunExecutionContext,
    ): Promise<PortResult<PersistenceListResult>>;
    delete(
      input: Readonly<{
        collection: string;
        expectedRevision?: string;
        id: string;
      }>,
      context: RunExecutionContext,
    ): Promise<PortResult<Readonly<{ deleted: boolean }>>>;
  }>;
  readonly storage: Readonly<{
    get(
      input: Readonly<{ key: string }>,
      context: RunExecutionContext,
    ): Promise<PortResult<Readonly<{ revision: string; value: unknown }>>>;
    set(
      input: Readonly<{
        expectedRevision?: string;
        key: string;
        value: unknown;
      }>,
      context: RunExecutionContext,
    ): Promise<PortResult<Readonly<{ revision: string }>>>;
  }>;
}
