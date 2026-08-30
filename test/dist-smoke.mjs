import assert from "node:assert/strict";

const core = await import("@galaxy/ai-coder-core");
const ports = await import("@galaxy/ai-coder-core/ports");

assert.equal(core.DEFAULT_AI_CODER_CORE_SETTINGS.executionMode, "single");
assert.deepEqual(ports.portSuccess("ready"), { ok: true, data: "ready" });
