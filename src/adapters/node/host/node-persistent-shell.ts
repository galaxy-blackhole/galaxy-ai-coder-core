/**
 * A persistent shell for one workspace, mirroring the harness this project follows.
 *
 * @deepseek-ai/dsh-tool-bash-persistent keeps one shell per agent session: commands share
 * cwd, exported variables and background jobs, calls are serialized, the timeout is a
 * maximum (the result returns as soon as the command finishes), and reaching the maximum
 * kills and resets the shell while returning the partial output. This class does the same
 * for the node host: bash reads a command line followed by a sentinel line carrying the
 * exit code, so `cd`, exports and `&` processes survive between calls, and disposing the
 * shell when a run ends also stops whatever that run left behind.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export type PersistentShellStatus = "exited" | "timed_out" | "canceled" | "unavailable";

export type PersistentShellRun = Readonly<{
  durationMs: number;
  /** null when the command was killed at its maximum or the shell died. */
  exitCode: number | null;
  output: string;
  status: PersistentShellStatus;
  truncated: boolean;
}>;

export type PersistentShellRunOptions = Readonly<{
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  maxOutputBytes?: number;
  timeoutMs: number;
}>;

const SENTINEL_PREFIX = "__GALAXY_SHELL_DONE__";
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

/** Keep the tail of a stream, which is what a model needs, and remember truncation. */
class TailText {
  private value = "";
  private truncatedFlag = false;
  constructor(private readonly maxBytes: number) {}
  append(chunk: string): void {
    this.value += chunk;
    if (Buffer.byteLength(this.value, "utf8") <= this.maxBytes) return;
    this.truncatedFlag = true;
    const buffer = Buffer.from(this.value, "utf8");
    this.value = buffer.subarray(buffer.byteLength - this.maxBytes).toString("utf8");
  }
  get text(): string { return this.value; }
  get truncated(): boolean { return this.truncatedFlag; }
}

type Pending = {
  nonce: string;
  output: TailText;
  resolve: (value: Readonly<{ exitCode: number | null; status: "exited" | "timed_out" | "canceled" }>) => void;
  timer: NodeJS.Timeout;
  onAbort: () => void;
  signal: AbortSignal;
};

export class PersistentShell {
  private child: ChildProcess | undefined;
  private pending: Pending | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: Readonly<{ maxOutputBytes?: number; root: string }>) {}

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
  }

  private startShell(): void {
    const child = spawn("/bin/bash", ["--noprofile", "--norc"], {
      cwd: this.options.root,
      detached: process.platform !== "win32",
      env: { ...process.env, PS1: "", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.absorb(chunk));
    child.stderr?.on("data", (chunk: string) => this.absorb(chunk));
    child.once("exit", () => {
      this.child = undefined;
      this.settle(null, "exited");
    });
    child.once("error", () => {
      this.child = undefined;
      this.settle(null, "exited");
    });
    this.child = child;
  }

  private absorb(chunk: string): void {
    const pending = this.pending;
    if (pending === undefined) return;
    pending.output.append(chunk);
    const needle = SENTINEL_PREFIX + pending.nonce;
    const index = pending.output.text.indexOf(needle);
    if (index === -1) return;
    const text = pending.output.text;
    const lineEnd = text.indexOf("\n", index);
    const codeText = text.slice(index + needle.length, lineEnd === -1 ? index + needle.length + 8 : lineEnd).trim();
    const exitCode = Number.parseInt(codeText, 10);
    const body = text.slice(0, index).replace(/\n$/, "");
    this.settle(Number.isFinite(exitCode) ? exitCode : null, "exited", body);
  }

  /** Kill the shell (a shell that hit its maximum is reset, like the harness does). */
  private terminate(signal: NodeJS.Signals): void {
    const child = this.child;
    this.child = undefined;
    if (child === undefined) return;
    try {
      if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* already gone */ }
  }

  private settle(
    exitCode: number | null,
    status: "exited" | "timed_out" | "canceled",
    body?: string,
  ): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve(Object.freeze({ exitCode, status, ...(body === undefined ? {} : { output: body }) }));
  }

  async run(command: string, runOptions: PersistentShellRunOptions, signal: AbortSignal): Promise<PersistentShellRun> {
    const execute = async (): Promise<PersistentShellRun> => {
      const startedAt = Date.now();
      const maxOutputBytes = runOptions.maxOutputBytes ?? this.options.maxOutputBytes ?? MAX_BUFFERED_BYTES;
      const output = new TailText(maxOutputBytes);
      if (this.disposed) {
        return Object.freeze({ durationMs: 0, exitCode: null, output: "", status: "unavailable" as const, truncated: false });
      }
      if (!this.running) {
        try { this.startShell(); } catch {
          return Object.freeze({ durationMs: Date.now() - startedAt, exitCode: null, output: "", status: "unavailable" as const, truncated: false });
        }
      }
      const prefix: string[] = [];
      if (runOptions.cwd !== undefined && runOptions.cwd !== ".") prefix.push("cd " + shellQuote(runOptions.cwd) + " || exit 200");
      if (runOptions.env !== undefined) {
        for (const [key, value] of Object.entries(runOptions.env)) prefix.push("export " + key + "=" + shellQuote(value));
      }
      const nonce = randomUUID().replace(/-/g, "");
      const line = (prefix.length > 0 ? prefix.join("; ") + "; " : "")
        + command + "\nprintf '" + SENTINEL_PREFIX + nonce + "%s\\n' \"$?\"\n";

      const settled = await new Promise<Readonly<{ exitCode: number | null; status: "exited" | "timed_out" | "canceled"; output?: string }>>((resolve) => {
        const onAbort = (): void => {
          this.terminate("SIGTERM");
          this.settle(null, "canceled");
        };
        const timer = setTimeout(() => {
          this.terminate("SIGTERM");
          this.settle(null, "timed_out");
        }, runOptions.timeoutMs);
        timer.unref?.();
        this.pending = {
          nonce,
          output,
          resolve: (value) => resolve(value),
          timer,
          onAbort,
          signal,
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          this.child?.stdin?.write(line);
        } catch {
          this.settle(null, "exited");
        }
      });

      return Object.freeze({
        durationMs: Date.now() - startedAt,
        exitCode: settled.exitCode,
        output: settled.output ?? output.text,
        status: settled.status,
        truncated: output.truncated,
      });
    };
    const chained = this.tail.then(execute, execute);
    this.tail = chained.then(() => undefined, () => undefined);
    return await chained;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.tail.catch(() => undefined);
    this.terminate("SIGTERM");
  }
}
