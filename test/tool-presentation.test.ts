/**
 * The projection is the whole contract of a tools mode: what the model sees in a round.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPresentationAvailable,
  parseToolPresentationMode,
  projectToolDefinitions,
  RUN_CODE_TOOL_NAME,
} from "../src/tools/tool-presentation.ts";
import { AI_CODER_CORE_TOOL_CATALOG, descriptorToModelDefinition } from "../src/tools/tool-registry.ts";

const RUN_CODE = descriptorToModelDefinition(AI_CODER_CORE_TOOL_CATALOG.find(tool => tool.id === "code.run")!);
const OTHERS = AI_CODER_CORE_TOOL_CATALOG.slice(0, 3).map(descriptorToModelDefinition);

test("native keeps the registry, ptc sends run_code alone, both sends one more", () => {
  const native = projectToolDefinitions("native", OTHERS, RUN_CODE);
  assert.equal(native.length, OTHERS.length);
  assert.equal(native.some(tool => tool.function.name === RUN_CODE_TOOL_NAME), false, "a native round never shows run_code");
  const ptc = projectToolDefinitions("ptc", OTHERS, RUN_CODE);
  assert.equal(ptc.length, 1, "ptc collapses the registry into one entry point");
  assert.equal(ptc[0]?.function.name, RUN_CODE_TOOL_NAME);
  assert.equal(projectToolDefinitions("both", OTHERS, RUN_CODE).length, OTHERS.length + 1);
});

test("the run_code definition comes from the catalogue, not from a second copy", () => {
  const entry = AI_CODER_CORE_TOOL_CATALOG.find(tool => tool.id === "code.run");
  assert.ok(entry, "code.run is in the catalogue");
  assert.equal(RUN_CODE.function.name, entry.modelName);
  assert.ok(RUN_CODE.function.description.includes("ptc"), "and its description explains the mode it belongs to");
  assert.equal(entry.category, "command");
});

test("a ptc session with no composed runtime fails before the model is asked anything", () => {
  assert.throws(() => assertPresentationAvailable("ptc", false), /CODE_RUNTIME_MISSING/);
  assert.throws(() => assertPresentationAvailable("both", false), /CODE_RUNTIME_MISSING/);
  assertPresentationAvailable("native", false);
  assertPresentationAvailable("ptc", true);
});

test("the mode parser accepts exactly the three modes", () => {
  assert.equal(parseToolPresentationMode(" PTC "), "ptc");
  assert.equal(parseToolPresentationMode("Native"), "native");
  assert.throws(() => parseToolPresentationMode("turbo"), /Invalid tools mode/);
});