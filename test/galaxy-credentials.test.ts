import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  galaxyCredentialsHealth,
  galaxyCredentialsPath,
  galaxyRefName,
  parseGalaxyCredentials,
  readGalaxyCredential,
  readGalaxyCredentials,
  renderRefValue,
  upsertGalaxyCredential,
} from "../src/adapters/node/config/galaxy-credentials.js";

async function withTemp<T>(run: (path: string) => Promise<T> | T): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "galaxy-credentials-"));
  await mkdir(join(home, ".galaxy"), { recursive: true });
  try {
    return await run(galaxyCredentialsPath(home));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const SHARED_DOCUMENT = `version: 1
records:
  client-connection/browser-session:
    kind: browser-session
    payload:
      version: 1
      secret: abc
refs:
  GBH_GALAXY_API_KEY: sk-first
`;

test("reference names derive from the provider id", () => {
  assert.equal(galaxyRefName("galaxy"), "GBH_GALAXY_API_KEY");
  assert.equal(galaxyRefName("anthropic"), "GBH_ANTHROPIC_API_KEY");
  assert.equal(galaxyRefName("my-gateway"), "GBH_MY_GATEWAY_API_KEY");
  assert.equal(galaxyRefName("  Ollama Local  "), "GBH_OLLAMA_LOCAL_API_KEY");
  assert.equal(galaxyRefName("***"), "GBH_PROVIDER_API_KEY");
});

test("a missing document reads as empty, never as an error", async () => {
  await withTemp(async path => {
    const document = readGalaxyCredentials(path);
    assert.deepEqual(document.refs, {});
    assert.equal(document.version, undefined);
    assert.equal(readGalaxyCredential("GBH_GALAXY_API_KEY", path), undefined);
    assert.equal(galaxyCredentialsHealth(path).exists, false);
  });
});

test("writing a key creates a versioned document DSH can read", async () => {
  await withTemp(async path => {
    upsertGalaxyCredential("GBH_GALAXY_API_KEY", "sk-live", path);
    const text = await readFile(path, "utf8");
    assert.match(text, /^version: 1$/m);
    assert.match(text, /^refs:$/m);
    assert.equal(readGalaxyCredential("GBH_GALAXY_API_KEY", path), "sk-live");
    const health = galaxyCredentialsHealth(path);
    assert.equal(health.version, 1);
    assert.equal(health.ownerOnly, true, "the writer must produce an owner-only file");
    assert.deepEqual(health.refs, ["GBH_GALAXY_API_KEY"]);
  });
});

test("editing one reference leaves records, comments, and other refs byte-identical", async () => {
  await withTemp(async path => {
    await writeFile(path, SHARED_DOCUMENT, "utf8");
    upsertGalaxyCredential("GBH_ANTHROPIC_API_KEY", "sk-ant", path);
    upsertGalaxyCredential("GBH_GALAXY_API_KEY", "sk-second", path);
    const text = await readFile(path, "utf8");
    assert.match(text, /^records:$/m);
    assert.match(text, /^ {2}client-connection\/browser-session:$/m);
    assert.match(text, /^ {6}secret: abc$/m);
    assert.match(text, /^ {2}GBH_GALAXY_API_KEY: sk-second$/m);
    assert.match(text, /^ {2}GBH_ANTHROPIC_API_KEY: sk-ant$/m);
    const document = parseGalaxyCredentials(text);
    assert.equal(document.refs["GBH_GALAXY_API_KEY"], "sk-second");
    assert.equal(Object.keys(document.refs).length, 2);
  });
});

test("an empty value removes the reference and leaves the block in place", async () => {
  await withTemp(async path => {
    await writeFile(path, SHARED_DOCUMENT, "utf8");
    upsertGalaxyCredential("GBH_GALAXY_API_KEY", "", path);
    const text = await readFile(path, "utf8");
    assert.doesNotMatch(text, /GBH_GALAXY_API_KEY/);
    assert.match(text, /^refs:$/m);
    assert.equal(readGalaxyCredential("GBH_GALAXY_API_KEY", path), undefined);
  });
});

test("values that need quoting round-trip", async () => {
  const value = 'sk with spaces # not-a-comment "quoted"';
  assert.equal(renderRefValue(value), JSON.stringify(value));
  await withTemp(async path => {
    upsertGalaxyCredential("GBH_ODD_API_KEY", value, path);
    assert.equal(readGalaxyCredential("GBH_ODD_API_KEY", path), value);
  });
});

test("a plain scalar stops at an inline comment", () => {
  const document = parseGalaxyCredentials("refs:\n  GBH_ONE_API_KEY: sk-one # rotated 2026\n");
  assert.equal(document.refs["GBH_ONE_API_KEY"], "sk-one");
});

test("the pre-release flat layout still reads", () => {
  const document = parseGalaxyCredentials("GBH_GALAXY_API_KEY: sk-flat\n");
  assert.equal(document.version, undefined);
  assert.equal(document.refs["GBH_GALAXY_API_KEY"], "sk-flat");
});

test("health reports a file another writer made world-readable", async () => {
  await withTemp(async path => {
    upsertGalaxyCredential("GBH_GALAXY_API_KEY", "sk-live", path);
    await chmod(path, 0o644);
    const health = galaxyCredentialsHealth(path);
    assert.equal(health.ownerOnly, false);
    assert.equal(health.mode, "644");
  });
});
