/**
 * The sandbox body. It runs one program and nothing else: no module loader, no fs, no net, no process. The only
 * way out is `parentPort.postMessage`, and the only authority is the tool bindings the host handed over.
 */
import { Script } from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

interface WorkerInit {
  readonly goal: string;
  readonly names: readonly string[];
  readonly program: string;
}

const init = workerData as WorkerInit;
/** A worker always has a port; the helper keeps the type honest for the closures below. */
function requirePort(): NonNullable<typeof parentPort> {
  if (parentPort === null) throw new Error("The code worker needs a parent port.");
  return parentPort;
}
const port = requirePort();

let nextCallId = 0;
const pending = new Map<number, { reject: (error: Error) => void; resolve: (value: unknown) => void }>();
port.on("message", message => {
  if (message === null || typeof message !== "object" || message.type !== "tool-result") return;
  const entry = pending.get(message.id as number);
  if (entry === undefined) return;
  pending.delete(message.id as number);
  if (message.ok === true) entry.resolve(message.value);
  else {
    const error = new Error(String(message.error ?? "tool call failed"));
    (error as { code?: string }).code = String(message.code ?? "TOOL_FAILED");
    entry.reject(error);
  }
});

/** Every tool is a promise that travels to the host and back; the host owns approval, caps and evidence. */
function callTool(name: string, args: unknown): Promise<unknown> {
  const id = nextCallId;
  nextCallId += 1;
  const payload = args === null || typeof args !== "object" ? {} : args;
  return new Promise((resolve, reject) => {
    pending.set(id, { reject, resolve });
    port.postMessage({ args: payload, id, name, type: "tool-call" });
  });
}

const tools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
for (const name of init.names) tools[name] = (args: Record<string, unknown>) => callTool(name, args ?? {});

const logs: string[] = [];
function capture(stream: "stderr" | "stdout", values: readonly unknown[]): void {
  const text = values.map(value => (typeof value === "string" ? value : safeJson(value))).join(" ");
  logs.push(text);
  port.postMessage({ stream, text, type: "log" });
}
function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
const consoleShim = Object.freeze({
  error: (...values: unknown[]) => capture("stderr", values),
  info: (...values: unknown[]) => capture("stdout", values),
  log: (...values: unknown[]) => capture("stdout", values),
  warn: (...values: unknown[]) => capture("stderr", values),
});

/*
 * A context with nothing in it: no process, no require, no globalThis of the host, and `import()` is refused
 * because a vm script has no module callback. Only the bindings cross this line — the same stance as DSH's
 * "the runtime stays host-plane", but enforced by construction rather than by convention.
 */
const sandbox: Record<string, unknown> = { console: consoleShim, tools: Object.freeze(tools) };
for (const [name, call] of Object.entries(tools)) sandbox[name] = call;

try {
  const source = '"use strict"; (async () => {\n' + init.program + '\n})()';
  const script = new Script(source, { filename: "run_code.program.js" });
  const value = await (script.runInNewContext(sandbox, { breakOnSigint: false, timeout: 600_000 }) as Promise<unknown>);
  port.postMessage({ logs, ok: true, type: "done", value: safeJson(value ?? null) });
} catch (error) {
  port.postMessage({ error: error instanceof Error ? error.message : String(error), logs, ok: false, type: "done" });
}
