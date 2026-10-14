import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSkillList, parseSkillDocument, readWorkspaceSkills } from "../src/runtime/skills.js";

test("frontmatter is read, and a document without it is still a skill", () => {
  const parsed = parseSkillDocument("---\nname: orbit-framework\ndescription: cách gọi Orbit\n---\n\nNội dung skill\n");
  assert.equal(parsed.fields.name, "orbit-framework");
  assert.equal(parsed.fields.description, "cách gọi Orbit");
  assert.equal(parsed.body, "Nội dung skill");
  const plain = parseSkillDocument("chỉ là nội dung\n");
  assert.deepEqual(plain.fields, {});
  assert.equal(plain.body, "chỉ là nội dung");
});

test("both conventions are read, and ours wins on a tie", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-skills-"));
  try {
    await mkdir(join(root, ".galaxy", "skills", "orbit"), { recursive: true });
    await mkdir(join(root, ".claude", "skills", "orbit"), { recursive: true });
    await mkdir(join(root, ".claude", "skills", "other"), { recursive: true });
    await writeFile(join(root, ".galaxy", "skills", "orbit", "SKILL.md"), "---\nname: orbit\ndescription: của ta\n---\ncủa ta\n");
    await writeFile(join(root, ".claude", "skills", "orbit", "SKILL.md"), "---\nname: orbit\ndescription: của claude\n---\ncủa claude\n");
    await writeFile(join(root, ".claude", "skills", "other", "SKILL.md"), "không frontmatter\n");
    const skills = await readWorkspaceSkills(root);
    assert.deepEqual(skills.map((skill) => skill.name), ["orbit", "other"], "sorted, no duplicates");
    assert.equal(skills[0]?.description, "của ta", "our own directory is the one a person edits");
    assert.equal(skills[1]?.name, "other", "the directory name is the fallback");
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("a skill that needs an MCP server says so, and the listing says it too", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-skills-"));
  try {
    await mkdir(join(root, ".galaxy", "skills", "orbit"), { recursive: true });
    await writeFile(join(root, ".galaxy", "skills", "orbit", "SKILL.md"), [
      "---", "name: orbit", "description: cách gọi Orbit", "requires:", '  orbit: ">=0.4.1"', '  galaxy-ui: "*"', "---", "Nội dung",
    ].join("\n"));
    const skills = await readWorkspaceSkills(root);
    /* The validator returns them in a canonical order, so the same skill always reads the same way. */
    assert.deepEqual(skills[0]?.requires, [
      { range: "*", server: "galaxy-ui" },
      { range: ">=0.4.1", server: "orbit" },
    ]);
    const listing = formatSkillList(skills);
    assert.match(listing, /needs: galaxy-ui\*, orbit>=0\.4\.1/);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("a malformed requirement does not hide the skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-skills-"));
  try {
    await mkdir(join(root, ".galaxy", "skills", "broken"), { recursive: true });
    await writeFile(join(root, ".galaxy", "skills", "broken", "SKILL.md"), ["---", "name: broken", "requires:", "  không hợp lệ: x", "---", "vẫn đọc được"].join("\n"));
    const skills = await readWorkspaceSkills(root);
    assert.equal(skills.length, 1, "the document is still there");
    assert.deepEqual(skills[0]?.requires, [], "the requirement that cannot be read is not invented");
    assert.equal(skills[0]?.body, "vẫn đọc được");
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("a workspace without skills is not a failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-skills-"));
  try { assert.deepEqual(await readWorkspaceSkills(root), []); }
  finally { await rm(root, { force: true, recursive: true }); }
});

test("the listing names each skill and where it lives", () => {
  const listing = formatSkillList([{ body: "x", description: "cách gọi", name: "orbit", requires: [], source: "/w/.galaxy/skills/orbit/SKILL.md" }]);
  assert.match(listing, /^orbit — cách gọi {2}\[\/w/);
});
