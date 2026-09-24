import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  publicOllamaConnection,
  resolveOllamaConnection,
} from "../../src/config/manual-provider-config.js";

test("manual Galaxy provider config supplies Ollama credentials without exposing them publicly", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, ".galaxy", "config.json");
  await mkdir(join(root, ".galaxy"));
  await writeFile(configPath, JSON.stringify({
    agent: [
      { type: "manual", apiKey: "manual-secret", model: "manual-model", baseUrl: "https://ollama.example/api/" },
      { type: "gemini", apiKey: "unrelated-secret" },
    ],
  }));

  const connection = await resolveOllamaConnection({
    configPath,
    environment: { OLLAMA_API_KEY: "environment-secret" },
  });
  assert.equal(connection.apiKey, "manual-secret");
  assert.equal(connection.credentialSource, "manual-config");
  assert.equal(connection.model, "manual-model");
  assert.equal(connection.baseUrl, "https://ollama.example/api");

  const publicValue = publicOllamaConnection(connection);
  assert.equal(JSON.stringify(publicValue).includes("manual-secret"), false);
  assert.equal("apiKey" in publicValue, false);
});

test("Ollama connection uses environment credentials and core defaults when manual config is absent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-no-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const connection = await resolveOllamaConnection({
    configPath: join(root, "missing.json"),
    environment: { OLLAMA_API_KEY: "environment-secret" },
  });
  assert.equal(connection.credentialSource, "environment");
  assert.equal(connection.apiKey, "environment-secret");
  assert.equal(connection.baseUrl, "https://ollama.com");
  assert.equal(connection.model, "glm-5.3-flash:cloud");
});

test("Ollama connection rejects unsafe base URLs and malformed Galaxy config", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "galaxy-code-bad-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  await writeFile(configPath, "not-json");
  await assert.rejects(() => resolveOllamaConnection({ configPath }), /not valid JSON/);

  await writeFile(configPath, JSON.stringify({ agent: [] }));
  await assert.rejects(
    () => resolveOllamaConnection({ configPath, baseUrl: "https://user:secret@ollama.example?key=x" }),
    /must not contain credentials/,
  );
});
