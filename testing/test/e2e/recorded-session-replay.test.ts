import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseLiveHealthScenario } from "../../src/domain/live-health-scenario.js";
import { runLiveHealth, type LiveHealthReport } from "../../src/live/run-live-health.js";
import { AI_CODER_PROMPT_VERSION } from "@galaxy-stack/ai-coder-core";
import { createReplayFetch, type RecordedSession } from "../../src/provider/ollama-record-replay.js";

function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const recordedFixture = new URL("../../live/recordings/01-write-and-validate.json", import.meta.url);
const scenarioFile = new URL("../../live/scenarios/01-write-and-validate.json", import.meta.url);

/**
 * Replays a recorded live smoke session without a provider, an API key, or
 * network access. The recorded NDJSON bodies flow through the real Ollama
 * normalizer and the real run controller, so the keyless suite covers the same
 * tool orchestration path that the live campaign exercises.
 */
test("recorded smoke session replays keylessly to the same completed oracle", async () => {
  const session = JSON.parse(await readFile(recordedFixture, "utf8")) as RecordedSession;
  const scenario = parseLiveHealthScenario(JSON.parse(await readFile(scenarioFile, "utf8")));
  assert.equal(
    session.contract.promptVersion,
    AI_CODER_PROMPT_VERSION,
    "Re-record the fixture: the prompt version changed since the session was recorded.",
  );
  assert.equal(
    session.contract.scenarioFingerprint,
    sha256Text(await readFile(scenarioFile, "utf8")),
    "Re-record the fixture: the scenario definition changed since the session was recorded.",
  );

  const run = async (): Promise<LiveHealthReport> => {
    const workspacePath = await mkdtemp(join(tmpdir(), "galaxy-replay-smoke-"));
    try {
      return await runLiveHealth({
        connection: {
          baseUrl: session.connection.baseUrl,
          configPath: "replay-fixture",
          credentialSource: "none",
          model: session.connection.model,
        },
        fetch: createReplayFetch(session),
        scenario,
        workspacePath,
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  };

  const first = await run();
  assert.equal(first.passed, true, JSON.stringify(first.failures));
  assert.equal(first.status, "completed");
  assert.equal(first.pauseReason, null);
  assert.deepEqual(first.changedPaths, ["hello.txt"]);
  assert.ok(first.validation.some((item) => item.status === "passed"), "recorded validation must replay as trusted evidence");

  const second = await run();
  assert.deepEqual(second.toolSequence, first.toolSequence, "replay is deterministic across runs");
  assert.equal(second.finalResponse, first.finalResponse);
  assert.equal(second.passed, true);
});
