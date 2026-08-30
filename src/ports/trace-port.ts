/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Structured, correlated trace sink for deterministic replay and diagnostics.
 */

import type { RunExecutionContext } from "./execution-context.js";
import type { PortResult } from "./port-result.js";

export type TraceEventKind =
  | "state_transition"
  | "tool_call"
  | "tool_result"
  | "token_ledger"
  | "context_diagnostic"
  | "checkpoint"
  | "prompt_snapshot"
  | "policy_decision"
  | "completion_gate";

export type TraceEvent = Readonly<{
  eventId: string;
  executionId: string;
  kind: TraceEventKind;
  payload: Readonly<Record<string, unknown>>;
  runId: string;
  sequence: number;
  taskId: string;
  timestamp: string;
}>;

export interface TracePort {
  emit(
    event: TraceEvent,
    context: RunExecutionContext,
  ): Promise<PortResult<void>>;
  /** Durably flush all accepted events through the current execution boundary. */
  flush(context: RunExecutionContext): Promise<PortResult<void>>;
}
