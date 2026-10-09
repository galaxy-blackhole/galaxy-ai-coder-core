import type { AiCoderToolDescriptor } from "../tools/tool-registry-types.js";

/**
 * The code runtime a `ptc` round needs. Host-plane by design: a deployment either composes one or the session
 * cannot select the mode. See docs/design/tool-modes.md.
 */
export type CodeToolOutcome = Readonly<
  | { ok: true; value: unknown }
  | { ok: false; code: string; error: string }
>;

export type CodeRunLimits = Readonly<{
  /** Wall clock for one program. The worker is terminated when it expires. */
  wallClockMs: number;
  /** How many tool calls one program may make before further calls fail. */
  maxToolCalls: number;
  /** V8 heap ceiling for the worker. */
  heapMb: number;
  /** Output bytes kept in the program's result; the rest is spilled by the caller. */
  outputBytes: number;
}>;

export const DEFAULT_CODE_RUN_LIMITS: CodeRunLimits = Object.freeze({
  heapMb: 256,
  maxToolCalls: 64,
  outputBytes: 32_768,
  wallClockMs: 120_000,
});

export type CodeRunEvent = Readonly<
  | { type: "code/log"; stream: "stderr" | "stdout"; text: string }
  | { type: "code/tool-result"; callId: string; ok: boolean; summary: string }
  | { type: "code/tool-start"; callId: string; name: string }
>;

export interface CodeRunInput {
  /** One call from inside the program. The host routes it through the ordinary tool path. */
  readonly callTool: (name: string, args: Readonly<Record<string, unknown>>) => Promise<CodeToolOutcome>;
  readonly goal: string;
  readonly limits: CodeRunLimits;
  readonly onEvent?: (event: CodeRunEvent) => void;
  readonly program: string;
  /** The names the program may call; the façade is built from exactly these. */
  readonly toolNames: readonly string[];
}

export type CodeRunResult = Readonly<
  | { durationMs: number; logs: readonly string[]; ok: true; value: string }
  | { code: string; durationMs: number; error: string; logs: readonly string[]; ok: false }
>;

export interface CodeRuntimePort {
  readonly language: string;
  /** The façade the model sees instead of N schemas. Pure: same descriptors, same text. */
  renderSdk(descriptors: readonly AiCoderToolDescriptor[]): string;
  /** Run one program to completion, or fail with a typed code. Never rejects. */
  run(input: CodeRunInput, signal?: AbortSignal): Promise<CodeRunResult>;
}
