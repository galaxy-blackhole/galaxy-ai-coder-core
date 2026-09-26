import assert from "node:assert/strict";
import test from "node:test";
import { OllamaEmbeddings } from "../src/adapters/node/memory/ollama-embeddings.js";

function response(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json" } });
}

test("OllamaEmbeddings batches input and omits credentials for localhost", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const provider = new OllamaEmbeddings({ baseUrl: "http://127.0.0.1:11434", model: "bge-m3", maxBatch: 2, apiKey: "secret", fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return response({ embeddings: body.input.map(() => [1, 0, 0]) });
  } });
  const vectors = await provider.embed(["a", "b", "c"]);
  assert.equal(vectors.length, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "http://127.0.0.1:11434/api/embed");
  assert.equal((calls[0]!.init?.headers as Record<string, string>).Authorization, undefined);
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)).input, ["a", "b"]);
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)).input, ["c"]);
});

test("OllamaEmbeddings sends the credential to a remote endpoint", async () => {
  let authorization: unknown;
  const provider = new OllamaEmbeddings({ baseUrl: "https://ollama.com", model: "bge-m3", apiKey: "secret", fetch: async (_url, init) => {
    authorization = (init?.headers as Record<string, string>)?.Authorization;
    return response({ embeddings: [[1, 0]] });
  } });
  await provider.embed(["x"]);
  assert.equal(authorization, "Bearer secret");
});

test("OllamaEmbeddings rejects mismatched, invalid or failed responses", async () => {
  const mismatch = new OllamaEmbeddings({ baseUrl: "http://127.0.0.1:11434", model: "m", fetch: async () => response({ embeddings: [[1, 0]] }) });
  await assert.rejects(() => mismatch.embed(["a", "b"]), /did not match/);
  const invalid = new OllamaEmbeddings({ baseUrl: "http://127.0.0.1:11434", model: "m", fetch: async () => response({ embeddings: [[1, "x"]] }) });
  await assert.rejects(() => invalid.embed(["a"]), /invalid vector/);
  const failure = new OllamaEmbeddings({ baseUrl: "http://127.0.0.1:11434", model: "m", fetch: async () => response({ error: "model not found" }, { ok: false, status: 404 }) });
  await assert.rejects(() => failure.embed(["a"]), /Ollama embedding failed \(404\)/);
});
