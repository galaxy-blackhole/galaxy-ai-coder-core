/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Bounded artifact storage shared by checkpoints and oversized tool output.
 */

import type { RunExecutionContext } from "./execution-context.js";
import type { PaginationRequest, PaginationResult } from "./pagination.js";
import type { PortResult } from "./port-result.js";

export type ArtifactRegisterInput = Readonly<{
  byteLength: number;
  contentSha256: string;
  kind: string;
  locator: string;
  metadata?: Readonly<Record<string, unknown>>;
  mimeType: string;
  retention?: "temporary" | "default" | "durable";
}>;

export type ArtifactCreateTextInput = Readonly<{
  content: string;
  kind: string;
  metadata?: Readonly<Record<string, unknown>>;
  mimeType: string;
  name?: string;
  retention?: "temporary" | "default" | "durable";
}>;

export type ArtifactRegisterResult = Readonly<{
  byteLength: number;
  contentSha256: string;
  id: string;
  mimeType: string;
  locator?: string;
}>;

export type ArtifactReadTextResult = Readonly<{
  content: string;
  contentSha256?: string;
  mimeType: string;
  pagination: PaginationResult;
}>;

export type ArtifactListEntry = Readonly<{
  createdAt: string;
  id: string;
  kind: string;
  metadata?: Readonly<Record<string, unknown>>;
  mimeType: string;
}>;

export type ArtifactListResult = Readonly<{
  artifacts: readonly ArtifactListEntry[];
  pagination: PaginationResult;
}>;

export interface ArtifactPort {
  readonly artifacts: Readonly<{
    createText(
      input: ArtifactCreateTextInput,
      context: RunExecutionContext,
    ): Promise<PortResult<ArtifactRegisterResult>>;
    register(
      input: ArtifactRegisterInput,
      context: RunExecutionContext,
    ): Promise<PortResult<ArtifactRegisterResult>>;
    list(
      input: PaginationRequest & Readonly<{ kind?: string }>,
      context: RunExecutionContext,
    ): Promise<PortResult<ArtifactListResult>>;
    readText(
      input: Readonly<{ cursor?: string; id: string; maxBytes?: number }>,
      context: RunExecutionContext,
    ): Promise<PortResult<ArtifactReadTextResult>>;
  }>;
}
