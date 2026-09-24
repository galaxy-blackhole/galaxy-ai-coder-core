import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function isInside(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance === "" || (!distance.startsWith(`..${sep}`) && distance !== ".." && !isAbsolute(distance));
}

function scopeError(
  code: "INVALID_INPUT" | "PERMISSION_DENIED",
  message: string,
): Error & Readonly<{ code: "INVALID_INPUT" | "PERMISSION_DENIED" }> {
  return Object.assign(new Error(message), { code });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export class WorkspaceScope {
  private constructor(readonly root: string) {}

  static async create(rootPath: string): Promise<WorkspaceScope> {
    const absoluteRoot = await realpath(resolve(rootPath));
    const rootInfo = await lstat(absoluteRoot);
    if (!rootInfo.isDirectory()) {
      throw new Error(`Workspace root '${absoluteRoot}' is not a directory.`);
    }
    return new WorkspaceScope(absoluteRoot);
  }

  resolveLexical(relativePath: string): string {
    if (relativePath.includes("\0")) throw scopeError("INVALID_INPUT", "Workspace path contains a null byte.");
    if (isAbsolute(relativePath)) throw scopeError("PERMISSION_DENIED", "Workspace paths must be relative.");
    const candidate = resolve(this.root, relativePath || ".");
    if (!isInside(this.root, candidate)) {
      throw scopeError("PERMISSION_DENIED", `Workspace path escapes the configured root: '${relativePath}'.`);
    }
    return candidate;
  }

  async resolveExisting(relativePath: string): Promise<string> {
    const candidate = this.resolveLexical(relativePath);
    const canonical = await realpath(candidate);
    if (!isInside(this.root, canonical)) {
      throw scopeError("PERMISSION_DENIED", `Workspace symlink escapes the configured root: '${relativePath}'.`);
    }
    return canonical;
  }

  /**
   * Resolve a mutation target without following symlinks. Existing symlink
   * components are rejected so copy/write cannot be redirected after lexical
   * scope validation. Call this again immediately before committing a write.
   */
  async resolveForWrite(relativePath: string): Promise<string> {
    return this.resolveMutationPath(relativePath, false);
  }

  /** Resolve an existing removal/move source while permitting the final link itself. */
  async resolveForDelete(relativePath: string): Promise<string> {
    return this.resolveMutationPath(relativePath, true);
  }

  private async resolveMutationPath(
    relativePath: string,
    allowFinalSymlink: boolean,
  ): Promise<string> {
    const candidate = this.resolveLexical(relativePath);
    if (candidate === this.root) {
      throw scopeError("PERMISSION_DENIED", "Mutating the workspace root is not allowed.");
    }
    const distance = relative(this.root, candidate);
    const segments = distance.split(sep).filter((segment) => segment.length > 0);
    let current = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      current = join(current, segment);
      try {
        const info = await lstat(current);
        const isFinal = index === segments.length - 1;
        if (info.isSymbolicLink() && !(allowFinalSymlink && isFinal)) {
          throw scopeError(
            "PERMISSION_DENIED",
            `Workspace mutation cannot follow symlink '${relativePath}'.`,
          );
        }
        if (!isFinal && !info.isDirectory()) {
          throw scopeError(
            "INVALID_INPUT",
            `Workspace mutation parent is not a directory: '${relativePath}'.`,
          );
        }
      } catch (error) {
        if (isMissing(error)) return candidate;
        throw error;
      }
    }
    return candidate;
  }
}
