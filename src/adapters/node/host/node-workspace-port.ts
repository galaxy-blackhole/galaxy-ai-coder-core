import type {
  PortFailure,
  PortErrorCode,
  PortError,
  PortResult,
  ToolExecutionContext,
  WorkspaceApplyPatchResult,
  WorkspaceEntry,
  WorkspaceListResult,
  WorkspaceMutationPrecondition,
  WorkspacePort,
  WorkspaceReadTextResult,
  WorkspaceSearchPathsResult,
  WorkspaceSearchTextResult,
  WorkspaceStatResult,
  WorkspaceWriteTextResult,
} from "../../../ports/index.js";
import { createHash, randomUUID } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import {
  copyFile,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { sha256Text } from "./content-hash.js";
import { WorkspaceScope } from "./path-scope.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const DEFAULT_MAX_BYTES = 128 * 1024;
const MAX_READ_FILE_BYTES = 16 * 1024 * 1024;
const SEARCH_READ_CHUNK_BYTES = 64 * 1024;
const MAX_SEARCH_LINE_CHARACTERS = 1024 * 1024;
const MAX_SCANNED_ENTRIES = 100_000;
const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", "dist", "coverage"]);
/** Reading generated dependency sources floods context with library internals; framework docs live in MCP tools and skill documents instead. */
const NON_READABLE_SEGMENTS = new Set(["node_modules", ".bun-cache"]);
function dependencyReadError(path: string): PortError {
  return Object.freeze({
    code: "UNSUPPORTED" as PortErrorCode,
    message: `${path} nằm trong thư mục dependency (node_modules/.bun-cache) — không đọc source thư viện bằng file tools. Dùng framework MCP tools (vd orbit/nebula) hoặc tài liệu docs để tra API.`,
    retryable: false,
    suggestedAction: "Dùng MCP tools của framework hoặc tìm trong docs; chỉ đọc source authored trong workspace.",
  });
}
function isDependencyPath(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => NON_READABLE_SEGMENTS.has(segment));
}
/** After an install, package manifests, declarations and READMEs are cheap ground truth; full library source trees are not. */
function isDependencyGroundTruth(path: string): boolean {
  const file = path.split(/[\\/]/).at(-1) ?? "";
  return file === "package.json" || file === "README.md" || file.endsWith(".d.ts");
}

function failure(code: PortErrorCode, message: string, retryable = false): PortFailure {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message, retryable }),
  });
}

function exceptionFailure(error: unknown): PortFailure {
  const message = error instanceof Error ? error.message : String(error);
  const nativeCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "WORKSPACE_ERROR")
    : "WORKSPACE_ERROR";
  const code: PortErrorCode = (() => {
    switch (nativeCode) {
      case "ABORT_ERR":
      case "CANCELED": return "CANCELED";
      case "DEADLINE_EXCEEDED": return "DEADLINE_EXCEEDED";
      case "INVALID_INPUT":
      case "ENOTDIR": return "INVALID_INPUT";
      case "LIMIT_EXCEEDED": return "LIMIT_EXCEEDED";
      case "CONFLICT": return "CONFLICT";
      case "EACCES":
      case "EPERM":
      case "PERMISSION_DENIED": return "PERMISSION_DENIED";
      case "ENOENT":
      case "NOT_FOUND": return "NOT_FOUND";
      case "EEXIST":
      case "ALREADY_EXISTS": return "ALREADY_EXISTS";
      case "EAGAIN":
      case "EBUSY":
      case "UNAVAILABLE": return "UNAVAILABLE";
      case "PRECONDITION_FAILED": return "PRECONDITION_FAILED";
      default: return "IO_ERROR";
    }
  })();
  return failure(code, message, code === "UNAVAILABLE");
}

function checkContext(context: ToolExecutionContext): PortFailure | undefined {
  if (context.signal.aborted) return failure("CANCELED", "The run was canceled.");
  if (Date.now() >= context.deadline) return failure("DEADLINE_EXCEEDED", "The run deadline elapsed.");
  return undefined;
}

function throwIfBlocked(context: ToolExecutionContext): void {
  const blocked = checkContext(context);
  if (blocked !== undefined) {
    throw Object.assign(new Error(blocked.error.message), { code: blocked.error.code });
  }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw Object.assign(new Error("Pagination limit must be a positive integer."), { code: "INVALID_INPUT" });
  }
  return Math.min(limit, MAX_LIMIT);
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  if (match?.[1] === undefined) {
    throw Object.assign(new Error("Invalid pagination cursor."), { code: "INVALID_INPUT" });
  }
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset)) {
    throw Object.assign(new Error("Invalid pagination cursor."), { code: "INVALID_INPUT" });
  }
  return offset;
}

function page<T>(values: readonly T[], cursor?: string, requestedLimit?: number): {
  readonly values: readonly T[];
  readonly pagination: Readonly<{ hasMore: boolean; nextCursor?: string }>;
} {
  const offset = decodeCursor(cursor);
  const limit = boundedLimit(requestedLimit);
  if (offset > values.length) {
    throw Object.assign(new Error("Pagination cursor is outside the result set."), { code: "INVALID_INPUT" });
  }
  const result = values.slice(offset, offset + limit);
  const nextOffset = offset + result.length;
  const hasMore = nextOffset < values.length;
  return {
    values: Object.freeze(result),
    pagination: Object.freeze({
      hasMore,
      ...(hasMore ? { nextCursor: `offset:${nextOffset}` } : {}),
    }),
  };
}

function relativeWorkspacePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split("\\").join("/") || ".";
}

async function currentText(
  path: string,
  context: ToolExecutionContext,
): Promise<string | undefined> {
  try {
    return decodeUtf8(await readFile(path, { signal: context.signal }), path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function decodeUtf8(bytes: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error(`Workspace text operation requires valid UTF-8: ${path}.`), { code: "INVALID_INPUT" });
  }
}

async function readUtf8(path: string, context: ToolExecutionContext): Promise<string> {
  return decodeUtf8(await readFile(path, { signal: context.signal }), path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

type ReadCursor = Readonly<{
  contentSha256: string;
  endLine: number;
  offset: number;
  startLine: number;
}>;

function decodeReadCursor(cursor: string): ReadCursor {
  const match = /^text:([a-f0-9]{64}):(\d+):(\d+):(\d+)$/.exec(cursor);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) {
    throw Object.assign(new Error("Invalid text pagination cursor."), { code: "INVALID_INPUT" });
  }
  const result = {
    contentSha256: match[1],
    startLine: Number(match[2]),
    endLine: Number(match[3]),
    offset: Number(match[4]),
  };
  if (!Number.isSafeInteger(result.startLine) || !Number.isSafeInteger(result.endLine) || !Number.isSafeInteger(result.offset)) {
    throw Object.assign(new Error("Invalid text pagination cursor."), { code: "INVALID_INPUT" });
  }
  return result;
}

function utf8Chunk(
  bytes: Buffer,
  offset: number,
  maxBytes: number,
): Readonly<{ content: string; endOffset: number }> {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } catch {
    throw Object.assign(new Error("Text cursor is not aligned to a UTF-8 character boundary."), { code: "INVALID_INPUT" });
  }
  let endOffset = Math.min(bytes.length, offset + maxBytes);
  while (endOffset > offset) {
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, endOffset));
      return Object.freeze({ content, endOffset });
    } catch {
      endOffset -= 1;
    }
  }
  if (offset >= bytes.length) return Object.freeze({ content: "", endOffset: offset });
  throw Object.assign(new Error("maxBytes is too small for the next UTF-8 character."), { code: "LIMIT_EXCEEDED" });
}

function countNewlines(value: string): number {
  let count = 0;
  for (const character of value) if (character === "\n") count += 1;
  return count;
}

async function scanUtf8Lines(
  absolutePath: string,
  context: ToolExecutionContext,
  onLine: (line: string, lineNumber: number) => void,
): Promise<string> {
  const handle = await open(absolutePath, "r");
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(SEARCH_READ_CHUNK_BYTES);
  let carry = "";
  let lineNumber = 1;
  let position = 0;
  const decode = (bytes?: Uint8Array, stream = false): string => {
    try {
      return decoder.decode(bytes, { stream });
    } catch {
      throw Object.assign(new Error(`Workspace text search requires valid UTF-8: ${absolutePath}.`), {
        code: "INVALID_UTF8",
      });
    }
  };
  const consume = (text: string): void => {
    const combined = carry + text;
    let start = 0;
    while (true) {
      const newline = combined.indexOf("\n", start);
      if (newline < 0) break;
      onLine(combined.slice(start, newline), lineNumber);
      lineNumber += 1;
      start = newline + 1;
    }
    carry = combined.slice(start);
    if (carry.length > MAX_SEARCH_LINE_CHARACTERS) {
      throw Object.assign(new Error(
        `Workspace text search line exceeds ${MAX_SEARCH_LINE_CHARACTERS} characters: ${absolutePath}.`,
      ), { code: "LIMIT_EXCEEDED" });
    }
  };
  try {
    while (true) {
      throwIfBlocked(context);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      consume(decode(chunk, true));
    }
    consume(decode());
    onLine(carry, lineNumber);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function enforcePrecondition(current: string | undefined, precondition: WorkspaceMutationPrecondition): PortFailure | undefined {
  if (precondition.kind === "must_not_exist") {
    return current === undefined
      ? undefined
      : failure(
        "PRECONDITION_FAILED",
        "The target already exists. Re-read the file, then use a matches_sha256 precondition with the current content hash for edits; must_not_exist only fits the first creation.",
      );
  }
  if (!/^[a-f0-9]{64}$/.test(precondition.contentSha256)) {
    return failure("INVALID_INPUT", "Content hash preconditions must be lowercase SHA-256 values.");
  }
  if (current === undefined) return failure("PRECONDITION_FAILED", "The target does not exist.");
  const actual = sha256Text(current);
  return actual === precondition.contentSha256
    ? undefined
    : failure(
      "PRECONDITION_FAILED",
      `Content hash mismatch; expected ${precondition.contentSha256}, but the current content hash is ${actual}. Re-read the file to see its current content, then use this current hash as contentSha256 in your next matches_sha256 precondition.`,
    );
}

function globPattern(query: string): RegExp {
  let source = "";
  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    if (character === "*") {
      if (query[index + 1] === "*") {
        index += 1;
        if (query[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character === undefined ? "" : character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

export class NodeWorkspacePort implements WorkspacePort {
  readonly traversalExclusions = Object.freeze([...IGNORED_DIRECTORY_NAMES].sort());

  private constructor(private readonly scope: WorkspaceScope) {}

  static async create(workspaceRoot: string): Promise<NodeWorkspacePort> {
    return new NodeWorkspacePort(await WorkspaceScope.create(workspaceRoot));
  }

  private async allEntries(
    path: string,
    depth: number,
    context: ToolExecutionContext,
  ): Promise<readonly WorkspaceEntry[]> {
    throwIfBlocked(context);
    const root = await this.scope.resolveExisting(path);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) {
      throw Object.assign(new Error("Workspace traversal requires a directory path."), { code: "INVALID_INPUT" });
    }
    const results: WorkspaceEntry[] = [];
    const visit = async (absoluteDirectory: string, remainingDepth: number): Promise<void> => {
      throwIfBlocked(context);
      const directory = await this.scope.resolveExisting(
        relativeWorkspacePath(this.scope.root, absoluteDirectory),
      );
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const child of children) {
        throwIfBlocked(context);
        if (child.isDirectory() && IGNORED_DIRECTORY_NAMES.has(child.name)) continue;
        if (child.name.endsWith(".galaxy-code.lock")) continue;
        const absoluteChild = join(directory, child.name);
        const kind: WorkspaceEntry["kind"] = child.isFile()
          ? "file"
          : child.isDirectory()
            ? "directory"
            : child.isSymbolicLink()
              ? "symlink"
              : "other";
        results.push(Object.freeze({
          kind,
          name: child.name,
          path: relativeWorkspacePath(this.scope.root, absoluteChild),
        }));
        if (results.length > MAX_SCANNED_ENTRIES) {
          throw Object.assign(
            new Error(`Workspace scan exceeded ${MAX_SCANNED_ENTRIES} entries.`),
            { code: "LIMIT_EXCEEDED" },
          );
        }
        if (kind === "directory" && remainingDepth > 1) await visit(absoluteChild, remainingDepth - 1);
      }
    };
    await visit(root, depth);
    return Object.freeze(results);
  }

  async listDir(
    input: Readonly<{ cursor?: string; depth?: number; limit?: number; path: string }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceListResult>> {
    const canceled = checkContext(context);
    if (canceled !== undefined) return canceled;
    try {
      const depth = input.depth ?? 1;
      if (!Number.isSafeInteger(depth) || depth < 1 || depth > 20) return failure("INVALID_INPUT", "Depth must be between 1 and 20.");
      const result = page(await this.allEntries(input.path, depth, context), input.cursor, input.limit);
      return { ok: true, data: Object.freeze({ entries: result.values, pagination: result.pagination }) };
    } catch (error) {
      return exceptionFailure(error);
    }
  }

  async stat(input: Readonly<{ path: string }>, context: ToolExecutionContext): Promise<PortResult<WorkspaceStatResult>> {
    const canceled = checkContext(context);
    if (canceled !== undefined) return canceled;
    try {
      const lexical = this.scope.resolveLexical(input.path);
      let info;
      try {
        info = await lstat(lexical);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
          return { ok: true, data: Object.freeze({ kind: "missing" }) };
        }
        throw error;
      }
      const kind: WorkspaceStatResult["kind"] = info.isFile()
        ? "file"
        : info.isDirectory()
          ? "directory"
          : info.isSymbolicLink()
            ? "symlink"
            : "other";
      const content = kind === "file" && info.size <= MAX_READ_FILE_BYTES
        ? await readFile(await this.scope.resolveExisting(input.path), { signal: context.signal })
        : undefined;
      return {
        ok: true,
        data: Object.freeze({
          kind,
          size: info.size,
          mtimeMs: info.mtimeMs,
          ...(content === undefined ? {} : { contentSha256: createHash("sha256").update(content).digest("hex") }),
        }),
      };
    } catch (error) {
      return exceptionFailure(error);
    }
  }

  async readText(input: Readonly<{ cursor?: string; endLine?: number; maxBytes?: number; path: string; startLine?: number }>, context: ToolExecutionContext): Promise<PortResult<WorkspaceReadTextResult>> {
    if (isDependencyPath(String(input.path)) && !isDependencyGroundTruth(String(input.path))) return failure("UNSUPPORTED", dependencyReadError(String(input.path)).message, false);
    const canceled = checkContext(context);
    if (canceled !== undefined) return canceled;
    try {
      const resolvedPath = await this.scope.resolveExisting(input.path);
      const info = await lstat(resolvedPath);
      if (!info.isFile()) return failure("INVALID_INPUT", "readText requires a regular file.");
      if (info.size > MAX_READ_FILE_BYTES) {
        return failure("LIMIT_EXCEEDED", `Text file exceeds the ${MAX_READ_FILE_BYTES} byte host limit.`);
      }
      const fullContent = await readUtf8(resolvedPath, context);
      const contentSha256 = sha256Text(fullContent);
      const lines = fullContent.split("\n");
      const decodedCursor = input.cursor === undefined ? undefined : decodeReadCursor(input.cursor);
      if (decodedCursor !== undefined && decodedCursor.contentSha256 !== contentSha256) {
        return failure("CONFLICT", "The file changed after the text cursor was issued.");
      }
      if (
        decodedCursor !== undefined &&
        ((input.startLine !== undefined && input.startLine !== decodedCursor.startLine) ||
          (input.endLine !== undefined && input.endLine !== decodedCursor.endLine))
      ) {
        return failure("INVALID_INPUT", "Line range does not match the text cursor.");
      }
      const requestedStartLine = decodedCursor?.startLine ?? input.startLine ?? 1;
      const requestedEndLine = decodedCursor?.endLine ?? Math.min(input.endLine ?? lines.length, lines.length);
      if (
        !Number.isSafeInteger(requestedStartLine) ||
        !Number.isSafeInteger(requestedEndLine) ||
        requestedStartLine < 1 ||
        requestedStartLine > lines.length ||
        requestedEndLine < requestedStartLine ||
        requestedEndLine > lines.length
      ) {
        return failure("INVALID_INPUT", "Invalid line range.");
      }
      const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > DEFAULT_MAX_BYTES) {
        return failure("INVALID_INPUT", `maxBytes must be between 4 and ${DEFAULT_MAX_BYTES}.`);
      }
      const selectedText = lines.slice(requestedStartLine - 1, requestedEndLine).join("\n");
      const selectedBytes = Buffer.from(selectedText, "utf8");
      const offset = decodedCursor?.offset ?? 0;
      if (offset < 0 || offset > selectedBytes.length) return failure("INVALID_INPUT", "Text cursor is outside the requested range.");
      const chunk = utf8Chunk(selectedBytes, offset, maxBytes);
      const prefix = selectedBytes.subarray(0, offset).toString("utf8");
      const startLine = requestedStartLine + countNewlines(prefix);
      const endLine = startLine + countNewlines(chunk.content);
      const truncated = chunk.endOffset < selectedBytes.length;
      return {
        ok: true,
        data: Object.freeze({
          content: chunk.content,
          contentSha256,
          path: input.path,
          resolvedPath,
          startLine,
          endLine,
          truncated,
          pagination: Object.freeze({
            hasMore: truncated,
            ...(truncated
              ? { nextCursor: `text:${contentSha256}:${requestedStartLine}:${requestedEndLine}:${chunk.endOffset}` }
              : {}),
          }),
        }),
      };
    } catch (error) {
      return exceptionFailure(error);
    }
  }

  async searchPaths(
    input: Readonly<{
      cursor?: string;
      kind?: "file" | "directory";
      limit?: number;
      mode?: "contains" | "glob" | "fuzzy";
      path?: string;
      query: string;
    }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceSearchPathsResult>> {
    const globTarget = String(input.path ?? ".");
    if (isDependencyPath(globTarget) || isDependencyPath(String(input.query))) return failure("UNSUPPORTED", dependencyReadError(globTarget === "." ? String(input.query) : globTarget).message, false);
    const canceled = checkContext(context);
    if (canceled !== undefined) return canceled;
    try {
      if (input.query.length === 0 || input.query.length > 512) {
        return failure("INVALID_INPUT", "Search query length must be between 1 and 512.");
      }
      const basePath = await this.scope.resolveExisting(input.path ?? ".");
      const entries = await this.allEntries(input.path ?? ".", Number.POSITIVE_INFINITY, context);
      const lowered = input.query.toLowerCase();
      const pattern = input.mode === "glob" ? globPattern(input.query) : undefined;
      const matches = entries
        .filter((entry) => input.kind === undefined || entry.kind === input.kind)
        .map((entry) => Object.freeze({
          path: entry.path,
          searchPath: relativeWorkspacePath(basePath, join(this.scope.root, entry.path)),
        }))
        .filter(({ searchPath }) => {
          if (pattern !== undefined) return pattern.test(searchPath);
          if (input.mode === "fuzzy") {
            let cursor = 0;
            for (const character of searchPath.toLowerCase()) if (character === lowered[cursor]) cursor += 1;
            return cursor === lowered.length;
          }
          return searchPath.toLowerCase().includes(lowered);
        })
        .map(({ path }) => path)
        .sort();
      const result = page(matches, input.cursor, input.limit);
      return { ok: true, data: Object.freeze({ matches: result.values, pagination: result.pagination }) };
    } catch (error) {
      return exceptionFailure(error);
    }
  }

  async searchText(
    input: Readonly<{
      caseSensitive?: boolean;
      cursor?: string;
      glob?: string;
      limit?: number;
      path?: string;
      query: string;
      regex?: boolean;
    }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceSearchTextResult>> {
    const canceled = checkContext(context);
    if (canceled !== undefined) return canceled;
    try {
      if (input.query.length === 0 || input.query.length > 512) return failure("INVALID_INPUT", "Search query length must be between 1 and 512.");
      if (input.glob !== undefined && input.glob.length > 512) {
        return failure("INVALID_INPUT", "Search glob must not exceed 512 characters.");
      }
      const caseSensitive = input.caseSensitive ?? true;
      let matcher: (line: string) => number;
      if (input.regex === true) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(input.query, caseSensitive ? "u" : "iu");
        } catch {
          return failure("INVALID_INPUT", "Search query is not a valid regular expression.");
        }
        matcher = (line) => pattern.exec(line)?.index ?? -1;
      } else {
        const query = caseSensitive ? input.query : input.query.toLocaleLowerCase("en-US");
        matcher = caseSensitive
          ? (line) => line.indexOf(query)
          : (line) => line.toLocaleLowerCase("en-US").indexOf(query);
      }
      if (isDependencyPath(String(input.path ?? "."))) return failure("UNSUPPORTED", dependencyReadError(String(input.path ?? ".")).message, false);
      const offset = decodeCursor(input.cursor);
      const limit = boundedLimit(input.limit);
      const basePath = await this.scope.resolveExisting(input.path ?? ".");
      const entries = await this.allEntries(input.path ?? ".", Number.POSITIVE_INFINITY, context);
      const pathPattern = input.glob === undefined ? undefined : globPattern(input.glob);
      const matches: WorkspaceSearchTextResult["matches"][number][] = [];
      let matchedCount = 0;
      let hasMore = false;
      search:
      for (const entry of entries) {
        throwIfBlocked(context);
        if (entry.kind !== "file") continue;
        const searchPath = relativeWorkspacePath(basePath, join(this.scope.root, entry.path));
        if (pathPattern !== undefined && !pathPattern.test(searchPath)) continue;
        const absolutePath = await this.scope.resolveExisting(entry.path);
        const localMatches: Array<Readonly<{
          column: number;
          line: number;
          path: string;
          preview: string;
        }>> = [];
        let contentHash: string;
        try {
          contentHash = await scanUtf8Lines(absolutePath, context, (line, lineNumber) => {
            if (hasMore) return;
            const column = matcher(line);
            if (column < 0) return;
            if (matchedCount < offset) {
              matchedCount += 1;
              return;
            }
            if (matches.length + localMatches.length >= limit) {
              hasMore = true;
              return;
            }
            localMatches.push(Object.freeze({
              path: entry.path,
              line: lineNumber,
              column: column + 1,
              preview: line.slice(0, 500),
            }));
            matchedCount += 1;
          });
        } catch (error) {
          throwIfBlocked(context);
          if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") throw error;
          if (typeof error === "object" && error !== null && "code" in error && error.code !== "INVALID_UTF8") throw error;
          continue;
        }
        matches.push(...localMatches.map((match) => Object.freeze({ ...match, contentSha256: contentHash })));
        if (hasMore) break search;
      }
      if (!hasMore && matchedCount < offset) {
        return failure("INVALID_INPUT", "Pagination cursor is outside the result set.");
      }
      return {
        ok: true,
        data: Object.freeze({
          matches: Object.freeze(matches),
          pagination: Object.freeze({
            hasMore,
            ...(hasMore ? { nextCursor: `offset:${offset + matches.length}` } : {}),
          }),
        }),
      };
    } catch (error) {
      return exceptionFailure(error);
    }
  }

  private async withTargetLock<T>(
    target: string,
    context: ToolExecutionContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    throwIfBlocked(context);
    const lockPath = `${target}.galaxy-code.lock`;
    const handle = await open(lockPath, "wx").catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        throw Object.assign(new Error("Another mutation is already in progress for this path."), { code: "UNAVAILABLE" });
      }
      throw error;
    });
    try {
      throwIfBlocked(context);
      return await operation();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async atomicWrite(
    path: string,
    content: string,
    precondition: WorkspaceMutationPrecondition,
    context: ToolExecutionContext,
  ): Promise<{ readonly before?: string; readonly resolvedPath: string }> {
    throwIfBlocked(context);
    let resolvedPath: string;
    let firstCreatedParent: string | undefined;
    if (precondition.kind === "matches_sha256") {
      // A hash-bound edit requires an existing target. Never create parent
      // directories before proving that precondition.
      try {
        resolvedPath = await this.scope.resolveExisting(path);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
          throw Object.assign(new Error("The target does not exist."), { code: "PRECONDITION_FAILED" });
        }
        throw error;
      }
    } else {
      resolvedPath = await this.scope.resolveForWrite(path);
      firstCreatedParent = await mkdir(dirname(resolvedPath), { recursive: true });
      resolvedPath = await this.scope.resolveForWrite(path);
    }
    try {
      return await this.withTargetLock(resolvedPath, context, async () => {
        const before = await currentText(resolvedPath, context);
        const preconditionError = enforcePrecondition(before, precondition);
        if (preconditionError !== undefined) throw Object.assign(new Error(preconditionError.error.message), { code: preconditionError.error.code });
        if (before === content) {
          throw Object.assign(new Error("The requested write would not change the target content."), { code: "CONFLICT" });
        }
        const temporaryPath = join(dirname(resolvedPath), `.${basename(resolvedPath)}.${randomUUID()}.tmp`);
        const existingInfo = await lstat(resolvedPath).catch((error: unknown) => {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        });
        const mode = existingInfo === undefined ? 0o600 : existingInfo.mode & 0o777;
        const handle = await open(temporaryPath, "wx", mode);
        try {
          await handle.writeFile(content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          throwIfBlocked(context);
          await this.scope.resolveForWrite(path);
          if (precondition.kind === "matches_sha256") {
            const latest = await currentText(resolvedPath, context);
            if (latest === undefined || sha256Text(latest) !== precondition.contentSha256) {
              throw Object.assign(new Error("The target changed while preparing the write."), { code: "PRECONDITION_FAILED" });
            }
          }
          if (precondition.kind === "must_not_exist") {
            await link(temporaryPath, resolvedPath);
            await unlink(temporaryPath);
          } else {
            await rename(temporaryPath, resolvedPath);
          }
        } catch (error) {
          await unlink(temporaryPath).catch(() => undefined);
          throw error;
        }
        return { ...(before === undefined ? {} : { before }), resolvedPath };
      });
    } catch (error) {
      // Remove only directories created by this call, deepest first, and only
      // while they remain empty. Never recursively remove concurrent content.
      if (firstCreatedParent !== undefined) {
        let candidate = dirname(resolvedPath);
        while (true) {
          const removed = await rmdir(candidate).then(() => true, () => false);
          if (!removed || candidate === firstCreatedParent) break;
          candidate = dirname(candidate);
        }
      }
      throw error;
    }
  }

  async writeText(
    input: Readonly<{ content: string; path: string; precondition: WorkspaceMutationPrecondition }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceWriteTextResult>> {
    const canceled = checkContext(context);
    if (canceled !== undefined) return canceled;
    try {
      const result = await this.atomicWrite(input.path, input.content, input.precondition, context);
      return {
        ok: true,
        data: Object.freeze({
          path: input.path,
          resolvedPath: result.resolvedPath,
          ...(result.before === undefined ? {} : { beforeContentSha256: sha256Text(result.before) }),
          afterContentSha256: sha256Text(input.content),
          length: input.content.length,
        }),
      };
    } catch (error) {
      return exceptionFailure(error);
    }
  }

  async applyPatch(
    input: Readonly<{
      newText: string;
      oldText: string;
      path: string;
      precondition: WorkspaceMutationPrecondition;
      replaceAll?: boolean;
    }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<WorkspaceApplyPatchResult>> {
    const canceled = checkContext(context);
    if (canceled !== undefined) return canceled;
    if (input.oldText.length === 0) return failure("INVALID_INPUT", "Patch oldText must not be empty.");
    if (input.oldText === input.newText) {
      return failure("INVALID_INPUT", "Patch newText must differ from oldText.");
    }
    try {
      const absolutePath = await this.scope.resolveExisting(input.path);
      const before = await readUtf8(absolutePath, context);
      const preconditionError = enforcePrecondition(before, input.precondition);
      if (preconditionError !== undefined) return preconditionError;
      const occurrences = before.split(input.oldText).length - 1;
      if (occurrences === 0 || (occurrences > 1 && input.replaceAll !== true)) {
        return failure(
          "CONFLICT",
          occurrences > 1
            ? "Patch target is ambiguous. Extend oldText with more surrounding lines so it matches exactly one location."
            : "Patch target was not found. Re-read the exact region and copy its bytes verbatim; common causes are CRLF line endings, invisible characters, Unicode normalization differences, or edited content.",
        );
      }
      const after = input.replaceAll === true
        ? before.split(input.oldText).join(input.newText)
        : before.replace(input.oldText, input.newText);
      const writeResult = await this.atomicWrite(input.path, after, input.precondition, context);
      return {
        ok: true,
        data: Object.freeze({
          path: input.path,
          resolvedPath: writeResult.resolvedPath,
          beforeContentSha256: sha256Text(before),
          afterContentSha256: sha256Text(after),
          replacements: input.replaceAll === true ? occurrences : 1,
        }),
      };
    } catch (error) {
      return exceptionFailure(error);
    }
  }

  async mkdir(
    input: Readonly<{ path: string; recursive?: boolean }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<Readonly<{ created: boolean; path: string }>>> {
    const canceled = checkContext(context);
    if (canceled !== undefined) return canceled;
    try {
      const path = await this.scope.resolveForWrite(input.path);
      throwIfBlocked(context);
      let created: boolean;
      if (input.recursive === true) {
        created = await mkdir(path, { recursive: true }).then((createdPath) => createdPath !== undefined);
      } else {
        created = await mkdir(path).then(
          () => true,
          async (error: unknown) => {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
              const existing = await lstat(path);
              if (existing.isDirectory() && !existing.isSymbolicLink()) return false;
            }
            throw error;
          },
        );
      }
      await this.scope.resolveForWrite(input.path);
      return { ok: true, data: Object.freeze({ created, path: input.path }) };
    } catch (error) {
      return exceptionFailure(error);
    }
  }

  async move(
    input: Readonly<{ destinationPath: string; overwrite?: boolean; sourcePath: string }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<Readonly<{ destinationPath: string; sourcePath: string }>>> {
    const canceled = checkContext(context);
    if (canceled !== undefined) return canceled;
    try {
      const source = await this.scope.resolveForDelete(input.sourcePath);
      await lstat(source);
      let destination = await this.scope.resolveForWrite(input.destinationPath);
      await mkdir(dirname(destination), { recursive: true });
      destination = await this.scope.resolveForWrite(input.destinationPath);
      if (input.overwrite !== true && await pathExists(destination)) return failure("ALREADY_EXISTS", "Destination exists.");
      throwIfBlocked(context);
      const verifiedSource = await this.scope.resolveForDelete(input.sourcePath);
      const verifiedDestination = await this.scope.resolveForWrite(input.destinationPath);
      await rename(verifiedSource, verifiedDestination);
      return { ok: true, data: Object.freeze({ sourcePath: input.sourcePath, destinationPath: input.destinationPath }) };
    } catch (error) {
      return exceptionFailure(error);
    }
  }

  async copy(
    input: Readonly<{ destinationPath: string; overwrite?: boolean; sourcePath: string }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<Readonly<{ destinationPath: string; sourcePath: string }>>> {
    const canceled = checkContext(context);
    if (canceled !== undefined) return canceled;
    try {
      const source = await this.scope.resolveExisting(input.sourcePath);
      const sourceInfo = await lstat(source);
      if (!sourceInfo.isFile()) return failure("INVALID_INPUT", "copy requires a regular source file.");
      let destination = await this.scope.resolveForWrite(input.destinationPath);
      await mkdir(dirname(destination), { recursive: true });
      destination = await this.scope.resolveForWrite(input.destinationPath);
      throwIfBlocked(context);
      await copyFile(source, destination, input.overwrite === true ? 0 : fileSystemConstants.COPYFILE_EXCL);
      return { ok: true, data: Object.freeze({ sourcePath: input.sourcePath, destinationPath: input.destinationPath }) };
    } catch (error) {
      return exceptionFailure(error);
    }
  }

  async delete(
    input: Readonly<{ expectedContentSha256?: string; path: string; recursive?: boolean }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<Readonly<{ deleted: boolean; path: string }>>> {
    const canceled = checkContext(context);
    if (canceled !== undefined) return canceled;
    try {
      if (input.expectedContentSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedContentSha256)) {
        return failure("INVALID_INPUT", "Content hash preconditions must be lowercase SHA-256 values.");
      }
      const path = await this.scope.resolveForDelete(input.path);
      const info = await lstat(path);
      if (input.expectedContentSha256 !== undefined) {
        if (!info.isFile() || info.isSymbolicLink()) {
          return failure("INVALID_INPUT", "A content hash precondition requires a regular file.");
        }
        const content = await readFile(path, { signal: context.signal });
        if (createHash("sha256").update(content).digest("hex") !== input.expectedContentSha256) {
          return failure("PRECONDITION_FAILED", "Content hash mismatch.");
        }
      }
      await this.scope.resolveForDelete(input.path);
      throwIfBlocked(context);
      await rm(path, { recursive: input.recursive ?? false, force: false });
      return { ok: true, data: Object.freeze({ deleted: true, path: input.path }) };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return { ok: true, data: Object.freeze({ deleted: false, path: input.path }) };
      }
      return exceptionFailure(error);
    }
  }
}
