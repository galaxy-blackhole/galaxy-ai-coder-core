import type { CodingToolDefinition } from "./coding-messages.js";

/**
 * How a round presents its tools to the model.
 *
 * - `native`: every active tool as its own function definition (what every host does today),
 * - `ptc`:   `run_code` plus a generated SDK — the model calls tools from inside a program,
 * - `both`:  the two shapes side by side, for debugging a projection.
 *
 * The mode is chosen when a session is composed and never changes inside one: the tool array is part of the
 * request prefix, and a native turn's `tool_calls` name functions a `ptc` tool set does not contain.
 */
export type ToolPresentationMode = "native" | "ptc" | "both";

export const TOOL_PRESENTATION_MODES: readonly ToolPresentationMode[] = Object.freeze(["native", "ptc", "both"]);

export function isToolPresentationMode(value: unknown): value is ToolPresentationMode {
  return typeof value === "string" && (TOOL_PRESENTATION_MODES as readonly string[]).includes(value);
}

/** Parses a user-facing mode, so the CLI and the extension validate the same way. */
export function parseToolPresentationMode(value: string): ToolPresentationMode {
  const trimmed = value.trim().toLowerCase();
  if (isToolPresentationMode(trimmed)) return trimmed;
  throw new Error("Invalid tools mode: " + value + ". Use " + TOOL_PRESENTATION_MODES.join(" | ") + ".");
}

/** The one tool a `ptc` round offers in place of the registry. */
export const RUN_CODE_TOOL_NAME = "run_code";

/**
 * The tool set a round actually sends. Pure on purpose: the projection is the whole feature's contract, so it
 * is tested without a provider, a worker, or a session.
 */
export function projectToolDefinitions(
  mode: ToolPresentationMode,
  definitions: readonly CodingToolDefinition[],
  runCode: CodingToolDefinition,
): readonly CodingToolDefinition[] {
  if (mode === "native") return definitions;
  if (mode === "ptc") return Object.freeze([runCode]);
  return Object.freeze([...definitions, runCode]);
}

/**
 * A `ptc` round cannot run without a composed code runtime; failing when the session opens is kinder than
 * failing after the model has written a program.
 */
export function assertPresentationAvailable(mode: ToolPresentationMode, hasCodeRuntime: boolean): void {
  if (mode !== "native" && !hasCodeRuntime) {
    throw new Error("CODE_RUNTIME_MISSING: tools mode " + mode + " needs a composed code runtime.");
  }
}
