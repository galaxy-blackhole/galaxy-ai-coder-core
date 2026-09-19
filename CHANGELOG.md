# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Times are recorded in Asia/Ho_Chi_Minh (+07:00). Per-fix fragments are filed in
[CHANGELOG.d](CHANGELOG.d/README.md) and compiled here at release time.

## [0.3.0-alpha.1] - 2026-09-19 12:15 +07:00 (unpublished; first alpha-tagged release)

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
