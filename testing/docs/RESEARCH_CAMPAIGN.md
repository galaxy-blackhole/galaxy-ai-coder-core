# Research-first supplier catalog campaign

This campaign exercises the workflow “inspect the project, search for evidence, read the source, recommend or implement, test, review.” Three stages share one supplier-catalog workspace and use the real Ollama search/fetch adapter when explicitly run live. The model remains the configured Ollama `glm-5.3-flash:cloud`; no separate research model is required.

## Run

From `galaxy-code`, run the research campaign with audit logs and stop-on-first-failure:

```sh
npm run test:audit -- --live --only live:research
```

Run the full opted-in audit (including all registered live campaigns):

```sh
npm run test:audit -- --live
```

The live research calls require an Ollama API key. The host resolves it through the existing manual Ollama configuration; do not paste credentials into scenario JSON, prompts, or logs. Ollama's [web search documentation](https://docs.ollama.com/capabilities/web-search) describes authenticated search and fetch.

The offline fixture check is included in CLI integration tests and can be selected independently:

```sh
npm run test:audit -- --only cli:integration --test-name 'research campaign fixtures'
```

The SQLite stage requires Node.js >=22.13 with `node:sqlite`. The fixture uses in-memory databases, no npm installation, no database service, and no external HTTP request from application tests.

## Stages and oracles

| Stage | Work requested from the live model | What is automatically checked |
| --- | --- | --- |
| 01 — recommendation | Inspect an existing catalog client; verify claims about HTTP errors, cancellation and timeout before proposing an approach. Read Node.js and MDN documentation. | Completed read-only run; no changed paths; successful search and at least two fetches; both required domains fetched; final citations refer to fetched sources. |
| 02 — retry policy | Research fetch and Retry-After, then implement one pure policy module. Keep purchase submission non-retryable and prevent infinite retries. | Research before first write; only the policy file changes; all accumulated executable tests pass; validation and Git review occurred; citations refer to fetched sources. |
| 03 — migration incident | Reproduce a SQLite migration that leaves a partial table after a bad row; consult SQLite transaction/error documentation; fix only the transaction boundary. | Research before first write; only the migration changes; real SQLite rollback, corrected-input retry, idempotency and constraints pass alongside earlier tests; final validation, Git review and citations present. |

The final cumulative application suite has 12 tests. The policy tests cover cancellation precedence, GET/HEAD casing, POST/PATCH/PUT/DELETE exclusion, exhausted budgets, HTTP-versus-transport classification, delta-seconds and HTTP-date parsing, malformed/overflow values, past dates, maximum delay, and immutable input. Migration tests check rollback of DDL and earlier inserts, preservation of legacy rows/version markers, a closed transaction after failure, successful retry, no duplicate version rows, preservation of later writes, empty input and foreign keys.

The offline fixture integration test confirms each deliberately broken baseline fails, known-good implementations pass all 12 tests, and seven mutations are detected: unsafe purchase retry, ignored cancellation, off-by-one retry budget, unbounded delay, missing rollback, swallowed constraint errors and lost migration idempotency. It does not contact the model or search API.

## Why these sources

Node documents its browser-compatible [fetch implementation and AbortSignal APIs](https://nodejs.org/api/globals.html#fetch). MDN's [fetch reference](https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch) distinguishes HTTP error responses from rejected requests. Its [Retry-After reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After) explains integer seconds and HTTP-date forms. SQLite's [transaction documentation](https://sqlite.org/lang_transaction.html) describes explicit transaction boundaries and the need to handle errors and rollback deliberately.

The three-attempt budget, GET/HEAD-only allowlist, 250ms base delay and 5s cap are application policy. The campaign explicitly requires the model to distinguish these choices from statements supported by those documents.

## Limits of a pass

A successful search call, retrieved page and matching citation prove provenance and order of tool use; they do not automatically prove that every claim in the final prose is supported by the cited paragraph. Review the final recommendation against the retained source excerpts when evaluating reasoning quality. Bounded source evidence now survives core compaction and resume, while identical successful query/URL calls are cached within an executor process. Search rankings and page extraction can change, so a live failure should distinguish provider availability/extraction issues from tool execution or reasoning failures.

The private incident marker in stage 1 makes the “use generic API concepts in public queries” constraint concrete. This fixture alone is not a complete data-loss-prevention guarantee. This campaign also does not establish prompt-injection immunity, multi-process database concurrency, or arbitrary cross-platform compatibility.

These tests add measured coverage to the existing CLI/core evidence; they do not prove perfect behavior on every future task. After repeat live passes, the next useful evidence is repeated runs with different seeds/tasks, process interruption across compaction, and the same host contracts on Windows/Linux before adapting the stable core to other products.
