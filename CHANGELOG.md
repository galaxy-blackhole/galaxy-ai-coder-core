# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-18

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

## [0.1.0] - 2026-09-17

### Added

- Initial npm release of the platform-neutral single-agent runtime for
  Galaxy AI Coder.
- Deterministic run controller, context manager with tamper-evident
  checkpoints, prompt assembler, tool registry, approval policy, lexical
  retrieval, completion gate, and trace protocol.
- 100 deterministic tests covering runtime, registry, approval, retrieval,
  and checkpoint behavior.
