/**
 * The façade the model reads instead of N schemas. Pure, so it is asserted byte for byte.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderCodeSdk } from "../src/tools/code-sdk.js";
import { AI_CODER_CORE_TOOL_CATALOG } from "../src/tools/tool-registry.js";

test("every active tool becomes one callable, sorted, with its title as the comment", () => {
  const [listFiles, readFile] = AI_CODER_CORE_TOOL_CATALOG.filter(tool => tool.id === "workspace.list" || tool.id === "workspace.read");
  const sdk = renderCodeSdk([readFile!, listFiles!]);
  const lines = sdk.split("\n").filter((line: string) => line.startsWith("declare function "));
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /^declare function list_files\(/, "sorted by model name: " + JSON.stringify(lines));
  assert.match(lines[1] ?? "", /^declare function read_file\(/);
  assert.match(sdk, /TOOLS, FROM INSIDE A PROGRAM/);
});

test("a required field is required and an optional one is optional", () => {
  const schema = { properties: { path: { type: "string" }, limit: { type: "number" } }, required: ["path"], type: "object" };
  const sdk = renderCodeSdk([{ id: "x", inputSchema: schema, modelName: "probe", title: "Probe", } as never]);
  assert.match(sdk, /declare function probe\(args: \{ path: string; limit\?: number \}\)/, sdk);
});

test("enums, arrays and unknown shapes stay unambiguous", () => {
  const schema = {
    properties: { action: { enum: ["read", "update"] }, paths: { items: { type: "string" }, type: "array" }, thing: {} },
    required: ["action", "paths", "thing"],
    type: "object",
  };
  const sdk = renderCodeSdk([{ id: "y", inputSchema: schema, modelName: "probe", title: "Probe" } as never]);
  assert.match(sdk, /action: "read" \| "update"/, sdk);
  assert.match(sdk, /paths: Array<string>/);
  assert.match(sdk, /thing: unknown/);
});