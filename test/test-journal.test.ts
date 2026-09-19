import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('standalone core test reporter retains passing and failing assertions with source and timestamps', async context => {
  const root = await mkdtemp(join(tmpdir(), 'core-journal-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'sample.mjs');
  await writeFile(fixture, "import test from 'node:test'; test('works', () => {}); test('intentional failure', () => { throw new Error('retained stack'); });\n");
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const child = spawn(process.execPath, ['--test',
    `--test-reporter=${fileURLToPath(new URL('../scripts/test-journal-reporter.mjs', import.meta.url))}`, fixture], {
    env: { ...env, GALAXY_TEST_JOURNAL_DIRECTORY: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 1, stderr);
  const [run] = await readdir(join(root, '.galaxy/tests'));
  const summary = JSON.parse(await readFile(join(root, '.galaxy/tests', run!, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.counts.tests, 2);
  assert.equal(summary.counts.passed, 1);
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.sourceUnchanged, true);
  assert.match(summary.source.sha256, /^[0-9a-f]{64}$/);
  const failed = summary.tests.find((item: { name: string }) => item.name === 'intentional failure');
  assert.match(failed.error, /retained stack/);
  assert.ok(Date.parse(failed.recordedAt));
  const journal = await readFile(join(root, 'TEST_ERROR_LOG.md'), 'utf8');
  assert.match(journal, /PASS 1\/2 tests; FAIL 1/);
  assert.match(journal, /\+07:00/);
  assert.match(journal, /intentional failure/);
});
