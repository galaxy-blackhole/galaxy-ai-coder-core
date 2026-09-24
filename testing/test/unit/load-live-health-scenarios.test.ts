import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadLiveHealthScenarios } from "../../src/io/load-live-health-scenario.js";

const scenario = (name: string) => JSON.stringify({
  schemaVersion: 1,
  name,
  task: "Inspect and report.",
  expected: { allowedChanges: [], files: [] },
});

test("live health scenario directories are recursively sorted for a progressive campaign", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-live-scenarios-"));
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "nested"));
  await Promise.all([
    writeFile(join(root, "20-second.json"), scenario("second"), "utf8"),
    writeFile(join(root, "nested", "30-third.json"), scenario("third"), "utf8"),
    writeFile(join(root, "10-first.json"), scenario("first"), "utf8"),
  ]);

  const loaded = await loadLiveHealthScenarios(root);

  assert.deepEqual(loaded.map((item) => item.scenario.name), ["first", "second", "third"]);
});

test("live health scenario campaigns reject duplicate names", async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-live-scenarios-duplicate-"));
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(root, "01.json"), scenario("duplicate"), "utf8"),
    writeFile(join(root, "02.json"), scenario("duplicate"), "utf8"),
  ]);
  await assert.rejects(loadLiveHealthScenarios(root), /Duplicate live health scenario name/);
});

test("checked-in full application campaign is ordered and installs dependencies only once", async () => {
  const loaded = await loadLiveHealthScenarios("live/scenarios/full-application");
  assert.deepEqual(loaded.map((item) => item.scenario.name), [
    "full application 01 next production build",
    "full application 02 vite vue production build",
    "full application 03 nest http sqlite migration",
    "full application 04 angular production build",
  ]);
  assert.equal(loaded[0]?.scenario.runtime?.dependencySetup?.packageManager, "npm");
  assert.ok(loaded.slice(1).every((item) => item.scenario.runtime?.dependencySetup === undefined));
  assert.deepEqual(loaded.map((item) => item.scenario.expected.allowedChanges), [
    ["app/page.jsx"],
    ["src/vue/App.vue"],
    ["src/nest/catalog.service.mjs"],
    ["src/angular/app.ts"],
  ]);
  assert.ok(loaded.every((item) => item.scenario.expected.requirePassedValidation === true));
  const viteHarness = loaded[1]?.scenario.initialFiles?.find(
    (file) => file.path === "tests/02-vite-vue-build.test.mjs",
  )?.content ?? "";
  assert.match(viteHarness, /configLoader: 'native'/);
  assert.match(viteHarness, /node_modules\/\.vite-temp/);
  assert.match(viteHarness, /rm\(viteTemp, \{ recursive: true, force: true \}\)/);
  const nextConfig = loaded[0]?.scenario.initialFiles?.find(
    (file) => file.path === "next.config.mjs",
  )?.content ?? "";
  const nextHarness = loaded[0]?.scenario.initialFiles?.find(
    (file) => file.path === "tests/01-next-build.test.mjs",
  )?.content ?? "";
  assert.match(nextConfig, /turbopack: \{ root \}/);
  assert.match(nextHarness, /CI: '1'/);
  const angularFiles = loaded[3]?.scenario.initialFiles ?? [];
  assert.equal(angularFiles.some((file) => file.path === "tsconfig.json"), false);
  assert.equal(angularFiles.some((file) => file.path === "tsconfig.angular.json"), true);
  assert.match(
    angularFiles.find((file) => file.path === "tsconfig.app.json")?.content ?? "",
    /\.\/tsconfig\.angular\.json/,
  );
});
