import type {
  CommandRunnerPort,
  CommandRunResult,
  PortErrorCode,
  PortFailure,
  PortResult,
  ToolExecutionContext,
} from "../../../ports/index.js";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat } from "node:fs/promises";

import {
  assertWorkspaceHasNoHardLinks,
  buildBubblewrapArguments,
  containmentStatus,
  probeCommandContainment,
  type CommandContainmentMode,
  type CommandContainmentProbeResult,
  type CommandContainmentStatus,
} from "./command-containment.js";
import { nodeCommandHostEnvironment } from "./host-environment.js";
import { WorkspaceScope } from "./path-scope.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function failure(code: PortErrorCode, message: string, retryable = false): PortFailure {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message, retryable }) });
}

class TailBuffer {
  private value = Buffer.alloc(0);
  private didTruncate = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    const combined = Buffer.concat([this.value, buffer]);
    if (combined.length > this.maxBytes) {
      this.didTruncate = true;
      this.value = combined.subarray(combined.length - this.maxBytes);
    } else {
      this.value = combined;
    }
  }

  get text(): string {
    let decoded = this.value.toString("utf8");
    // stdout/stderr are byte streams and may be truncated in the middle of a
    // UTF-8 sequence. Replacement characters can encode to more bytes than
    // the retained buffer, so trim complete code points until the public text
    // representation also honours maxOutputBytes.
    while (Buffer.byteLength(decoded, "utf8") > this.maxBytes) {
      const first = decoded.codePointAt(0);
      if (first === undefined) break;
      decoded = decoded.slice(first > 0xffff ? 2 : 1);
    }
    return decoded;
  }

  get truncated(): boolean {
    return this.didTruncate;
  }
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => child.kill(signal));
      killer.unref();
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // Fall through when the process group has already ended.
  }
  child.kill(signal);
}

function commandEnvironment(overrides: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    throw Object.assign(new Error("Command environment overrides must be an object."), { code: "INVALID_INPUT" });
  }
  const inheritedNames = ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT"] as const;
  const environment: NodeJS.ProcessEnv = { CI: "1", FORCE_COLOR: "0" };
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) {
      throw Object.assign(new Error(`Invalid environment entry '${name}'.`), { code: "INVALID_INPUT" });
    }
    environment[name] = value;
  }
  return environment;
}

function exceptionFailure(error: unknown): PortFailure {
  const message = error instanceof Error ? error.message : String(error);
  const nativeCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "COMMAND_ERROR")
    : "COMMAND_ERROR";
  const code: PortErrorCode = nativeCode === "INVALID_INPUT"
    ? "INVALID_INPUT"
    : nativeCode === "PERMISSION_DENIED" || nativeCode === "EACCES" || nativeCode === "EPERM"
      ? "PERMISSION_DENIED"
      : nativeCode === "ENOENT" || nativeCode === "ENOTDIR"
        ? "NOT_FOUND"
        : nativeCode === "CANCELED" || nativeCode === "ABORT_ERR"
          ? "CANCELED"
          : nativeCode === "DEADLINE_EXCEEDED"
            ? "DEADLINE_EXCEEDED"
            : nativeCode === "EAGAIN" || nativeCode === "EBUSY"
              ? "UNAVAILABLE"
              : "IO_ERROR";
  return failure(code, message, code === "UNAVAILABLE");
}

export class NodeCommandPort implements CommandRunnerPort {
  private constructor(
    private readonly scope: WorkspaceScope,
    readonly containmentStatus: CommandContainmentStatus,
    readonly hostEnvironment: ReturnType<typeof nodeCommandHostEnvironment>,
  ) {}

  static async create(
    workspaceRoot: string,
    options: Readonly<{ containment?: CommandContainmentMode }> = {},
  ): Promise<NodeCommandPort> {
    const mode = options.containment ?? "best_effort";
    if (mode !== "best_effort" && mode !== "required") {
      throw Object.assign(new Error("containment must be 'best_effort' or 'required'."), { code: "INVALID_INPUT" });
    }
    const [scope, probe] = await Promise.all([
      WorkspaceScope.create(workspaceRoot),
      probeCommandContainment(),
    ]);
    return new NodeCommandPort(scope, containmentStatus(mode, probe), nodeCommandHostEnvironment());
  }

  static async probeContainment(): Promise<CommandContainmentProbeResult> {
    return await probeCommandContainment();
  }

  async run(
    input: Readonly<{
      command: string;
      cwd?: string;
      env?: Readonly<Record<string, string>>;
      maxOutputBytes?: number;
      timeoutMs?: number;
    }>,
    context: ToolExecutionContext,
  ): Promise<PortResult<CommandRunResult>> {
    if (context.signal.aborted) return failure("CANCELED", "The run was canceled.");
    if (context.deadline <= Date.now()) return failure("DEADLINE_EXCEEDED", "The run deadline elapsed.");
    if (typeof input.command !== "string" || input.command.trim().length === 0 || input.command.length > 32_768) {
      return failure("INVALID_INPUT", "Command must contain between 1 and 32768 characters.");
    }

    try {
      const cwd = await this.scope.resolveExisting(input.cwd ?? ".");
      if (!(await lstat(cwd)).isDirectory()) {
        return failure("INVALID_INPUT", "Command cwd must be a workspace directory.");
      }
      if (context.signal.aborted) return failure("CANCELED", "The run was canceled.");
      const deadlineRemaining = context.deadline - Date.now();
      if (deadlineRemaining <= 0) return failure("DEADLINE_EXCEEDED", "The run deadline elapsed.");
      const requestedTimeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1) {
        return failure("INVALID_INPUT", "timeoutMs must be a positive integer.");
      }
      const timeoutMs = Math.min(requestedTimeout, deadlineRemaining);
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) {
        return failure("INVALID_INPUT", `maxOutputBytes must be between 1 and ${MAX_OUTPUT_BYTES}.`);
      }
      const stdout = new TailBuffer(maxOutputBytes);
      const stderr = new TailBuffer(maxOutputBytes);
      const environment = commandEnvironment(input.env);
      const startedAt = Date.now();

      if (this.containmentStatus.mode === "required" && !this.containmentStatus.active) {
        return failure(
          "UNAVAILABLE",
          `Required command containment is unavailable (${this.containmentStatus.backend}/${this.containmentStatus.state}): ${this.containmentStatus.reason ?? "the backend did not pass conformance"}`,
        );
      }

      let launchCommand = this.hostEnvironment.command.executable;
      let launchArguments: readonly string[] = Object.freeze([
        ...this.hostEnvironment.command.argumentsPrefix,
        input.command,
      ]);
      let launchCwd = cwd;
      let launchEnvironment = environment;
      if (this.containmentStatus.active) {
        if (this.containmentStatus.backend !== "linux_bubblewrap" || this.containmentStatus.executable === null) {
          return failure("UNAVAILABLE", "The active command-containment backend has no executable implementation.");
        }
        await assertWorkspaceHasNoHardLinks(this.scope.root);
        launchCommand = this.containmentStatus.executable;
        launchEnvironment = {
          ...environment,
          HOME: "/tmp",
          TEMP: "/tmp",
          TMP: "/tmp",
          TMPDIR: "/tmp",
        };
        launchArguments = buildBubblewrapArguments({
          command: this.hostEnvironment.command.executable,
          commandArguments: Object.freeze([
            ...this.hostEnvironment.command.argumentsPrefix,
            input.command,
          ]),
          cwd,
          environment: launchEnvironment,
          workspace: this.scope.root,
        });
        launchCwd = this.scope.root;
      }

      return await new Promise<PortResult<CommandRunResult>>((resolveResult) => {
        const child = spawn(launchCommand, [...launchArguments], {
          cwd: launchCwd,
          env: launchEnvironment,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let status: CommandRunResult["status"] = "exited";
        let settled = false;
        let terminationRequested = false;
        let killTimer: NodeJS.Timeout | undefined;
        const abort = (): void => {
          if (settled || terminationRequested) return;
          terminationRequested = true;
          status = "canceled";
          terminate(child, "SIGTERM");
          killTimer = setTimeout(() => terminate(child, "SIGKILL"), 750);
          killTimer.unref();
        };
        const timeout = setTimeout(() => {
          if (settled || terminationRequested) return;
          terminationRequested = true;
          status = "timed_out";
          terminate(child, "SIGTERM");
          killTimer = setTimeout(() => terminate(child, "SIGKILL"), 750);
          killTimer.unref();
        }, timeoutMs);
        timeout.unref();

        context.signal.addEventListener("abort", abort, { once: true });
        // AbortSignal may have fired between the preflight check and listener
        // registration. Re-read it after subscribing to close that race.
        if (context.signal.aborted) abort();
        child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
        child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (killTimer !== undefined) clearTimeout(killTimer);
          context.signal.removeEventListener("abort", abort);
          resolveResult(exceptionFailure(error));
        });
        child.once("close", (exitCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (killTimer !== undefined) clearTimeout(killTimer);
          context.signal.removeEventListener("abort", abort);
          resolveResult({
            ok: true,
            data: Object.freeze({
              command: input.command,
              durationMs: Date.now() - startedAt,
              exitCode,
              status,
              stdout: stdout.text,
              stderr: stderr.text,
              stdoutTruncated: stdout.truncated,
              stderrTruncated: stderr.truncated,
            }),
          });
        });
      });
    } catch (error) {
      return exceptionFailure(error);
    }
  }
}
