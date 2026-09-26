import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DirectorySkills } from "../src/adapters/node/skills/directory-skills.js";
import { SkillMarketplace, signSkillIndex } from "../src/adapters/node/skills/skill-marketplace.js";

function skillContent(version: string): string {
  return `---\nname: orbit-framework\ndescription: Orbit backend framework guidance\nversion: ${version}\ntags:\n  - orbit\n  - backend\n---\n\n# Orbit Framework\nBody ${version}\n`;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function setup(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "galaxy-marketplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = { "0.1.0": skillContent("0.1.0"), "0.1.5": skillContent("0.1.5"), "0.2.0": skillContent("0.2.0") } as const;
  await mkdir(join(root, "payload"), { recursive: true });
  for (const [version, content] of Object.entries(contents)) await writeFile(join(root, "payload", `orbit-${version}.md`), content);
  const index = {
    schemaVersion: 1,
    skills: [{
      id: "orbit-framework", name: "Orbit Framework", description: "Orbit backend framework guidance", tags: ["orbit", "backend"],
      versions: Object.entries(contents).map(([version, content]) => ({ version, path: `payload/orbit-${version}.md`, sha256: sha(content) })),
    }],
  };
  await writeFile(join(root, "index.json"), JSON.stringify(index));
  return { root, contents };
}

test("marketplace installs, resolves versions, updates and removes skills", async t => {
  const { root, contents } = await setup(t);
  const installRoot = join(root, "installed");
  const market = new SkillMarketplace({ index: join(root, "index.json"), installRoot });

  const search = await market.search("orbit");
  assert.deepEqual(search.map(entry => entry.id), ["orbit-framework"]);
  assert.deepEqual((await market.search("nope")).map(entry => entry.id), []);

  const pinned = await market.install("orbit-framework", { version: "^0.1.0" });
  assert.equal(pinned.changed, true);
  assert.equal(pinned.skill.version, "0.1.5");

  const idempotent = await market.install("orbit-framework", { version: "0.1.5" });
  assert.equal(idempotent.changed, false);

  // The installed skill is discoverable through the normal skills port.
  const catalog = await new DirectorySkills({ managed: installRoot }).list();
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]!.id, "managed/orbit-framework");
  assert.equal(catalog[0]!.version, "0.1.5");
  assert.deepEqual(catalog[0]!.tags, ["orbit", "backend"]);

  const updated = await market.update();
  assert.equal(updated[0]!.skill.version, "0.2.0");
  assert.equal(updated[0]!.changed, true);

  // Refuse an implicit downgrade without an explicit version.
  await assert.rejects(() => market.install("orbit-framework", { version: "0.1.0" }), /newer than/);

  assert.equal(await market.remove("orbit-framework"), true);
  assert.equal(await market.remove("orbit-framework"), false);
  assert.deepEqual(await market.listInstalled(), []);
  assert.ok(contents["0.1.0"].includes("Body 0.1.0"));
});

test("marketplace verifies a signed index and rejects tampering, missing or wrong keys", async t => {
  const { root } = await setup(t);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  index.signature = signSkillIndex(index, privatePem);
  await writeFile(join(root, "signed.json"), JSON.stringify(index));

  const signed = new SkillMarketplace({ index: join(root, "signed.json"), installRoot: join(root, "installed-signed"), publicKey: publicPem });
  assert.equal((await signed.install("orbit-framework")).skill.version, "0.2.0");

  const tampered = { ...index, skills: index.skills.map((entry: Record<string, unknown>) => ({ ...entry, name: "Tampered" })) };
  await writeFile(join(root, "tampered.json"), JSON.stringify(tampered));
  await assert.rejects(() => new SkillMarketplace({ index: join(root, "tampered.json"), installRoot: join(root, "bad"), publicKey: publicPem }).loadIndex(), /signature/);

  const unsigned = { ...index }; delete unsigned.signature;
  await writeFile(join(root, "unsigned.json"), JSON.stringify(unsigned));
  await assert.rejects(() => new SkillMarketplace({ index: join(root, "unsigned.json"), installRoot: join(root, "missing"), publicKey: publicPem }).loadIndex(), /signature/);

  const otherPem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  await assert.rejects(() => new SkillMarketplace({ index: join(root, "signed.json"), installRoot: join(root, "wrong"), publicKey: otherPem }).loadIndex(), /signature/);
});

test("marketplace rejects a tampered payload and an unknown skill", async t => {
  const { root } = await setup(t);
  const tampered = {
    schemaVersion: 1,
    skills: [{ id: "orbit-framework", name: "Orbit", description: "x", versions: [{ version: "0.2.0", path: "payload/orbit-0.2.0.md", sha256: "0".repeat(64) }] }],
  };
  await writeFile(join(root, "tampered.json"), JSON.stringify(tampered));
  const market = new SkillMarketplace({ index: join(root, "tampered.json"), installRoot: join(root, "installed-2") });
  await assert.rejects(() => market.install("orbit-framework"), /integrity/);
  await assert.rejects(() => market.install("does-not-exist"), /Unknown skill/);
  assert.deepEqual(await market.listInstalled(), []);
});
