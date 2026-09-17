import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_CODER_CORE_TOOL_EFFECT_PROFILE,
  AI_CODER_CORE_TOOL_EFFECT_PROFILE_VERSION,
  AI_CODER_TOOL_EFFECT_CAPABILITIES,
  assertAiCoderCoreToolEffectCapabilities,
  assertAiCoderCoreToolEffectProfile,
  createAiCoderCoreToolEffectMetadata,
  validateAiCoderCoreToolEffectProfile,
} from "../src/tools/tool-effect-profile.js";
import { AI_CODER_CORE_TOOL_CATALOG } from "../src/tools/tool-registry.js";

test("canonical effect profile covers the complete core catalog without drift", () => {
  assert.equal(AI_CODER_CORE_TOOL_EFFECT_PROFILE_VERSION, "1.1.0");
  assert.deepEqual(validateAiCoderCoreToolEffectProfile(), []);
  assert.doesNotThrow(() => assertAiCoderCoreToolEffectProfile());
  assert.deepEqual(
    Object.keys(AI_CODER_CORE_TOOL_EFFECT_PROFILE),
    AI_CODER_CORE_TOOL_CATALOG.map((tool) => tool.id),
  );
  assert.equal(Object.keys(AI_CODER_CORE_TOOL_EFFECT_PROFILE).length, 21);
  assert.equal(Object.isFrozen(AI_CODER_CORE_TOOL_EFFECT_PROFILE), true);
  assert.equal(Object.isFrozen(AI_CODER_TOOL_EFFECT_CAPABILITIES), true);

  for (const capabilities of Object.values(AI_CODER_CORE_TOOL_EFFECT_PROFILE)) {
    assert.equal(Object.isFrozen(capabilities), true);
    assert.deepEqual(capabilities, [...new Set(capabilities)].sort());
    assert.equal(capabilities.every((value) => AI_CODER_TOOL_EFFECT_CAPABILITIES.includes(value)), true);
  }
});

test("profile grants workspace mutation evidence only to explicit mutation-capable tools", () => {
  const writeCapable = Object.entries(AI_CODER_CORE_TOOL_EFFECT_PROFILE)
    .filter(([, capabilities]) => capabilities.includes("write"))
    .map(([id]) => id);
  assert.deepEqual(writeCapable, ["command.run", "command.session", "project.validate", "workspace.edit", "workspace.write"]);
  assert.deepEqual(
    AI_CODER_CORE_TOOL_EFFECT_PROFILE["project.validate"],
    ["approval", "state_version", "validate", "write"],
  );
  assert.deepEqual(AI_CODER_CORE_TOOL_EFFECT_PROFILE["git.exec"], ["approval", "diff_review", "inspect"]);
  assert.equal(
    Object.values(AI_CODER_CORE_TOOL_EFFECT_PROFILE).some(
      (capabilities) => capabilities.includes("criterion_satisfy") || capabilities.includes("criterion_waive"),
    ),
    false,
  );
});

test("profile validation reports missing, extra, duplicated, unordered, and unknown capabilities", () => {
  const invalid = {
    ...AI_CODER_CORE_TOOL_EFFECT_PROFILE,
    "workspace.read": ["inspect", "approval", "approval", "not_real"],
    "unknown.tool": ["approval"],
  } as Readonly<Record<string, readonly string[]>>;
  const missingWrite = Object.fromEntries(
    Object.entries(invalid).filter(([id]) => id !== "workspace.write"),
  );
  const issues = validateAiCoderCoreToolEffectProfile({ effectCapabilities: missingWrite });
  assert.equal(issues.some((issue) => issue.includes("missing core tool workspace.write")), true);
  assert.equal(issues.some((issue) => issue.includes("unknown core tool unknown.tool")), true);
  assert.equal(issues.some((issue) => issue.includes("workspace.read contains duplicates")), true);
  assert.equal(issues.some((issue) => issue.includes("workspace.read must use canonical deterministic order")), true);
  assert.equal(issues.some((issue) => issue.includes("unknown capability not_real")), true);
});

test("active metadata derives canonical ids and retains the stable full profile", () => {
  const active = AI_CODER_CORE_TOOL_CATALOG.filter((tool) => tool.enabledByDefault);
  const metadata = createAiCoderCoreToolEffectMetadata([...active].reverse());
  assert.equal(Object.keys(metadata.canonicalToolIds).length, 13);
  assert.equal(Object.keys(metadata.effectCapabilities).length, 21);
  assert.equal(metadata.canonicalToolIds.read_file, "workspace.read");
  assert.deepEqual(metadata.effectCapabilities["workspace.read"], ["approval", "inspect"]);
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.canonicalToolIds), true);
  assert.equal(Object.isFrozen(metadata.effectCapabilities), true);
  assert.equal(metadata.effectCapabilities, AI_CODER_CORE_TOOL_EFFECT_PROFILE);
  assert.throws(
    () => createAiCoderCoreToolEffectMetadata([{ id: "extension.custom", modelName: "custom" }]),
    /No core effect profile exists/,
  );
  assert.throws(
    () => createAiCoderCoreToolEffectMetadata([
      { id: "workspace.read", modelName: "read_file" },
      { id: "workspace.read", modelName: "read_file_alias" },
    ]),
    /Duplicate active canonical tool ID/,
  );
});

test("core tool effect declarations fail closed while extension ids remain host-defined", () => {
  assert.doesNotThrow(() => assertAiCoderCoreToolEffectCapabilities(
    "command.run",
    ["write", "approval", "state_version"],
  ));
  assert.throws(
    () => assertAiCoderCoreToolEffectCapabilities("command.run", ["approval"]),
    /effect capabilities drifted/,
  );
  assert.throws(
    () => assertAiCoderCoreToolEffectCapabilities("workspace.read", ["approval", "inspect", "write"]),
    /effect capabilities drifted/,
  );
  assert.doesNotThrow(() => assertAiCoderCoreToolEffectCapabilities("extension.custom", ["write"]));
});
