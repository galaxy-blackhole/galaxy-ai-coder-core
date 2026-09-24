import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timezone = 'Asia/Ho_Chi_Minh';

export function timestamp(value) {
  if (!value) return 'not recorded';
  return `${new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(value))} +07:00 (${value})`;
}

function redact(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

function cell(value) {
  return redact(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('`', '&#96;').replace(/\r?\n/g, '<br>');
}

function block(value) {
  const content = redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const fence = '`'.repeat(Math.max(3, ...(content.match(/`+/g) ?? []).map(x => x.length + 1)));
  return `${fence}text\n${content}\n${fence}`;
}

function link(from, path, label) {
  return path ? `[${cell(label)}](<${relative(from, path).split('\\').join('/')}>)` : 'not recorded';
}

export function progress(summary) {
  const done = summary.steps.length;
  const passed = summary.steps.filter(step => step.passed).length;
  const total = summary.planned.length;
  return { done, passed, failed: done - passed, total, notRun: total - done - (summary.activeStep ? 1 : 0) };
}

function incidentCandidates(step, report) {
  const evidence = JSON.stringify(report);
  const incidents = [];
  if (step.id.includes('durable-research')) incidents.push('INC-007');
  if (/https?:\/\/[^"\\\s]*\*{1,2}:/.test(evidence)) incidents.push('INC-001');
  if (/LIMIT_EXCEEDED|byte limit/.test(evidence) && /dependency|node_modules|next|angular/i.test(evidence)) incidents.push('INC-003');
  if (/DEADLINE_EXCEEDED|deadline exceeded/i.test(evidence)) incidents.push('INC-004');
  if ((step.campaignId ?? step.id).includes('live:smoke') && (/does not match the scenario/i.test(evidence) || /PRECONDITION_FAILED/.test(evidence))) incidents.push('INC-008');
  if (/Patch target (was not found|is ambiguous)/.test(evidence)) incidents.push('INC-009');
  if (/RESEARCH_CITATION_UNSUPPORTED|without successful fetch evidence|unsupportedCitations/.test(evidence)) incidents.push('INC-010');
  return [...new Set(incidents)];
}

function boundedEvidenceText(value, maxLength = 12000) {
  const text = String(value ?? '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} characters]`;
}

/** Retain bounded failure evidence; full tool payloads stay in stdout.log. */
export function reportEvidence(report, step) {
  const items = report.reports ?? [report];
  const failed = items.find(item => !item.passed) ?? report;
  return {
    campaignMetrics: step.optIn === 'live' || step.campaignMetrics ? items.map(item => ({
      scenario: item.scenario ?? step.campaignId ?? step.id, passed: item.passed === true,
      runId: item.runId ?? null, model: item.connection?.model ?? null,
      toolCalls: item.toolSequence?.length ?? item.metrics?.toolCalls ?? null,
      retries: item.modelRetries?.length ?? item.metrics?.retries ?? null,
      compactions: item.checkpointReasons?.filter(reason => !['failure', 'pause'].includes(reason)).length ?? item.metrics?.compactions ?? null,
      completionRejections: item.completionRejections?.length ?? item.metrics?.completionRejections ?? null,
      warnings: item.warnings ?? [], error: item.error ?? null,
    })) : null,
    detail: report.passed === true && failed.passed === true ? null : {
      case: failed.scenario ?? failed.fixture ?? step.id,
      candidateIncidentIds: incidentCandidates(step, failed),
      diagnosedCause: failed.diagnosedCause ?? null,
      failures: failed.failures ?? [], error: failed.error ?? null,
      runId: failed.runId ?? null, model: failed.connection?.model ?? null,
      effectiveBudget: failed.effectiveBudget ?? null,
      phase: failed.transitions?.at(-1) ?? null,
      pauseReason: failed.pauseReason ?? null,
      completionRejections: failed.completionRejections ?? [],
      completionRejectionDetails: (failed.completionRejectionDetails ?? []).map(item => ({
        candidate: boundedEvidenceText(item.candidate),
        issues: item.issues ?? [],
        researchEvidence: item.researchEvidence ?? null,
      })),
      modelRetries: failed.modelRetries ?? [],
      validation: failed.validation?.map(item => ({ id: item.id, status: item.status, sequence: item.sequence })) ?? [],
      lastTools: failed.toolJournal?.slice(-5).map(item => ({
        tool: item.toolName, callId: item.toolCallId, ok: item.ok, errorCode: item.errorCode,
        errorMessage: item.errorMessage ?? null,
        argumentsHash: item.argumentsHash ?? null,
        argumentsExcerpt: boundedEvidenceText(item.argumentsExcerpt, 2000),
        resultExcerpt: boundedEvidenceText(item.resultExcerpt, 2000),
      })) ?? [],
    },
  };
}

/** A symptom key, not a claim about root cause or whether an earlier fix regressed. */
export function failureSignature(step) {
  const detail = step.detail;
  const codes = (detail?.completionRejections ?? []).flat().map(reason => reason.split(':')[0]);
  const key = [step.campaignId ?? step.id.replace(/:repeat-\d+$/, ''),
    detail?.case ?? detail?.name ?? '', detail?.error?.code ?? '', [...new Set(codes)].sort(),
    detail?.error?.message ?? detail?.error ?? detail?.failures ?? detail ?? 'nonzero exit'];
  return createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 16);
}

export function renderRun(summary, root, outputDirectory = root, previous = []) {
  const count = progress(summary);
  const runId = basename(root);
  const lines = [
    `## Run ${cell(runId)}`, '',
    `- Status: **${cell(summary.status)}**. DONE ${count.done}/${count.total}; PASS ${count.passed}/${count.total}; FAIL ${count.failed}; NOT RUN ${count.notRun}; RUNNING ${summary.activeStep ? 1 : 0}.`,
    `- Started: ${timestamp(summary.startedAt)}. Finished: ${timestamp(summary.finishedAt)}.`,
    `- Last PASS: ${cell(summary.steps.findLast(step => step.passed)?.id ?? 'none')}. First failure: ${cell(summary.failedStep ?? 'none')}. Active: ${cell(summary.activeStep?.id ?? 'none')}.`,
    `- Evidence: ${link(outputDirectory, join(root, 'summary.json'), 'summary.json')}.`,
    `- Source SHA-256: ${cell(summary.source?.sha256 ?? 'not recorded')}. Source unchanged: ${cell(summary.sourceUnchanged ?? 'not verified')}.`,
    `- Repositories: ${cell(JSON.stringify(summary.source?.repositories ?? {}))}.`,
    `- Environment: ${cell(JSON.stringify(summary.environment ?? {}))}. Options: ${cell(JSON.stringify(summary.options ?? {}))}.`,
    ...(summary.traceWarnings ?? []).map(warning => `- Trace warning: ${cell(warning)}.`),
    '', 'DONE counts finished steps, including failures; PASS counts successful steps. Audit groups, scenario stages and individual tests have separate denominators.', '',
    '| Step | Result | Started (+07:00 and UTC) | Finished (+07:00 and UTC) | Detail / evidence |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [index, id] of summary.planned.entries()) {
    const step = summary.steps.find(item => item.id === id);
    const active = summary.activeStep?.id === id;
    const status = step ? (step.interrupted ? 'INTERRUPTED' : step.passed ? 'PASS' : 'FAIL') : active ? 'RUNNING' : 'NOT RUN';
    const counts = step?.testSummary;
    const tests = counts ? `Tests: ${counts.passed} passed, ${counts.failed ?? (counts.firstFailure ? 1 : 0)} failed, ${counts.skipped} skipped; total ${counts.total ?? 'not recorded'}. Last PASS: ${cell(counts.lastPassed?.name ?? 'not recorded')}. ` : '';
    lines.push(`| ${index + 1}/${count.total} ${cell(id)} | ${status} | ${cell(timestamp(step?.startedAt ?? (active ? summary.activeStep.startedAt : null)))} | ${cell(timestamp(step?.finishedAt))} | ${tests}${link(outputDirectory, step?.stdoutLog, 'stdout')} / ${link(outputDirectory, step?.stderrLog, 'stderr')} |`);
  }
  for (const [index, step] of summary.steps.entries()) {
    if (!step.campaignMetrics?.length) continue;
    lines.push('', `### Scenarios in step ${index + 1}: ${cell(step.id)}`, '',
      `Reported stages: ${step.campaignMetrics.filter(item => item.passed).length}/${step.campaignMetrics.length} PASS. This is not the planned stage count.`, '',
      '| Scenario / run ID / model | Result | Tools / retries / compactions / completion rejections |', '| --- | --- | --- |');
    for (const item of step.campaignMetrics) lines.push(`| ${cell(item.scenario)} / ${cell(item.runId)} / ${cell(item.model)} | ${item.passed ? 'PASS' : 'FAIL'} | ${item.toolCalls ?? '?'} / ${item.retries ?? '?'} / ${item.compactions ?? '?'} / ${item.completionRejections ?? '?'} |`);
  }
  for (const step of summary.steps.filter(item => !item.passed)) {
    const signature = failureSignature(step);
    const matches = previous.filter(item => item.summary.steps.some(old => !old.passed && failureSignature(old) === signature));
    lines.push('', `### Failure: ${cell(step.id)}`, '',
      `Symptom signature: ${signature}. Automated category: ${cell(step.failureClass ?? 'unknown')}; candidate incidents: ${cell((step.detail?.candidateIncidentIds ?? []).join(', ') || 'none')}; diagnosed cause: ${cell(step.detail?.diagnosedCause ?? 'not yet diagnosed')}.`, '',
      `Earlier matching runs: ${matches.length ? matches.map(item => link(outputDirectory, join(item.root, 'summary.md'), basename(item.root))).join(', ') : 'none among retained logs'}. A match alone does not establish a regression.`, '',
      block(step.detail ?? { exitCode: step.exitCode, signal: step.signal }), '',
      `Resolution and regression requirements: ${link(outputDirectory, join(cliRoot, 'docs/TEST_FAILURE_ANALYSIS.md'), 'incident register and upstream references')}.`);
  }
  if (summary.sourceUnchanged === false) lines.push('', '**SOURCE DRIFT:** source changed during this run; passing steps do not certify a single source revision.');
  if (summary.steps.some(step => !step.startedAt)) lines.push('', 'Historical import: per-step wall-clock timestamps were not recorded. Durations and audit start/end are retained; exact step timestamps are not reconstructed.');
  return lines.join('\n') + '\n';
}

export async function writeRunMarkdown(root, summary) {
  const path = join(root, 'summary.md');
  await writeFile(`${path}.tmp`, renderRun(summary, root), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function retainedRuns(base) {
  const runs = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(base, entry.name);
    try {
      const summary = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8'));
      for (const step of summary.steps) {
        if (!step.campaignMetrics || step.campaignMetrics.every(item => 'runId' in item)) continue;
        try {
          const report = JSON.parse(await readFile(step.stdoutLog, 'utf8'));
          Object.assign(step, reportEvidence(report, step));
        } catch (error) {
          (summary.traceWarnings ??= []).push(`${step.id}: historical report unavailable (${error.code ?? error.name})`);
        }
      }
      runs.push({ root, summary });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return runs.sort((a, b) => a.summary.startedAt.localeCompare(b.summary.startedAt));
}

/** Append records; independent audits never rewrite each other's journal history. */
export async function appendAuditEvent(journal, root, summary, event) {
  const count = progress(summary);
  const step = summary.activeStep?.id ?? summary.steps.at(-1)?.id ?? '-';
  await mkdir(dirname(journal), { recursive: true });
  if (event === 'finished') {
    const previous = (await retainedRuns(dirname(root))).filter(item => item.root !== root && item.summary.startedAt < summary.startedAt);
    await appendFile(journal, `\n<!-- audit-finished:${basename(root)} -->\n${renderRun(summary, root, dirname(journal), previous)}`, { mode: 0o600 });
  } else {
    const time = event === 'started' ? summary.startedAt : event === 'step-started' ? summary.activeStep.startedAt : summary.steps.at(-1).finishedAt;
    const position = event === 'started' ? '-' : `${summary.planned.indexOf(step) + 1}/${count.total}`;
    await appendFile(journal, `\n- ${timestamp(time)} | run ${basename(root)} | ${event} ${position} ${cell(step)} | DONE ${count.done}/${count.total}; PASS ${count.passed}/${count.total}; FAIL ${count.failed} | ${link(dirname(journal), join(root, 'summary.md'), 'run trace')}\n`, { mode: 0o600 });
  }
}

/** Imports retained evidence without overwriting JSON logs or inventing missing times. */
export async function importAuditHistory(base, journal) {
  const runs = await retainedRuns(base);
  let existing = '';
  try { existing = await readFile(journal, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let imported = 0;
  for (const item of runs) {
    await writeRunMarkdown(item.root, item.summary);
    const marker = `<!-- audit-finished:${basename(item.root)} -->`;
    if (existing.includes(marker) || item.summary.status === 'running') continue;
    await appendAuditEvent(journal, item.root, item.summary, 'finished');
    imported++;
  }
  return { retained: runs.length, imported, journal };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  importAuditHistory(join(cliRoot, '.galaxy/audit'), join(cliRoot, 'TEST_ERROR_LOG.md'))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
