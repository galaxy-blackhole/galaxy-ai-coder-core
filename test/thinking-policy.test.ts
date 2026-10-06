import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleThinking, isThinkingAllowed, parseThinkingChoice, resolveThinkingPolicy, thinkingOptions, toOllamaThinking } from "../src/runtime/thinking-policy.js";

test("Ollama offers the levels its API documents", () => {
  const policy = resolveThinkingPolicy({ model: "deepseek-v4.1-flash:cloud" });
  assert.equal(policy.kind, "levels");
  assert.deepEqual(policy.choices, ["default", "off", "low", "medium", "high", "max"]);
  assert.equal(policy.default, "default");
});

test("a thinking-required model cannot be switched off", () => {
  const policy = resolveThinkingPolicy({ model: "kimi-k2.7-code:cloud" });
  assert.equal(policy.kind, "required");
  assert.equal(policy.choices.includes("off"), false);
  assert.match(policy.notes.join(" "), /không tắt được/);
});

test("a probed capability of none hides every level", () => {
  const policy = resolveThinkingPolicy({ model: "qwen3:8b", capability: "none" });
  assert.equal(policy.kind, "none");
  assert.deepEqual(policy.choices, ["default"]);
});

test("an unknown capability keeps the levels and warns", () => {
  const policy = resolveThinkingPolicy({ model: "mystery:latest", capability: "unknown" });
  assert.equal(policy.kind, "unknown");
  assert.deepEqual(policy.choices, ["default", "off", "low", "medium", "high", "max"]);
  assert.match(policy.notes.join(" "), /chưa xác minh/);
});

test("a config declaration replaces the built-in list and carries wire values", () => {
  const policy = resolveThinkingPolicy({ model: "custom:cloud", declared: { off: null, low: "low", max: "max", bogus: "x" } });
  assert.deepEqual(policy.choices, ["default", "off", "low", "max"]);
  assert.equal(toOllamaThinking(policy, "low"), "low");
  assert.equal(toOllamaThinking(policy, "max"), "max");
  assert.match(policy.notes.join(" "), /bogus/);
});

test("a declaration that offers nothing beyond off disables the control", () => {
  const policy = resolveThinkingPolicy({ model: "custom:cloud", declared: { off: null } });
  assert.equal(policy.kind, "none");
  assert.match(policy.notes.join(" "), /ngoài off/);
});

test("an unavailable preferred choice falls back to the default", () => {
  const policy = resolveThinkingPolicy({ model: "kimi-k2.7-code:cloud", preferred: "off" });
  assert.equal(policy.default, "default");
});

test("aliases parse into the shared vocabulary", () => {
  assert.equal(parseThinkingChoice("auto"), "default");
  assert.equal(parseThinkingChoice("TRUE"), "on");
  assert.equal(parseThinkingChoice("none"), "off");
  assert.equal(parseThinkingChoice("MAX"), "max");
  assert.equal(parseThinkingChoice("nope"), undefined);
});

test("cycling walks the policy list and wraps around", () => {
  const policy = resolveThinkingPolicy({ model: "x:cloud" });
  assert.equal(cycleThinking(policy, "default"), "off");
  assert.equal(cycleThinking(policy, "max"), "default");
  assert.equal(cycleThinking(policy, "minimal"), "default");
});

test("the default choice sends no think field", () => {
  const policy = resolveThinkingPolicy({ model: "x:cloud" });
  assert.equal(toOllamaThinking(policy, "default"), undefined);
  assert.equal(toOllamaThinking(policy, "off"), false);
  assert.equal(toOllamaThinking(policy, "high"), "high");
  assert.equal(toOllamaThinking(policy, "minimal"), undefined);
});

test("options carry the shared Vietnamese labels", () => {
  const policy = resolveThinkingPolicy({ model: "x:cloud" });
  assert.deepEqual(thinkingOptions(policy).map(option => option.label), ["Mặc định", "Tắt", "Thấp", "Vừa", "Cao", "Tối đa"]);
  assert.equal(isThinkingAllowed(policy, "on"), false);
});
