/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Cancellable bounded command execution and supervised terminal sessions.
 */

import type { ToolExecutionContext } from "./execution-context.js";
import type { PaginationRequest, PaginationResult } from "./pagination.js";
import type { PortResult } from "./port-result.js";

export type CommandExitStatus = "exited" | "timed_out" | "canceled";

export type CommandRunResult = Readonly<{
  command: string;
  durationMs: number;
  exitCode: number | null;
  status: CommandExitStatus;
  stderr: string;
  stderrArtifactId?: string;
  stderrTruncated: boolean;
  stdout: string;
  stdoutArtifactId?: string;
  stdoutTruncated: boolean;
}>;

export type CommandSessionStartResult = Readonly<{
  sessionId: string;
  startedAt: string;
}>;

export type CommandSessionReadResult = Readonly<{
  pagination: Readonly<{
    stderr: PaginationResult;
    stdout: PaginationResult;
  }>;
  status: "running" | CommandExitStatus;
  stderr: string;
  stderrArtifactId?: string;
  stderrTruncated: boolean;
  stdout: string;
  stdoutArtifactId?: string;
  stdoutTruncated: boolean;
}>;

export type CommandSessionListEntry = Readonly<{
  command: string;
  sessionId: string;
  startedAt: string;
  status: "running" | CommandExitStatus;
}>;

export interface CommandRunnerPort {
  run(
    input: Readonly<{
      command: string;
      cwd?: string;
      env?: Readonly<Record<string, string>>;
      maxOutputBytes?: number;
      timeoutMs?: number;
    }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<CommandRunResult>>;
}

export interface CommandSessionPort {
  start(
    input: Readonly<{
      command: string;
      cwd?: string;
      env?: Readonly<Record<string, string>>;
      maxOutputBytes?: number;
    }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<CommandSessionStartResult>>;
  read(
    input: Readonly<{
      maxChars?: number;
      sessionId: string;
      stderrCursor?: string;
      stdoutCursor?: string;
    }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<CommandSessionReadResult>>;
  write(
    input: Readonly<{ input: string; sessionId: string }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<Readonly<{ accepted: boolean }>>>;
  interrupt(
    input: Readonly<{ sessionId: string }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<Readonly<{ interrupted: boolean }>>>;
  kill(
    input: Readonly<{ sessionId: string }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<Readonly<{ killed: boolean }>>>;
  list(
    input: PaginationRequest,
    context: ToolExecutionContext,
  ): Promise<
    PortResult<
      Readonly<{
        pagination: PaginationResult;
        sessions: readonly CommandSessionListEntry[];
      }>
    >
  >;
}

/** Convenience type for hosts that deliberately expose both capabilities. */
export type CommandPort = CommandRunnerPort &
  Readonly<{ session: CommandSessionPort }>;
