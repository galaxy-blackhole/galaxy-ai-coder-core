/**
 * The label table every host reads: a tool call should read as a name, not as the model-facing function id.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_LABELS, labelForModelName, toolLabel } from "../src/tools/tool-labels.js";

test("the model-facing ids a model actually calls are all named", () => {
  assert.equal(toolLabel("list_files"), "Liệt kê thư mục");
  assert.equal(toolLabel("detect_project"), "Nhận diện dự án");
  assert.equal(toolLabel("workspace.list"), "Liệt kê thư mục");
  assert.equal(TOOL_LABELS["list_dir"], undefined, "an unknown id is not invented");
});

test("a detail follows the label without leaking control characters", () => {
  assert.equal(toolLabel("read_file", { path: "src/app.ts" }), "Đọc tệp (src/app.ts)");
  assert.equal(toolLabel("run_command", { command: "npm\ttest\u0007" }), "Chạy lệnh (npm test )".trimEnd() + "");
  assert.equal(toolLabel("run_command", { command: "x", description: "Chạy kiểm thử" }), "Chạy lệnh (Chạy kiểm thử)");
  assert.equal(toolLabel("git.exec", { action: "diff" }), "Kiểm tra Git (git diff)");
});

test("an MCP id loses its hash and its server prefix", () => {
  assert.equal(labelForModelName("mcp_orbit_knowledge_read_ab12cd34ef56"), "Tra cứu tri thức Orbit");
  assert.equal(labelForModelName("mcp_x_some_unknown_tool_ab12cd34ef56"), "some unknown tool");
  assert.equal(toolLabel("totally_unknown"), "totally_unknown", "an unknown tool still reads as something");
});