/**
 * The host's own bound for a single tool dispatch.
 *
 * A native or host tool that blocks forever would hang the whole run, so every dispatch is
 * raced against this bound and fails with TOOL_TIMEOUT when it loses.
 */
export const TOOL_DISPATCH_TIMEOUT_MS = 600_000;

/**
 * How far below the dispatch bound a model-chosen command timeout must stay.
 *
 * A model asked for exactly 600000ms on `bunx orbit-cli new`; the host bound is the same
 * 600000ms, so the host always won the race and the step died with
 * "Tool run_command did not return within 600000ms" instead of returning a result the model
 * could react to. Clamping leaves room for the tool to report its own timeout first.
 */
export const COMMAND_TIMEOUT_MARGIN_MS = 30_000;

/** Clamp a model-chosen tool timeout (command.run, project.validate) below the host bound. */
export function clampToolTimeoutMs(requested: number | undefined): number | undefined {
  if (requested === undefined) return undefined;
  return Math.min(requested, TOOL_DISPATCH_TIMEOUT_MS - COMMAND_TIMEOUT_MARGIN_MS);
}
