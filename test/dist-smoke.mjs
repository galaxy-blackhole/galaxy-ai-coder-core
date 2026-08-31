import assert from "node:assert/strict";

const core = await import("@galaxy/ai-coder-core");
const ports = await import("@galaxy/ai-coder-core/ports");

assert.equal(core.DEFAULT_AI_CODER_CORE_SETTINGS.executionMode, "single");
assert.equal(core.AI_CODER_PROMPT_VERSION, "ai-coder-single/2.0.0");
assert.equal(Object.keys(core.AI_CODER_CORE_TOOL_EFFECT_PROFILE).length, 21);
assert.deepEqual(core.AI_CODER_WORKSPACE_ENTRY_KINDS, ["directory", "file", "missing", "other", "symlink"]);
assert.equal(core.isAiCoderWorkspaceMutationEvidence({
  beforeKind: "missing",
  beforeHash: null,
  afterKind: "directory",
  afterHash: null,
}), true);
assert.deepEqual(ports.portSuccess("ready"), { ok: true, data: "ready" });
