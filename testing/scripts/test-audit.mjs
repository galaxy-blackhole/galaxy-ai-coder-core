import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceManifest } from './source-baseline.mjs';
import { appendAuditEvent, reportEvidence, writeRunMarkdown } from './audit-journal.mjs';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = resolve(cliRoot, "..");
const helper = join(cliRoot, "scripts/run-node-tests.mjs");

export function parseOptions(args) {
  const options = { live: false, github: false, keepGoing: false, list: false, repeat: 1 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--keep-going') options.keepGoing = true;
    else if (["--live", "--github", "--list"].includes(arg)) options[arg.slice(2)] = true;
    else if (arg === '--repeat') {
      const value = args[++index];
      if (!/^[1-9][0-9]*$/.test(value ?? '') || Number(value) > 20) throw new Error('--repeat requires an integer from 1 to 20.');
      options.repeat = Number(value);
    } else if (arg === "--only" || arg === "--test-name") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      options[arg === "--only" ? "only" : "testName"] = value;
    } else throw new Error(`Unknown audit argument: ${arg}`);
  }
  if (options.repeat > 1 && !options.live) throw new Error('--repeat requires --live; it repeats only live campaigns.');
  if (options.testName !== undefined) {
    if (!options.only) throw new Error("--test-name requires --only <test-group>.");
    new RegExp(options.testName);
  }
  return options;
}

/**
 * One failure class per failed step: environmental (provider/network/deadline),
 * model-behavior (pause or oracle misses without a runtime error), or product
 * (everything else, including harness/tool-execution faults).
 */
function classifyFailure(result, step) {
  if (step.tests || !step.report || typeof result.detail === 'string') return 'product';
  const detail = result.detail;
  const code = detail && typeof detail === "object" && !Array.isArray(detail)
    ? detail.error?.code
    : undefined;
  if (code === "PAUSED") return "model-behavior";
  if (typeof code === "string" && ["PROVIDER_ERROR", "DEADLINE_EXCEEDED", "TIMEOUT", "CANCELED"].includes(code)) {
    return "environmental";
  }
  if (typeof code === "string" && code.length > 0) return "product";
  return "model-behavior";
}

async function filesUnder(root, suffix) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
  }
  return files.sort();
}

export async function buildPlan(options) {
  const nodeStep = (id, cwd, args, extra = {}) => ({ id, cwd, file: process.execPath, args, ...extra });
  const compiler = (id, cwd, config, extra = []) => nodeStep(id, cwd, ["node_modules/typescript/bin/tsc", "-p", config, ...extra]);
  const tests = async (id, cwd, directory, additional = []) => nodeStep(id, cwd, [
    "--import", "tsx", helper,
    ...(options.only === id && options.testName ? ["--name", options.testName] : []),
    ...await filesUnder(join(cwd, directory), ".test.ts"), ...additional,
  ], { tests: true });
  const coreBuild = compiler("core:build", coreRoot, "tsconfig.build.json");
  const cliBuild = compiler("cli:build", cliRoot, "tsconfig.build.json");
  const cli = (id, args, extra = {}) => nodeStep(id, cliRoot, ["dist/cli.js", ...args, "--json"], { workspace: true, report: true, ...extra });
  const plan = [
    compiler("core:typecheck", coreRoot, "tsconfig.json"),
    await tests("core:tests", coreRoot, "test"), coreBuild,
    nodeStep("core:dist", coreRoot, ["test/dist-smoke.mjs"]),
    compiler("cli:typecheck", cliRoot, "tsconfig.json", ["--noEmit"]),
    await tests("cli:unit", cliRoot, "test/unit", [join(cliRoot, "scripts/test-audit.test.mjs"), join(cliRoot, 'scripts/source-baseline.test.mjs')]),
    await tests("cli:integration", cliRoot, "test/integration"),
    cliBuild, await tests("cli:e2e", cliRoot, "test/e2e", [join(cliRoot, 'scripts/durable-research.test.mjs')]),
  ];
  for (const path of await filesUnder(join(cliRoot, "fixtures"), ".json")) {
    const id = path.slice(join(cliRoot, "fixtures").length + 1).replaceAll("\\", "/").replace(/\.json$/, "").replace(/^scenarios\//, "");
    plan.push(cli(`fixture:${id}`, ["run", "--fixture", path]));
  }
  for (const entry of (await readdir(join(cliRoot, "campaigns"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) plan.push(cli(`campaign:${entry.name}`, ["campaign", "--fixture", join(cliRoot, "campaigns", entry.name)]));
  }
  plan.push(cli("live:smoke", ["health", "--live", "--scenario", "live/scenarios/01-write-and-validate.json"], { optIn: "live" }));
  const liveDirectories = (await readdir(join(cliRoot, "live/scenarios"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const preferred = ["progressive", "advanced-commerce", "advanced-polyglot", "dependency-backed", "full-application", "advanced-resilience", "research"];
  liveDirectories.sort((a, b) => (preferred.indexOf(a) < 0 ? 99 : preferred.indexOf(a)) - (preferred.indexOf(b) < 0 ? 99 : preferred.indexOf(b)) || a.localeCompare(b));
  for (const name of liveDirectories) {
    plan.push(cli(`live:${name}`, ["health", "--live", "--scenario", `live/scenarios/${name}`], { optIn: "live" }));
  }
  plan.push(nodeStep('live:durable-research', cliRoot, ['scripts/durable-research-health.mjs', '--live'], {
    optIn: 'live', workspace: true, report: true,
  }));
  plan.push(nodeStep("github", cliRoot, ["scripts/github-lifecycle-health.mjs"], {
    optIn: "github", report: true, finishBeforeCancel: true, env: { GALAXY_GITHUB_LIFECYCLE_CONFIRM: "1" },
  }));
  const expand = steps => steps.flatMap(step => step.optIn === 'live' && options.repeat > 1
    ? Array.from({ length: options.repeat }, (_, index) => ({ ...step, campaignId: step.id, repetition: index + 1, id: `${step.id}:repeat-${index + 1}` }))
    : [step]);
  if (options.list) return expand(plan);
  if (!options.only) return expand(plan.filter((step) => !step.optIn || options[step.optIn]));
  const selected = plan.find((step) => step.id === options.only);
  if (!selected) throw new Error(`Unknown case '${options.only}'. Use --list.`);
  if (selected.optIn && !options[selected.optIn]) throw new Error(`${selected.id} requires --${selected.optIn}.`);
  if (options.testName && !selected.tests) throw new Error("--test-name only applies to core:tests / cli:unit / cli:integration / cli:e2e.");
  const prerequisites = selected.cwd === cliRoot && selected.id !== "github" ? [coreBuild, ...(selected.workspace || selected.id === "cli:e2e" ? [cliBuild] : [])]
    : selected.id === "core:dist" ? [coreBuild] : [];
  if (options.repeat > 1 && selected.optIn !== 'live') throw new Error('--repeat only applies to live campaigns.');
  return [...prerequisites.filter((step) => step.id !== selected.id), ...expand([selected])];
}

async function saveSummary(root, summary) {
  const path = join(root, "summary.json");
  await writeFile(`${path}.tmp`, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  await writeRunMarkdown(root, summary);
}

async function executeStep(step, directory, signal) {
  const stdoutLog = join(directory, "stdout.log");
  const stderrLog = join(directory, "stderr.log");
  const args = [...step.args,
    ...(step.workspace ? ["--workspace", join(directory, "workspace")] : []),
    ...(step.optIn === "live" ? ["--store-dir", join(directory, "store")] : []),
  ];
  // Audit tests launch isolated Node runners; do not inherit an enclosing test worker identity.
  const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
  const child = spawn(step.file, args, {
    cwd: step.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
    // Keep a terminal Ctrl+C from killing the GitHub lifecycle before finally cleanup.
    detached: step.finishBeforeCancel === true, windowsHide: true,
    env: { ...environment, ...step.env },
  });
  let spawnError;
  let interrupted = false;
  const cancel = () => {
    interrupted = true;
    if (!step.finishBeforeCancel) child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const completion = new Promise((resolveDone) => {
    child.once("error", (error) => { spawnError = error.message; });
    child.once("close", (code, terminationSignal) => resolveDone({ exitCode: code, signal: terminationSignal }));
  });
  const stdout = pipeline(child.stdout, createWriteStream(stdoutLog, { mode: 0o600 }));
  const stderr = pipeline(child.stderr, createWriteStream(stderrLog, { mode: 0o600 }));
  const result = await completion;
  await Promise.all([stdout, stderr]);
  signal?.removeEventListener("abort", cancel);
  let detail = spawnError ?? null;
  let testSummary = null;
  let campaignMetrics = null;
  if (step.tests && (await stat(stdoutLog)).size <= 16 * 1024 * 1024) {
    const lastLine = (await readFile(stdoutLog, "utf8")).trimEnd().split("\n").at(-1);
    try {
      const parsed = JSON.parse(lastLine);
      if (parsed.event === "audit:test-summary") {
        testSummary = parsed;
        detail = parsed.firstFailure;
      }
    } catch { /* Raw stdout/stderr remain the evidence if the worker crashed. */ }
  }
  if (step.report) {
    try {
      if ((await stat(stdoutLog)).size > 16 * 1024 * 1024) throw new Error("Report exceeds 16 MiB; inspect stdout.log.");
      const report = JSON.parse(await readFile(stdoutLog, "utf8"));
      const evidence = reportEvidence(report, step);
      campaignMetrics = evidence.campaignMetrics;
      detail = evidence.detail;
    } catch (error) { detail = `Invalid/missing JSON report: ${error.message}`; }
  }
  return { ...result, stdoutLog, stderrLog, detail, interrupted, testSummary, campaignMetrics };
}

export async function runSteps(steps, root, { execute = executeStep, signal, output = process.stdout, source, verifySource, keepGoing = false, journal, options } = {}) {
  const summary = {
    startedAt: new Date().toISOString(), status: "running",
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    planned: steps.map((step) => step.id), activeStep: null, steps: [],
    ...(source ? { source } : {}),
    ...(options ? { options } : {}),
  };
  await mkdir(root, { recursive: true, mode: 0o700 });
  await saveSummary(root, summary);
  if (journal) await appendAuditEvent(journal, root, summary, 'started');
  for (const [index, step] of steps.entries()) {
    if (signal?.aborted) { summary.status = "interrupted"; break; }
    const directory = join(root, `${String(index + 1).padStart(3, "0")}-${step.id.replace(/[^a-zA-Z0-9-]/g, "-")}`);
    await mkdir(directory, { mode: 0o700 });
    const startedAt = new Date().toISOString();
    summary.activeStep = { id: step.id, directory, startedAt };
    await saveSummary(root, summary);
    if (journal) await appendAuditEvent(journal, root, summary, 'step-started');
    output.write(`[${index + 1}/${steps.length}] RUN ${step.id}\n  ${directory}\n`);
    const start = Date.now();
    let result;
    try { result = await execute(step, directory, signal); }
    catch (error) { result = { exitCode: 1, detail: error.message }; }
    const passed = result.exitCode === 0 && result.detail == null && !result.interrupted;
    const failureClass = passed ? null : classifyFailure(result, step);
    summary.steps.push({ id: step.id, campaignId: step.campaignId ?? step.id, repetition: step.repetition ?? 1, passed, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - start, ...result, ...(passed ? {} : { failureClass }) });
    summary.activeStep = null;
    if (!passed) {
      summary.status = result.interrupted ? 'interrupted' : 'failed';
      summary.failedStep ??= step.id;
    }
    await saveSummary(root, summary);
    if (journal) await appendAuditEvent(journal, root, summary, passed ? 'step-passed' : 'step-failed');
    if (!passed) {
      const continued = keepGoing && step.optIn !== undefined && !result.interrupted;
      output.write(`${continued ? "FAIL (continued)" : "STOP"} ${step.id}${failureClass ? ` [${failureClass}]` : ""}\n  stdout: ${result.stdoutLog ?? directory}\n  stderr: ${result.stderrLog ?? directory}\n`);
      if (result.detail) output.write(`${JSON.stringify(result.detail)}\n`);
      if (!continued) break;
    }
    if (passed) output.write(`PASS ${step.id}\n`);
  }
  if (summary.status === "running") summary.status = "passed";
  summary.failureClasses = Object.fromEntries(["environmental", "model-behavior", "product"].map((className) => [
    className,
    summary.steps.filter((step) => step.failureClass === className).length,
  ]));
  summary.stability = Object.fromEntries([...new Set(steps.filter(step => step.optIn === 'live').map(step => step.campaignId ?? step.id))].map(id => {
    const attempted = summary.steps.filter(step => step.campaignId === id);
    return [id, { planned: steps.filter(step => (step.campaignId ?? step.id) === id).length,
      attempted: attempted.length, passed: attempted.filter(step => step.passed).length,
      failed: attempted.filter(step => !step.passed).length,
      passRateAmongAttempted: attempted.length ? attempted.filter(step => step.passed).length / attempted.length : null,
      observations: attempted.flatMap(step => step.campaignMetrics ?? []),
    }];
  }));
  if (source && verifySource) {
    const after = await verifySource();
    summary.sourceUnchanged = source.sha256 === after.sha256;
    summary.finalSourceSha256 = after.sha256;
    if (!summary.sourceUnchanged) {
      summary.status = 'failed';
      summary.failedStep ??= 'source-drift';
      output.write('STOP source-drift: source changed during audit; this run cannot certify a single revision.\n');
    }
  }
  summary.finishedAt = new Date().toISOString();
  await saveSummary(root, summary);
  if (journal) await appendAuditEvent(journal, root, summary, 'finished');
  output.write(`Audit ${summary.status}: ${join(root, "summary.json")}\n`);
  return summary;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const plan = await buildPlan(options);
  if (options.list) {
    for (const step of plan) process.stdout.write(`${step.id}${step.optIn ? ` (requires --${step.optIn})` : ""}\n`);
    return;
  }
  const base = join(cliRoot, ".galaxy/audit");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const source = await sourceManifest();
    const result = await runSteps(plan, root, {
      signal: controller.signal, source, verifySource: sourceManifest, keepGoing: options.keepGoing,
      journal: join(cliRoot, 'TEST_ERROR_LOG.md'), options,
    });
    process.exitCode = result.status === "passed" ? 0 : 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`audit: ${error.message}\n`); process.exitCode = 2; });
}
