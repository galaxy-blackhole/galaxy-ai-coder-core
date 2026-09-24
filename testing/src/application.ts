import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  AI_CODER_PROMPT_VERSION,
  AI_CODER_TOOL_REGISTRY_SCHEMA_VERSION,
  AiCoderToolRegistry,
  assembleAiCoderPrompt,
  createAiCoderTaskContract,
  createAiCoderToolRegistrySnapshot,
  formatAiCoderUserTask,
} from "@galaxy-stack/ai-coder-core";

import type { CliCommand, OutputFormat } from "./domain/cli-options.js";
import { resolveOllamaConnection } from "./config/manual-provider-config.js";
import { sha256Text } from "./host/content-hash.js";
import { FileRunStore } from "./host/file-run-store.js";
import { nodeCommandHostEnvironment } from "./host/host-environment.js";
import { loadFixtures } from "./io/load-fixtures.js";
import { loadLiveHealthScenarios } from "./io/load-live-health-scenario.js";
import { renderOutput, type OutputWriter } from "./io/output.js";
import {
  LAB_AVAILABLE_TOOL_IDS,
  LAB_GRANTED_PERMISSIONS,
} from "./lab/tool-executor.js";
import { runDeterministicCampaign } from "./lab/run-campaign.js";
import { runDeterministicFixture, type DeterministicRunReport } from "./lab/run-fixture.js";
import { runLiveHealth, type LiveHealthReport } from "./live/run-live-health.js";
import { createRecordingFetch } from "./provider/ollama-record-replay.js";
import { SCRIPTED_MODEL_CAPABILITIES } from "./lab/scripted-model.js";
import { GALAXY_CODE_VERSION, HELP_TEXT } from "./ui/help.js";

export interface ApplicationOptions {
  readonly cwd: string;
  readonly output: OutputWriter;
  readonly signal?: AbortSignal;
}

type Check = Readonly<{
  detail: string;
  name: string;
  passed: boolean;
}>;

function writeValue(output: OutputWriter, value: unknown, format: OutputFormat): void {
  output.write(renderOutput(value, format));
}

function runExecFile(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, [...args], { cwd, encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout.trim());
    });
  });
}

function createLabRegistry(mode: "auto" | "scaffold" | "refactor" | "review_only" | "validate_only" = "auto") {
  const snapshot = createAiCoderToolRegistrySnapshot({
    availableToolIds: new Set(LAB_AVAILABLE_TOOL_IDS),
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    grantedPermissions: new Set(LAB_GRANTED_PERMISSIONS),
    mode,
  });
  return new AiCoderToolRegistry(snapshot);
}

async function doctor(cwd: string): Promise<Readonly<{ checks: readonly Check[]; ok: boolean }>> {
  const checks: Check[] = [];
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push(Object.freeze({
    detail: `Node ${process.versions.node}; Galaxy Code requires Node >=20.`,
    name: "node",
    passed: nodeMajor >= 20,
  }));

  try {
    const registry = createLabRegistry();
    checks.push(Object.freeze({
      detail: `${registry.snapshot.descriptors.length} adapter-backed tools; catalog ${registry.snapshot.catalogHash}.`,
      name: "core-registry",
      passed: registry.snapshot.descriptors.length === LAB_AVAILABLE_TOOL_IDS.length,
    }));
  } catch (error) {
    checks.push(Object.freeze({
      detail: error instanceof Error ? error.message : String(error),
      name: "core-registry",
      passed: false,
    }));
  }

  try {
    const version = await runExecFile("git", ["--version"], cwd);
    checks.push(Object.freeze({ detail: version, name: "git", passed: true }));
  } catch (error) {
    checks.push(Object.freeze({
      detail: `Git is required for deterministic final-diff evidence: ${error instanceof Error ? error.message : String(error)}`,
      name: "git",
      passed: false,
    }));
  }
  return Object.freeze({ checks: Object.freeze(checks), ok: checks.every((check) => check.passed) });
}

function toolsReport() {
  const registry = createLabRegistry();
  return Object.freeze({
    schemaVersion: AI_CODER_TOOL_REGISTRY_SCHEMA_VERSION,
    catalogHash: registry.snapshot.catalogHash,
    activeHash: registry.activeHash,
    activeCount: registry.activeDescriptors.length,
    catalogCount: registry.snapshot.descriptors.length,
    tools: Object.freeze(registry.snapshot.descriptors.map((tool) => Object.freeze({
      activeByDefault: registry.activeDescriptors.some((active) => active.id === tool.id),
      category: tool.category,
      id: tool.id,
      idempotency: tool.idempotency,
      modelName: tool.modelName,
      mutability: tool.mutability,
      risk: tool.risk,
    }))),
  });
}

async function promptReport(task: string, cwd: string) {
  const registry = createLabRegistry();
  const taskId = `prompt:${sha256Text(task).slice(0, 16)}`;
  const snapshot = await assembleAiCoderPrompt({
    approvalProfile: "balanced",
    capabilities: SCRIPTED_MODEL_CAPABILITIES,
    complexity: "standard",
    dirtyStateSummary: "not inspected by the prompt command",
    hostEnvironment: nodeCommandHostEnvironment(),
    mode: "auto",
    networkAccess: "denied",
    registrySnapshotHash: registry.activeHash,
    taskId,
    writeAccess: "allowed",
    workspacePath: ".",
  });
  const contract = createAiCoderTaskContract({
    complexity: "standard",
    mode: "auto",
    originalRequest: task,
    taskId,
    workspacePath: ".",
  });
  return Object.freeze({
    estimatedTokens: snapshot.estimatedTokens,
    moduleVersions: snapshot.moduleVersions,
    promptHash: snapshot.promptHash,
    promptVersion: snapshot.promptVersion,
    systemPrompt: snapshot.systemPrompt,
    userTask: formatAiCoderUserTask(contract),
  });
}

function fixtureDirectoryName(name: string, index: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "fixture";
  return `${String(index + 1).padStart(3, "0")}-${slug}`;
}

function containsPath(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function canonicalProspectivePath(path: string): Promise<string> {
  let existing = path;
  const missing: string[] = [];
  while (true) {
    try {
      return join(await realpath(existing), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

async function runOneFixture(
  command: Extract<CliCommand, { kind: "run" }>,
  signal?: AbortSignal,
): Promise<DeterministicRunReport & Readonly<{ retainedWorkspace: string | null }>> {
  const loaded = await loadFixtures(command.fixturePath);
  if (loaded.length !== 1) throw new Error("The run command accepts exactly one fixture file.");
  const temporaryRoot = command.workspacePath === undefined
    ? await mkdtemp(join(tmpdir(), "galaxy-code-run-"))
    : null;
  const workspacePath = resolve(command.workspacePath ?? temporaryRoot ?? ".");
  await mkdir(workspacePath, { recursive: true });
  if (temporaryRoot === null && (await readdir(workspacePath)).length > 0) {
    throw new Error("The deterministic run workspace must be empty; use a new directory to avoid modifying existing files.");
  }
  const item = loaded[0];
  if (item === undefined) throw new Error("No fixture was loaded.");
  try {
    const report = await runDeterministicFixture({
      fixture: item.fixture,
      ...(signal === undefined ? {} : { signal }),
      ...(command.task === undefined ? {} : { taskOverride: command.task }),
      workspacePath,
    });
    return Object.freeze({
      ...report,
      retainedWorkspace: temporaryRoot === null ? workspacePath : null,
    });
  } finally {
    if (temporaryRoot !== null) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function evaluateFixtures(command: Extract<CliCommand, { kind: "eval" }>, signal?: AbortSignal) {
  const loaded = await loadFixtures(command.fixturePath);
  const temporaryRoot = command.workspacePath === undefined
    ? await mkdtemp(join(tmpdir(), "galaxy-code-eval-"))
    : null;
  const suiteRoot = resolve(command.workspacePath ?? temporaryRoot ?? ".");
  await mkdir(suiteRoot, { recursive: true });
  const reports: DeterministicRunReport[] = [];
  try {
    for (const [index, item] of loaded.entries()) {
      if (signal?.aborted) throw new Error("Evaluation canceled by the CLI host.");
      const workspacePath = join(suiteRoot, fixtureDirectoryName(item.fixture.name, index));
      await mkdir(workspacePath, { recursive: false });
      reports.push(await runDeterministicFixture({
        fixture: item.fixture,
        workspacePath,
        ...(signal === undefined ? {} : { signal }),
      }));
    }
  } finally {
    if (temporaryRoot !== null) await rm(temporaryRoot, { recursive: true, force: true });
  }
  const passed = reports.filter((report) => report.passed).length;
  return Object.freeze({
    failed: reports.length - passed,
    passed,
    reports: Object.freeze(reports),
    retainedWorkspace: command.workspacePath === undefined ? null : suiteRoot,
    total: reports.length,
  });
}

async function runCampaign(command: Extract<CliCommand, { kind: "campaign" }>, signal?: AbortSignal) {
  const loaded = await loadFixtures(command.fixturePath);
  const temporaryRoot = command.workspacePath === undefined
    ? await mkdtemp(join(tmpdir(), "galaxy-code-campaign-"))
    : null;
  const workspacePath = resolve(command.workspacePath ?? temporaryRoot ?? ".");
  await mkdir(workspacePath, { recursive: true });
  try {
    const report = await runDeterministicCampaign({
      fixtures: Object.freeze(loaded.map((item) => item.fixture)),
      ...(signal === undefined ? {} : { signal }),
      workspacePath,
    });
    return Object.freeze({
      ...report,
      retainedWorkspace: command.workspacePath === undefined ? null : workspacePath,
    });
  } finally {
    if (temporaryRoot !== null) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runHealth(command: Extract<CliCommand, { kind: "health" }>, cwd: string, signal?: AbortSignal) {
  const loaded = await loadLiveHealthScenarios(command.scenarioPath, cwd);
  if (command.resume && loaded.length !== 1) {
    throw new Error("The health --resume command accepts exactly one scenario file, not a directory campaign.");
  }
  if (command.runId !== undefined && loaded.length !== 1) {
    throw new Error("The health --run-id option accepts exactly one scenario file.");
  }
  const scenarioParts: string[] = [];
  for (const item of loaded) scenarioParts.push(sha256Text(await readFile(item.path, "utf8")));
  const scenarioFingerprint = scenarioParts.sort().join(",");
  const temporaryRoot = command.workspacePath === undefined
    ? await mkdtemp(join(tmpdir(), "galaxy-code-live-health-"))
    : null;
  let workspacePath = resolve(command.workspacePath ?? temporaryRoot ?? ".");
  if (temporaryRoot === null) {
    await mkdir(workspacePath, { recursive: true });
    if (!command.resume && (await readdir(workspacePath)).length > 0) {
      throw new Error("The live health workspace must be empty; use a new directory to avoid modifying existing files.");
    }
  }
  const storePath = command.storeDir === undefined ? null : resolve(cwd, command.storeDir);
  if (storePath !== null && (containsPath(workspacePath, storePath) || containsPath(storePath, workspacePath))) {
    throw new Error("The durable run store and model-writable workspace must not overlap.");
  }
  workspacePath = await realpath(workspacePath);
  if (storePath !== null) {
    const prospectiveStorePath = await canonicalProspectivePath(storePath);
    if (containsPath(workspacePath, prospectiveStorePath) || containsPath(prospectiveStorePath, workspacePath)) {
      throw new Error("The durable run store and model-writable workspace must not overlap after resolving links.");
    }
  }
  const store = storePath === null ? undefined : await FileRunStore.create(storePath);
  if (store !== undefined && command.runId !== undefined && await store.loadFinalReport(command.runId) !== null) {
    throw new Error(`Run '${command.runId}' already completed and cannot be overwritten or resumed.`);
  }
  const connection = await resolveOllamaConnection({
    ...(command.baseUrl === undefined ? {} : { baseUrl: command.baseUrl }),
    ...(command.configPath === undefined ? {} : { configPath: resolve(cwd, command.configPath) }),
    ...(command.model === undefined ? {} : { model: command.model }),
  });
  const recorder = command.recordPath === undefined ? null : createRecordingFetch({
    ...(connection.apiKey === undefined ? {} : { apiKey: connection.apiKey }),
    baseUrl: connection.baseUrl,
    model: connection.model,
    output: resolve(cwd, command.recordPath),
    promptVersion: AI_CODER_PROMPT_VERSION,
    scenarioFingerprint,
  });
  try {
    const reports: LiveHealthReport[] = [];
    for (const item of loaded) {
      if (signal?.aborted) throw new Error("Live health campaign canceled by the CLI host.");
      const report = await runLiveHealth({
        connection,
        ...(recorder === null ? {} : { fetch: recorder.fetch }),
        ...(command.pauseAfterToolCalls === undefined ? {} : { pauseAfterToolCalls: command.pauseAfterToolCalls }),
        ...(command.resume ? { resume: true } : {}),
        ...(command.runId === undefined ? {} : { runId: command.runId }),
        scenario: item.scenario,
        ...(signal === undefined ? {} : { signal }),
        ...(store === undefined ? {} : { store }),
        workspacePath,
      });
      reports.push(report);
      if (!report.passed) break;
    }
    if (recorder !== null) await recorder.flush();
    if (loaded.length === 1) {
      return Object.freeze({
        ...reports[0]!,
        retainedWorkspace: temporaryRoot === null ? workspacePath : null,
      });
    }
    const passedStages = reports.filter((report) => report.passed).length;
    return Object.freeze({
      completedStages: reports.length,
      failedStages: reports.length - passedStages,
      passed: reports.length === loaded.length && passedStages === loaded.length,
      plannedStages: loaded.length,
      reports: Object.freeze(reports),
      retainedWorkspace: temporaryRoot === null ? workspacePath : null,
    });
  } finally {
    if (temporaryRoot !== null) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function executeCliCommand(command: CliCommand, options: ApplicationOptions): Promise<number> {
  switch (command.kind) {
    case "help":
      options.output.write(HELP_TEXT);
      return 0;
    case "version":
      options.output.write(GALAXY_CODE_VERSION);
      return 0;
    case "doctor": {
      const report = await doctor(options.cwd);
      writeValue(options.output, report, command.format);
      return report.ok ? 0 : 1;
    }
    case "tools":
      writeValue(options.output, toolsReport(), command.format);
      return 0;
    case "prompt":
      writeValue(options.output, await promptReport(command.task, options.cwd), command.format);
      return 0;
    case "run": {
      const report = await runOneFixture(command, options.signal);
      writeValue(options.output, report, command.format);
      return report.passed ? 0 : 1;
    }
    case "eval": {
      const report = await evaluateFixtures(command, options.signal);
      writeValue(options.output, report, command.format);
      return report.failed === 0 ? 0 : 1;
    }
    case "campaign": {
      const report = await runCampaign(command, options.signal);
      writeValue(options.output, report, command.format);
      return report.passed ? 0 : 1;
    }
    case "health": {
      const report = await runHealth(command, options.cwd, options.signal);
      writeValue(options.output, report, command.format);
      return report.passed ? 0 : 1;
    }
  }
}

export const CORE_CONTRACT_VERSIONS = Object.freeze({
  prompt: AI_CODER_PROMPT_VERSION,
  registry: AI_CODER_TOOL_REGISTRY_SCHEMA_VERSION,
});
