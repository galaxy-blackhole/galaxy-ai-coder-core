# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Times are recorded in Asia/Ho_Chi_Minh (+07:00). Per-fix fragments are filed in
[CHANGELOG.d](CHANGELOG.d/README.md) and compiled here at release time.

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
    following the DeepSeek Harness `repeat-tool-reminder` design): escalating
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
