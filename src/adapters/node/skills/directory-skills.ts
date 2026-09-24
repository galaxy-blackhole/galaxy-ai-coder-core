import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { AgentSkillsPort, SkillDescriptor } from "../../../agent/index.js";

const MAX_BYTES = 65536;
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
async function boundedFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Skill resource must be a regular file up to 64 KiB.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error("Skill resource exceeded its size limit.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}
function describe(id: string, source: string, content: string): SkillDescriptor {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!front) throw new Error(`Skill ${id} requires YAML frontmatter.`);
  const metadata: unknown = parse(front[1]!, { maxAliasCount: 20 });
  if (!metadata || typeof metadata !== "object" || !("name" in metadata) || !("description" in metadata) || typeof metadata.name !== "string" || typeof metadata.description !== "string" || !metadata.name.trim() || !metadata.description.trim() || metadata.description.length > 2048) throw new Error(`Invalid skill metadata: ${id}`);
  return { id, name: metadata.name, description: metadata.description, source, contentHash: createHash("sha256").update(content).digest("hex") };
}
export class DirectorySkills implements AgentSkillsPort {
  private readonly entries = new Map<string, { root: string; hash: string }>();
  constructor(private readonly roots: Readonly<Record<string, string>>) {}
  async list(): Promise<readonly SkillDescriptor[]> {
    const result: SkillDescriptor[] = [];
    this.entries.clear();
    for (const [namespace, path] of Object.entries(this.roots)) {
      let root: string;
      try { root = await realpath(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
      for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        if (result.length >= 256) throw new Error("Skill catalog exceeds 256 entries; narrow the configured roots.");
        const skillRoot = await realpath(join(root, entry.name));
        const source = await realpath(join(skillRoot, "SKILL.md")).catch(e => { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; });
        if (!source) continue;
        if (!inside(root, skillRoot) || !inside(skillRoot, source)) throw new Error("Skill path escapes its catalog.");
        const descriptor = describe(`${namespace}/${entry.name}`, source, await boundedFile(source));
        this.entries.set(descriptor.id, { root: skillRoot, hash: descriptor.contentHash }); result.push(descriptor);
      }
    }
    return result;
  }
  async load(id: string): Promise<SkillDescriptor & { readonly content: string }> {
    const content = await this.readResource(id, "SKILL.md");
    const entry = this.entries.get(id)!;
    const descriptor = describe(id, join(entry.root, "SKILL.md"), content);
    if (entry.hash !== descriptor.contentHash) throw new Error("Skill changed after discovery; refresh the catalog.");
    return { ...descriptor, content };
  }
  async readResource(id: string, path: string): Promise<string> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown skill. Discover skills before loading.");
    if (isAbsolute(path)) throw new Error("Skill resources must use relative paths.");
    const target = await realpath(resolve(entry.root, path));
    if (!inside(entry.root, target)) throw new Error("Skill resource escapes its directory.");
    return boundedFile(target);
  }
}
