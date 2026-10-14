/**
 * Skills a workspace keeps on disk.
 *
 * A skill is a document that teaches a call shape, and it belongs to the project rather than to us, so it is read
 * from files: `.galaxy/skills/<name>/SKILL.md` is our own convention, and `.claude/skills/<name>/SKILL.md` is what a
 * project may already have. A team should not have to move a file to be taught to us.
 *
 * Reading is tolerant in the same way the rest of this product is: a missing directory is a workspace with no skills,
 * and a malformed frontmatter falls back to the directory name rather than hiding the skill.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkspaceSkill {
  readonly body: string;
  readonly description: string;
  readonly name: string;
  /** Where it was read from, so a person can go and edit it. */
  readonly source: string;
}

/** The places skills are looked for, in the order they are read. */
export const SKILL_DIRECTORIES = Object.freeze([
  Object.freeze([".galaxy", "skills"]),
  Object.freeze([".claude", "skills"]),
]);

interface Frontmatter {
  readonly body: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Splits `---` frontmatter from the body. Only the flat `key: value` lines a skill needs are understood; anything
 * more elaborate would be a YAML parser, and a skill that needs one is not this feature.
 */
export function parseSkillDocument(text: string): Frontmatter {
  const lines = text.split(String.fromCharCode(10));
  if (lines[0]?.trim() !== "---") return Object.freeze({ body: text.trim(), fields: Object.freeze({}) });
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return Object.freeze({ body: text.trim(), fields: Object.freeze({}) });
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return Object.freeze({ body: lines.slice(end + 1).join(String.fromCharCode(10)).trim(), fields: Object.freeze(fields) });
}

async function readSkillFile(source: string, directoryName: string): Promise<WorkspaceSkill | null> {
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch {
    return null;
  }
  const { body, fields } = parseSkillDocument(text);
  const name = (fields.name ?? directoryName).trim();
  if (name.length === 0 || body.length === 0) return null;
  return Object.freeze({
    body,
    description: (fields.description ?? "").trim(),
    name,
    source,
  });
}

/**
 * Every skill this workspace keeps, by name. Our own directory wins when both define the same skill, because it is
 * the one this product documents and therefore the one a person editing it expects to win.
 */
export async function readWorkspaceSkills(workspaceRoot: string): Promise<readonly WorkspaceSkill[]> {
  const found = new Map<string, WorkspaceSkill>();
  for (const parts of SKILL_DIRECTORIES) {
    const root = join(workspaceRoot, ...parts);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const skill = await readSkillFile(join(root, entry, "SKILL.md"), entry);
      if (skill !== null && !found.has(skill.name)) found.set(skill.name, skill);
    }
  }
  return Object.freeze([...found.values()].sort((left, right) => left.name < right.name ? -1 : 1));
}

/** How a workspace's skills are listed for the model: names, descriptions, and where to read them. */
export function formatSkillList(skills: readonly WorkspaceSkill[]): string {
  return skills
    .map((skill) => skill.name + (skill.description.length === 0 ? "" : " — " + skill.description) + "  [" + skill.source + "]")
    .join(String.fromCharCode(10));
}
