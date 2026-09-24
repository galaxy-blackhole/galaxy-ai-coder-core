import assert from "node:assert/strict";
import test from "node:test";

import { parseLiveHealthScenario } from "../../src/domain/live-health-scenario.js";

const base = {
  schemaVersion: 1,
  name: "research contract",
  task: "Research before recommending.",
  runtime: { research: { provider: "ollama" } },
  expected: { allowedChanges: [], files: [] },
};

test("research scenario parser freezes provider and explicit evidence requirements", () => {
  const research = {
    minSearchCalls: 1,
    minFetchCalls: 2,
    requiredDomains: ["nodejs.org", "developer.mozilla.org"],
    requireCitations: true,
    beforeFirstWrite: true,
  };
  const scenario = parseLiveHealthScenario({ ...base, expected: { ...base.expected, research } });
  assert.deepEqual(scenario.runtime?.research, { provider: "ollama" });
  assert.deepEqual(scenario.expected.research, research);
  assert.ok(Object.isFrozen(scenario.runtime?.research));
  assert.ok(Object.isFrozen(scenario.expected.research));
  assert.ok(Object.isFrozen(scenario.expected.research?.requiredDomains));
});

test("research scenario rejects embedded credentials, unknown providers, and assertions without enabled research", () => {
  for (const research of [
    { provider: "other" },
    { provider: "ollama", apiKey: "must-never-be-in-scenario" },
    { provider: "ollama", baseUrl: "https://attacker.invalid" },
    { provider: "ollama", fetch: true },
    null,
  ]) {
    assert.throws(() => parseLiveHealthScenario({ ...base, runtime: { research } }));
  }
  assert.throws(() => parseLiveHealthScenario({
    ...base,
    runtime: {},
    expected: { ...base.expected, research: { minSearchCalls: 1 } },
  }), /Research assertions require runtime.research/);
});

test("research requirements reject malformed counts, booleans, domains, and unknown oracle fields", () => {
  for (const research of [
    { minSearchCalls: -1 },
    { minFetchCalls: 1.5 },
    { minSearchCalls: "1" },
    { minFetchCalls: Number.POSITIVE_INFINITY },
    { requireCitations: "true" },
    { beforeFirstWrite: 1 },
    { minFetches: 1 },
    { requiredDomains: "sqlite.org" },
    ...["https://sqlite.org", "*.sqlite.org", "sqlite.org:443", "SQLITE.ORG", "localhost", "sqlite.org/path", "sqlite.org@evil.invalid", "127.0.0.1"]
      .map(domain => ({ requiredDomains: [domain] })),
  ]) {
    assert.throws(() => parseLiveHealthScenario({ ...base, expected: { ...base.expected, research } }), JSON.stringify(research));
  }
});

