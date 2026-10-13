import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_PRESETS, DEFAULT_AGENT_PRESET_ID, resolveAgentPreset } from "../src/runtime/agent-presets.js";

test("every preset is complete, named, and unique", () => {
  const ids = AGENT_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of AGENT_PRESETS) {
    assert.ok(preset.id.length > 0);
    assert.ok(preset.label.length > 0);
    assert.ok(preset.description.length > 0);
    assert.ok(["native", "ptc", "both"].includes(preset.toolPresentation));
    assert.ok(["strict", "balanced", "trusted-workspace"].includes(preset.approvalProfile));
  }
});

test("a name resolves, and an unknown name is a refusal rather than a default", () => {
  assert.equal(resolveAgentPreset("ptc")?.id, "ptc");
  assert.equal(resolveAgentPreset("  TRUSTED ")?.id, "trusted");
  assert.equal(resolveAgentPreset("nonsense"), null);
  assert.equal(resolveAgentPreset(undefined), null);
  assert.notEqual(resolveAgentPreset(DEFAULT_AGENT_PRESET_ID), null);
});

test("the presets differ in what they ask and how they work", () => {
  const cautious = resolveAgentPreset("cautious");
  const standard = resolveAgentPreset("standard");
  const ptc = resolveAgentPreset("ptc");
  assert.equal(cautious?.approvalProfile, "strict");
  assert.equal(standard?.toolPresentation, "native");
  assert.equal(ptc?.toolPresentation, "ptc");
  assert.equal((ptc?.permissions ?? []).includes("workspace.write"), true);
});
