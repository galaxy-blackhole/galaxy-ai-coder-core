import {
  portFailure,
  portSuccess,
  type AiCoderResumeWorkspaceVerifier,
  type AiCoderWorkspaceCheckpointSnapshot,
  type PortResult,
  type RunExecutionContext,
} from "../../../index.js";
import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

import { WorkspaceScope } from "./path-scope.js";
import { GENERATED_WORKSPACE_DIRECTORIES, isGeneratedWorkspaceFileName, isGeneratedWorkspacePath } from "./workspace-generated-state.js";

const IGNORED_DIRECTORIES = new Set([
  ".galaxy",
  ".git",
  ...GENERATED_WORKSPACE_DIRECTORIES,
]);
const MAX_ENTRIES = 100_000;
const MAX_BYTES = 512 * 1024 * 1024;

export interface NodeWorkspaceEvidenceVerifierOptions {
  /** Content bytes hashed for authored files. Derived-directory files use metadata. */
  readonly maxHashedBytes?: number;
  readonly maxEntries?: number;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function checkContext(context: RunExecutionContext): void {
  if (context.signal.aborted) throw Object.assign(new Error("Workspace evidence capture was canceled."), { code: "CANCELED" });
  if (Date.now() >= context.deadline) throw Object.assign(new Error("Workspace evidence capture exceeded the run deadline."), { code: "DEADLINE_EXCEEDED" });
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const nativeCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "IO_ERROR";
  const code = nativeCode === "CANCELED"
    ? "CANCELED" as const
    : nativeCode === "DEADLINE_EXCEEDED"
      ? "DEADLINE_EXCEEDED" as const
      : nativeCode === "LIMIT_EXCEEDED"
        ? "LIMIT_EXCEEDED" as const
        : nativeCode === "INVALID_INPUT"
          ? "INVALID_INPUT" as const
          : nativeCode === "PERMISSION_DENIED"
            ? "PERMISSION_DENIED" as const
            : nativeCode === "PRECONDITION_FAILED"
              ? "PRECONDITION_FAILED" as const
              : nativeCode === "NOT_FOUND" || nativeCode === "ENOENT"
                ? "NOT_FOUND" as const
        : "IO_ERROR" as const;
  return portFailure({ code, message, retryable: false });
}

function codedError(code: string, message: string): Error & Readonly<{ code: string }> {
  return Object.assign(new Error(message), { code });
}

function normalizedExpectedHash(value: string): string {
  const match = /^(?:sha256:)?([a-fA-F0-9]{64})$/.exec(value);
  if (match?.[1] === undefined) {
    throw codedError("INVALID_INPUT", "Active file content hashes must be SHA-256 values.");
  }
  return match[1].toLowerCase();
}

function isBelowIgnoredDirectory(path: string): boolean {
  return path.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment));
}

function sameIdentity(
  left: Readonly<{ dev: number; ino: number }>,
  right: Readonly<{ dev: number; ino: number }>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableMetadata(
  left: Readonly<{ ctimeMs: number; mtimeMs: number; size: number }>,
  right: Readonly<{ ctimeMs: number; mtimeMs: number; size: number }>,
): boolean {
  return left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

export class NodeWorkspaceEvidenceVerifier implements AiCoderResumeWorkspaceVerifier {
  readonly consistency = "serialized_workspace" as const;
  private constructor(
    private readonly workspaceRoot: string,
    private readonly scope: WorkspaceScope,
    private readonly maxEntries: number,
    private readonly maxHashedBytes: number,
  ) {}

  static async create(
    workspaceRoot: string,
    options: NodeWorkspaceEvidenceVerifierOptions = {},
  ): Promise<NodeWorkspaceEvidenceVerifier> {
    const maxEntries = options.maxEntries ?? MAX_ENTRIES;
    const maxHashedBytes = options.maxHashedBytes ?? MAX_BYTES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Workspace evidence maxEntries must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maxHashedBytes) || maxHashedBytes < 1) {
      throw new Error("Workspace evidence maxHashedBytes must be a positive safe integer.");
    }
    const canonicalRoot = await realpath(workspaceRoot);
    return new NodeWorkspaceEvidenceVerifier(
      canonicalRoot,
      await WorkspaceScope.create(canonicalRoot),
      maxEntries,
      maxHashedBytes,
    );
  }

  private async fingerprint(
    context: RunExecutionContext,
    activeFiles: AiCoderWorkspaceCheckpointSnapshot["activeFiles"],
  ): Promise<string> {
    const hash = createHash("sha256");
    let entries = 0;
    let bytes = 0;
    const accountEntry = (): void => {
      entries += 1;
      if (entries > this.maxEntries) {
        throw codedError("LIMIT_EXCEEDED", "Workspace evidence exceeded its entry limit.");
      }
    };
    const readStableFile = async (absolutePath: string, workspacePath: string): Promise<Readonly<{
      content: Buffer;
      mode: number;
    }>> => {
      checkContext(context);
      const before = await lstat(absolutePath);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw codedError("INVALID_INPUT", `Workspace evidence expected a regular file: ${workspacePath}.`);
      }
      bytes += before.size;
      if (bytes > this.maxHashedBytes) throw codedError("LIMIT_EXCEEDED", "Workspace evidence exceeded its byte limit.");
      const noFollow = process.platform === "win32" ? 0 : fileConstants.O_NOFOLLOW;
      const handle = await open(absolutePath, fileConstants.O_RDONLY | noFollow);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || !sameIdentity(before, opened)) {
          throw codedError("IO_ERROR", `Workspace file changed during evidence capture: ${workspacePath}.`);
        }
        checkContext(context);
        const content = await handle.readFile();
        checkContext(context);
        const after = await handle.stat();
        if (!after.isFile() || !sameIdentity(opened, after) || !stableMetadata(opened, after)
          || content.byteLength !== opened.size) {
          throw codedError("IO_ERROR", `Workspace file changed during evidence capture: ${workspacePath}.`);
        }
        return Object.freeze({ content, mode: opened.mode });
      } finally {
        await handle.close();
      }
    };
    const visit = async (absoluteDirectory: string): Promise<void> => {
      checkContext(context);
      const children = await readdir(absoluteDirectory, { withFileTypes: true });
      children.sort((left, right) => compareCodeUnits(left.name, right.name));
      for (const child of children) {
        checkContext(context);
        if (child.isDirectory() && IGNORED_DIRECTORIES.has(child.name)) continue;
        if (isGeneratedWorkspaceFileName(child.name)) continue;
        if (child.name.endsWith(".galaxy-code.lock")) continue;
        accountEntry();
        const absolutePath = join(absoluteDirectory, child.name);
        const workspacePath = relative(this.workspaceRoot, absolutePath).split("\\").join("/");
        if (child.isDirectory()) {
          hash.update(`directory\0${workspacePath}\0`);
          await visit(absolutePath);
          continue;
        }
        if (child.isSymbolicLink()) {
          hash.update(`symlink\0${workspacePath}\0${await readlink(absolutePath)}\0`);
          continue;
        }
        if (!child.isFile()) {
          hash.update(`other\0${workspacePath}\0`);
          continue;
        }
        const file = await readStableFile(absolutePath, workspacePath);
        hash.update(`file\0${workspacePath}\0${file.mode}\0${file.content.byteLength}\0`);
        hash.update(file.content);
        hash.update("\0");
      }
    };
    const visitExplicitDirectory = async (absoluteDirectory: string, workspaceDirectory: string): Promise<void> => {
      checkContext(context);
      const children = await readdir(absoluteDirectory, { withFileTypes: true });
      children.sort((left, right) => compareCodeUnits(left.name, right.name));
      for (const child of children) {
        checkContext(context);
        if (isGeneratedWorkspaceFileName(child.name)) continue;
        if (child.name.endsWith(".galaxy-code.lock")) continue;
        accountEntry();
        const absolutePath = join(absoluteDirectory, child.name);
        const workspacePath = `${workspaceDirectory}/${child.name}`.replace(/^\.\//, "");
        if (child.isDirectory()) {
          const canonicalDirectory = await this.scope.resolveExisting(workspacePath);
          hash.update(`active-tree-directory\0${workspacePath}\0`);
          await visitExplicitDirectory(canonicalDirectory, workspacePath);
        } else if (child.isSymbolicLink()) {
          hash.update(`active-tree-symlink\0${workspacePath}\0${await readlink(absolutePath)}\0`);
        } else if (child.isFile()) {
          const canonicalFile = await this.scope.resolveExisting(workspacePath);
          const file = await readStableFile(canonicalFile, workspacePath);
          hash.update(`active-tree-file\0${workspacePath}\0${file.mode}\0${file.content.byteLength}\0`);
          hash.update(file.content);
          hash.update("\0");
        } else {
          hash.update(`active-tree-other\0${workspacePath}\0`);
        }
      }
    };
    const visitDerivedDirectory = async (absoluteDirectory: string, workspaceDirectory: string): Promise<void> => {
      checkContext(context);
      const beforeDirectory = await lstat(absoluteDirectory);
      if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) {
        throw codedError("IO_ERROR", `Derived workspace directory changed during evidence capture: ${workspaceDirectory}.`);
      }
      const children = await readdir(absoluteDirectory, { withFileTypes: true });
      children.sort((left, right) => compareCodeUnits(left.name, right.name));
      for (const child of children) {
        checkContext(context);
        if (child.name.endsWith(".galaxy-code.lock")) continue;
        accountEntry();
        const absolutePath = join(absoluteDirectory, child.name);
        const workspacePath = `${workspaceDirectory}/${child.name}`.replace(/^\.\//, "");
        const before = await lstat(absolutePath);
        if (before.isDirectory() && !before.isSymbolicLink()) {
          const canonicalDirectory = await this.scope.resolveExisting(workspacePath);
          hash.update(`active-derived-directory\0${workspacePath}\0${before.mode}\0${before.dev}\0${before.ino}\0`);
          await visitDerivedDirectory(canonicalDirectory, workspacePath);
          continue;
        }
        if (before.isSymbolicLink()) {
          const target = await readlink(absolutePath);
          const after = await lstat(absolutePath);
          if (!after.isSymbolicLink() || !sameIdentity(before, after) || !stableMetadata(before, after)) {
            throw codedError("IO_ERROR", `Derived workspace symlink changed during evidence capture: ${workspacePath}.`);
          }
          hash.update(`active-derived-symlink\0${workspacePath}\0${target}\0${after.mode}\0${after.mtimeMs}\0${after.ctimeMs}\0`);
          continue;
        }
        const after = await lstat(absolutePath);
        if (!sameIdentity(before, after) || !stableMetadata(before, after)) {
          throw codedError("IO_ERROR", `Derived workspace entry changed during evidence capture: ${workspacePath}.`);
        }
        const kind = after.isFile() ? "file" : "other";
        hash.update(`active-derived-${kind}\0${workspacePath}\0${after.dev}\0${after.ino}\0${after.mode}\0${after.size}\0${after.mtimeMs}\0${after.ctimeMs}\0`);
      }
      const afterDirectory = await lstat(absoluteDirectory);
      if (!afterDirectory.isDirectory() || !sameIdentity(beforeDirectory, afterDirectory)
        || !stableMetadata(beforeDirectory, afterDirectory)) {
        throw codedError("IO_ERROR", `Derived workspace directory changed during evidence capture: ${workspaceDirectory}.`);
      }
    };
    await visit(this.workspaceRoot);
    const sortedActiveFiles = [...activeFiles].sort((left, right) => compareCodeUnits(left.path, right.path));
    for (const activeFile of sortedActiveFiles) {
      checkContext(context);
      const lexicalPath = this.scope.resolveLexical(activeFile.path);
      const workspacePath = relative(this.workspaceRoot, lexicalPath).split("\\").join("/") || ".";
      // Generated paths (build output, tsbuildinfo) must not enter the durable
      // fingerprint even when they were tracked as active paths.
      if (isGeneratedWorkspacePath(workspacePath.split("/"))) continue;
      let pathInfo;
      try {
        pathInfo = await lstat(lexicalPath);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
          if ((activeFile.kind !== undefined && activeFile.kind !== "missing")
            || activeFile.contentHash !== null) {
            throw codedError("PRECONDITION_FAILED", `Active file is missing: ${workspacePath}.`);
          }
          hash.update(`active-missing\0${workspacePath}\0`);
          continue;
        }
        throw error;
      }
      accountEntry();
      if (activeFile.kind === "missing") {
        throw codedError("PRECONDITION_FAILED", `Active path was expected to be missing: ${workspacePath}.`);
      }
      if (pathInfo.isSymbolicLink()) {
        const linkTarget = await readlink(lexicalPath);
        hash.update(`active-symlink\0${workspacePath}\0${linkTarget}\0`);
        if (activeFile.kind !== undefined && activeFile.kind !== "symlink") {
          throw codedError("PRECONDITION_FAILED", `Active path kind changed; expected ${activeFile.kind}, received symlink: ${workspacePath}.`);
        }
        if (activeFile.kind === "symlink") {
          const actualHash = createHash("sha256").update(`symlink\0${linkTarget}`, "utf8").digest("hex");
          if (activeFile.contentHash === null || actualHash !== normalizedExpectedHash(activeFile.contentHash)) {
            throw codedError("PRECONDITION_FAILED", `Active symlink target changed: ${workspacePath}.`);
          }
          continue;
        }
        const canonicalTarget = await this.scope.resolveExisting(activeFile.path);
        const targetInfo = await lstat(canonicalTarget);
        if (targetInfo.isFile()) {
          const file = await readStableFile(canonicalTarget, workspacePath);
          const actualHash = createHash("sha256").update(file.content).digest("hex");
          if (activeFile.contentHash !== null && actualHash !== normalizedExpectedHash(activeFile.contentHash)) {
            throw codedError("PRECONDITION_FAILED", `Active file content hash changed: ${workspacePath}.`);
          }
          hash.update(`active-target-file\0${workspacePath}\0${file.mode}\0${file.content.byteLength}\0`);
          hash.update(file.content);
          hash.update("\0");
        } else if (targetInfo.isDirectory()) {
          if (activeFile.contentHash !== null) {
            throw codedError("INVALID_INPUT", `Active symlink target cannot carry a content hash: ${workspacePath}.`);
          }
          hash.update(`active-target-directory\0${workspacePath}\0`);
          const targetWorkspacePath = relative(this.workspaceRoot, canonicalTarget).split("\\").join("/");
          if (isBelowIgnoredDirectory(targetWorkspacePath)) {
            await visitDerivedDirectory(canonicalTarget, workspacePath);
          } else {
            await visitExplicitDirectory(canonicalTarget, workspacePath);
          }
        } else if (activeFile.contentHash !== null) {
          throw codedError("INVALID_INPUT", `Active symlink target cannot carry a content hash: ${workspacePath}.`);
        }
        continue;
      }
      const canonicalPath = await this.scope.resolveExisting(activeFile.path);
      if (pathInfo.isFile()) {
        if (activeFile.kind !== undefined && activeFile.kind !== "file") {
          throw codedError("PRECONDITION_FAILED", `Active path kind changed; expected ${activeFile.kind}, received file: ${workspacePath}.`);
        }
        const file = await readStableFile(canonicalPath, workspacePath);
        const actualHash = createHash("sha256").update(file.content).digest("hex");
        if (activeFile.contentHash !== null && actualHash !== normalizedExpectedHash(activeFile.contentHash)) {
          throw codedError("PRECONDITION_FAILED", `Active file content hash changed: ${workspacePath}.`);
        }
        hash.update(`active-file\0${workspacePath}\0${file.mode}\0${file.content.byteLength}\0`);
        hash.update(file.content);
        hash.update("\0");
      } else if (pathInfo.isDirectory()) {
        if (activeFile.kind !== undefined && activeFile.kind !== "directory") {
          throw codedError("PRECONDITION_FAILED", `Active path kind changed; expected ${activeFile.kind}, received directory: ${workspacePath}.`);
        }
        if (activeFile.contentHash !== null) {
          throw codedError("INVALID_INPUT", `Active directory cannot carry a content hash: ${workspacePath}.`);
        }
        hash.update(`active-directory\0${workspacePath}\0`);
        if (workspacePath !== "." && isBelowIgnoredDirectory(workspacePath)) {
          await visitDerivedDirectory(canonicalPath, workspacePath);
        }
      } else {
        if (activeFile.kind !== undefined && activeFile.kind !== "other") {
          throw codedError("PRECONDITION_FAILED", `Active path kind changed; expected ${activeFile.kind}, received other: ${workspacePath}.`);
        }
        if (activeFile.kind === "other") {
          const actualHash = createHash("sha256").update(`other\0${String(pathInfo.mode)}`, "utf8").digest("hex");
          if (activeFile.contentHash === null || actualHash !== normalizedExpectedHash(activeFile.contentHash)) {
            throw codedError("PRECONDITION_FAILED", `Active special entry changed: ${workspacePath}.`);
          }
        } else if (activeFile.contentHash !== null) {
          throw codedError("INVALID_INPUT", `Active non-file path cannot carry a content hash: ${workspacePath}.`);
        }
        hash.update(`active-other\0${workspacePath}\0`);
      }
    }
    return `sha256:${hash.digest("hex")}`;
  }

  async capture(
    input: Parameters<AiCoderResumeWorkspaceVerifier["capture"]>[0],
    context: RunExecutionContext,
  ): Promise<PortResult<AiCoderWorkspaceCheckpointSnapshot>> {
    try {
      return portSuccess(Object.freeze({
        activeFiles: Object.freeze(input.activeFiles.map((item) => Object.freeze({ ...item }))),
        dirtyStateSummary: input.dirtyStateSummary,
        stateFingerprint: await this.fingerprint(context, input.activeFiles),
      }));
    } catch (error) {
      return failure(error);
    }
  }

  async verify(
    snapshot: AiCoderWorkspaceCheckpointSnapshot,
    context: RunExecutionContext,
  ): Promise<PortResult<Readonly<{ currentFingerprint: string; matches: boolean }>>> {
    try {
      const currentFingerprint = await this.fingerprint(context, snapshot.activeFiles);
      return portSuccess(Object.freeze({
        currentFingerprint,
        matches: currentFingerprint === snapshot.stateFingerprint,
      }));
    } catch (error) {
      return failure(error);
    }
  }
}
