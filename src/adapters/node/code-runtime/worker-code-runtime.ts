/**
 * The worker sandbox behind `run_code`. One worker per program, no pooling, no state between runs: a run either
 * finishes, times out, is cancelled, or dies — and every one of those is a typed failure, never a hang.
 */
import { Worker } from "node:worker_threads";
import {
  DEFAULT_CODE_RUN_LIMITS,
  type CodeRunInput,
  type CodeRunLimits,
  type CodeRunResult,
  type CodeRuntimePort,
} from "../../../ports/code-runtime-port.js";
import type { AiCoderToolDescriptor } from "../../../tools/tool-registry-types.js";
import { renderCodeSdk } from "../../../tools/code-sdk.js";

export interface WorkerCodeRuntimeOptions {
  readonly limits?: Partial<CodeRunLimits>;
  readonly workerUrl?: URL;
}

/** tsx runs the TypeScript source; an installed package runs the compiled sibling. */
function workerEntryUrl(): URL {
  const here = import.meta.url;
  return new URL(here.endsWith(".ts") ? "./code-worker-entry.ts" : "./code-worker-entry.js", here);
}

export class WorkerCodeRuntime implements CodeRuntimePort {
  readonly language = "typescript";
  private readonly limits: CodeRunLimits;
  private readonly workerUrl: URL;

  constructor(options: WorkerCodeRuntimeOptions = {}) {
    this.limits = Object.freeze({ ...DEFAULT_CODE_RUN_LIMITS, ...options.limits });
    this.workerUrl = options.workerUrl ?? workerEntryUrl();
  }

  renderSdk(descriptors: readonly AiCoderToolDescriptor[]): string {
    return renderCodeSdk(descriptors);
  }

  async run(input: CodeRunInput, signal?: AbortSignal): Promise<CodeRunResult> {
    const started = Date.now();
    const logs: string[] = [];
    const limits = { ...this.limits, ...input.limits };
    return await new Promise<CodeRunResult>((resolve) => {
      let settled = false;
      let calls = 0;
      const worker = new Worker(this.workerUrl, {
        resourceLimits: { maxOldGenerationSizeMb: limits.heapMb },
        workerData: { goal: input.goal, names: input.toolNames, program: input.program },
      });
      const finish = (result: CodeRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onAbort);
        void worker.terminate();
        resolve(result);
      };
      const fail = (code: string, error: string): void => {
        finish({ code, durationMs: Date.now() - started, error, logs, ok: false });
      };
      const deadline = setTimeout(() => {
        fail("RUN_CODE_TIMEOUT", "the program exceeded " + Math.round(limits.wallClockMs / 1000).toString() + "s");
      }, limits.wallClockMs);
      const onAbort = (): void => { fail("RUN_CODE_CANCELLED", "the run was cancelled"); };
      if (signal?.aborted === true) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });

      worker.on("message", (message: { args?: Record<string, unknown>; code?: string; error?: string; id?: number; logs?: string[]; name?: string; ok?: boolean; stream?: string; text?: string; type?: string; value?: string }) => {
        if (message.type === "log") {
          const line = (message.stream === "stderr" ? "[stderr] " : "") + String(message.text ?? "");
          logs.push(line);
          input.onEvent?.({ stream: message.stream === "stderr" ? "stderr" : "stdout", text: String(message.text ?? ""), type: "code/log" });
          return;
        }
        if (message.type === "tool-call") {
          const id = message.id ?? 0;
          const name = String(message.name ?? "");
          const callId = `${name}#${id.toString()}`;
          calls += 1;
          if (calls > limits.maxToolCalls) {
            worker.postMessage({ code: "CODE_TOOL_LIMIT", error: "the program asked for more than " + limits.maxToolCalls.toString() + " tool calls", id, ok: false, type: "tool-result" });
            return;
          }
          input.onEvent?.({ callId, name, type: "code/tool-start" });
          void input.callTool(name, message.args ?? {}).then(
            (outcome) => {
              input.onEvent?.({ callId, ok: outcome.ok, summary: outcome.ok ? "ok" : outcome.code, type: "code/tool-result" });
              worker.postMessage({ id, ok: outcome.ok, type: "tool-result", value: outcome.ok ? outcome.value : undefined, ...(outcome.ok ? {} : { code: outcome.code, error: outcome.error }) });
            },
            (error: unknown) => {
              const text = error instanceof Error ? error.message : String(error);
              input.onEvent?.({ callId, ok: false, summary: "failed", type: "code/tool-result" });
              worker.postMessage({ code: "TOOL_FAILED", error: text, id, ok: false, type: "tool-result" });
            },
          );
          return;
        }
        if (message.type === "done") {
          for (const line of message.logs ?? []) if (!logs.includes(line)) logs.push(line);
          if (message.ok === true) finish({ durationMs: Date.now() - started, logs, ok: true, value: String(message.value ?? "null") });
          else fail("RUN_CODE_FAILED", String(message.error ?? "the program failed"));
        }
      });
      worker.on("error", (error) => { fail("RUN_CODE_CRASHED", error.message); });
      worker.on("exit", (code) => { if (code !== 0) fail("RUN_CODE_CRASHED", "the worker exited with code " + code.toString()); });
    });
  }
}
