/**
 * Long-running server and watcher commands: recognising them lets the host warn
 * the model that they are supervision cost rather than validation evidence.
 */
const SERVER_COMMAND = /(?:^|[;&|]\s*)(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|serve|start|watch)\b|(?:^|[\s/])(?:vite|next\s+dev|nodemon|webpack-dev-server|react-scripts\s+start)\b(?!\s+build)|(?:^|\s)--watch\b/;

export function looksLikeLongRunningServer(command: string): boolean {
  return SERVER_COMMAND.test(command.trim());
}

/**
 * Advisory appended to a command result. A backgrounded server returns exit code
 * 0 immediately, so without this note a headless run can spend its whole turn
 * budget probing ports (observed in the gymflow E2E).
 */
export function serverCommandAdvisory(command: string): string | undefined {
  if (!looksLikeLongRunningServer(command)) return undefined;
  return "This looks like a long-running server or watcher. It is not validation evidence: prove the project with validate_project (test, typecheck, lint, build) and exercise a server only when the task explicitly asks for it, through the bounded session capability, stopping it before the final validation.";
}
