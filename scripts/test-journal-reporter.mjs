import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function time(value) {
  return `${new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(value))} +07:00 (${value})`;
}

function text(value) {
  return String(value ?? '').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, '$1[REDACTED]')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;').replaceAll('`', '&#96;').replace(/\r?\n/g, '<br>');
}

async function sourceIdentity() {
  const hash = createHash('sha256');
  async function visit(path) {
    for (const entry of (await readdir(join(repository, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && !['node_modules', '.galaxy', '.git', 'dist'].includes(entry.name)) await visit(child);
      else if (entry.isFile()) hash.update(child).update('\0').update(await readFile(join(repository, child))).update('\0');
    }
  }
  for (const path of ['src', 'test', 'scripts']) await visit(path);
  for (const name of (await readdir(repository)).filter(name => /^(package(-lock)?\.json|tsconfig.*\.json)$/.test(name)).sort()) {
    hash.update(name).update('\0').update(await readFile(join(repository, name))).update('\0');
  }
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Archives may not include .git. */ }
  return { commit, sha256: hash.digest('hex'), packageVersion: JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version };
}

/** Development-only Node reporter; the published core has no CLI or filesystem dependency. */
export default async function* report(events) {
  const logRoot = process.env.GALAXY_TEST_JOURNAL_DIRECTORY ?? repository;
  const base = join(logRoot, '.galaxy/tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
  const journal = join(logRoot, 'TEST_ERROR_LOG.md');
  const runId = relative(base, root);
  const summary = { runId, startedAt: new Date().toISOString(), status: 'running',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    source: await sourceIdentity(), tests: [], counts: null };
  const save = async () => {
    await writeFile(join(root, 'summary.json.tmp'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    await rename(join(root, 'summary.json.tmp'), join(root, 'summary.json'));
  };
  await save();
  await writeFile(join(root, 'summary.md'), `# Core unit test run ${runId}\n\nStarted: ${time(summary.startedAt)}. Source: ${summary.source.sha256}.\n\n| Recorded time | Result | Test | Location |\n| --- | --- | --- | --- |\n`, { mode: 0o600 });
  await appendFile(journal, `\n## Core tests ${runId}\n\nSTART ${time(summary.startedAt)}. [Progress](<.galaxy/tests/${runId}/summary.md>). Commit: ${summary.source.commit ?? 'not recorded'}; source SHA-256: ${summary.source.sha256}.\n`, { mode: 0o600 });
  for await (const { type, data } of events) {
    if (type === 'test:summary' && !data.file) summary.counts = data.counts;
    if (!['test:pass', 'test:fail', 'test:stdout', 'test:stderr'].includes(type)) continue;
    const recordedAt = new Date().toISOString();
    const entry = { type, recordedAt, name: data.name, file: data.file, line: data.line,
      skip: data.skip, todo: data.todo, kind: data.details?.type,
      durationMs: data.details?.duration_ms, message: data.message,
      error: data.details?.error ? inspect(data.details.error, { depth: 6, colors: false }) : undefined };
    await appendFile(join(root, 'events.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    if (type === 'test:stdout' || type === 'test:stderr' || data.details?.type === 'suite') continue;
    summary.tests.push(entry);
    const result = data.skip ? 'SKIP' : data.todo ? 'TODO' : type === 'test:pass' ? 'PASS' : 'FAIL';
    await appendFile(join(root, 'summary.md'), `| ${time(recordedAt)} | ${result} | ${text(data.name)} | ${text(data.file)}:${data.line ?? '?'} |\n`);
    await save();
  }
  const failures = summary.tests.filter(item => item.type === 'test:fail' && !item.skip && !item.todo);
  summary.status = failures.length || !summary.counts || summary.counts.failed || summary.counts.cancelled ? 'failed' : 'passed';
  summary.finishedAt = new Date().toISOString();
  const finalSource = await sourceIdentity();
  summary.sourceUnchanged = summary.source.sha256 === finalSource.sha256;
  summary.finalSourceSha256 = finalSource.sha256;
  if (!summary.sourceUnchanged) {
    summary.status = 'failed';
    process.exitCode = 1;
  }
  await save();
  const counts = summary.counts;
  const result = `\n${time(summary.finishedAt)} | ${summary.status.toUpperCase()} | PASS ${counts?.passed ?? '?'}/${counts?.tests ?? '?'} tests; FAIL ${counts?.failed ?? failures.length}; CANCELED ${counts?.cancelled ?? '?'}; SKIP ${counts?.skipped ?? '?'}. Source unchanged: ${summary.sourceUnchanged}.\n`;
  const details = failures.map(item => `\n### ${text(item.name)}\n\nRecorded: ${time(item.recordedAt)}; ${text(item.file)}:${item.line ?? '?'}.\n\n${text(item.error)}\n`).join('');
  await appendFile(join(root, 'summary.md'), result + details);
  await appendFile(journal, `\n### Finished ${runId}\n${result}${details}\n[Full trace](<.galaxy/tests/${runId}/events.jsonl>) | [Summary](<.galaxy/tests/${runId}/summary.json>).\n`);
  yield `Core test journal: ${journal}\n`;
}
