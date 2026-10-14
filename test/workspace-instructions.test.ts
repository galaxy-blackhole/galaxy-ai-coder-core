import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceInstructions } from "../src/runtime/workspace-instructions.js";

async function workspace(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "galaxy-instructions-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  return root;
}

test("both conventions are read, AGENTS.md first", async () => {
  const root = await workspace({ "AGENTS.md": "quy tắc của dự án\n", "CLAUDE.md": "điều đã có từ công cụ khác\n" });
  try {
    const found = await readWorkspaceInstructions(root);
    assert.deepEqual(found.map((item) => item.source), ["AGENTS.md", "CLAUDE.md"]);
    assert.equal(found[0]?.content, "quy tắc của dự án");
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("a workspace with neither file yields nothing, and does not fail", async () => {
  const root = await workspace({});
  try { assert.deepEqual(await readWorkspaceInstructions(root), []); }
  finally { await rm(root, { force: true, recursive: true }); }
});

test("a large file is capped, and an empty one is skipped", async () => {
  const root = await workspace({ "AGENTS.md": "x".repeat(500), "CLAUDE.md": "   \n" });
  try {
    const found = await readWorkspaceInstructions(root, { maxChars: 100 });
    assert.equal(found.length, 1);
    assert.equal(found[0]?.content.length, 100);
  } finally { await rm(root, { force: true, recursive: true }); }
});
