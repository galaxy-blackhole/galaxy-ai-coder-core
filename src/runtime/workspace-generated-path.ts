/**
 * Shared generated-state policy.
 *
 * A path is generated state when it is build output, an installed dependency
 * tree, or a tool/editor cache rather than authored source. The Node workspace
 * snapshotter (which decides durable `write` evidence) and the workspace
 * evidence verifier (which decides the resume/final workspace fingerprint)
 * must agree on this boundary.
 *
 * The snapshotter deliberately keeps build/output directories (dist, build,
 * coverage, out) `durable` so `run_command` can still attest the file
 * mutations it performed; the runtime filters these paths out of *authored*
 * evidence and progress below, so regenerating build output never resets the
 * no-progress budget.
 */

/** Generated directory basenames. Any path segment equal to one of these marks the subtree. */
export const GENERATED_WORKSPACE_DIRECTORIES: readonly string[] = Object.freeze([
  ".galaxy",
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

/** Generated file suffixes: incremental build metadata and run logs, never authored source. */
export const GENERATED_WORKSPACE_FILE_SUFFIXES: readonly string[] = Object.freeze([
  ".log",
  ".tsbuildinfo",
]);

/**
 * Churning files: a detached process keeps writing them for as long as it runs (a dev server, a
 * watcher, a probe loop). They are not authored source and they cannot be hashed reliably — reading
 * one races its writer.
 *
 * Measured: `nohup bun run dev > .dev-frontend.log` inside the workspace made the workspace evidence
 * capture fail in the 2026-10-02 gymflow run ("Active file content hash changed: .dev-frontend.log"),
 * which killed a step whose work was already on disk (24/25 instead of 25/25).
 */
export const CHURNING_WORKSPACE_FILE_SUFFIXES: readonly string[] = Object.freeze([
  ".log",
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

export function isChurningWorkspaceFileName(name: string): boolean {
  return CHURNING_WORKSPACE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * True when the leaf is a churning file. Only the leaf counts: a pinned file inside `dist/` is
 * generated but never churning, and the evidence verifier still tracks it (host conformance).
 */
export function isChurningWorkspacePath(segments: readonly string[]): boolean {
  const leaf = segments[segments.length - 1];
  return leaf !== undefined && isChurningWorkspaceFileName(leaf);
}

/** True when any path segment is a generated directory, or the leaf is a generated file. */
export function isGeneratedWorkspacePath(segments: readonly string[]): boolean {
  if (segments.some((segment) => DIRECTORY_NAMES.has(segment))) return true;
  const leaf = segments[segments.length - 1];
  return leaf !== undefined && isGeneratedWorkspaceFileName(leaf);
}
