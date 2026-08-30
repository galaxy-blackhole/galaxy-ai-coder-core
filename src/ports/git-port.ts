/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Bounded read-only Git operations. Mutations remain approval-gated commands.
 */

import type { ToolExecutionContext } from "./execution-context.js";
import type { PaginationRequest, PaginationResult } from "./pagination.js";
import type { PortResult } from "./port-result.js";

export type GitCommandResult = Readonly<{
  pagination: PaginationResult;
  stderr: string;
  stdout: string;
}>;

export interface GitPort {
  status(
    input: PaginationRequest & Readonly<{ paths?: readonly string[] }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<GitCommandResult>>;
  diff(
    input: PaginationRequest & Readonly<{ paths?: readonly string[] }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<GitCommandResult>>;
  log(
    input: PaginationRequest & Readonly<{ paths?: readonly string[] }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<GitCommandResult>>;
}
