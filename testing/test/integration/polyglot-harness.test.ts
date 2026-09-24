import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadLiveHealthScenarios } from "../../src/io/load-live-health-scenario.js";

const run = promisify(execFile);
const scenarioDirectory = fileURLToPath(new URL("../../live/scenarios/advanced-polyglot/", import.meta.url));

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

test("polyglot harness removes owned build artifacts when an earlier child fails", async (context) => {
  const scenarios = await loadLiveHealthScenarios(scenarioDirectory);
  for (const scenarioIndex of [1, 2]) {
    const scenario = scenarios[scenarioIndex]?.scenario;
    assert.ok(scenario?.initialFiles, `Missing polyglot scenario ${scenarioIndex + 1}`);
    await context.test(scenario.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "galaxy-polyglot-cleanup-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      for (const file of scenario.initialFiles!) {
        const path = join(root, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content);
      }
      const rustArtifact = join(root, process.platform === "win32" ? ".galaxy-rust-test.exe" : ".galaxy-rust-test");
      const javaArtifact = join(root, ".galaxy-java-classes");
      await writeFile(rustArtifact, "stale artifact");
      if (scenarioIndex === 2) {
        await mkdir(javaArtifact, { recursive: true });
        await writeFile(join(javaArtifact, "stale.class"), "stale class");
      }

      await assert.rejects(run(process.execPath, ["scripts/test-all.mjs"], {
        cwd: root,
        env: { ...process.env, NO_COLOR: "1" },
        timeout: 30_000,
      }));
      assert.equal(await exists(rustArtifact), false, "Rust artifact must be removed after a failed child command");
      if (scenarioIndex === 2) {
        assert.equal(await exists(javaArtifact), false, "Java output directory must be removed after a failed child command");
      }
    });
  }
});
