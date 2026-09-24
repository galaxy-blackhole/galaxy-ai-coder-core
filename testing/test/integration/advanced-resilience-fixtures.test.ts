import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadLiveHealthScenarios } from "../../src/io/load-live-health-scenario.js";

const run = promisify(execFile);
const scenarioDirectory = fileURLToPath(new URL("../../live/scenarios/advanced-resilience/", import.meta.url));

const referenceImplementations: readonly Readonly<Record<string, string>>[] = [
  {
    "src/migrations.mjs": String.raw`export function migrate(db, migrations, targetVersion) {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0 || targetVersion > ordered.length
      || ordered.some((migration, index) => migration.version !== index + 1)) {
    throw new Error('Invalid target version');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    if (rows.some((row, index) => row.version !== index + 1) || rows.length > ordered.length) throw new Error('Unknown applied version');
    const current = rows.length;
    for (let version = current; version < targetVersion; version++) {
      db.exec(ordered[version].up);
      db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(version + 1);
    }
    for (let version = current; version > targetVersion; version--) {
      db.exec(ordered[version - 1].down);
      db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(version);
    }
    db.exec('COMMIT');
    return targetVersion;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
`,
  },
  {
    "src/checkout.mjs": String.raw`export function createCheckoutService(db, { afterDebit = () => {} } = {}) {
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
  return async function checkout({ key, sku, quantity }) {
    if (typeof key !== 'string' || !key.trim() || typeof sku !== 'string' || !Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Invalid request');
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT id, sku, quantity, total_cents FROM orders WHERE request_key = ?').get(key);
      let result;
      if (existing) {
        if (existing.sku !== sku || existing.quantity !== quantity) throw new Error('Idempotency conflict');
        result = { orderId: existing.id, totalCents: existing.total_cents };
      } else {
        const product = db.prepare('SELECT price_cents, stock FROM products WHERE sku = ?').get(sku);
        if (!product || product.stock < quantity) throw new Error('Insufficient stock');
        const totalCents = product.price_cents * quantity;
        db.prepare('UPDATE products SET stock = stock - ? WHERE sku = ?').run(quantity, sku);
        afterDebit();
        const inserted = db.prepare('INSERT INTO orders(request_key, sku, quantity, total_cents) VALUES (?, ?, ?, ?)').run(key, sku, quantity, totalCents);
        const orderId = Number(inserted.lastInsertRowid);
        db.prepare('INSERT INTO order_outbox(order_id, event) VALUES (?, ?)').run(orderId, 'order.created');
        result = { orderId, totalCents };
      }
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
}
`,
  },
  {
    "src/pricing.mjs": "export const RESELLER_ACCOUNT = 'Café';\r\nexport const LOOKALIKE_ACCOUNT = 'Café';\r\n\r\nfunction validate(priceCents, quantity) {\r\n  if (!Number.isSafeInteger(priceCents) || priceCents < 0 || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Invalid quote');\r\n  if (!Number.isSafeInteger(priceCents * quantity)) throw new Error('Unsafe quote');\r\n}\r\n\r\nexport function quoteRetail(priceCents, quantity) {\r\n  validate(priceCents, quantity);\r\n  const discountPercent = 0;\r\n  return Math.round(priceCents * quantity * (100 - discountPercent) / 100);\r\n}\r\n\r\nexport function quoteWholesale(priceCents, quantity, account) {\r\n  validate(priceCents, quantity);\r\n  const discountPercent = account === RESELLER_ACCOUNT && quantity >= 12 ? 8 : 0;\r\n  return Math.round(priceCents * quantity * (100 - discountPercent) / 100);\r\n}\r\n",
  },
  {
    "src/log-analysis.mjs": String.raw`export async function summarizeLog(readable, { maxLineBytes = 4096 } = {}) {
  const result = { records: 0, malformedLines: 0, oversizedLines: 0, errorCount: 0, otherErrors: 0, byCode: {}, sampleRequestIds: [] };
  let chunks = [];
  let bytes = 0;
  let oversized = false;
  const consume = () => {
    if (oversized) { result.oversizedLines++; }
    else if (bytes > 0) {
      const text = Buffer.concat(chunks, bytes).toString('utf8').replace(/\r$/, '');
      if (text.trim()) {
        let row;
        try { row = JSON.parse(text); } catch {}
        if (!row || typeof row !== 'object' || !['info', 'error'].includes(row.level)
            || (row.level === 'error' && (typeof row.code !== 'string' || typeof row.requestId !== 'string'))) {
          result.malformedLines++;
        } else {
          result.records++;
          if (row.level === 'error') {
            result.errorCount++;
            if (Object.hasOwn(result.byCode, row.code)) result.byCode[row.code]++;
            else if (Object.keys(result.byCode).length < 16) Object.defineProperty(result.byCode, row.code, { value: 1, enumerable: true, writable: true });
            else result.otherErrors++;
            if (result.sampleRequestIds.length < 3 && !result.sampleRequestIds.includes(row.requestId)) result.sampleRequestIds.push(row.requestId);
          }
        }
      }
    }
    chunks = []; bytes = 0; oversized = false;
  };
  for await (const value of readable) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    for (let end = 0; end <= chunk.length; end++) {
      if (end !== chunk.length && chunk[end] !== 10) continue;
      const piece = chunk.subarray(start, end);
      if (!oversized) {
        if (bytes + piece.length > maxLineBytes) { oversized = true; chunks = []; bytes = 0; }
        else if (piece.length) { chunks.push(Buffer.from(piece)); bytes += piece.length; }
      }
      if (end !== chunk.length) consume();
      start = end + 1;
    }
  }
  if (bytes || oversized) consume();
  return result;
}
`,
    "scripts/analyze-log.mjs": String.raw`import { createReadStream } from 'node:fs';
import { summarizeLog } from '../src/log-analysis.mjs';
try {
  if (process.argv.length !== 3) throw new Error('Usage: analyze-log <path>');
  console.log(JSON.stringify(await summarizeLog(createReadStream(process.argv[2]))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
`,
  },
];

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

async function runSuite(root: string): Promise<{ code: number; output: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  // A nested node --test process otherwise silently skips every fixture test.
  delete env.NODE_TEST_CONTEXT;
  delete env.FORCE_COLOR;
  try {
    const { stdout, stderr } = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      shell: process.platform === "win32",
      env,
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string; signal?: string; killed?: boolean };
    if (typeof failure.code !== "number" || failure.killed || failure.signal) throw error;
    return { code: failure.code, output: (failure.stdout ?? "") + (failure.stderr ?? "") };
  }
}

function faultyImplementation(stage: number): Readonly<Record<string, string>> {
  const reference = referenceImplementations[stage]!;
  if (stage === 0) return {
    "src/migrations.mjs": reference["src/migrations.mjs"]!
      .replace("db.exec('BEGIN IMMEDIATE')", "db.exec('SELECT 1')")
      .replace("db.exec('COMMIT')", "db.exec('SELECT 1')")
      .replace("db.exec('ROLLBACK')", "db.exec('SELECT 1')"),
  };
  if (stage === 1) return {
    "src/checkout.mjs": reference["src/checkout.mjs"]!.replace("db.exec('ROLLBACK')", "db.exec('COMMIT')"),
  };
  if (stage === 2) return {
    "src/pricing.mjs": reference["src/pricing.mjs"]!.replace("account === RESELLER_ACCOUNT && quantity >= 12", "quantity >= 12"),
  };
  return {
    "src/log-analysis.mjs": reference["src/log-analysis.mjs"]!.replace("if (bytes || oversized) consume();", "// Incorrectly drop the final unterminated record."),
  };
}

test("advanced resilience fixtures reject stubs and semantic regressions and pass cumulative real implementations", {
  timeout: 180_000,
  skip: Number(process.versions.node.split(".")[0]) < 24 ? "Real SQLite resilience fixtures require Node.js >=24" : false,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-resilience-fixtures-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const loaded = await loadLiveHealthScenarios(scenarioDirectory);
  assert.equal(loaded.length, referenceImplementations.length);

  for (const [index, { scenario }] of loaded.entries()) {
    await context.test(scenario.name, async () => {
      await writeFiles(root, Object.fromEntries(scenario.initialFiles!.map(({ path, content }) => [path, content])));
      const stub = await runSuite(root);
      assert.notEqual(stub.code, 0, `The unimplemented stage must fail its real behavioral tests: ${stub.output}`);

      const reference = referenceImplementations[index]!;
      assert.deepEqual(Object.keys(reference).sort(), [...scenario.expected.allowedChanges].sort());
      await writeFiles(root, reference);
      const passing = await runSuite(root);
      assert.equal(passing.code, 0, passing.output.slice(-12_000));

      if (index === 3) {
        const nullPrototype = {
          ...reference,
          "src/log-analysis.mjs": reference["src/log-analysis.mjs"]!.replace(
            "byCode: {}, sampleRequestIds: []",
            "byCode: Object.create(null), sampleRequestIds: []",
          ),
        };
        assert.notEqual(nullPrototype["src/log-analysis.mjs"], reference["src/log-analysis.mjs"]);
        await writeFiles(root, nullPrototype);
        const nullPrototypePassing = await runSuite(root);
        assert.equal(nullPrototypePassing.code, 0, nullPrototypePassing.output.slice(-12_000));
        await writeFiles(root, reference);
      }

      const faulty = faultyImplementation(index);
      for (const [path, content] of Object.entries(faulty)) {
        assert.notEqual(content, reference[path], "Fault injection must actually alter the implementation");
      }
      await writeFiles(root, faulty);
      const regression = await runSuite(root);
      assert.notEqual(regression.code, 0, "The behavioral oracle must detect the injected semantic regression");
      await writeFiles(root, reference);
    });
  }
});
