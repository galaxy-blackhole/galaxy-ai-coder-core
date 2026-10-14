/**
 * Background work, kept in one place.
 *
 * A command that takes minutes cannot be a tool call that blocks for them: the call is given a deadline, the
 * command is not, and the run dies waiting for something that was never going to finish in time. Here a command is
 * started, given an id, and read when the model asks — the shape the reference uses for the same reason.
 *
 * Output is streamed into a bounded buffer and read incrementally: each read returns what arrived since the last
 * one, so a long build can be watched without repeating everything already seen.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface JobStartOptions {
  /** Working directory for the command. */
  readonly cwd: string;
  /** What the job is, for a listing that has to read as a sentence. */
  readonly kind: string;
  /** Extra environment on top of the process's own. */
  readonly env?: Readonly<Record<string, string>>;
  /** How much output to keep; the oldest is dropped past this. */
  readonly maxBytes?: number;
}

export interface JobRow {
  readonly exitCode: number | null;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly startedAt: number;
  readonly status: JobStatus;
}

export interface JobRead {
  readonly exitCode: number | null;
  readonly status: JobStatus;
  readonly text: string;
  readonly truncated: boolean;
}

/* Not an extension of JobRow: that shape is what a reader gets, and every field in it is frozen. */
interface JobRecord {
  buffer: string;
  child: ChildProcessWithoutNullStreams | null;
  dropped: boolean;
  exitCode: number | null;
  finishedAt: number | null;
  id: string;
  kind: string;
  label: string;
  maxBytes: number;
  readAt: number;
  startedAt: number;
  status: JobStatus;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Keeps every background job this process started, and nothing older than the process itself. */
export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private next = 1;

  /**
   * Told once whenever the book changes — a job starting or ending — so a host can show the list without polling
   * it. A caller that has to poll for something this cheap ends up polling for everything.
   */
  constructor(private readonly onChange: ((rows: readonly JobRow[]) => void) | null = null) {}

  start(command: string, options: JobStartOptions): JobRow {
    const id = "job-" + String(this.next);
    this.next += 1;
    const child = spawn(command, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: true,
    });
    const record: JobRecord = {
      buffer: "",
      child,
      dropped: false,
      exitCode: null,
      finishedAt: null,
      id,
      kind: options.kind,
      label: command.length > 200 ? command.slice(0, 200) + "…" : command,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      readAt: 0,
      startedAt: Date.now(),
      status: "running",
    };
    this.jobs.set(id, record);
    const append = (chunk: Buffer | string): void => {
      record.buffer += String(chunk);
      if (record.buffer.length > record.maxBytes) {
        record.buffer = record.buffer.slice(record.buffer.length - record.maxBytes);
        record.dropped = true;
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      append(String(error.message));
      record.status = "failed";
      record.finishedAt = Date.now();
      record.child = null;
    });
    child.on("close", (code, signal) => {
      record.exitCode = code;
      record.finishedAt = Date.now();
      record.child = null;
      if (signal !== null) record.status = "killed";
      else record.status = code === 0 ? "completed" : "failed";
      this.announce();
    });
    this.announce();
    return this.row(record);
  }

  list(): readonly JobRow[] {
    return [...this.jobs.values()].map((record) => this.row(record));
  }

  /**
   * What arrived since the previous read. With `wait`, it holds until the job ends or the timeout expires — and a
   * timeout leaves the job running, because waiting is the caller's choice, not a reason to stop the work.
   */
  async output(id: string, wait = false, timeoutMs = 30_000): Promise<JobRead | null> {
    const record = this.jobs.get(id);
    if (record === undefined) return null;
    if (wait && record.status === "running") {
      const deadline = Date.now() + Math.max(1, timeoutMs);
      while (record.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const text = record.buffer.slice(record.readAt);
    record.readAt = record.buffer.length;
    return { exitCode: record.exitCode, status: record.status, text, truncated: record.dropped };
  }

  /** Ends the job's process group, so a shell's children go with it. */
  kill(id: string): boolean {
    const record = this.jobs.get(id);
    if (record === undefined || record.child === null) return false;
    record.child.kill("SIGTERM");
    const child = record.child;
    setTimeout(() => {
      if (record.status === "running") child.kill("SIGKILL");
    }, 2000).unref();
    return true;
  }

  private announce(): void {
    if (this.onChange !== null) this.onChange(this.list());
  }

  private row(record: JobRecord): JobRow {
    return {
      exitCode: record.exitCode,
      id: record.id,
      kind: record.kind,
      label: record.label,
      startedAt: record.startedAt,
      status: record.status,
    };
  }
}
