import type { AiCoderRuntimeEvent } from "@galaxy-stack/ai-coder-core";
import assert from "node:assert/strict";
import test from "node:test";

import { observeResearch } from "../../src/live/research-observations.js";

type Event = AiCoderRuntimeEvent;
const start = (toolCallId: string): Event => ({
  type: "tool_start",
  call: { toolCallId },
}) as Event;

function result(
  toolCallId: string,
  canonicalToolId: string,
  output: unknown,
  extra: Record<string, unknown> = {},
): Event {
  return {
    type: "tool_result",
    call: { toolCallId },
    result: {
      canonicalToolId,
      ok: true,
      content: JSON.stringify(output),
      ...extra,
    },
  } as Event;
}

const search = (id: string, urls: readonly string[]): Event => result(id, "research.search", {
  results: urls.map(url => ({ title: "Documentation", url, content: "A search excerpt, not a fetched page." })),
});
const fetch = (id: string, url: string, content = "Fetched documentation."): Event => result(id, "research.fetch", {
  url,
  content,
  contentHash: "sha256:source-evidence",
});
const write = (id: string, authority = "host"): Event => result(id, "command.run", {}, {
  effectsAuthority: authority,
  effects: { writes: [{ path: "src/catalog.mjs", contentHash: "sha256:write" }] },
});
const required = {
  minSearchCalls: 1,
  minFetchCalls: 1,
  requiredDomains: ["sqlite.org"],
  requireCitations: true,
  beforeFirstWrite: true,
} as const;

test("research observations accept fetched citations, canonical fragments, and successful pre-write research", () => {
  const observed = observeResearch([
    start("search"),
    search("search", ["https://sqlite.org/lang_transaction.html#immediate"]),
    start("fetch"),
    fetch("fetch", "https://sqlite.org/lang_transaction.html"),
    start("edit"),
    write("edit"),
  ], "Use an explicit transaction. [SQLite](https://sqlite.org/lang_transaction.html#immediate).", required);

  assert.equal(observed.scope, "current_process");
  assert.equal(observed.searchCalls, 1);
  assert.equal(observed.fetchCalls, 1);
  assert.deepEqual(observed.citedUrls, ["https://sqlite.org/lang_transaction.html"]);
  assert.deepEqual(observed.unsupportedCitations, []);
  assert.equal(observed.researchBeforeFirstWrite, true);
  assert.deepEqual(observed.failures, []);
  assert.equal(observed.sources.find(source => source.kind === "fetch")?.contentHash, "sha256:source-evidence");
  assert.ok(Object.isFrozen(observed));
  assert.ok(Object.isFrozen(observed.sources));
});

test("resumed runs keep credit for research seeded from the checkpoint", () => {
  const observed = observeResearch([
    start("read"),
    write("read"),
  ], "Use an explicit transaction. [SQLite](https://sqlite.org/lang_transaction.html#immediate).", required, [
    { url: "https://sqlite.org/lang_transaction.html", kind: "fetch", contentHash: "sha256:seeded" },
    { url: "https://sqlite.org/search-results", kind: "search" },
  ]);

  assert.equal(observed.scope, "current_process_with_checkpoint_seed");
  assert.equal(observed.searchCalls, 1);
  assert.equal(observed.fetchCalls, 1);
  assert.equal(observed.researchBeforeFirstWrite, true);
  assert.deepEqual(observed.unsupportedCitations, []);
  assert.deepEqual(observed.failures, []);
  assert.equal(observed.sources.find(source => source.kind === "fetch")?.contentHash, "sha256:seeded");
});

test("search snippets cannot satisfy fetched-domain or citation evidence and fabricated citations fail", () => {
  const observed = observeResearch([
    search("search", ["https://sqlite.org/lang_transaction.html"]),
  ], "See [SQLite](https://sqlite.org/lang_transaction.html) and https://example.com/invented.", required);

  assert.equal(observed.searchCalls, 1);
  assert.equal(observed.fetchCalls, 0);
  assert.deepEqual(observed.unsupportedCitations, [
    "https://sqlite.org/lang_transaction.html",
    "https://example.com/invented",
  ]);
  assert.ok(observed.failures.some(message => message.includes("Too few non-empty")));
  assert.ok(observed.failures.some(message => message.includes("required domain 'sqlite.org'")));
  assert.ok(observed.failures.some(message => message.includes("lacks a citation")));
  assert.ok(observed.failures.some(message => message.includes("without successful fetch evidence")));
});

test("research citations preserve balanced parentheses belonging to the fetched URL", () => {
  const url = "https://en.wikipedia.org/wiki/Retry_(pattern)";
  for (const citation of [`[Source](${url}).`, `(${url})`, `<${url}>`, url]) {
    const observed = observeResearch([fetch("f", url)], citation, { minFetchCalls: 1, requireCitations: true });
    assert.deepEqual(observed.citedUrls, [url], citation);
    assert.deepEqual(observed.failures, [], citation);
  }
});

test("failed, unreadable, invalid-URL, and empty fetch outputs cannot create successful research evidence", () => {
  const observed = observeResearch([
    search("search", ["https://sqlite.org/lang_transaction.html"]),
    result("denied", "research.fetch", { url: "https://sqlite.org/lang_transaction.html", content: "not delivered" }, {
      ok: false,
      error: { code: "NETWORK_DENIED" },
    }),
    result("unreadable", "research.fetch", null, { content: "{invalid" }),
    fetch("empty", "https://sqlite.org/lang_transaction.html", " \n\t"),
    fetch("scheme", "file:///tmp/invented-source"),
    fetch("credentials", "https://sqlite.org@attacker.invalid/page"),
    fetch("relative", "/lang_transaction.html"),
    result("null", "research.fetch", null),
  ], "See https://sqlite.org/lang_transaction.html.", required);

  assert.equal(observed.fetchCalls, 0);
  assert.deepEqual(observed.failedCalls, [
    { tool: "research.fetch", code: "NETWORK_DENIED" },
    { tool: "research.fetch", code: "UNREADABLE_TOOL_OUTPUT" },
  ]);
  assert.equal(observed.sources.filter(source => source.kind === "fetch").length, 0);
  assert.deepEqual(observed.unsupportedCitations, ["https://sqlite.org/lang_transaction.html"]);
  assert.ok(observed.failures.some(message => message.includes("Too few non-empty")));
});

test("research required domains reject suffix, path, and user-info spoofing but permit real subdomains", () => {
  for (const spoof of [
    "https://sqlite.org.attacker.invalid/doc",
    "https://notsqlite.org/doc",
    "https://attacker.invalid/sqlite.org/doc",
    "https://sqlite.org@attacker.invalid/doc",
    "https://attacker.invalid/?source=sqlite.org",
  ]) {
    const observed = observeResearch([search("s", [spoof]), fetch("f", spoof)], "", {
      minFetchCalls: 1,
      requiredDomains: ["sqlite.org"],
    });
    assert.ok(observed.failures.some(message => message.includes("required domain 'sqlite.org'")), spoof);
  }
  const observed = observeResearch([
    fetch("real", "https://www.sqlite.org/lang_transaction.html"),
  ], "", { minFetchCalls: 1, requiredDomains: ["sqlite.org"] });
  assert.deepEqual(observed.failures, []);
});

test("research ordering uses writer dispatch time even if its result arrives after the fetch", () => {
  const observed = observeResearch([
    search("s", ["https://sqlite.org/lang_transaction.html"]),
    start("writer"),
    start("f"),
    fetch("f", "https://sqlite.org/lang_transaction.html"),
    write("writer"),
  ], "https://sqlite.org/lang_transaction.html", required);

  assert.equal(observed.fetchCalls, 1);
  assert.equal(observed.researchBeforeFirstWrite, false);
  assert.deepEqual(observed.failures, ["Required research was not completed before the first workspace write."]);
});

test("research must satisfy all domains and minimum counts before the first write, not only before completion", () => {
  const observed = observeResearch([
    search("s1", ["https://nodejs.org/api/globals.html"]),
    fetch("f1", "https://nodejs.org/api/globals.html"),
    start("writer"),
    search("s2", ["https://sqlite.org/lang_transaction.html"]),
    fetch("f2", "https://sqlite.org/lang_transaction.html"),
    write("writer"),
  ], "https://nodejs.org/api/globals.html and https://sqlite.org/lang_transaction.html", {
    ...required,
    minSearchCalls: 2,
    minFetchCalls: 2,
    requiredDomains: ["nodejs.org", "sqlite.org"],
  });

  assert.equal(observed.searchCalls, 2);
  assert.equal(observed.fetchCalls, 2);
  assert.equal(observed.researchBeforeFirstWrite, false);
  assert.deepEqual(observed.failures, ["Required research was not completed before the first workspace write."]);
});

test("only actual host write effects set the first-write boundary, including command writes", () => {
  const observations = [
    start("read"),
    result("read", "workspace.read", { content: "a file" }),
    start("claimed-write"),
    write("claimed-write", "model"),
    start("derived"),
    result("derived", "command.run", { derivedMutations: { count: 1, paths: ["node_modules/cache"], truncated: false } }, {
      effectsAuthority: "host",
      effects: { stateVersion: "metadata-only-state" },
    }),
    search("s", ["https://sqlite.org/lang_transaction.html"]),
    fetch("f", "https://sqlite.org/lang_transaction.html"),
    start("actual-write"),
    write("actual-write"),
  ];
  const observed = observeResearch(observations, "https://sqlite.org/lang_transaction.html", required);
  assert.equal(observed.researchBeforeFirstWrite, true);
  assert.deepEqual(observed.failures, []);

  const earlyWrite = observeResearch([
    write("fallback-without-start"),
    ...observations,
  ], "https://sqlite.org/lang_transaction.html", required);
  assert.equal(earlyWrite.researchBeforeFirstWrite, false);
});

test("a read-only run has no write-order failure but must still meet its research requirements", () => {
  const observed = observeResearch([], "No verified sources available.", required);
  assert.equal(observed.researchBeforeFirstWrite, true);
  assert.ok(observed.failures.some(message => message.includes("Too few successful")));
  assert.ok(observed.failures.some(message => message.includes("Too few non-empty")));
  assert.ok(observed.failures.some(message => message.includes("lacks a citation")));
  assert.ok(observed.failures.every(message => !message.includes("before the first workspace write")));
});

test("research report bounds source, citation, and failed-call inventories without losing late evidence checks", () => {
  const urls = Array.from({ length: 160 }, (_, index) => `https://example.com/docs/${index}`);
  const events: Event[] = [
    search("s", urls),
    ...urls.map((url, index) => fetch(`f${index}`, url)),
    ...urls.map((_url, index) => result(`failed${index}`, "research.fetch", {}, { ok: false, error: { code: "HTTP_503" } })),
    fetch("late", "https://sqlite.org/lang_transaction.html"),
    fetch("duplicate", "https://sqlite.org/lang_transaction.html"),
  ];
  const finalResponse = [...urls, "https://sqlite.org/lang_transaction.html", "https://fabricated.invalid/proof"].join("\n");
  const observed = observeResearch(events, finalResponse, required);

  assert.equal(observed.fetchCalls, 162);
  assert.equal(observed.sources.length, 128);
  assert.equal(observed.sourcesTruncated, true);
  assert.equal(observed.citedUrls.length, 128);
  assert.equal(observed.failedCalls.length, 128);
  assert.deepEqual(observed.unsupportedCitations, ["https://fabricated.invalid/proof"]);
  assert.ok(observed.failures.every(message => !message.includes("required domain")));
  assert.ok(observed.failures.every(message => !message.includes("lacks a citation")));
  assert.ok(observed.failures.some(message => message.includes("without successful fetch evidence")));
});

test("repeated fetched URLs retain one reported source and propagate truncation metadata", () => {
  const url = "https://sqlite.org/lang_transaction.html";
  const observed = observeResearch([
    fetch("f1", url),
    result("f2", "research.fetch", { url: url + "#section", content: "Bounded excerpt", truncated: true, contentHash: "new-source-hash" }),
  ], url, { minFetchCalls: 2, requiredDomains: ["sqlite.org"], requireCitations: true });

  assert.equal(observed.fetchCalls, 2);
  assert.equal(observed.sources.length, 1);
  assert.equal(observed.sourcesTruncated, false);
  assert.deepEqual(observed.sources[0], {
    url, kind: "fetch", truncated: true, contentHash: "new-source-hash",
    excerpt: "Bounded excerpt", trust: "untrusted_external",
  });
  assert.deepEqual(observed.failures, []);
});

test("research diagnostics retain bounded Unicode-safe excerpts and prioritize fetched sources", () => {
  const content = "😀".repeat(900);
  const observed = observeResearch([
    search("many", Array.from({ length: 150 }, (_, index) => `https://nodejs.org/api/${index}.html`)),
    fetch("read", "https://nodejs.org/api/globals.html", content),
  ], "", {});
  assert.equal(observed.sourcesTruncated, true);
  assert.equal(observed.sources[0]?.kind, "fetch");
  assert.equal(observed.sources[0]?.excerpt, "😀".repeat(512));
  assert.equal(observed.sources[0]?.trust, "untrusted_external");
});
