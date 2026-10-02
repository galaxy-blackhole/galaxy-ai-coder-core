import assert from "node:assert/strict";
import test from "node:test";
import { isValidRequirementRange, parseSkillRequires, satisfiesVersion } from "../src/agent/skill-requirements.js";

test("a declared range accepts the versions it names and rejects older ones", () => {
  assert.equal(satisfiesVersion("0.4.1", ">=0.4.1"), true);
  assert.equal(satisfiesVersion("0.5.0", ">=0.4.1"), true);
  assert.equal(satisfiesVersion("1.0.0", ">=0.4.1"), true);
  // The skew that cost the 2026-10-02 gymflow run four calls: 0.4.0 declared a schema the shipped
  // skill had outgrown.
  assert.equal(satisfiesVersion("0.4.0", ">=0.4.1"), false);
  assert.equal(satisfiesVersion("0.4.1-beta.1", ">=0.4.1"), false);
  assert.equal(satisfiesVersion("0.4.2-beta.1", ">=0.4.1"), true);
});

test("ranges combine comparators and tolerate build metadata", () => {
  assert.equal(satisfiesVersion("1.1.0", ">=1.0.0 <2.0.0"), true);
  assert.equal(satisfiesVersion("2.0.0", ">=1.0.0 <2.0.0"), false);
  assert.equal(satisfiesVersion("1.1.0+20261002", ">=1.0.0"), true);
  assert.equal(satisfiesVersion("1.1.0", "*"), true);
  assert.equal(satisfiesVersion("0.0.1", ""), true);
});

test("an unprovable version never satisfies a bounded range", () => {
  assert.equal(satisfiesVersion("unknown", ">=0.4.1"), false);
  assert.equal(satisfiesVersion("0.4", ">=0.4.1"), false);
  assert.equal(satisfiesVersion("0.4.1", ">=0.4"), false, "a malformed range is not a pass");
});

test("frontmatter requires is parsed, sorted and validated", () => {
  assert.equal(parseSkillRequires(undefined), undefined);
  assert.deepEqual(parseSkillRequires({ orbit: ">=0.4.1" }), [{ server: "orbit", range: ">=0.4.1" }]);
  assert.deepEqual(parseSkillRequires({ orbit: ">=0.4.1", nebula: "1.1.0" }), [
    { server: "nebula", range: "1.1.0" },
    { server: "orbit", range: ">=0.4.1" },
  ]);
  assert.equal(isValidRequirementRange(">=0.4.1"), true);
  assert.equal(isValidRequirementRange("latest"), false);
  assert.equal(isValidRequirementRange("^0.4.1"), false, "caret ranges are not supported: be explicit");
  assert.throws(() => parseSkillRequires({}), /at least one/);
  assert.throws(() => parseSkillRequires({ orbit: "latest" }), /version range/);
  assert.throws(() => parseSkillRequires({ "bad name": ">=1.0.0" }), /invalid MCP server name/);
  assert.throws(() => parseSkillRequires(["orbit"]), /mapping/);
  const many: Record<string, string> = {};
  for (let index = 0; index < 17; index += 1) many[`server${index}`] = ">=1.0.0";
  assert.throws(() => parseSkillRequires(many), /at most 16/);
});
