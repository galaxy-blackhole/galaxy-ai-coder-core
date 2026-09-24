import {
  assertAiCoderRunCheckpoint,
  type AiCoderRunCheckpoint,
} from "../../../index.js";
import type {
  AiCoderFinalReport,
  AiCoderRunStore,
} from "../../../runtime/index.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { sha256Text } from "./content-hash.js";

function assertActive(context: Readonly<{ deadline: number; signal: AbortSignal }>): void {
  if (context.signal.aborted) throw context.signal.reason ?? new Error("Run-store operation was canceled.");
  if (Date.now() >= context.deadline) throw new Error("Run-store operation deadline elapsed.");
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = join(
    resolve(path, ".."),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

/**
 * Minimal durable host store for the CLI laboratory. The configured directory
 * must be outside model-writable workspace roots in production hosts.
 */
export class FileRunStore implements AiCoderRunStore {
  readonly checkpointTrust = "trusted_host" as const;

  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FileRunStore> {
    const target = resolve(root);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("FileRunStore root must be a real directory.");
    }
    return new FileRunStore(await realpath(target));
  }

  private async runDirectory(runId: string): Promise<string> {
    const directory = join(this.root, sha256Text(runId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("FileRunStore run path must be a real directory.");
    }
    return directory;
  }

  async loadLatestCheckpoint(
    runId: string,
    context: Readonly<{ deadline: number; signal: AbortSignal }>,
  ): Promise<AiCoderRunCheckpoint | null> {
    assertActive(context);
    const path = join(await this.runDirectory(runId), "checkpoint.json");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    assertActive(context);
    return assertAiCoderRunCheckpoint(JSON.parse(raw) as unknown);
  }

  async saveCheckpoint(
    checkpoint: AiCoderRunCheckpoint,
    context: Readonly<{ deadline: number; signal: AbortSignal }>,
  ): Promise<Readonly<{ artifactRef?: string }>> {
    assertActive(context);
    const verified = await assertAiCoderRunCheckpoint(checkpoint);
    const directory = await this.runDirectory(verified.runId);
    await writeJsonAtomically(join(directory, "checkpoint.json"), verified);
    assertActive(context);
    return Object.freeze({ artifactRef: `galaxy-checkpoint://${sha256Text(verified.runId)}/${verified.contentHash}` });
  }

  async saveFinalReport(
    report: AiCoderFinalReport,
    context: Readonly<{ deadline: number; signal: AbortSignal }>,
  ): Promise<void> {
    assertActive(context);
    const directory = await this.runDirectory(report.runId);
    await writeJsonAtomically(join(directory, "final-report.json"), report);
    assertActive(context);
  }

  async loadFinalReport(runId: string): Promise<AiCoderFinalReport | null> {
    const path = join(await this.runDirectory(runId), "final-report.json");
    try {
      return JSON.parse(await readFile(path, "utf8")) as AiCoderFinalReport;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
