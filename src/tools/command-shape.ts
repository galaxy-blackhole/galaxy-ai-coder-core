/**
 * Long-running server and watcher commands: recognising them lets the host warn
 * the model that they are supervision cost rather than validation evidence.
 */
const SERVER_COMMAND = /(?:^|[;&|]\s*)(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|serve|start|watch)\b|(?:^|[\s;&|])(?:[^\s;&|]*\/)?(?:vite|nodemon|webpack-dev-server)\b(?![\w./@-])(?!\s+build)|(?:^|[\s;&|])next\s+dev\b|(?:^|\s)--watch\b/;

/** `bun create vite` scaffolds a project; the same word as a runner starts a server. */
const PACKAGE_SCAFFOLD_INVOCATION = /(?:^|[;&|]\s*)(?:bun|bunx|npx|npm|pnpm|yarn)\s+(?:create|init|add|install|i|remove|update|link|dlx\s+create)\b/;

export function looksLikeLongRunningServer(command: string): boolean {
  const trimmed = command.trim();
  if (PACKAGE_SCAFFOLD_INVOCATION.test(trimmed)) return false;
  return SERVER_COMMAND.test(trimmed);
}

/**
 * Advisory appended to a command result. A backgrounded server returns exit code
 * 0 immediately, so without this note a headless run can spend its whole turn
 * budget probing ports (observed in the gymflow E2E).
 */
/** A whole-project check run through the shell instead of validate_project. */
const PROJECT_CHECK_COMMAND = /(?:^|[;&|]\s*)(?:(?:npm|bun|bunx|npx|pnpx|pnpm|yarn)\s+(?:run\s+|exec\s+|dlx\s+)?(?:test|typecheck|lint|build|tsc|eslint|vitest|jest)\b|(?:[^\s;&|]*\/)?(?:tsc|eslint|vitest|jest)\b)/;
/** A named file means the model is diagnosing one target, not running the project check. */
const TARGETED_CHECK_ARGUMENT = /(?:\.(?:test|spec)\.[A-Za-z]+\b|(?:^|\s)[\w.-]*\/[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte)\b)/;

/**
 * A declared project check is only trusted evidence when it runs through
 * validate_project; the shell equivalent costs a turn and grants nothing (3 such
 * commands appeared in one gymflow E2E step that also called validate_project 12
 * times). Targeted single-file runs are diagnostics and stay advisory-free.
 */
/** The declared check a shell command runs, so the advisory can name it exactly. */
function declaredCheck(command: string): "build" | "lint" | "test" | "typecheck" {
  if (/\btsc\b|\btypecheck\b/.test(command)) return "typecheck";
  if (/\beslint\b|\blint\b/.test(command)) return "lint";
  if (/\b(?:vitest|jest)\b|(?:^|[;&|]\s*)(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(command)) return "test";
  return "build";
}

/** The project the command acts on: an explicit `cd` wins, then the tool's own cwd. */
function projectPathForCommand(command: string, cwd?: string): string {
  const changeDirectory = /(?:^|[;&|]\s*)cd\s+([^\s;&|]+)/.exec(command);
  const candidate = changeDirectory?.[1] ?? cwd ?? ".";
  const normalized = candidate.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
}

export function validationCommandAdvisory(command: string, cwd?: string): string | undefined {
  if (!PROJECT_CHECK_COMMAND.test(command)) return undefined;
  if (TARGETED_CHECK_ARGUMENT.test(command)) return undefined;
  if (looksLikeLongRunningServer(command)) return undefined;
  const check = declaredCheck(command);
  const path = projectPathForCommand(command, cwd);
  return `This is a declared project check run through the shell, so it produces no completion evidence. Run validate_project with {"path":"${path}","checks":["${check}"]} to make the result count; keep a direct command only for diagnosis.`;
}

/** A reader program, and separately a dependency path: either order appears in practice. */
const SHELL_READER = /\b(?:cat|bat|head|tail|less|more|sed|awk|grep|rg|strings)\b/;
const DEPENDENCY_PATH = /node_modules\//;

/**
 * The host guard refuses file-tool reads of library source, but a shell reader
 * bypasses it silently (seen in the gymflow security step: `cd
 * backend/node_modules/@galaxy-stack/orbit-security/dist && cat …`). Reading
 * declarations or a manifest is allowed and cheap; reading library source is not.
 */
export function dependencyShellReadAdvisory(command: string): string | undefined {
  if (!SHELL_READER.test(command) || !DEPENDENCY_PATH.test(command)) return undefined;
  return "This reads library source inside node_modules through the shell, which the file tools refuse for good reason: it floods context with internals that are not documentation. Read a specific package.json, README.md or *.d.ts instead (allowed), or use the framework MCP knowledge and bundled skills.";
}

export function serverCommandAdvisory(command: string): string | undefined {
  if (!looksLikeLongRunningServer(command)) return undefined;
  return "This looks like a long-running server or watcher. It is not validation evidence: prove the project with validate_project (test, typecheck, lint, build) and exercise a server only when the task explicitly asks for it, through the bounded session capability, stopping it before the final validation.";
}
