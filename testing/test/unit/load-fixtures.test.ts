import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadFixtures } from "../../src/io/load-fixtures.js";

test("loadFixtures sorts a directory for reproducible evaluation order", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "galaxy-code-fixtures-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = (name: string) => JSON.stringify({
    schemaVersion: 1,
    name,
    task: `run ${name}`,
    rounds: [{ content: "done", finishReason: "stop" }],
  });
  await Promise.all([
    writeFile(join(directory, "b.json"), fixture("b")),
    writeFile(join(directory, "a.json"), fixture("a")),
    writeFile(join(directory, "ignored.txt"), "not a fixture"),
  ]);

  const loaded = await loadFixtures(directory);
  assert.deepEqual(loaded.map(({ fixture: entry }) => entry.name), ["a", "b"]);
});

test("loadFixtures discovers nested suites and rejects duplicate fixture names", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "galaxy-code-nested-fixtures-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "nested"));
  const fixture = (name: string) => JSON.stringify({
    schemaVersion: 2,
    name,
    task: `run ${name}`,
    rounds: [{ content: "done", finishReason: "stop" }],
  });
  await writeFile(join(directory, "root.json"), fixture("root"));
  await writeFile(join(directory, "nested", "nested.json"), fixture("nested"));
  assert.deepEqual((await loadFixtures(directory)).map((item) => item.fixture.name), ["nested", "root"]);

  await writeFile(join(directory, "nested", "duplicate.json"), fixture("root"));
  await assert.rejects(() => loadFixtures(directory), /Duplicate fixture name 'root'/);
});
