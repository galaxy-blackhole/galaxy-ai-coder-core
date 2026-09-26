import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type MarketplaceFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SkillIndexVersion {
  readonly path?: string;
  readonly sha256: string;
  readonly url?: string;
  readonly version: string;
}
export interface SkillIndexEntry {
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly tags?: readonly string[];
  readonly versions: readonly SkillIndexVersion[];
}
export interface SkillIndex {
  readonly schemaVersion: number;
  readonly skills: readonly SkillIndexEntry[];
  /** Base64 Ed25519 signature over the signature-free canonical index (see signSkillIndex). */
  readonly signature?: string;
}
export interface InstalledSkill {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
  readonly installedAt: string;
  readonly source: string;
}

const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_BYTES = 65536;
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Deterministic JSON with sorted object keys, so publisher and verifier agree byte-for-byte. */
export function stableSkillIndexJson(value: unknown): string {
  if (value === null || typeof value !== "object") return value === undefined ? "null" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSkillIndexJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSkillIndexJson(item)}`)
    .join(",")}}`;
}
function indexSignaturePayload(index: unknown): Buffer {
  const { signature: _signature, ...rest } = (index ?? {}) as Record<string, unknown>;
  return Buffer.from(stableSkillIndexJson(rest), "utf8");
}
/** Produce the base64 signature a publisher stores in the index `signature` field. */
export function signSkillIndex(index: unknown, privateKeyPem: string): string {
  return cryptoSign(null, indexSignaturePayload(index), privateKeyPem).toString("base64");
}
export function verifySkillIndexSignature(index: unknown, publicKeyPem: string): boolean {
  const signature = (index as { signature?: unknown } | null)?.signature;
  if (typeof signature !== "string" || signature.trim().length === 0) return false;
  try {
    return cryptoVerify(null, indexSignaturePayload(index), publicKeyPem, Buffer.from(signature, "base64"));
  } catch { return false; }
}

function isRemote(source: string): boolean {
  try { const url = new URL(source); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; }
}
function parseVersion(version: string): readonly [number, number, number, string] {
  const [core = "", pre = ""] = version.split("-", 2);
  const [major = 0, minor = 0, patch = 0] = core.split(".").map(part => Number(part));
  return [major, minor, patch, pre];
}
export function compareSkillVersions(left: string, right: string): number {
  const a = parseVersion(left); const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return (a[index] as number) - (b[index] as number);
  // A release outranks its prereleases; compare prerelease strings lexically otherwise.
  if (a[3] === b[3]) return 0;
  if (a[3] === "") return 1;
  if (b[3] === "") return -1;
  return a[3] < b[3] ? -1 : 1;
}
export function satisfiesSkillRange(version: string, range: string): boolean {
  const wanted = range.trim();
  if (wanted === "" || wanted === "*" || wanted === "latest") return true;
  const target = wanted.replace(/^[\^~]/, "");
  if (!VERSION.test(target)) throw new Error(`Invalid skill version range: ${range}`);
  if (compareSkillVersions(version, target) < 0) return false;
  const [major, minor] = parseVersion(target);
  if (wanted.startsWith("^")) return major > 0 ? parseVersion(version)[0] === major : minor > 0 ? parseVersion(version)[1] === minor : parseVersion(version)[2] === parseVersion(target)[2];
  if (wanted.startsWith("~")) return parseVersion(version)[0] === major && parseVersion(version)[1] === minor;
  return compareSkillVersions(version, target) === 0;
}

/**
 * Local-first skill marketplace. The index and skill bodies may be a filesystem
 * path or an HTTP(S) URL; every installed body is verified against the index
 * sha256 and written atomically outside the model-writable workspace.
 */
export class SkillMarketplace {
  private readonly fetchImpl: MarketplaceFetch;
  private readonly installRoot: string;
  private readonly indexSource: string;
  private readonly publicKey: string | undefined;
  constructor(options: { fetch?: MarketplaceFetch; index: string; installRoot: string; publicKey?: string }) {
    if (!options.index.trim()) throw new Error("A skill index path or URL is required.");
    if (!isAbsolute(options.installRoot)) throw new Error("The skill install root must be an absolute path.");
    if (options.publicKey !== undefined && !options.publicKey.includes("PUBLIC KEY")) throw new Error("The trusted skill index public key must be a PEM public key.");
    this.indexSource = options.index.trim();
    this.installRoot = options.installRoot;
    this.publicKey = options.publicKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  async loadIndex(): Promise<SkillIndex> {
    const raw = isRemote(this.indexSource)
      ? await this.fetchText(this.indexSource, MAX_INDEX_BYTES)
      : await readFile(this.indexSource, "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error("Skill index is not valid JSON."); }
    if (!parsed || typeof parsed !== "object" || (parsed as SkillIndex).schemaVersion !== 1 || !Array.isArray((parsed as SkillIndex).skills)) throw new Error("Unsupported skill index schema.");
    if (this.publicKey !== undefined && !verifySkillIndexSignature(parsed, this.publicKey)) {
      throw new Error("Skill index signature is missing or does not match the trusted public key.");
    }
    const skills = (parsed as SkillIndex).skills.map((entry) => this.validateEntry(entry));
    return Object.freeze({
      schemaVersion: 1,
      skills: Object.freeze(skills),
      ...(typeof (parsed as SkillIndex).signature === "string" ? { signature: (parsed as SkillIndex).signature } : {}),
    });
  }
  async search(query = ""): Promise<readonly SkillIndexEntry[]> {
    const index = await this.loadIndex();
    const needle = query.trim().toLowerCase();
    if (!needle) return index.skills;
    return index.skills.filter(entry => [entry.id, entry.name, entry.description, ...(entry.tags ?? [])].some(value => value.toLowerCase().includes(needle)));
  }
  async listInstalled(): Promise<readonly InstalledSkill[]> {
    const installed: InstalledSkill[] = [];
    for (const entry of await readdir(this.installRoot, { withFileTypes: true }).catch(() => [] as { isDirectory(): boolean; name: string }[])) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.installRoot, entry.name, ".galaxy-skill.json"), "utf8")) as InstalledSkill;
        if (meta && typeof meta.id === "string" && typeof meta.version === "string") installed.push(Object.freeze(meta));
      } catch { /* A directory without managed metadata is not a marketplace skill. */ }
    }
    return Object.freeze(installed.sort((left, right) => left.id.localeCompare(right.id)));
  }
  async install(id: string, options: { version?: string } = {}): Promise<{ changed: boolean; skill: InstalledSkill }> {
    const index = await this.loadIndex();
    const entry = index.skills.find(candidate => candidate.id === id);
    if (!entry) throw new Error(`Unknown skill: ${id}.`);
    const range = options.version ?? "*";
    const candidates = entry.versions.filter(candidate => satisfiesSkillRange(candidate.version, range)).sort((left, right) => compareSkillVersions(right.version, left.version));
    const chosen = candidates[0];
    if (!chosen) throw new Error(`No version of ${id} satisfies ${range}.`);
    const content = await this.loadSkillContent(chosen);
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== chosen.sha256.toLowerCase()) throw new Error(`Skill ${id}@${chosen.version} failed integrity verification.`);
    const existing = (await this.listInstalled()).find(skill => skill.id === id);
    if (existing && existing.sha256 === digest) return { changed: false, skill: existing };
    if (existing && compareSkillVersions(existing.version, chosen.version) > 0) throw new Error(`Installed ${id}@${existing.version} is newer than ${chosen.version}; pass an explicit version to downgrade.`);
    const skillDir = join(this.installRoot, id);
    await mkdir(skillDir, { recursive: true, mode: 0o700 });
    await this.atomicWrite(join(skillDir, "SKILL.md"), content);
    const skill: InstalledSkill = Object.freeze({ id, name: entry.name, version: chosen.version, sha256: digest, installedAt: new Date().toISOString(), source: chosen.url ?? chosen.path ?? this.indexSource });
    await this.atomicWrite(join(skillDir, ".galaxy-skill.json"), JSON.stringify(skill, null, 2));
    return { changed: true, skill };
  }
  async update(): Promise<readonly { changed: boolean; skill: InstalledSkill }[]> {
    const results: { changed: boolean; skill: InstalledSkill }[] = [];
    for (const installed of await this.listInstalled()) results.push(await this.install(installed.id, { version: "*" }).catch(() => ({ changed: false, skill: installed })));
    return Object.freeze(results);
  }
  async remove(id: string): Promise<boolean> {
    if (!SKILL_ID.test(id)) throw new Error("Invalid skill id.");
    const target = resolve(this.installRoot, id);
    if (dirname(target) !== resolve(this.installRoot)) throw new Error("Skill id escapes the install root.");
    try { await stat(target); } catch { return false; }
    await rm(target, { recursive: true, force: true });
    return true;
  }
  private validateEntry(value: unknown): SkillIndexEntry {
    if (!value || typeof value !== "object") throw new Error("Invalid skill index entry.");
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || !SKILL_ID.test(entry.id) || typeof entry.name !== "string" || typeof entry.description !== "string" || !Array.isArray(entry.versions) || entry.versions.length === 0) throw new Error("Invalid skill index entry.");
    const tags = Array.isArray(entry.tags) && entry.tags.every(tag => typeof tag === "string") ? Object.freeze(entry.tags as string[]) : undefined;
    const seen = new Set<string>();
    const versions = entry.versions.map((raw): SkillIndexVersion => {
      if (!raw || typeof raw !== "object") throw new Error(`Invalid version entry for ${entry.id}.`);
      const candidate = raw as Record<string, unknown>;
      if (typeof candidate.version !== "string" || !VERSION.test(candidate.version) || typeof candidate.sha256 !== "string" || !SHA256.test(candidate.sha256.toLowerCase())) throw new Error(`Invalid version entry for ${entry.id}.`);
      if ((typeof candidate.url !== "string" || !candidate.url) && (typeof candidate.path !== "string" || !candidate.path)) throw new Error(`Version ${candidate.version} of ${entry.id} needs a url or path.`);
      if (seen.has(candidate.version)) throw new Error(`Duplicate version ${candidate.version} for ${entry.id}.`);
      seen.add(candidate.version);
      return Object.freeze({
        version: candidate.version,
        sha256: candidate.sha256.toLowerCase(),
        ...(typeof candidate.url === "string" && candidate.url ? { url: candidate.url } : {}),
        ...(typeof candidate.path === "string" && candidate.path ? { path: candidate.path } : {}),
      });
    });
    return Object.freeze({ id: entry.id, name: entry.name, description: entry.description, versions: Object.freeze(versions), ...(tags === undefined ? {} : { tags }) });
  }
  private async loadSkillContent(version: SkillIndexVersion): Promise<string> {
    if (version.url) {
      if (!isRemote(version.url)) throw new Error("A remote skill index must use absolute HTTP(S) URLs.");
      return (await this.fetchText(version.url, MAX_SKILL_BYTES));
    }
    if (isRemote(this.indexSource)) {
      const base = new URL(this.indexSource);
      return await this.fetchText(new URL(version.path!, base).href, MAX_SKILL_BYTES);
    }
    if (isAbsolute(version.path!)) throw new Error("Local skill paths must be relative to the index.");
    const base = dirname(resolve(this.indexSource));
    const target = resolve(base, version.path!);
    if (target !== base && !target.startsWith(base + "/")) throw new Error("Skill path escapes the index directory.");
    return (await readFile(target, "utf8"));
  }
  private async fetchText(url: string, limit: number): Promise<string> {
    const response = await this.fetchImpl(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`Skill fetch failed (${response.status}) for ${url}.`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit) throw new Error(`Skill payload exceeds ${limit} bytes.`);
    return text;
  }
  private async atomicWrite(target: string, content: string): Promise<void> {
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }
}
