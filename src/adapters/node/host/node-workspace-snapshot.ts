import type { AiCoderWorkspaceEntryKind, RunExecutionContext } from "../../../index.js";
import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import { WorkspaceScope } from "./path-scope.js";

const MAX_ENTRIES = 100_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_DURABLE_MUTATIONS = 10_000;
const READ_BUFFER_BYTES = 64 * 1024;
const DIRECTORY_HASH = createHash("sha256").update("directory\0", "utf8").digest("hex");

export type NodeWorkspaceSnapshotEntry = Readonly<{
  /** Opaque value used only to compare two snapshots captured by this host. */
  comparisonFingerprint: string;
  /** Only durable entries may cross the core evidence boundary as writes. */
  evidenceClass: "derived" | "durable";
  kind: "directory" | "file" | "other" | "symlink";
  path: string;
}>;

export type NodeWorkspaceSnapshot = Readonly<{
  entries: readonly NodeWorkspaceSnapshotEntry[];
  stateVersion: string;
}>;

export type NodeWorkspaceSnapshotOptions = Readonly<{
  /**
   * Entries under these workspace-relative directories are generated state.
   * The snapshotter detects their mutations using stable identity/metadata,
   * but never presents those opaque fingerprints as durable content hashes.
   */
  derivedDirectories?: readonly string[];
  /** Defaults to the production 512 MiB content-hash budget. */
  maxHashedBytes?: number;
}>;

/**
 * Shared policy for repositories whose installed dependency tree and generated
 * build caches are much larger than authored sources. Derived entries keep
 * stable fingerprint coverage without consuming the durable content-hash
 * budget, and their mutations never enter authored oracle evidence.
 */
export const DEPENDENCY_AWARE_WORKSPACE_SNAPSHOT_OPTIONS: NodeWorkspaceSnapshotOptions = Object.freeze({
  derivedDirectories: Object.freeze([
    ".cache",
    ".gradle",
    ".mypy_cache",
    ".next",
    ".parcel-cache",
    ".pytest_cache",
    ".bun-cache",
    ".turbo",
    ".vite",
    "__pycache__",
    "node_modules",
    "target",
  ]),
});

export type NodeWorkspaceObservedMutation = Readonly<{
  afterFingerprint: string | null;
  afterKind: AiCoderWorkspaceEntryKind;
  beforeFingerprint: string | null;
  beforeKind: AiCoderWorkspaceEntryKind;
  evidenceClass: "derived" | "durable";
  path: string;
}>;

export type NodeWorkspaceMutationDiff = Readonly<{
  /** All independently observed mutations, including generated dependency state. */
  observedMutations: readonly NodeWorkspaceObservedMutation[];
  stateVersion: string;
  /** Byte-verifiable authored mutations safe to pass to AI Coder core. */
  writes: readonly Readonly<{
    afterHash: string | null;
    afterKind: AiCoderWorkspaceEntryKind;
    beforeHash: string | null;
    beforeKind: AiCoderWorkspaceEntryKind;
    path: string;
  }>[];
}>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function codedError(code: string, message: string): Error & Readonly<{ code: string }> {
  return Object.assign(new Error(message), { code });
}

function checkContext(context: RunExecutionContext): void {
  if (context.signal.aborted) {
    throw codedError("CANCELED", "Workspace mutation snapshot was canceled.");
  }
  if (Date.now() >= context.deadline) {
    throw codedError("DEADLINE_EXCEEDED", "Workspace mutation snapshot exceeded the run deadline.");
  }
}

function isExcludedName(name: string): boolean {
  return name === ".git" || name.endsWith(".galaxy-code.lock");
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

function metadataHash(info: Readonly<{
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  size: number;
}>): string {
  return createHash("sha256").update(JSON.stringify([
    "file-metadata-v1", info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs,
  ])).digest("hex");
}

function workspacePath(segments: readonly string[]): string {
  return segments.join("/");
}

function snapshotVersion(entries: readonly NodeWorkspaceSnapshotEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(JSON.stringify([entry.path, entry.kind, entry.evidenceClass, entry.comparisonFingerprint]));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

export class NodeWorkspaceSnapshotter {
  private readonly derivedDirectories: ReadonlySet<string>;
  private readonly maxHashedBytes: number;

  private constructor(private readonly scope: WorkspaceScope, options: NodeWorkspaceSnapshotOptions) {
    this.derivedDirectories = new Set(options.derivedDirectories ?? []);
    this.maxHashedBytes = options.maxHashedBytes ?? MAX_BYTES;
  }

  static async create(
    workspaceRoot: string,
    options: NodeWorkspaceSnapshotOptions = {},
  ): Promise<NodeWorkspaceSnapshotter> {
    for (const path of options.derivedDirectories ?? []) {
      if (!path || path === "." || path.includes("\\") || path.startsWith("/")
        || path.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error(`Invalid derived workspace directory: ${path || "<empty>"}.`);
      }
    }
    if (!Number.isSafeInteger(options.maxHashedBytes ?? MAX_BYTES) || (options.maxHashedBytes ?? MAX_BYTES) < 1) {
      throw new Error("Workspace snapshot maxHashedBytes must be a positive safe integer.");
    }
    return new NodeWorkspaceSnapshotter(await WorkspaceScope.create(workspaceRoot), options);
  }

  async capture(context: RunExecutionContext): Promise<NodeWorkspaceSnapshot> {
    const entries: NodeWorkspaceSnapshotEntry[] = [];
    let entryCount = 0;
    let byteCount = 0;

    const accountEntry = (): void => {
      entryCount += 1;
      if (entryCount > MAX_ENTRIES) {
        throw codedError("LIMIT_EXCEEDED", "Workspace mutation snapshot exceeded its entry limit.");
      }
    };

    const readStableFileHash = async (
      absolutePath: string,
      relativePath: string,
      derived: boolean,
    ): Promise<string> => {
      checkContext(context);
      const before = await lstat(absolutePath);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw codedError("CONFLICT", `Workspace path changed while taking a mutation snapshot: ${relativePath}.`);
      }
      const canonicalPath = await this.scope.resolveExisting(relativePath);
      if (canonicalPath !== absolutePath) {
        throw codedError("PERMISSION_DENIED", `Workspace snapshot cannot follow a symlink: ${relativePath}.`);
      }
      if (derived) {
        const after = await lstat(absolutePath);
        if (!after.isFile() || !sameIdentity(before, after) || !stableMetadata(before, after)) {
          throw codedError("CONFLICT", `Workspace file changed while taking a mutation snapshot: ${relativePath}.`);
        }
        return metadataHash(after);
      }
      byteCount += before.size;
      if (byteCount > this.maxHashedBytes) {
        throw codedError("LIMIT_EXCEEDED", "Workspace mutation snapshot exceeded its byte limit.");
      }

      const noFollow = process.platform === "win32" ? 0 : fileConstants.O_NOFOLLOW;
      const handle = await open(absolutePath, fileConstants.O_RDONLY | noFollow);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || !sameIdentity(before, opened)) {
          throw codedError("CONFLICT", `Workspace file changed while taking a mutation snapshot: ${relativePath}.`);
        }
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
        let position = 0;
        while (position < opened.size) {
          checkContext(context);
          const length = Math.min(buffer.byteLength, opened.size - position);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          if (bytesRead === 0) {
            throw codedError("CONFLICT", `Workspace file changed while taking a mutation snapshot: ${relativePath}.`);
          }
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        const after = await handle.stat();
        if (!after.isFile() || !sameIdentity(opened, after) || !stableMetadata(opened, after)) {
          throw codedError("CONFLICT", `Workspace file changed while taking a mutation snapshot: ${relativePath}.`);
        }
        return hash.digest("hex");
      } finally {
        await handle.close();
      }
    };

    const visitDirectory = async (
      absoluteDirectory: string,
      segments: readonly string[],
      inheritedDerived = false,
    ): Promise<void> => {
      checkContext(context);
      const relativeDirectory = workspacePath(segments) || ".";
      const before = await lstat(absoluteDirectory);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw codedError("CONFLICT", `Workspace directory changed while taking a mutation snapshot: ${relativeDirectory}.`);
      }
      if (segments.length > 0) {
        const canonicalDirectory = await this.scope.resolveExisting(relativeDirectory);
        if (canonicalDirectory !== absoluteDirectory) {
          throw codedError("PERMISSION_DENIED", `Workspace snapshot cannot follow a directory symlink: ${relativeDirectory}.`);
        }
      }
      const names = await readdir(absoluteDirectory);
      names.sort(compareCodeUnits);
      for (const name of names) {
        checkContext(context);
        if (isExcludedName(name)) continue;
        accountEntry();
        const childSegments = Object.freeze([...segments, name]);
        const relativePath = workspacePath(childSegments);
        const derived = inheritedDerived || childSegments.some((segment) => this.derivedDirectories.has(segment));
        const absolutePath = join(absoluteDirectory, name);
        const info = await lstat(absolutePath);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          entries.push(Object.freeze({
            comparisonFingerprint: DIRECTORY_HASH,
            evidenceClass: derived ? "derived" : "durable",
            kind: "directory",
            path: relativePath,
          }));
          await visitDirectory(absolutePath, childSegments, derived);
          continue;
        }
        if (info.isSymbolicLink()) {
          const target = await readlink(absolutePath);
          const after = await lstat(absolutePath);
          if (!after.isSymbolicLink() || !sameIdentity(info, after) || !stableMetadata(info, after)) {
            throw codedError("CONFLICT", `Workspace symlink changed while taking a mutation snapshot: ${relativePath}.`);
          }
          entries.push(Object.freeze({
            comparisonFingerprint: createHash("sha256").update(`symlink\0${target}`, "utf8").digest("hex"),
            evidenceClass: derived ? "derived" : "durable",
            kind: "symlink",
            path: relativePath,
          }));
          continue;
        }
        if (info.isFile()) {
          entries.push(Object.freeze({
            comparisonFingerprint: await readStableFileHash(absolutePath, relativePath, derived),
            evidenceClass: derived ? "derived" : "durable",
            kind: "file",
            path: relativePath,
          }));
          continue;
        }
        const after = await lstat(absolutePath);
        if (!sameIdentity(info, after) || !stableMetadata(info, after)) {
          throw codedError("CONFLICT", `Workspace entry changed while taking a mutation snapshot: ${relativePath}.`);
        }
        entries.push(Object.freeze({
          comparisonFingerprint: createHash("sha256").update(`other\0${String(info.mode)}`, "utf8").digest("hex"),
          evidenceClass: derived ? "derived" : "durable",
          kind: "other",
          path: relativePath,
        }));
      }
      const after = await lstat(absoluteDirectory);
      if (!after.isDirectory() || !sameIdentity(before, after) || !stableMetadata(before, after)) {
        throw codedError("CONFLICT", `Workspace directory changed while taking a mutation snapshot: ${relativeDirectory}.`);
      }
    };

    await visitDirectory(this.scope.root, Object.freeze([]));
    entries.sort((left, right) => compareCodeUnits(left.path, right.path));
    const frozenEntries = Object.freeze(entries);
    return Object.freeze({
      entries: frozenEntries,
      stateVersion: snapshotVersion(frozenEntries),
    });
  }
}

export function diffNodeWorkspaceSnapshots(
  before: NodeWorkspaceSnapshot,
  after: NodeWorkspaceSnapshot,
): NodeWorkspaceMutationDiff {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort(compareCodeUnits);
  const observedMutations = paths.flatMap((path) => {
    const beforeEntry = beforeByPath.get(path);
    const afterEntry = afterByPath.get(path);
    if (beforeEntry?.kind === afterEntry?.kind
      && beforeEntry?.comparisonFingerprint === afterEntry?.comparisonFingerprint) return [];
    if (beforeEntry !== undefined && afterEntry !== undefined
      && beforeEntry.evidenceClass !== afterEntry.evidenceClass) {
      throw codedError("INVALID_INPUT", `Workspace snapshot evidence class changed for: ${path}.`);
    }
    const beforeKind = beforeEntry?.kind ?? "missing";
    const afterKind = afterEntry?.kind ?? "missing";
    return [Object.freeze({
      afterFingerprint: afterKind === "missing" ? null : afterEntry?.comparisonFingerprint ?? null,
      afterKind,
      beforeFingerprint: beforeKind === "missing" ? null : beforeEntry?.comparisonFingerprint ?? null,
      beforeKind,
      evidenceClass: beforeEntry?.evidenceClass ?? afterEntry?.evidenceClass ?? "durable",
      path,
    })];
  });
  const writes = observedMutations.flatMap((mutation) => mutation.evidenceClass === "derived" ? [] : [Object.freeze({
    afterHash: mutation.afterKind === "directory" || mutation.afterKind === "missing"
      ? null
      : mutation.afterFingerprint,
    afterKind: mutation.afterKind,
    beforeHash: mutation.beforeKind === "directory" || mutation.beforeKind === "missing"
      ? null
      : mutation.beforeFingerprint,
    beforeKind: mutation.beforeKind,
    path: mutation.path,
  })]);
  if (writes.length > MAX_DURABLE_MUTATIONS) {
    throw codedError(
      "LIMIT_EXCEEDED",
      `Workspace mutation diff exceeded ${MAX_DURABLE_MUTATIONS} durable changed paths.`,
    );
  }
  return Object.freeze({
    observedMutations: Object.freeze(observedMutations),
    stateVersion: after.stateVersion,
    writes: Object.freeze(writes),
  });
}
