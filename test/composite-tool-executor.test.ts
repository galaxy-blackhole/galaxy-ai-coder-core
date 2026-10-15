import assert from "node:assert/strict";
import test from "node:test";
import { CompositeToolExecutor } from "../src/agent/index.js";
import type { AiCoderRuntimeToolExecutor, AiCoderRuntimeToolSet } from "../src/runtime/runtime-types.js";

/**
 * A tool's effect policy belongs to whoever owns the tool. Merging looked like a merge but behaved like a
 * last-writer-wins overwrite, and an executor that had never heard of a tool flattened its policy to an empty list —
 * which the runtime reads as a drift and refuses the tool for. These tests hold that line.
 */
function executor(set: AiCoderRuntimeToolSet): AiCoderRuntimeToolExecutor {
  return {
    execute: async () => { throw new Error("not used"); },
    getToolSet: async () => set,
  } as unknown as AiCoderRuntimeToolExecutor;
}

function definition(name: string) {
  return { type: "function", function: { name, description: name, parameters: { properties: {}, type: "object" } } };
}

test("an executor that does not know a tool cannot erase the policy of the one that owns it", async () => {
  const owner = executor({
    canonicalToolIds: { read_file: "workspace.read" },
    definitions: [definition("read_file")],
    effectCapabilities: { "skill.list": ["approval", "inspect"], "workspace.read": ["approval", "inspect"] },
    snapshotHash: "a",
  } as AiCoderRuntimeToolSet);
  const ignorant = executor({
    canonicalToolIds: { skill_list: "skill.list" },
    definitions: [definition("skill_list")],
    effectCapabilities: { "skill.list": [] },
    snapshotHash: "b",
  } as AiCoderRuntimeToolSet);
  const set = await new CompositeToolExecutor([owner, ignorant]).getToolSet({} as never);
  assert.deepEqual(set.effectCapabilities["skill.list"], ["approval", "inspect"], "knowledge survives ignorance");
});

test("two executors that disagree about a policy are reported, not silently resolved", async () => {
  const one = executor({
    canonicalToolIds: {}, definitions: [], effectCapabilities: { "workspace.read": ["approval", "inspect"] }, snapshotHash: "a",
  } as AiCoderRuntimeToolSet);
  const other = executor({
    canonicalToolIds: {}, definitions: [], effectCapabilities: { "workspace.read": ["approval", "write"] }, snapshotHash: "b",
  } as AiCoderRuntimeToolSet);
  await assert.rejects(() => new CompositeToolExecutor([one, other]).getToolSet({} as never), /contradicts between executors/);
});

test("the same policy from two executors is not a contradiction", async () => {
  const set = {
    canonicalToolIds: {}, definitions: [], effectCapabilities: { "workspace.read": ["inspect", "approval"] }, snapshotHash: "a",
  } as AiCoderRuntimeToolSet;
  const merged = await new CompositeToolExecutor([executor(set), executor({ ...set, snapshotHash: "b" } as AiCoderRuntimeToolSet)]).getToolSet({} as never);
  assert.deepEqual([...merged.effectCapabilities["workspace.read"]!].sort(), ["approval", "inspect"]);
});
