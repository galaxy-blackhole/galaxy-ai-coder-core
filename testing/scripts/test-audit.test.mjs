import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPlan, parseOptions, runSteps } from "./test-audit.mjs";
import { failureSignature, importAuditHistory, progress, renderRun, reportEvidence } from './audit-journal.mjs';

const helper = fileURLToPath(new URL("./run-node-tests.mjs", import.meta.url));

async function temporary(context) {
  const path = await mkdtemp(join(tmpdir(), "galaxy-audit-test-"));
  context.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function executeHelper(args) {
  return new Promise((resolve, reject) => {
    const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
    const child = spawn(process.execPath, [helper, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("audit stops at a failed step and persists evidence without starting later steps", async (context) => {
  const root = await temporary(context);
  const executed = [];
  const result = await runSteps([{ id: "pass" }, { id: "fail" }, { id: "never" }], root, {
    output: { write() {} },
    async execute(step) {
      executed.push(step.id);
      return { exitCode: step.id === "fail" ? 1 : 0, stderrLog: "failure.log" };
    },
  });
  assert.deepEqual(executed, ["pass", "fail"]);
  assert.equal(result.failedStep, "fail");
  assert.equal(result.status, "failed");
  assert.deepEqual(JSON.parse(await readFile(join(root, "summary.json"), "utf8")), result);
});

test("audit exposes exact failed Node test and aborts queued test files", async (context) => {
  const root = await temporary(context);
  const broken = join(root, "01-broken.mjs");
  const later = join(root, "02-later.mjs");
  await writeFile(broken, "import test from 'node:test'; test('intentional first failure', () => { throw new Error('audit failure evidence'); });\n");
  await writeFile(later, "import test from 'node:test'; test('must not start', () => { console.log('LATER_TEST_EXECUTED'); });\n");
  const result = await executeHelper([broken, later]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /intentional first failure/);
  assert.match(result.stderr, /audit failure evidence/);
  assert.doesNotMatch(result.stdout, /LATER_TEST_EXECUTED/);
});

test("audit name filter fails if it executes no tests", async (context) => {
  const root = await temporary(context);
  const file = join(root, "test.mjs");
  await writeFile(file, "import test from 'node:test'; test('one known case', () => {});\n");
  const result = await executeHelper(["--name", "does not exist", file]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No matching tests executed/);
  const passed = await executeHelper(["--name", "one known case", file]);
  assert.equal(passed.code, 0, passed.stderr);
});

test("audit live and GitHub checks require explicit flags and use separate campaign invocations", async () => {
  const offline = await buildPlan(parseOptions([]));
  assert.ok(offline.every((step) => !step.optIn));
  await assert.rejects(buildPlan(parseOptions(["--only", "live:dependency-backed"])), /requires --live/);
  await assert.rejects(buildPlan(parseOptions(["--only", "github"])), /requires --github/);
  const selected = await buildPlan(parseOptions(["--live", "--only", "live:dependency-backed"]));
  assert.deepEqual(selected.map((step) => step.id), ["core:build", "cli:build", "live:dependency-backed"]);
  const full = await buildPlan(parseOptions(["--live", "--github"]));
  assert.deepEqual(full.filter((step) => step.optIn === "live").map((step) => step.id), [
    "live:smoke", "live:progressive", "live:advanced-commerce", "live:advanced-polyglot",
    "live:dependency-backed", "live:full-application", "live:advanced-resilience", "live:research",
    "live:high-compaction", "live:durable-research",
  ]);
  assert.ok(full.every((step) => !step.args.includes("live/scenarios")));
  assert.equal(full.find((step) => step.id === "github").env.GALAXY_GITHUB_LIFECYCLE_CONFIRM, "1");
  await assert.rejects(buildPlan(parseOptions(["--only", "fixture:empty-terminal-response", "--test-name", "x"])), /only applies/);
});

test('live repeat uses isolated steps, stops on the first failure and counts only attempted runs', async context => {
  const root=await temporary(context);
  const plan=await buildPlan(parseOptions(['--live','--only','live:research','--repeat','3']));
  assert.deepEqual(plan.map(step=>step.id),['core:build','cli:build','live:research:repeat-1','live:research:repeat-2','live:research:repeat-3']);
  const result=await runSteps(plan,root,{output:{write(){}},execute:async step=>({exitCode:step.repetition===2?1:0})});
  assert.equal(result.status,'failed');
  assert.equal(result.steps.length,4);
  assert.equal(result.stability['live:research'].planned,3);
  assert.equal(result.stability['live:research'].attempted,2);
  assert.equal(result.stability['live:research'].passRateAmongAttempted,0.5);
  for(const value of ['0','21','2.5','NaN'])assert.throws(()=>parseOptions(['--live','--repeat',value]));
  assert.throws(()=>parseOptions(['--repeat','3']),/requires --live/);
  await assert.rejects(buildPlan(parseOptions(['--live','--only','cli:unit','--repeat','3'])),/only applies/);
});

test('audit keep-going continues past failed live steps and classifies failures', async context => {
  const root=await temporary(context);
  const executed=[];
  const steps=[
    {id:'live:flake',optIn:'live',campaignId:'live:flake',report:true},
    {id:'live:ok',optIn:'live',campaignId:'live:ok',report:true},
    {id:'fixture:after-live',report:true},
  ];
  let output = '';
  const result=await runSteps(steps,root,{
    keepGoing:parseOptions(['--live', '--keep-going']).keepGoing,
    output:{write(value){output += value;}},
    async execute(step){
      executed.push(step.id);
      if(step.id==='live:flake')return{exitCode:1,detail:{case:'flake',failures:[],error:{code:'PROVIDER_ERROR',message:'transport failed'}}};
      return{exitCode:0};
    },
  });
  assert.deepEqual(executed,['live:flake','live:ok','fixture:after-live']);
  assert.equal(result.status,'failed');
  assert.equal(result.failedStep,'live:flake');
  assert.deepEqual(result.failureClasses,{environmental:1,'model-behavior':0,product:0});
  assert.equal(result.steps.find(step=>step.id==='live:flake').failureClass,'environmental');
  assert.match(output, /FAIL \(continued\) live:flake/);
  assert.doesNotMatch(output, /PASS live:flake/);

  const stoppedRoot=await temporary(context);
  const stopped=await runSteps(steps,stoppedRoot,{
    keepGoing:true,
    output:{write(){}},
    async execute(step){
      if(step.id!=='live:flake')return{exitCode:1,detail:{case:'oracle',failures:['Expected status completed, received paused.'],error:null}};
      return{exitCode:0};
    },
  });
  assert.equal(stopped.steps.length,3,"keep-going still stops at the first non-opt-in failure");
  assert.equal(stopped.failedStep,'live:ok');
  assert.equal(stopped.steps[1].failureClass,'model-behavior');
  assert.equal(stopped.steps[2].failureClass,'model-behavior');
  assert.deepEqual(stopped.failureClasses,{environmental:0,'model-behavior':2,product:0});
});

test('audit journals exact timestamps, last success, failure trace and unattempted steps', async context => {
  const base = await temporary(context);
  const root = join(base, 'runs/run-a');
  const journal = join(base, 'TEST_ERROR_LOG.md');
  const result = await runSteps([{ id: 'first' }, { id: 'broken', tests: true }, { id: 'later' }], root, {
    journal, output: { write() {} }, source: { sha256: 'source-test', repositories: { core: { head: 'commit-test' } } },
    async execute(step) {
      const current = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8'));
      assert.equal(current.activeStep.id, step.id);
      assert.ok(Date.parse(current.activeStep.startedAt));
      assert.match(await readFile(join(root, 'summary.md'), 'utf8'), /RUNNING/);
      return step.id === 'broken' ? { exitCode: 1, detail: { name: 'assertion name', file: 'test/file.ts', line: 42, error: 'Error: expected value\n at test/file.ts:42' } } : { exitCode: 0 };
    },
  });
  assert.deepEqual(progress(result), { done: 2, passed: 1, failed: 1, total: 3, notRun: 1 });
  assert.equal(result.steps[1].failureClass, 'product');
  for (const step of result.steps) assert.ok(Date.parse(step.startedAt) <= Date.parse(step.finishedAt));
  const report = await readFile(journal, 'utf8');
  assert.match(report, /DONE 2\/3; PASS 1\/3; FAIL 1; NOT RUN 1/);
  assert.match(report, /Last PASS: first/);
  assert.match(report, /3\/3 later \| NOT RUN/);
  assert.match(report, /assertion name/);
  assert.match(report, /test\/file.ts:42/);
  assert.match(report, /\+07:00/);
  assert.match(report, /source-test/);
});

test('audit history import is idempotent, preserves JSON and does not invent historical step times', async context => {
  const base = await temporary(context);
  const root = join(base, 'runs/legacy');
  await mkdir(root, { recursive: true });
  const old = { startedAt: '2026-09-18T02:00:00.000Z', finishedAt: '2026-09-18T02:05:00.000Z', status: 'failed',
    planned: ['old', 'unrun'], failedStep: 'old', activeStep: null,
    steps: [{ id: 'old', passed: false, durationMs: 300000, detail: { error: { code: 'MAX_TURNS', message: 'limit' } } }] };
  const bytes = JSON.stringify(old);
  await writeFile(join(root, 'summary.json'), bytes);
  const journal = join(base, 'TEST_ERROR_LOG.md');
  assert.equal((await importAuditHistory(join(base, 'runs'), journal)).imported, 1);
  assert.equal((await importAuditHistory(join(base, 'runs'), journal)).imported, 0);
  assert.equal(await readFile(join(root, 'summary.json'), 'utf8'), bytes);
  assert.match(await readFile(journal, 'utf8'), /Historical import: per-step wall-clock timestamps were not recorded/);
  assert.match(await readFile(journal, 'utf8'), /2026-09-18 09:00:00/);
});

test('concurrent audits append both runs and repeat symptoms reference earlier evidence', async context => {
  const base = await temporary(context);
  const journal = join(base, 'TEST_ERROR_LOG.md');
  const execute = async () => ({ exitCode: 1, detail: { case: 'known', error: { code: 'NO_PROGRESS', message: 'same symptom' } } });
  await Promise.all(['run-one', 'run-two'].map(id => runSteps([{ id: 'live:case', optIn: 'live' }], join(base, 'runs', id), {
    journal, execute, output: { write() {} },
  })));
  const contents = await readFile(journal, 'utf8');
  for (const id of ['run-one', 'run-two']) assert.equal(contents.split(`<!-- audit-finished:${id} -->`).length, 2);
  const step = { id: 'live:case:repeat-1', detail: { case: 'known', error: { code: 'NO_PROGRESS', message: 'same symptom' } } };
  assert.equal(failureSignature(step), failureSignature({ ...step, id: 'live:case:repeat-2' }));
  const old = { root: join(base, 'old'), summary: { steps: [{ ...step, passed: false }] } };
  const rendered = renderRun({ startedAt: new Date().toISOString(), status: 'failed', planned: [step.id], steps: [{ ...step, passed: false }] }, join(base, 'new'), base, [old]);
  assert.match(rendered, /Earlier matching runs: \[old\]/);
});

test('Markdown logs escape table content and redact credentials without hiding original evidence paths', () => {
  const rendered = renderRun({ startedAt: '2026-09-18T00:00:00Z', status: 'failed', planned: ['bad|name'],
    steps: [{ id: 'bad|name', passed: false, detail: 'Bearer secret-token api_key=private-key ```' }] }, '/tmp/audit/run');
  assert.match(rendered, /bad&#124;name/);
  assert.match(rendered, /\[REDACTED\]/);
  assert.doesNotMatch(rendered, /secret-token|private-key/);
  assert.match(rendered, /````text/);
});

test('audit failure evidence retains completion candidates, source ledger and tool diagnostics', () => {
  const captured = reportEvidence({
    passed: false,
    scenario: 'research recovery',
    completionRejections: [['RESEARCH_CITATION_UNSUPPORTED: unfetched URL']],
    completionRejectionDetails: [{
      candidate: 'Candidate citing https://search.example/result',
      issues: ['RESEARCH_CITATION_UNSUPPORTED: unfetched URL'],
      researchEvidence: {
        fetchedUrls: ['https://docs.example/guide'],
        searchOnlyUrls: ['https://search.example/result'],
        sources: [{ contentHash: 'sha256:fetched', kind: 'fetch', toolCallId: 'fetch-1', url: 'https://docs.example/guide' }],
        unsupportedCitations: ['https://search.example/result'],
      },
    }],
    toolJournal: [{
      argumentsHash: 'sha256:args',
      argumentsExcerpt: '{"url":"https://search.example/result"}',
      errorCode: 'PROVIDER_ERROR',
      errorMessage: 'invalid page schema (payloadSha256=abc)',
      ok: false,
      resultExcerpt: 'provider rejected schema',
      toolCallId: 'fetch-1',
      toolName: 'fetch_url',
    }],
  }, { id: 'live:research', optIn: 'live' });
  assert.deepEqual(captured.detail.candidateIncidentIds, ['INC-010']);
  assert.equal(captured.detail.diagnosedCause, null);
  assert.match(captured.detail.completionRejectionDetails[0].candidate, /search\.example/);
  assert.deepEqual(captured.detail.completionRejectionDetails[0].researchEvidence.fetchedUrls, ['https://docs.example/guide']);
  assert.equal(captured.detail.completionRejectionDetails[0].researchEvidence.sources[0].toolCallId, 'fetch-1');
  assert.match(captured.detail.lastTools[0].errorMessage, /payloadSha256/);
  assert.match(captured.detail.lastTools[0].argumentsExcerpt, /search\.example/);
});

test('audit incident matcher maps structural failure families to candidate incidents', () => {
  const candidates = (step, report) => reportEvidence(report, step).detail.candidateIncidentIds;
  assert.deepEqual(candidates({ id: 'live:advanced-resilience:repeat-1' }, {
    passed: false,
    toolJournal: [{ toolName: 'edit_file', ok: false, errorCode: 'CONFLICT', errorMessage: 'Patch target was not found.', argumentsHash: 'sha256:a', argumentsExcerpt: '{}', resultExcerpt: '', toolCallId: 't1' }],
  }), ['INC-009']);
  assert.deepEqual(candidates({ id: 'live:smoke:repeat-2' }, {
    passed: false,
    failures: ["File 'hello.txt' content does not match the scenario."],
    toolJournal: [{ toolName: 'write_file', ok: false, errorCode: 'PRECONDITION_FAILED', errorMessage: 'The target already exists.', argumentsHash: 'sha256:b', argumentsExcerpt: '{}', resultExcerpt: '', toolCallId: 't2' }],
  }), ['INC-008']);
  assert.deepEqual(candidates({ id: 'live:advanced-polyglot:repeat-1' }, {
    passed: false,
    error: { code: 'DEADLINE_EXCEEDED', message: 'AI Coder run deadline exceeded.' },
  }), ['INC-004']);
  assert.deepEqual(candidates({ id: 'live:durable-research:repeat-1' }, {
    passed: false,
    failures: ['Final response cites URLs without successful fetch evidence; inspect research.unsupportedCitations.'],
  }), ['INC-007', 'INC-010']);
  assert.deepEqual(candidates({ id: 'live:research:repeat-1' }, {
    passed: false,
    research: { unsupportedCitations: ['https://docs.example/guide**: trailing markdown'] },
  }), ['INC-001', 'INC-010']);
});

test('audit cannot certify source that changed during a passing run',async context=>{
  const root=await temporary(context);
  const result=await runSteps([{id:'pass'}],root,{output:{write(){}},source:{sha256:'before'},verifySource:async()=>({sha256:'after'}),execute:async()=>({exitCode:0})});
  assert.equal(result.status,'failed');assert.equal(result.failedStep,'source-drift');assert.equal(result.sourceUnchanged,false);
});

test("audit JSON oracle failure stops even when the child exits zero and keeps its workspace", async (context) => {
  const root = await temporary(context);
  const producer = join(root, "producer.mjs");
  await writeFile(producer, "import { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path'; const workspace = process.argv.at(-1); await mkdir(workspace); await writeFile(join(workspace, 'evidence.txt'), 'keep me'); console.log(JSON.stringify({ passed:false, reports:[{passed:false, scenario:'stage 2', failures:['wrong file bytes']}] }));\n");
  const result = await runSteps([
    { id: "live:failure", file: process.execPath, args: [producer], cwd: root, report: true, workspace: true },
    { id: "never" },
  ], join(root, "logs"), { output: { write() {} } });
  assert.equal(result.status, "failed");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].detail.case, "stage 2");
  assert.equal(await readFile(join(root, "logs/001-live-failure/workspace/evidence.txt"), "utf8"), "keep me");
});

test("audit interruption lets an external cleanup step finish before stopping", async (context) => {
  const root = await temporary(context);
  const producer = join(root, "cleanup.mjs");
  await writeFile(producer, "process.on('SIGTERM', () => process.exit(2)); setTimeout(() => console.log('cleanup finished'), 150);\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  context.after(() => clearTimeout(timer));
  const result = await runSteps([
    { id: "external", file: process.execPath, args: [producer], cwd: root, finishBeforeCancel: true },
    { id: "never" },
  ], join(root, "logs"), { signal: controller.signal, output: { write() {} } });
  assert.equal(result.status, "interrupted");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].exitCode, 0);
  assert.match(await readFile(result.steps[0].stdoutLog, "utf8"), /cleanup finished/);
});
