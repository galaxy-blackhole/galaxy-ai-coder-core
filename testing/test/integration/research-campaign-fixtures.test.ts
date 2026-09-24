import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { loadLiveHealthScenarios } from "../../src/io/load-live-health-scenario.js";
import type { LiveHealthScenario } from "../../src/domain/live-health-scenario.js";

const implementedPolicy = `
export function decideRetry(input) {
  const { method, status, errorName, aborted, attempt, retryAfter, nowMs } = input;
  const stop = reason => ({ retry: false, delayMs: 0, reason });
  if (aborted || errorName === 'AbortError') return stop('canceled');
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) return stop('unsafe-method');
  if (attempt >= 3) return stop('exhausted');
  const transient = status === undefined
    ? ['TypeError', 'TimeoutError'].includes(errorName)
    : [429, 503].includes(status);
  if (!transient) return stop('not-retryable');
  let delayMs = 250 * 2 ** (attempt - 1);
  const value = retryAfter?.trim();
  if (value && /^[0-9]+$/.test(value)) {
    const seconds = Number(value);
    if (Number.isFinite(seconds * 1000)) delayMs = seconds * 1000;
  } else if (value && /^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && new Date(parsed).toUTCString() === value) delayMs = Math.max(0, parsed - nowMs);
  }
  return { retry: true, delayMs: Math.min(5000, delayMs), reason: 'transient' };
}
`;

const implementedMigration = `
export function migrateCatalog(db) {
  if (db.prepare('SELECT version FROM schema_migrations WHERE version = 2').get()) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE product_prices (product_id TEXT PRIMARY KEY REFERENCES products(id), price_cents INTEGER NOT NULL CHECK (price_cents >= 0))');
    const insert = db.prepare('INSERT INTO product_prices(product_id, price_cents) VALUES (?, ?)');
    for (const row of db.prepare('SELECT id, price FROM products ORDER BY id').all()) {
      insert.run(row.id, Math.round(row.price * 100));
    }
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(2);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
`;

async function overlay(root: string, scenario: LiveHealthScenario): Promise<void> {
  for (const file of scenario.initialFiles ?? []) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

function suite(root: string, stages: number): { status: number | null; output: string } {
  const filenames = ["test/01-client.test.mjs", "test/02-retry-policy.test.mjs", "test/03-migration.test.mjs"].slice(0, stages);
  // This is an independent project test process, not a child of this file's test runner.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...filenames], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.doesNotMatch(result.stderr, /skipping running files/);
  return { status: result.status, output: result.stdout + result.stderr };
}

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);

test("research campaign fixtures expose unsafe retry and partial SQLite migration with cumulative real tests", {
  skip: nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)
    ? "Real SQLite research fixtures require Node.js >=22.13" : false,
}, async (context) => {
  const scenarios = (await loadLiveHealthScenarios("live/scenarios/research")).map(item => item.scenario);
  assert.deepEqual(scenarios.map(item => item.name), [
    "research 01 supplier client recommendation",
    "research 02 bounded supplier retry policy",
    "research 03 atomic sqlite catalog migration",
  ]);
  assert.deepEqual(scenarios.map(item => item.expected.allowedChanges), [[], ["src/retry-policy.mjs"], ["src/catalog-migration.mjs"]]);
  assert.equal(scenarios[0]?.mode, "review_only");
  assert.ok(scenarios.every(item => item.runtime?.research?.provider === "ollama"));
  assert.ok(scenarios.every(item => item.expected.research?.requireCitations === true));
  assert.ok(scenarios.slice(1).every(item => item.expected.research?.beforeFirstWrite === true));

  const root = await mkdtemp(join(tmpdir(), "galaxy-research-fixtures-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await overlay(root, scenarios[0]!);
  let result = suite(root, 1);
  assert.equal(result.status, 0, result.output);

  await overlay(root, scenarios[1]!);
  result = suite(root, 2);
  assert.notEqual(result.status, 0, `stage 2 must reject the incomplete baseline: ${result.output}`);
  assert.match(result.output, /not-implemented/);

  await writeFile(join(root, "src/retry-policy.mjs"), implementedPolicy, "utf8");
  result = suite(root, 2);
  assert.equal(result.status, 0, result.output);

  for (const [label, mutated] of [
    ["purchase retry", implementedPolicy.replace("['GET', 'HEAD']", "['GET', 'HEAD', 'POST']")],
    ["ignored caller cancellation", implementedPolicy.replace("aborted || errorName === 'AbortError'", "false")],
    ["exhausted retry budget", implementedPolicy.replace("attempt >= 3", "attempt > 3")],
    ["unbounded Retry-After", implementedPolicy.replace("Math.min(5000, delayMs)", "delayMs")],
  ]) {
    await writeFile(join(root, "src/retry-policy.mjs"), mutated!, "utf8");
    assert.notEqual(suite(root, 2).status, 0, `suite must detect ${label}`);
  }
  await writeFile(join(root, "src/retry-policy.mjs"), implementedPolicy, "utf8");

  await overlay(root, scenarios[2]!);
  result = suite(root, 3);
  assert.notEqual(result.status, 0, "stage 3 must reproduce partial migration");
  assert.match(result.output, /failed migration must not leave a created table or partial rows/);

  await writeFile(join(root, "src/catalog-migration.mjs"), implementedMigration, "utf8");
  result = suite(root, 3);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /# tests 12/);

  for (const [label, mutated] of [
    ["missing rollback", implementedMigration.replace("db.exec('ROLLBACK')", "void 0")],
    ["swallowed constraint error", implementedMigration.replace("throw error;", "return false;")],
    ["lost idempotency", implementedMigration.replace("return false;", "return true;")],
  ]) {
    await writeFile(join(root, "src/catalog-migration.mjs"), mutated!, "utf8");
    assert.notEqual(suite(root, 3).status, 0, `suite must detect ${label}`);
  }
});
