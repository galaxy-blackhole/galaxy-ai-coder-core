import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesHookTool, readHookConfig, runToolHooks } from "../src/runtime/hooks.js";

test("a matcher covers what the other tools say it covers", () => {
  assert.equal(matchesHookTool(undefined, "Bash"), true, "no matcher means every tool");
  assert.equal(matchesHookTool("", "Bash"), true);
  assert.equal(matchesHookTool("*", "anything"), true);
  assert.equal(matchesHookTool("Edit|Write", "Write"), true);
  assert.equal(matchesHookTool("Edit|Write", "Read"), false);
  assert.equal(matchesHookTool("Bash", "Bash"), true);
});

test("a workspace's own hooks are read, and a broken file is not a broken session", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-hooks-"));
  try {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: "exit 0" }], matcher: "Bash" }] },
    }));
    const config = await readHookConfig(root);
    assert.equal(config.PreToolUse?.length, 1);
    assert.equal(config.PostToolUse, undefined);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("exit 0 lets the call through and exit 2 refuses it with the reason on stderr", async () => {
  const allow = await runToolHooks({ PreToolUse: [{ hooks: [{ command: "exit 0" }] }] }, "PreToolUse", "Bash", {});
  assert.equal(allow.deny, false);
  const deny = await runToolHooks({ PreToolUse: [{ hooks: [{ command: "echo không được phép >&2; exit 2" }] }] }, "PreToolUse", "Bash", {});
  assert.equal(deny.deny, true);
  assert.match(deny.reason ?? "", /không được phép/);
});

test("a hook that fails to answer is reported and does not freeze the call", async () => {
  const decision = await runToolHooks({ PreToolUse: [{ hooks: [{ command: "exit 3" }] }] }, "PreToolUse", "Bash", {});
  assert.equal(decision.deny, false, "only exit 2 refuses; anything else is a non-blocking error");
  assert.equal(decision.warnings.length, 1);
});

test("a matcher that does not cover the tool never runs its command", async () => {
  const decision = await runToolHooks({ PreToolUse: [{ hooks: [{ command: "exit 2" }], matcher: "Edit" }] }, "PreToolUse", "Bash", {});
  assert.equal(decision.deny, false);
});
