/**
 * Shared generated-state policy for the Node workspace host.
 *
 * A path is generated state when it is build output, an installed dependency
 * tree, or a tool/editor cache rather than authored source. The mutation
 * snapshotter (which decides durable `write` evidence) and the workspace
 * evidence verifier (which decides the resume/final workspace fingerprint)
 * must agree on this boundary. When they disagree, one side records a durable
 * write while the other omits it from the fingerprint, so the completion gate
 * can never be satisfied and the run grinds to `maxTurns`.
 */

/** Generated directory basenames. Any path segment equal to one of these marks the subtree. */
export const GENERATED_WORKSPACE_DIRECTORIES: readonly string[] = Object.freeze([
  ".bun-cache",
  ".cache",
  ".gradle",
  ".mypy_cache",
  ".next",
  ".parcel-cache",
  ".pytest_cache",
  ".turbo",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

/** Generated file suffixes: incremental build metadata, never authored source. */
export const GENERATED_WORKSPACE_FILE_SUFFIXES: readonly string[] = Object.freeze([
  ".tsbuildinfo",
]);

/** Generated file basenames. */
export const GENERATED_WORKSPACE_FILE_NAMES: readonly string[] = Object.freeze([
  ".DS_Store",
  ".eslintcache",
]);

const DIRECTORY_NAMES = new Set(GENERATED_WORKSPACE_DIRECTORIES);
const FILE_NAMES = new Set(GENERATED_WORKSPACE_FILE_NAMES);

export function isGeneratedWorkspaceDirectoryName(name: string): boolean {
  return DIRECTORY_NAMES.has(name);
}

export function isGeneratedWorkspaceFileName(name: string): boolean {
  return FILE_NAMES.has(name)
    || GENERATED_WORKSPACE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** True when any path segment is a generated directory, or the leaf is a generated file. */
export function isGeneratedWorkspacePath(segments: readonly string[]): boolean {
  if (segments.some((segment) => DIRECTORY_NAMES.has(segment))) return true;
  const leaf = segments[segments.length - 1];
  return leaf !== undefined && isGeneratedWorkspaceFileName(leaf);
}
