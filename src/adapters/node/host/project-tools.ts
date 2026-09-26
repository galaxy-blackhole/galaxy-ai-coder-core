import type {
  CommandRunnerPort,
  ToolExecutionContext,
  WorkspaceEntry,
  WorkspaceReaderPort,
} from "../../../ports/index.js";
import { posix } from "node:path";

const MANIFEST_NAMES = new Set([
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "pubspec.yaml",
]);

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".c": "C",
  ".cpp": "C++",
  ".cs": "C#",
  ".dart": "Dart",
  ".go": "Go",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".kt": "Kotlin",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".swift": "Swift",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".vue": "Vue",
});

const DETERMINISTIC_VALIDATION_ENV = Object.freeze({
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONHASHSEED: "0",
});

const VALIDATION_SUMMARY_MAX_CHARACTERS = 2_000;

export const PROJECT_DETECTION_LIMITS = Object.freeze({
  maxDepth: 20,
  maxEntries: 20_000,
  maxPages: 25_000,
  pageSize: 1_000,
  rootManifestMaxBytes: 128_000,
  reportedManifests: 64,
});

export type ProjectCheck = "test" | "typecheck" | "lint" | "build";

export interface DetectedProject {
  readonly projectRoot: string;
  readonly languages: readonly string[];
  readonly packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  readonly manifests: readonly string[];
  readonly commands: Readonly<Record<string, string>>;
  readonly scan: Readonly<{
    readonly complete: boolean;
    readonly deepestDepth: number;
    readonly entriesScanned: number;
    readonly maxDepth: number;
  }>;
  readonly warnings: readonly string[];
}

export interface ProjectValidationResult {
  readonly check: ProjectCheck;
  readonly command?: string;
  readonly status: "passed" | "failed" | "timed_out" | "cancelled" | "skipped";
  readonly exitCode?: number | null;
  readonly summary: string;
}

function extension(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

function projectRelativePath(projectRoot: string, name: string): string {
  const normalized = posix.normalize(projectRoot.replaceAll("\\", "/"));
  return normalized === "." ? name : `${normalized.replace(/^\.\//, "").replace(/\/$/, "")}/${name}`;
}

function traversalScopeWarning(workspace: WorkspaceReaderPort): string | undefined {
  const exclusions = (workspace as WorkspaceReaderPort & Readonly<{
    traversalExclusions?: readonly string[];
  }>).traversalExclusions;
  if (!Array.isArray(exclusions) || exclusions.length === 0) return undefined;
  return `Project scan completeness applies to the host-visible tree; excluded directory names: ${[...exclusions].sort().join(", ")}.`;
}

type ProjectScan = Readonly<{
  entries: readonly WorkspaceEntry[];
  metadata: DetectedProject["scan"];
  warnings: readonly string[];
}>;

function portError(result: Readonly<{ error: Readonly<{ code: string; message: string }> }>): Error {
  return Object.assign(new Error(`${result.error.code}: ${result.error.message}`), { code: result.error.code });
}

async function scanWorkspace(
  workspace: WorkspaceReaderPort,
  path: string,
  context: ToolExecutionContext,
): Promise<ProjectScan> {
  const entries = new Map<string, WorkspaceEntry>();
  const directories: Array<Readonly<{ depth: number; path: string }>> = [{ depth: 0, path }];
  const queuedDirectories = new Set<string>([path]);
  let directoryIndex = 0;
  let deepestDepth = 0;
  let pageCount = 0;
  let adapterLimitReached = false;
  let depthLimitReached = false;
  let entryLimitReached = false;
  let pageLimitReached = false;

  scan: while (directoryIndex < directories.length) {
    const directory = directories[directoryIndex];
    directoryIndex += 1;
    if (directory === undefined) break;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    while (true) {
      if (pageCount >= PROJECT_DETECTION_LIMITS.maxPages) {
        pageLimitReached = true;
        break scan;
      }
      pageCount += 1;
      const result = await workspace.listDir({
        path: directory.path,
        depth: 1,
        limit: PROJECT_DETECTION_LIMITS.pageSize,
        ...(cursor === undefined ? {} : { cursor }),
      }, context);
      if (!result.ok) {
        if (result.error.code === "LIMIT_EXCEEDED") {
          adapterLimitReached = true;
          break;
        }
        throw portError(result);
      }
      for (const entry of result.data.entries) {
        if (entries.has(entry.path)) continue;
        if (entries.size >= PROJECT_DETECTION_LIMITS.maxEntries) {
          entryLimitReached = true;
          break scan;
        }
        entries.set(entry.path, entry);
        const entryDepth = directory.depth + 1;
        deepestDepth = Math.max(deepestDepth, entryDepth);
        if (entry.kind !== "directory") continue;
        if (entryDepth >= PROJECT_DETECTION_LIMITS.maxDepth) {
          depthLimitReached = true;
          continue;
        }
        if (!queuedDirectories.has(entry.path)) {
          queuedDirectories.add(entry.path);
          directories.push(Object.freeze({ depth: entryDepth, path: entry.path }));
        }
      }
      if (!result.data.pagination.hasMore) break;
      const nextCursor = result.data.pagination.nextCursor;
      if (nextCursor === undefined || nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw Object.assign(new Error("Workspace pagination did not make forward progress."), { code: "CONFLICT" });
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  const warnings: string[] = [];
  if (adapterLimitReached) warnings.push("The workspace adapter limit prevented a complete project scan.");
  if (depthLimitReached) {
    warnings.push(`The project scan reached its maximum depth of ${PROJECT_DETECTION_LIMITS.maxDepth}; deeper entries were not inspected.`);
  }
  if (entryLimitReached) {
    warnings.push(`The project scan reached its limit of ${PROJECT_DETECTION_LIMITS.maxEntries} entries; remaining entries were not inspected.`);
  }
  if (pageLimitReached) {
    warnings.push(`The project scan reached its limit of ${PROJECT_DETECTION_LIMITS.maxPages} pages; remaining entries were not inspected.`);
  }
  return Object.freeze({
    entries: Object.freeze([...entries.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    metadata: Object.freeze({
      complete: warnings.length === 0,
      deepestDepth,
      entriesScanned: entries.size,
      maxDepth: PROJECT_DETECTION_LIMITS.maxDepth,
    }),
    warnings: Object.freeze(warnings),
  });
}

async function packageScripts(
  workspace: WorkspaceReaderPort,
  packageJsonPath: string,
  context: ToolExecutionContext,
): Promise<Readonly<{ commands: Readonly<Record<string, string>>; warnings: readonly string[] }>> {
  const result = await workspace.readText({ path: packageJsonPath, maxBytes: PROJECT_DETECTION_LIMITS.rootManifestMaxBytes }, context);
  if (!result.ok) {
    throw portError(result);
  }
  if (result.data.truncated || result.data.pagination.hasMore) {
    return Object.freeze({
      commands: Object.freeze({}),
      warnings: Object.freeze([
        `Root manifest '${packageJsonPath}' exceeds ${PROJECT_DETECTION_LIMITS.rootManifestMaxBytes} readable bytes; scripts were not parsed.`,
      ]),
    });
  }
  try {
    const parsed = JSON.parse(result.data.content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return Object.freeze({
        commands: Object.freeze({}),
        warnings: Object.freeze([`Root manifest '${packageJsonPath}' must contain a JSON object; scripts were not parsed.`]),
      });
    }
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (scripts === undefined) return Object.freeze({ commands: Object.freeze({}), warnings: Object.freeze([]) });
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
      return Object.freeze({
        commands: Object.freeze({}),
        warnings: Object.freeze([`Root manifest '${packageJsonPath}' has a non-object 'scripts' field; scripts were not parsed.`]),
      });
    }
    const entries = Object.entries(scripts);
    const commands = Object.fromEntries(
      entries
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    );
    const warnings = entries.some(([, value]) => typeof value !== "string")
      ? Object.freeze([`Root manifest '${packageJsonPath}' contains non-string scripts; those entries were ignored.`])
      : Object.freeze([]);
    return Object.freeze({ commands: Object.freeze(commands), warnings });
  } catch {
    return Object.freeze({
      commands: Object.freeze({}),
      warnings: Object.freeze([`Root manifest '${packageJsonPath}' is not valid JSON; scripts were not parsed.`]),
    });
  }
}

async function existingRootFiles(
  workspace: WorkspaceReaderPort,
  projectRoot: string,
  names: readonly string[],
  context: ToolExecutionContext,
): Promise<ReadonlySet<string>> {
  const paths = new Set<string>();
  for (const name of names) {
    const candidate = projectRelativePath(projectRoot, name);
    const result = await workspace.stat({ path: candidate }, context);
    if (!result.ok) throw portError(result);
    if (result.data.kind === "file") paths.add(candidate);
  }
  return paths;
}

export async function detectProject(
  workspace: WorkspaceReaderPort,
  path: string,
  context: ToolExecutionContext,
): Promise<DetectedProject> {
  const scan = await scanWorkspace(workspace, path, context);
  const filePaths = scan.entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path);
  const exactRootFiles = await existingRootFiles(
    workspace,
    path,
    Object.freeze([...MANIFEST_NAMES, "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]),
    context,
  );
  const allManifests = [...new Set([
    ...filePaths.filter((entry) => MANIFEST_NAMES.has(entry.split("/").at(-1) ?? "")),
    ...[...exactRootFiles].filter((entry) => MANIFEST_NAMES.has(entry.split("/").at(-1) ?? "")),
  ])].sort();
  const manifests = allManifests.slice(0, PROJECT_DETECTION_LIMITS.reportedManifests);
  const languageSet = new Set<string>();
  for (const entry of filePaths) {
    const language = LANGUAGE_BY_EXTENSION[extension(entry)];
    if (language !== undefined) languageSet.add(language);
  }
  const packageJsonPath = projectRelativePath(path, "package.json");
  const manifest = !exactRootFiles.has(packageJsonPath)
    ? undefined
    : await packageScripts(workspace, packageJsonPath, context);
  const commands = manifest?.commands ?? Object.freeze({});
  const packageManager = exactRootFiles.has(projectRelativePath(path, "pnpm-lock.yaml"))
    ? "pnpm" as const
    : exactRootFiles.has(projectRelativePath(path, "yarn.lock"))
      ? "yarn" as const
      : exactRootFiles.has(projectRelativePath(path, "bun.lock")) || exactRootFiles.has(projectRelativePath(path, "bun.lockb"))
        ? "bun" as const
        : exactRootFiles.has(packageJsonPath)
          ? "npm" as const
          : undefined;
  const scopeWarning = traversalScopeWarning(workspace);
  const warnings = [
    ...scan.warnings,
    ...(scopeWarning === undefined ? [] : [scopeWarning]),
    ...(manifest?.warnings ?? []),
    ...(allManifests.length > manifests.length
      ? [`Detected ${allManifests.length} manifests; only the first ${PROJECT_DETECTION_LIMITS.reportedManifests} were reported.`]
      : []),
  ];
  return Object.freeze({
    projectRoot: path,
    languages: Object.freeze([...languageSet].sort()),
    manifests: Object.freeze(manifests),
    commands,
    scan: scan.metadata,
    warnings: Object.freeze([...new Set(warnings)]),
    ...(packageManager === undefined ? {} : { packageManager }),
  });
}

function commandForCheck(manager: NonNullable<DetectedProject["packageManager"]>, check: ProjectCheck): string {
  if (manager === "npm") return `npm run ${check}`;
  if (manager === "yarn") return `yarn ${check}`;
  if (manager === "pnpm") return `pnpm run ${check}`;
  return `bun run ${check}`;
}

function validationDiagnostic(
  run: Readonly<{
    stderr: string;
    stderrTruncated: boolean;
    stdout: string;
    stdoutTruncated: boolean;
  }>,
): string {
  const streams = [
    { label: "stdout", text: run.stdout.trim(), truncated: run.stdoutTruncated },
    { label: "stderr", text: run.stderr.trim(), truncated: run.stderrTruncated },
  ].filter((stream) => stream.text.length > 0 || stream.truncated);
  if (streams.length === 0) return "";
  if (streams.length === 1 && streams[0] !== undefined && !streams[0].truncated) {
    return streams[0].text.slice(-VALIDATION_SUMMARY_MAX_CHARACTERS);
  }
  const labels = streams.map((stream) => `[${stream.label}${stream.truncated ? " truncated" : ""}]\n`);
  const separators = Math.max(0, streams.length - 1);
  const contentBudget = Math.max(1, Math.floor(
    (VALIDATION_SUMMARY_MAX_CHARACTERS - labels.reduce((sum, label) => sum + label.length, 0) - separators)
      / streams.length,
  ));
  return streams.map((stream, index) => `${labels[index]}${stream.text.slice(-contentBudget)}`)
    .join("\n")
    .slice(-VALIDATION_SUMMARY_MAX_CHARACTERS);
}

export async function validateProject(
  workspace: WorkspaceReaderPort,
  commandPort: CommandRunnerPort,
  input: Readonly<{ checks: readonly ProjectCheck[]; path: string; timeoutMs?: number }>,
  context: ToolExecutionContext,
): Promise<Readonly<{ cancelled: boolean; passed: boolean; results: readonly ProjectValidationResult[] }>> {
  const checks = [...new Set(input.checks)];
  const results: ProjectValidationResult[] = [];
  const terminalResults = (
    status: "cancelled" | "timed_out",
    summary: string,
  ): Readonly<{ cancelled: boolean; passed: boolean; results: readonly ProjectValidationResult[] }> => Object.freeze({
    cancelled: status === "cancelled",
    passed: false,
    results: Object.freeze(checks.map((check) => Object.freeze({ check, status, summary }))),
  });
  if (context.signal.aborted) return terminalResults("cancelled", "Run canceled before project detection.");
  if (Date.now() >= context.deadline) return terminalResults("timed_out", "Run deadline elapsed before project detection.");
  let project: DetectedProject;
  try {
    project = await detectProject(workspace, input.path, context);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "CANCELED") return terminalResults("cancelled", "Run canceled during project detection.");
    if (code === "DEADLINE_EXCEEDED") return terminalResults("timed_out", "Run deadline elapsed during project detection.");
    // Models sometimes pass a file path (the artifact they just created) instead
    // of a project directory. That is a scoping mistake, not an unknown side
    // effect: fall back to the workspace root instead of failing the run.
    if (code === "INVALID_INPUT") {
      project = await detectProject(workspace, ".", context);
    } else throw error;
  }
  for (const check of checks) {
    if (context.signal.aborted) {
      results.push(Object.freeze({ check, status: "cancelled", summary: "Run canceled before check started." }));
      continue;
    }
    if (Date.now() >= context.deadline) {
      results.push(Object.freeze({ check, status: "timed_out", summary: "Run deadline elapsed before check started." }));
      continue;
    }
    if (project.packageManager === undefined || project.commands[check] === undefined) {
      results.push(Object.freeze({ check, status: "skipped", summary: `No '${check}' script was detected.` }));
      continue;
    }
    const command = commandForCheck(project.packageManager, check);
    const run = await commandPort.run({
      command,
      cwd: input.path,
      env: DETERMINISTIC_VALIDATION_ENV,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }, context);
    if (!run.ok) {
      const status: ProjectValidationResult["status"] = run.error.code === "CANCELED"
        ? "cancelled"
        : run.error.code === "DEADLINE_EXCEEDED"
          ? "timed_out"
          : "failed";
      results.push(Object.freeze({ check, command, status, summary: `${run.error.code}: ${run.error.message}` }));
      continue;
    }
    const status: ProjectValidationResult["status"] = run.data.status === "canceled"
      ? "cancelled"
      : run.data.status === "timed_out"
        ? "timed_out"
        : run.data.exitCode === 0
          ? "passed"
          : "failed";
    const diagnostic = validationDiagnostic(run.data);
    results.push(Object.freeze({
      check,
      command,
      status,
      exitCode: run.data.exitCode,
      summary: diagnostic || `${check} ${status}.`,
    }));
  }
  return Object.freeze({
    results: Object.freeze(results),
    cancelled: results.some((result) => result.status === "cancelled"),
    passed: results.length > 0 && results.every((result) => result.status === "passed" || result.status === "skipped"),
  });
}
