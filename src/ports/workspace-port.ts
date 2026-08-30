/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Bounded workspace read ports and atomic, precondition-aware mutation ports.
 */

import type { ToolExecutionContext } from "./execution-context.js";
import type { PaginationRequest, PaginationResult } from "./pagination.js";
import type { PortResult } from "./port-result.js";

export type WorkspaceEntry = Readonly<{
  kind: "file" | "directory" | "symlink" | "other";
  name: string;
  path: string;
}>;

export type WorkspaceListResult = Readonly<{
  entries: readonly WorkspaceEntry[];
  pagination: PaginationResult;
}>;

export type WorkspaceStatResult = Readonly<{
  contentSha256?: string;
  kind: "file" | "directory" | "symlink" | "missing" | "other";
  mtimeMs?: number;
  size?: number;
}>;

export type WorkspaceReadTextResult = Readonly<{
  content: string;
  contentSha256: string;
  endLine: number;
  pagination: PaginationResult;
  path: string;
  resolvedPath: string;
  startLine: number;
  truncated: boolean;
}>;

export type WorkspaceMutationPrecondition =
  | Readonly<{ contentSha256: string; kind: "matches_sha256" }>
  | Readonly<{ kind: "must_not_exist" }>;

export type WorkspaceMutationResult = Readonly<{
  afterContentSha256?: string;
  beforeContentSha256?: string;
  path: string;
  resolvedPath: string;
}>;

export type WorkspaceWriteTextResult = WorkspaceMutationResult &
  Readonly<{
    afterContentSha256: string;
    length: number;
  }>;

export type WorkspaceApplyPatchResult = WorkspaceMutationResult &
  Readonly<{
    afterContentSha256: string;
    beforeContentSha256: string;
    replacements: number;
  }>;

export type WorkspaceSearchPathsResult = Readonly<{
  matches: readonly string[];
  pagination: PaginationResult;
}>;

export type WorkspaceSearchTextMatch = Readonly<{
  column?: number;
  contentSha256?: string;
  line: number;
  path: string;
  preview: string;
}>;

export type WorkspaceSearchTextResult = Readonly<{
  matches: readonly WorkspaceSearchTextMatch[];
  pagination: PaginationResult;
}>;

export interface WorkspaceReaderPort {
  listDir(
    input: PaginationRequest & Readonly<{ depth?: number; path: string }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceListResult>>;
  stat(
    input: Readonly<{ path: string }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceStatResult>>;
  readText(
    input: Readonly<{
      cursor?: string;
      endLine?: number;
      maxBytes?: number;
      path: string;
      startLine?: number;
    }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceReadTextResult>>;
  searchPaths(
    input: PaginationRequest &
      Readonly<{
        kind?: "file" | "directory";
        mode?: "contains" | "glob" | "fuzzy";
        path?: string;
        query: string;
      }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceSearchPathsResult>>;
  searchText(
    input: PaginationRequest &
      Readonly<{
        caseSensitive?: boolean;
        glob?: string;
        path?: string;
        query: string;
        regex?: boolean;
      }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceSearchTextResult>>;
}

export interface WorkspaceWriterPort {
  /** Must compare the precondition and commit the replacement atomically. */
  applyPatch(
    input: Readonly<{
      newText: string;
      oldText: string;
      path: string;
      precondition: WorkspaceMutationPrecondition;
      replaceAll?: boolean;
    }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceApplyPatchResult>>;
  /** Must write via an atomic replace and enforce the precondition in the same operation. */
  writeText(
    input: Readonly<{
      content: string;
      path: string;
      precondition: WorkspaceMutationPrecondition;
    }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceWriteTextResult>>;
  mkdir(
    input: Readonly<{ path: string; recursive?: boolean }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<Readonly<{ created: boolean; path: string }>>>;
}

/** Convenience type for hosts that intentionally expose both capabilities. */
export type WorkspacePort = WorkspaceReaderPort & WorkspaceWriterPort;
