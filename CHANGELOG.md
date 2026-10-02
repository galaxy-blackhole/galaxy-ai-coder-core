# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Times are recorded in Asia/Ho_Chi_Minh (+07:00). Per-fix fragments are filed in
[CHANGELOG.d](CHANGELOG.d/README.md) and compiled here at release time.

## [0.3.5] - 2026-10-02 09:43 +0700

### Fixed

- A server log inside the workspace no longer fails the evidence capture. `.log` is generated state,
  and a churning active file is hashed by path instead of content. See
  [CHANGELOG.d fragment](CHANGELOG.d/2026-10-02-log-churning-va-hop-dong-version-skill-mcp.md).
- The post-failure classification fingerprint is best effort: an unverifiable workspace no longer
  ends a run whose work is already on disk (2026-10-02 gymflow `s13`).
- Skills declare the companion MCP version their documented call shapes need
  (`requires: { orbit: ">=0.4.1" }`), and `McpAgentClient.serverVersion` exposes the version the
  server reports so a host can warn about the skew instead of shipping it.

## [0.3.2] - 2026-09-30 14:50 +0700

### Changed

- Baseline review chỉ tính file nguồn, không chết vì install/build chạy nền.
- Shell persistent cho run_command, giống DeepSeek Harness.
- Agent tự quyết timeout của lệnh, host chỉ giữ backstop suy ra từ lựa chọn đó.
- Timeout của run_command theo đúng cơ chế DeepSeek Harness.

## [0.3.3] - 2026-09-30 18:07 +0700

### Changed

- Tài liệu credential dùng chung cho mọi Galaxy host ([CHANGELOG.d/2026-09-30-galaxy-credentials.md](CHANGELOG.d/2026-09-30-galaxy-credentials.md)).

## [0.3.4] - 2026-10-01 01:58 +0700

### Changed

- Baseline review chỉ tính file nguồn, không chết vì install/build chạy nền.
- Shell persistent cho run_command, giống DeepSeek Harness.
- Agent tự quyết timeout của lệnh, host chỉ giữ backstop suy ra từ lựa chọn đó.
- Timeout của run_command theo đúng cơ chế DeepSeek Harness.
- Mutation không xác minh được là lỗi tool retryable, không giết bước.

## [0.3.1] - 2026-09-29 05:25 +07:00

### Fixed

- Advisory khi đọc source node_modules bằng shell. See [CHANGELOG.d fragment](CHANGELOG.d/2026-09-29-advisory-doc-source-node-modules-bang-shell.md).
- Dừng vì trần output ('length') là lỗi tạm thời, không phải fail run. See [CHANGELOG.d fragment](CHANGELOG.d/2026-09-29-retry-khi-model-dung-vi-output-length.md).

## [0.3.0] - 2026-09-28 23:10 +07:00

First verified stable line: the 25-prompt end-to-end flow completes with this
runtime. The failure journal that drove the changes below lives in
`galaxy-code/docs/TEST_FAILURE_ANALYSIS.md`.

### Changed

- Prompt-cache layout: the mutable run state moved after the stable prefix, so a turn
  re-bills only its tail (measured run-wide 40% → 61%, per step 10% → 59–87%).
- `project.validate` records the scope it really covered, so a check in one package
  is no longer invalidated by a write in a sibling package.
- The completion gate is scope-aware: documentation writes need no validation, a path
  written and then removed needs none either, and untracked workspace drift still
  voids every validation.
- Reaching the turn budget grants one tool-free finalization turn instead of failing a
  run whose evidence is already satisfied; `maxTurns` and the host deadline are
  configurable through the CLI.
- Arguments above a schema cap are clamped and reported rather than rejected; a
  shell-run project check and a long-running server answer with an advisory that names
  the exact `validate_project` call; a refused dependency search names the read that
  is allowed.
- `context_diagnostic` fingerprints every context item and the tool block each turn —
  that is how the cache regression above was found.

<details>
<summary>Per-fix trail: 39 fragments (2026-09-19 … 2026-09-28)</summary>

- Advisory guard policy cho observation (2026-09-19 00:15 +07:00) (core). [fragment](CHANGELOG.d/2026-09-19-advisory-guard-policy.md)
- Sửa parser citation bị nhiễu Markdown (2026-09-19 11:55 +07:00) (core). [fragment](CHANGELOG.d/2026-09-19-research-citation-parsing.md)
- Lưu evidence khi citation bị từ chối (2026-09-19 23:15 +07:00) (core). [fragment](CHANGELOG.d/2026-09-19-research-rejection-evidence.md)
- Node test reporter ghi nhật ký (2026-09-18 23:45 +07:00) (core). [fragment](CHANGELOG.d/2026-09-19-test-journal-reporter.md)
- Remediation cho RESEARCH_EVIDENCE_MISSING (2026-09-21 02:20 +07:00) (core). [fragment](CHANGELOG.d/2026-09-21-evidence-missing-remediation.md)
- Nudge nhận diện bằng arguments hash (2026-09-21 00:55 +07:00) (core). [fragment](CHANGELOG.d/2026-09-21-observation-nudge-context.md)
- Retry delay theo scenario budget + deadline-aware skip (2026-09-22 07:25 +07:00) (core). [fragment](CHANGELOG.d/2026-09-22-model-retry-budget.md)
- Recovery turn trước no-progress pause (2026-09-22 01:07 +07:00) (core). [fragment](CHANGELOG.d/2026-09-22-no-progress-recovery-turn.md)
- Agent platform foundation (core). [fragment](CHANGELOG.d/2026-09-23-agent-platform.md)
- # 0.3.0-alpha.7 — 2026-09-23 07:00 +07:00 (core). [fragment](CHANGELOG.d/2026-09-23-conservative-output-reserve.md)
- Request-scoped approvals and scratch workspace review (core). [fragment](CHANGELOG.d/2026-09-24-approval-workspace-review.md)
- Incremental Ollama streaming (core). [fragment](CHANGELOG.d/2026-09-24-incremental-ollama.md)
- Tail-anchored tool output bounding (core). [fragment](CHANGELOG.d/2026-09-25-tail-anchored-bounding.md)
- Binary review không chặn, pipe guidance, test finalization (adapters/tools, prompt, runtime/test). [fragment](CHANGELOG.d/2026-09-26-binary-review-pipe-guidance-finalization-test.md)
- Cache capability và MCP reconnect (runtime/prompt/adapters). [fragment](CHANGELOG.d/2026-09-26-cache-capability-and-mcp-reconnect.md)
- Cache-hit (prefix reuse) harness (runtime/prompt). [fragment](CHANGELOG.d/2026-09-26-cache-hit-harness.md)
- Cache hit rate, token_ledger event, và systemPromptUpdate option (runtime/context/adapters). [fragment](CHANGELOG.d/2026-09-26-cache-hit-rate-and-inhistory-option.md)
- Cache hit luỹ kế (context/runtime). [fragment](CHANGELOG.d/2026-09-26-cumulative-cache-hit.md)
- Default model: deepseek-v4.1-flash:cloud (core). [fragment](CHANGELOG.d/2026-09-26-default-model-deepseek.md)
- Finalization tool-free, allowlist in-history, cache accounting (runtime/adapters/context). [fragment](CHANGELOG.d/2026-09-26-finalization-prefix-and-verified-inhistory.md)
- Generated-state evidence boundary (runtime/host). [fragment](CHANGELOG.d/2026-09-26-generated-state-and-churn-guard.md)
- Failure-injection test cho MCP reconnect (adapters/mcp). [fragment](CHANGELOG.d/2026-09-26-mcp-reconnect-fixture.md)
- Memory hybrid ranking, semantic port và consolidation (adapters/memory). [fragment](CHANGELOG.d/2026-09-26-memory-hybrid-semantic-consolidation.md)
- Memory recall benchmark (adapters/memory (test)). [fragment](CHANGELOG.d/2026-09-26-memory-recall-benchmark.md)
- Ollama báo cache; adapter map vào token ledger (adapters/provider). [fragment](CHANGELOG.d/2026-09-26-ollama-cache-usage.md)
- Ollama embedding provider (adapters/memory/config). [fragment](CHANGELOG.d/2026-09-26-ollama-embeddings-provider.md)
- Re-record live replay fixture (testing). [fragment](CHANGELOG.d/2026-09-26-rerecord-live-fixture.md)
- Ký số skill index (Ed25519 trust) (adapters/skills). [fragment](CHANGELOG.d/2026-09-26-skill-index-signing.md)
- Skill versioning và marketplace (adapters/skills). [fragment](CHANGELOG.d/2026-09-26-skill-version-and-marketplace.md)
- Build output là derived, manifest workspace (runtime/host). [fragment](CHANGELOG.d/2026-09-27-workspace-derived-build-output.md)
- Advisory khi lệnh shell trùng check dự án hoặc chạy server (tools/prompt). [fragment](CHANGELOG.d/2026-09-28-advisory-lenh-check-va-server.md)
- Clamp tham số vượt cap thay vì từ chối tool call (tools/adapter). [fragment](CHANGELOG.d/2026-09-28-clamp-tham-so-vuot-cap.md)
- Fingerprint từng context item mỗi lượt (chẩn đoán cache) (context/diagnostics). [fragment](CHANGELOG.d/2026-09-28-digest-context-item.md)
- Gate không đòi validation cho path đã bị xoá (runtime/completion-gate). [fragment](CHANGELOG.d/2026-09-28-gate-bo-qua-path-da-xoa.md)
- Hết ngân sách lượt thì finalize một lượt trước khi fail (runtime). [fragment](CHANGELOG.d/2026-09-28-ngan-sach-luot-finalization.md)
- project.validate ghi đúng phạm vi theo project path (tools/executor). [fragment](CHANGELOG.d/2026-09-28-scope-cua-project-validate.md)
- Validation chỉ stale theo phạm vi nó bao phủ (runtime/completion-gate). [fragment](CHANGELOG.d/2026-09-28-staleness-theo-pham-vi.md)
- Lỗi guard dependency nói rõ đường đọc được phép (host/workspace-port). [fragment](CHANGELOG.d/2026-09-28-thong-bao-guard-dependency.md)
- Đặt run state đổi-mỗi-lượt ra sau prefix ổn định (cache) (context/runtime). [fragment](CHANGELOG.d/2026-09-28-thu-tu-mandatory-state-cache.md)

</details>

## [0.3.0-alpha.7] - 2026-09-23 07:00 +07:00

### Fixed

- Conservative context profile `outputReserveTokens` raised from 24 000 to
  32 768 (matching balanced/extended) to prevent `INVALID_MODEL_STREAM
  "length"` failures when the model spends the full reserve on thinking plus
  tool-call JSON before writing any file. Profile config version bumped to
  `1.1.0`. See
  [CHANGELOG.d fragment](CHANGELOG.d/2026-09-23-conservative-output-reserve.md).

## [0.3.0-alpha.6] - 2026-09-22 07:25 +07:00

### Changed

- Model retry backoff is now a budget knob (`modelRetryDelaysMs`, 1-8 entries,
  up to 600 000 ms each) consumed in order by retry attempt and reported in
  `model_retry` events, replacing the hardcoded delay table. Retries are also
  deadline-aware: when the remaining run budget cannot cover the backoff plus
  the failed attempt's duration, the runtime skips the attempt and fails loud
  with the full budget math. See
  [CHANGELOG.d fragment](CHANGELOG.d/2026-09-22-model-retry-budget.md).

## [0.3.0-alpha.5] - 2026-09-22 01:07 +07:00

### Changed

- No-progress pause now grants exactly one recovery feedback round before
  pausing: the runtime injects `[GALAXY NO-PROGRESS RECOVERY]` listing the
  round's failed tools with their remediation and expects a materially
  different strategy. Thresholds (2/2/2), pause semantics, and
  fail-loud-after-budget behavior are unchanged; a trace
  `policy_decision(action: "no_progress_recovery_turn")` marks the granted
  round. Inspired by Gemini CLI's two-strike loop detection; see
  [CHANGELOG.d fragment](CHANGELOG.d/2026-09-22-no-progress-recovery-turn.md).

## [0.3.0-alpha.4] - 2026-09-21 02:20 +07:00

### Changed

- `RESEARCH_EVIDENCE_MISSING` completion rejections now carry actionable
  remediation naming `search_web` (discovery) and `fetch_url` (reading), and
  state that fetch-only runs do not satisfy a search requirement.

## [0.3.0-alpha.3] - 2026-09-21 00:55 +07:00

### Changed

- Advisory observation nudges include the repeated call's `arguments_hash` so
  the model can identify exactly which call is repeating while the guard keeps
  recognition on the full canonical arguments.

## [0.3.0-alpha.2] - 2026-09-19 23:15 +07:00

### Added

- `completion_rejected` runtime events now retain the rejected candidate and a
  structured research ledger: successfully fetched URLs, search-only URLs,
  unsupported citations, and source tool-call correlation. Hosts can persist
  enough evidence to diagnose a repeated citation failure without
  reconstructing model output from prose.
- README installation, lifecycle usage, public API, adapter ownership, and
  alpha-upgrade guidance.

### Changed

- Research citation rejection feedback lists the successfully fetched sources
  available to the model and tells it to fetch or remove unsupported URLs.
  Search snippets and plausible URLs remain insufficient completion evidence.

## [0.3.0-alpha.1] - 2026-09-19 12:17 +07:00 (published; first alpha-tagged release)

The first release after `0.1.0` is alpha-tagged because the no-progress guard
policy changes the default runtime behavior. All changes since `0.1.0` ship in
this version; the internal working versions `0.2.0`–`0.2.2` were never published.

### Added

- Configurable observation guard policy:
  - `AiCoderRunBudget.noProgressPolicy`: `advisory` (default) and `strict`.
  - `AiCoderRunBudget.observationNudgeThresholds` (default `[3, 5, 8]`,
    following the upstream DSH `repeat-tool-reminder` design): escalating
    trusted nudges for repeated read-only observations; blocking only after the
    final threshold. Advisory nudges no longer count toward
    `maxNoProgressEpisodes`; the `strict` policy preserves the older
    first-incident accounting.
- Checkpoints persist `noProgress.policy` and
  `noProgress.observationNudgeThresholds`; resuming with a different guard
  configuration fails with `CHECKPOINT_INCOMPATIBLE` (legacy checkpoints
  without these fields still resume).
- `policy_decision` trace events for `observation_nudge` and
  `observation_blocked`.
- Development-only Node test reporter: `npm test` writes a timestamped journal
  (`TEST_ERROR_LOG.md`, `.galaxy/tests/<run>/`) with assertion results,
  failure stacks, test counts, commit, and source fingerprint. Excluded from
  the published bundle.

### Changed

- Observation-family counters now count every dispatched identical observation
  attempt, including failed results, matching the documented "requested"
  contract.

### Fixed

- Research citation parsing: trailing Markdown emphasis and punctuation
  (`**url**:`, `*url*`, backtick-quoted URLs, trailing `:`/`;`) are
  stripped before canonicalization, so citations of successfully fetched
  sources are no longer rejected when the model decorates them. Search-only
  URLs cited as unfetched are still rejected. See
  [2026-09-19-research-citation-parsing.md](CHANGELOG.d/2026-09-19-research-citation-parsing.md).

## [0.2.2] - 2026-09-19 11:54 +07:00 (internal working version)

- Working version carrying the citation parsing fix; superseded by
  `0.3.0-alpha.1` before publishing.

## [0.2.1] - 2026-09-19 00:00 +07:00 (internal working version)

- Working version for the advisory guard policy and the test journal reporter;
  the first two live audits on the advisory guard ran with this version.

## [0.2.0] - 2026-09-18 02:00 +07:00 (internal working version)

### Added

- Prompt version `ai-coder-single/2.6.0` ships two new static modules:
  - `code-minimalism-policy`: ordered resolution ladder before writing new code
    (unnecessary behavior → repository → standard library → platform →
    installed dependency → focused one-line change), and forbids weakening
    validation, security handling, accessibility, or error reporting to reduce
    code size.
  - `evidence-provenance-policy`: requires `EXTRACTED`, `INFERRED`, or
    `AMBIGUOUS` labels for non-obvious internal code claims.
- Completion gate now rejects `RESEARCH_CITATION_UNSUPPORTED`: every cited
  research URL must carry successful fetch evidence before completion.
- Optional MCP port definition checklist in `docs/HOST_CONFORMANCE.md`
  (Definition / Effect policy / Provider / Consumer / Conformance scenarios).
- Optional fast pre-push gate via `git config core.hooksPath .githooks`.

### Changed

- Project is the core exception of the Galaxy Stack plan: npm scope stays
  `@galaxy-stack/ai-coder-core`, GitHub repository moves to the
  [galaxy-blackhole](https://github.com/galaxy-blackhole) organization.

## [0.1.0] - 2026-09-17 14:46 +07:00 (published on npm and GitHub)

### Added

- Initial npm release of the platform-neutral single-agent runtime for
  Galaxy AI Coder.
- Deterministic run controller, context manager with tamper-evident
  checkpoints, prompt assembler, tool registry, approval policy, lexical
  retrieval, completion gate, and trace protocol.
- 100 deterministic tests covering runtime, registry, approval, retrieval,
  and checkpoint behavior.
