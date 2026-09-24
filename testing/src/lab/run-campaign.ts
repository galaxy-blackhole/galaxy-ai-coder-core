import type { DeterministicFixture } from "../domain/fixture.js";
import { sha256Text } from "../host/content-hash.js";
import {
  runDeterministicFixture,
  type DeterministicRunReport,
} from "./run-fixture.js";

export interface DeterministicCampaignOptions {
  readonly fixtures: readonly DeterministicFixture[];
  readonly signal?: AbortSignal;
  readonly workspacePath: string;
}

export interface DeterministicCampaignReport {
  readonly campaignReplayHash: string;
  readonly completedStages: number;
  readonly failures: readonly string[];
  readonly passed: boolean;
  readonly plannedStages: number;
  readonly reports: readonly DeterministicRunReport[];
  readonly workspacePath: string;
}

export async function runDeterministicCampaign(
  options: DeterministicCampaignOptions,
): Promise<DeterministicCampaignReport> {
  if (options.fixtures.length === 0) throw new Error("A deterministic campaign requires at least one fixture.");
  const fixtureNames = options.fixtures.map((fixture) => fixture.name);
  if (new Set(fixtureNames).size !== fixtureNames.length) {
    throw new Error("A deterministic campaign requires unique fixture names because each name defines its run identity.");
  }
  const reports: DeterministicRunReport[] = [];
  const failures: string[] = [];
  for (const [index, fixture] of options.fixtures.entries()) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Campaign canceled by the CLI host.");
    const report = await runDeterministicFixture({
      fixture,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      workspacePath: options.workspacePath,
    });
    reports.push(report);
    if (!report.passed) {
      failures.push(...report.failures.map((failure) => `stage ${index + 1} (${fixture.name}): ${failure}`));
      break;
    }
  }
  const campaignReplayHash = `sha256:${sha256Text(JSON.stringify({
    plannedStages: options.fixtures.map((fixture) => fixture.name),
    reports: reports.map((report) => Object.freeze({
      fixture: report.fixture,
      passed: report.passed,
      replayHash: report.replayHash,
      status: report.status,
    })),
  }))}`;
  return Object.freeze({
    campaignReplayHash,
    completedStages: reports.length,
    failures: Object.freeze(failures),
    passed: failures.length === 0 && reports.length === options.fixtures.length,
    plannedStages: options.fixtures.length,
    reports: Object.freeze(reports),
    workspacePath: options.workspacePath,
  });
}
