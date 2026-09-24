import assert from "node:assert/strict";
import test from "node:test";

import type { CodingRoundRequest, RunExecutionContext } from "@galaxy-stack/ai-coder-core/ports";

import { OllamaCodingModel } from "../../src/provider/ollama-coding-model.js";

function context(signal = new AbortController().signal): RunExecutionContext {
  return Object.freeze({
    deadline: Date.now() + 10_000,
    mode: "auto",
    runId: "run-live-test",
    signal,
    taskId: "task-live-test",
    workspaceRoot: "/tmp/live-test",
  });
}

function request(): CodingRoundRequest {
  return Object.freeze({
    maxOutputTokens: 2048,
    messages: Object.freeze([
      Object.freeze({ role: "system" as const, content: "system" }),
      Object.freeze({ role: "user" as const, content: "inspect" }),
    ]),
    preserveThinking: true,
    temperature: 0,
    think: true,
    tools: Object.freeze([Object.freeze({
      type: "function" as const,
      function: Object.freeze({ name: "list_files", description: "List", parameters: Object.freeze({ type: "object" }) }),
    })]),
  });
}

function ndjsonResponse(lines: readonly unknown[], splitAt?: number): Response {
  const bytes = new TextEncoder().encode(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const body = splitAt === undefined
    ? bytes
    : new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

test("Ollama NDJSON transport termination is retryable while invalid JSON is not", async () => {
  const partialBytes = new TextEncoder().encode('{"message":{"role":"assistant","content":"partial"}}\n');
  const terminatedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(partialBytes);
      controller.error(new TypeError("terminated"));
    },
  });
  const responses = [
    new Response(terminatedBody, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }),
    new Response(new TextEncoder().encode("{not-json}\n"), { status: 200, headers: { "Content-Type": "application/x-ndjson" } }),
  ];
  const model = new OllamaCodingModel({
    apiKey: "top-secret",
    baseUrl: "http://localhost:11434",
    model: "glm-5.3-flash:cloud",
    fetch: async () => responses.shift() ?? Response.json({ error: "missing mock" }, { status: 500 }),
  });

  const terminated = [];
  for await (const event of model.streamRound(request(), context())) terminated.push(event);
  const terminatedFailure = terminated.at(-1);
  assert.equal(terminatedFailure?.type, "error");
  if (terminatedFailure?.type === "error") {
    assert.equal(terminatedFailure.error.code, "MALFORMED_STREAM");
    assert.equal(terminatedFailure.error.retryable, true);
  }

  const malformed = [];
  for await (const event of model.streamRound(request(), context())) malformed.push(event);
  const malformedFailure = malformed.at(-1);
  assert.equal(malformedFailure?.type, "error");
  if (malformedFailure?.type === "error") {
    assert.equal(malformedFailure.error.code, "MALFORMED_STREAM");
    assert.equal(malformedFailure.error.retryable, false);
  }
});

test("Ollama model probes Kimi capabilities and maps split NDJSON through the canonical protocol", async () => {
  const requests: Readonly<{ body: string; headers: Headers; url: string }>[] = [];
  const mutableRequests: { body: string; headers: Headers; url: string }[] = [];
  const fetchMock = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    mutableRequests.push({ body: String(init?.body ?? ""), headers: new Headers(init?.headers), url: String(input) });
    if (String(input).endsWith("/api/show")) {
      return Response.json({
        capabilities: ["completion", "vision", "tools", "thinking"],
        model_info: { "kimi.context_length": 262144 },
      });
    }
    return ndjsonResponse([
      { message: { role: "assistant", thinking: "inspect" }, done: false },
      { message: { role: "assistant", tool_calls: [
        { id: "call-1", function: { name: "list_files", arguments: { path: "src" } } },
        { id: "call-2", function: { name: "list_files", arguments: { path: "test" } } },
      ] }, done: false },
      { message: { role: "assistant", content: "", thinking: "", tool_calls: [] }, done: true, done_reason: "stop", prompt_eval_count: 30, eval_count: 4 },
    ], 17);
  };
  void requests;
  const model = new OllamaCodingModel({
    apiKey: "top-secret",
    baseUrl: "https://ollama.example",
    model: "kimi-k2.7-code:cloud",
    fetch: fetchMock,
  });

  const capabilities = await model.capabilities(context());
  assert.equal(capabilities.ok, true);
  if (capabilities.ok) {
    assert.equal(capabilities.data.contextWindow, 262144);
    assert.equal(capabilities.data.toolCalling, "supported");
    assert.equal(capabilities.data.parallelToolCalling, "supported");
    assert.equal(capabilities.data.thinking, "required");
    assert.equal(capabilities.data.preserveThinking, "supported");
    assert.equal(capabilities.data.structuredOutput, "unknown");
    assert.equal(capabilities.data.maxOutputTokens, undefined, "the /api/show response does not verify an output-token ceiling");
  }
  const events = [];
  for await (const event of model.streamRound(request(), context())) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["started", "thinking", "tool_call", "tool_call", "usage", "done"]);
  const calls = events.filter((event) => event.type === "tool_call");
  const prefix = calls[0]?.call.toolCallId.replace(/:provider:call-1$/, '');
  assert.match(prefix ?? '', /^ollama:[0-9a-f-]{36}:1$/);
  assert.deepEqual(calls.map((event) => event.call.toolCallId), [`${prefix}:provider:call-1`, `${prefix}:provider:call-2`]);
  assert.deepEqual(calls.map((event) => event.call.arguments.path), ["src", "test"]);
  assert.deepEqual(model.diagnostics, { chatRequests: 1, normalizedEvents: 6, responseBytes: model.diagnostics.responseBytes, responseChunks: 3 });
  assert.equal(model.diagnostics.responseBytes > 0, true);

  assert.equal(mutableRequests.length, 2);
  assert.equal(mutableRequests[0]?.url, "https://ollama.example/api/show");
  assert.equal(mutableRequests[1]?.url, "https://ollama.example/api/chat");
  assert.equal(mutableRequests.every((item) => item.headers.get("authorization") === "Bearer top-secret"), true);
  const chatBody = JSON.parse(mutableRequests[1]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(chatBody.model, "kimi-k2.7-code:cloud");
  assert.equal(chatBody.stream, true);
  assert.equal(chatBody.think, true);
  assert.deepEqual(chatBody.options, { num_predict: 2048, temperature: 0 });
  assert.equal(JSON.stringify(chatBody).includes("top-secret"), false);
});

test("fresh Ollama adapters cannot reuse tool correlation IDs, with absent or repeated provider IDs", async () => {
  for (const providerId of [undefined, "same-provider-id"]) {
    const models = Array.from({ length: 2 }, () => new OllamaCodingModel({
      baseUrl: "https://ollama.example", model: "kimi-k2.7-code:cloud",
      fetch: async () => ndjsonResponse([{
        message: { role: "assistant", tool_calls: [{
          ...(providerId ? { id: providerId } : {}),
          function: { name: "list_files", arguments: { path: "." } },
        }] }, done: true, done_reason: "stop",
      }]),
    }));
    const ids: string[] = [];
    for (const model of models) {
      for (let round = 0; round < 2; round++) {
        for await (const event of model.streamRound(request(), context())) {
          if (event.type === "tool_call") ids.push(event.call.toolCallId);
        }
      }
    }
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4, "both adapter instance and round are correlation boundaries");
  }
});

test("Ollama model adapts oneOf and const without mutating the core tool schema", async () => {
  const parameters = Object.freeze({
    type: "object",
    properties: Object.freeze({
      precondition: Object.freeze({
        oneOf: Object.freeze([
          Object.freeze({
            type: "object",
            properties: Object.freeze({ kind: Object.freeze({ const: "must_not_exist" }) }),
            required: Object.freeze(["kind"]),
          }),
          Object.freeze({
            type: "object",
            properties: Object.freeze({
              kind: Object.freeze({ const: "matches_sha256" }),
              contentSha256: Object.freeze({ type: "string" }),
            }),
            required: Object.freeze(["kind", "contentSha256"]),
          }),
        ]),
      }),
    }),
    required: Object.freeze(["precondition"]),
  });
  let postedBody = "";
  const model = new OllamaCodingModel({
    baseUrl: "https://ollama.example",
    model: "kimi-k2.7-code:cloud",
    fetch: async (_input, init) => {
      postedBody = String(init?.body ?? "");
      return ndjsonResponse([{
        message: { role: "assistant", content: "No action needed." },
        done: true,
        done_reason: "stop",
      }]);
    },
  });
  const adaptedRequest = Object.freeze({
    ...request(),
    tools: Object.freeze([Object.freeze({
      type: "function" as const,
      function: Object.freeze({ name: "write_file", description: "Write", parameters }),
    })]),
  });

  const events = [];
  for await (const event of model.streamRound(adaptedRequest, context())) events.push(event);
  assert.equal(events.at(-1)?.type, "done");
  const posted = JSON.parse(postedBody) as Record<string, unknown>;
  const serializedTools = JSON.stringify(posted.tools);
  assert.equal(serializedTools.includes("\"oneOf\""), false);
  assert.equal(serializedTools.includes("\"const\""), false);
  assert.equal(serializedTools.includes("\"anyOf\""), true);
  assert.equal(serializedTools.includes("\"enum\":[\"must_not_exist\"]"), true);
  assert.equal(serializedTools.includes("\"enum\":[\"matches_sha256\"]"), true);
  assert.equal(JSON.stringify(parameters).includes("\"oneOf\""), true);
  assert.equal(JSON.stringify(parameters).includes("\"const\""), true);
});

test("Ollama model omits the optional tools field for a core tool-free finalization turn", async () => {
  let postedBody = "";
  const model = new OllamaCodingModel({
    baseUrl: "https://ollama.example",
    model: "kimi-k2.7-code:cloud",
    fetch: async (_input, init) => {
      postedBody = String(init?.body ?? "");
      return ndjsonResponse([{
        message: { role: "assistant", content: "Verified final report." },
        done: true,
        done_reason: "stop",
      }]);
    },
  });

  const events = [];
  for await (const event of model.streamRound(Object.freeze({
    ...request(),
    tools: Object.freeze([]),
  }), context())) events.push(event);

  assert.equal(events.at(-1)?.type, "done");
  const posted = JSON.parse(postedBody) as Record<string, unknown>;
  assert.equal(Object.hasOwn(posted, "tools"), false);
});

test("Ollama model classifies HTTP errors without leaking credentials", async () => {
  const model = new OllamaCodingModel({
    apiKey: "top-secret",
    baseUrl: "https://ollama.example/api",
    model: "missing",
    fetch: async () => Response.json({ error: "model missing; Bearer top-secret" }, { status: 404 }),
  });
  const probe = await model.capabilities(context());
  assert.equal(probe.ok, false);
  if (!probe.ok) {
    assert.equal(probe.error.code, "CAPABILITY_MISMATCH");
    assert.equal(probe.error.message.includes("top-secret"), false);
  }

  const events = [];
  for await (const event of model.streamRound(request(), context())) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["started", "error"]);
  const failure = events.at(-1);
  if (failure?.type === "error") {
    assert.equal(failure.error.code, "CAPABILITY_MISMATCH");
    assert.equal(failure.error.message.includes("top-secret"), false);
  }
});

test("Ollama model preserves a safe transport cause code without leaking credentials", async () => {
  const transportError = new TypeError("fetch failed with Bearer top-secret") as TypeError & {
    cause?: Readonly<{ code: string }>;
  };
  transportError.cause = Object.freeze({ code: "ENOTFOUND" });
  const model = new OllamaCodingModel({
    apiKey: "top-secret",
    baseUrl: "https://unresolvable.example",
    model: "kimi-k2.7-code:cloud",
    fetch: async () => { throw transportError; },
  });

  const probe = await model.capabilities(context());
  assert.equal(probe.ok, false);
  if (!probe.ok) {
    assert.equal(probe.error.code, "PROVIDER_ERROR");
    assert.match(probe.error.message, /cause=ENOTFOUND/);
    assert.equal(probe.error.message.includes("top-secret"), false);
    assert.equal(probe.error.retryable, true);
  }
});

test("Ollama model preserves mid-stream provider errors and empty terminal failures", async () => {
  const responses = [
    ndjsonResponse([{ message: { role: "assistant", content: "partial" }, done: false }, { error: "cloud unavailable; Bearer top-secret" }]),
    ndjsonResponse([{ message: { role: "assistant", content: "", thinking: "", tool_calls: [] }, done: true, done_reason: "stop" }]),
  ];
  const model = new OllamaCodingModel({
    apiKey: "top-secret",
    baseUrl: "http://localhost:11434",
    model: "kimi-k2.7-code:cloud",
    fetch: async () => responses.shift() ?? Response.json({ error: "missing mock" }, { status: 500 }),
  });

  const first = [];
  for await (const event of model.streamRound(request(), context())) first.push(event);
  const firstFailure = first.at(-1);
  assert.equal(firstFailure?.type, "error");
  if (firstFailure?.type === "error") {
    assert.equal(firstFailure.error.code, "PROVIDER_ERROR");
    assert.equal(firstFailure.error.message.includes("top-secret"), false);
  }

  const second = [];
  for await (const event of model.streamRound(request(), context())) second.push(event);
  assert.deepEqual(second.map((event) => event.type), ["started", "error"]);
  const secondFailure = second.at(-1);
  if (secondFailure?.type === "error") assert.equal(secondFailure.error.code, "MALFORMED_STREAM");
});

test("Ollama model cancellation reaches an active fetch", async () => {
  const controller = new AbortController();
  const model = new OllamaCodingModel({
    baseUrl: "http://localhost:11434",
    model: "kimi-k2.7-code:cloud",
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });
  const events = [];
  setTimeout(() => controller.abort(new Error("test cancel")), 5);
  for await (const event of model.streamRound(request(), context(controller.signal))) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["started", "error"]);
  const failure = events.at(-1);
  if (failure?.type === "error") assert.equal(failure.error.code, "CANCELED");
});

test("Ollama model cancellation remains active while the NDJSON body is streaming", async () => {
  const abortController = new AbortController();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let bodyCanceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode('{"message":{"role":"assistant","thinking":"waiting"},"done":false}\n'));
    },
    cancel() {
      bodyCanceled = true;
    },
  });
  const model = new OllamaCodingModel({
    baseUrl: "http://localhost:11434",
    model: "kimi-k2.7-code:cloud",
    fetch: async () => new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }),
  });
  const collecting = (async () => {
    const received = [];
    for await (const event of model.streamRound(request(), context(abortController.signal))) received.push(event);
    return received;
  })();
  setTimeout(() => abortController.abort(new Error("cancel after headers")), 5);
  const outcome = await Promise.race([
    collecting.then(() => "completed" as const),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 75)),
  ]);
  if (outcome === "timed-out") streamController.error(new Error("test cleanup"));
  const received = await collecting;

  assert.equal(outcome, "completed", "stream consumption must stop promptly after cancellation");
  assert.equal(bodyCanceled, true, "the response body reader must be canceled");
  assert.deepEqual(received.map((event) => event.type), ["started", "thinking", "error"]);
  const failure = received.at(-1);
  if (failure?.type === "error") assert.equal(failure.error.code, "CANCELED");
});


test("Ollama delivers thinking and UTF-8 text while the HTTP body is still open", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; }, cancel() { canceled = true; } });
  const model = new OllamaCodingModel({ baseUrl: "http://localhost:11434", model: "stream-test", fetch: async () => new Response(body) });
  const abort = new AbortController();
  const received: import("@galaxy-stack/ai-coder-core").CodingRoundEvent[] = [];
  let first!: () => void;
  const firstContent = new Promise<void>(resolve => { first = resolve; });
  let ended = false;
  const collecting = (async () => {
    for await (const event of model.streamRound(request(), context(abort.signal))) {
      received.push(event); if (event.type === "content") first();
    }
    ended = true;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ message: { thinking: "Đang nghĩ" }, done: false }) + "\n" + JSON.stringify({ message: { content: "Xin chào 👩‍💻" }, done: false }) + "\n");
    const emojiStart = bytes.findIndex((byte) => byte === 0xf0);
    writer.enqueue(bytes.slice(0, emojiStart + 2)); writer.enqueue(bytes.slice(emojiStart + 2));
    await Promise.race([firstContent, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("First delta was buffered until EOF")), 1000); })]);
    assert.equal(ended, false, "UI-facing deltas must arrive before completion");
    assert.deepEqual(received.map(event => event.type), ["started", "thinking", "content"]);
    const partial = received.at(-1); assert.equal(partial?.type === "content" ? partial.delta : null, "Xin chào 👩‍💻");
    writer.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "!" }, done: true, done_reason: "stop" }))); writer.close();
    await collecting;
    const done = received.at(-1); assert.equal(done?.type, "done");
    if (done?.type === "done") assert.equal(done.content, "Xin chào 👩‍💻!");
    assert.equal(received.filter(event => event.type === "started").length, 1);
    assert.equal(model.diagnostics.responseChunks, 3);
  } finally { clearTimeout(timer); abort.abort(); await collecting; }
  assert.equal(canceled, false, "normally closed bodies need no forced cancellation");
});

test("Ollama cancels its response body when a consumer stops before reading payload", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const model = new OllamaCodingModel({ baseUrl: "http://localhost:11434", model: "stream-test", fetch: async () => new Response(body) });
  const stream = model.streamRound(request(), context())[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value?.type, "started");
  await stream.return?.();
  assert.equal(canceled, true);
});

test("incremental Ollama response still enforces the byte limit and cancels malformed streams", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(writer) {
      writer.enqueue(new TextEncoder().encode('{"message":{"content":"partial"},"done":false}\n'));
      writer.enqueue(new Uint8Array(8 * 1024 * 1024));
    },
    cancel() { canceled = true; },
  });
  const model = new OllamaCodingModel({ baseUrl: "http://localhost:11434", model: "stream-test", fetch: async () => new Response(body) });
  const events = [];
  for await (const event of model.streamRound(request(), context())) events.push(event);
  assert.deepEqual(events.map(event => event.type), ["started", "content", "error"]);
  const failure = events.at(-1); if (failure?.type === "error") assert.match(failure.error.message, /8 MiB/);
  assert.equal(canceled, true);
});
