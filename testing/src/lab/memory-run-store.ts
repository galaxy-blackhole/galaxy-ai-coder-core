import type {
  AiCoderFinalReport,
  AiCoderRunStore,
} from "@galaxy-stack/ai-coder-core/runtime";
import type { AiCoderRunCheckpoint } from "@galaxy-stack/ai-coder-core";

export class MemoryRunStore implements AiCoderRunStore {
  readonly checkpointTrust = "trusted_host" as const;
  private readonly checkpoints = new Map<string, AiCoderRunCheckpoint>();
  private readonly reports = new Map<string, AiCoderFinalReport>();
  private readonly recordedCheckpoints: AiCoderRunCheckpoint[] = [];
  private readonly recordedReports: AiCoderFinalReport[] = [];

  get checkpointHistory(): readonly AiCoderRunCheckpoint[] {
    return Object.freeze(structuredClone(this.recordedCheckpoints));
  }

  get finalReportHistory(): readonly AiCoderFinalReport[] {
    return Object.freeze(structuredClone(this.recordedReports));
  }

  async loadLatestCheckpoint(runId: string): Promise<AiCoderRunCheckpoint | null> {
    return this.checkpoints.get(runId) ?? null;
  }

  async saveCheckpoint(checkpoint: AiCoderRunCheckpoint): Promise<Readonly<{ artifactRef?: string }>> {
    this.checkpoints.set(checkpoint.runId, checkpoint);
    this.recordedCheckpoints.push(structuredClone(checkpoint));
    return Object.freeze({ artifactRef: `memory://checkpoints/${checkpoint.runId}/${checkpoint.contentHash}` });
  }

  async saveFinalReport(report: AiCoderFinalReport): Promise<void> {
    this.reports.set(report.runId, report);
    this.recordedReports.push(structuredClone(report));
  }

  getCheckpoint(runId: string): AiCoderRunCheckpoint | null {
    return this.checkpoints.get(runId) ?? null;
  }

  getFinalReport(runId: string): AiCoderFinalReport | null {
    return this.reports.get(runId) ?? null;
  }
}
