/**
 * Timeout policy for host tools that run a process (command.run, project.validate).
 *
 * The agent decides how long a command may take: a scaffolder, a typecheck plus a full
 * verify, or a long test run each need a different budget, and the model knows which one it
 * is running. The schema therefore states no ceiling, the executor passes the requested
 * timeout straight through, and the host only keeps a *derived* backstop so a tool that
 * ignores its own timeout cannot hang the run: the guard is the tool's own timeout plus
 * head-room, never a fixed cap. Measured: a step asked for 600000ms while the guard was the
 * same 600000ms, the guard won the race, and the step died with
 * "Tool run_command did not return within 600000ms" instead of receiving a timeout result.
 * The run deadline (`--run-minutes`) remains the only hard bound, and the command port
 * already clamps a request to the deadline that is left.
 */

/** Wait used when a call carries no timeout of its own; the command port uses the same value. */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** Head-room the host adds on top of the tool's own timeout so the tool always answers first. */
export const TOOL_DISPATCH_GUARD_MARGIN_MS = 60_000;

/** The host backstop for one dispatch: what the agent asked for, plus head-room. */
export function dispatchGuardMs(requestedTimeoutMs?: number): number {
  const usable = typeof requestedTimeoutMs === "number" && Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : DEFAULT_TOOL_TIMEOUT_MS;
  return usable + TOOL_DISPATCH_GUARD_MARGIN_MS;
}
