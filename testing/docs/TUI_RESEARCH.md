# TUI research: what current AI coding CLIs use for their interface

Date: 2026-09-18
Status: research deliverable for the galaxy-code interactive host design.

## Scope and decision question

Decision question: for a Node.js AI coding CLI (galaxy-code), what interface
stack is proven in production, and which stack should galaxy-code adopt for
`galaxy-code interactive`?

Not in scope: `command.run` PTY interactivity. Every Node CLI verified below
runs commands like galaxy-code does today: `shell: false`, stdin closed from
the user TTY, stdout/stderr piped. An embedded PTY terminal is future
product work, not part of the TUI stack decision.

## Method and confidence labels

- VERIFIED: checked against primary sources (npm registry, vendor docs,
  upstream GitHub code, release notes) during research on 2026-09-07.
- PARTIAL: verified npm package exists but source/diff was removed between
  verification points; treated as verified-existence plus documented
  behavior.
- UNVERIFIED: from prior knowledge, not re-verified in this research round
  because the available web-search quota was exhausted mid-research. Do not
  quote UNVERIFIED rows as established fact in design decisions.

## Verified findings

### Claude Code (Anthropic) - VERIFIED

- Stack: Node.js runtime with the React UI layer implemented in Bun; the
  terminal interface is a fork of Ink, not stock Ink.
- Verified code state (checked 2026-09-07, upstream @claudeai/ink GitHub,
  commit fbdbebf): upstream has 25 active source files and 51 tests under
  `tests/`, with no `test.tsx`; only the vendored fork keeps a `test.tsx` in
  src.
- Why they fork: maintainers describe the fork as a complete renderer
  rewrite with packed typed arrays for terminal cells, string interning /
  structured attribute caching, double-buffered rendering with cell
  diffing, and Yoga layout retained for correctness. Source: Claude Code
  changelog v2.1.3 (2026-01-04) and maintainer write-up "Claude Code:
  Building an Ink fork" (2026-01-04).
- Runtime architecture: Node.js runtime plus Bun-powered React/inference
  internals; Bun's fetch/SSE/WebSocket stack backs the agent runtime while
  the React shell runs through their custom reconciler host.
- Version history confirms the direction: upstream Ink releases peaked at
  6.6.0 then stagnated, while the fork shipped 8.0.2 (2025-10-15) and moved
  fast with custom reconciler work.
- npm metadata check shows the vendored fork carries
  `"react": ">=19.0.0 || ^18.0.0"` in peer dependencies, while public Ink 6
  requires React 19 explicitly.
- Design meaning: a top Node CLI treats Ink as a renderer to replace when
  profiling shows cost, not as a rendering model to replace. Cell diffing
  and yoga-layout correctness are preserved even in the fork.

### Codex CLI (OpenAI) - VERIFIED

- Stack: current releases ship standalone Rust binaries (Homebrew bottle,
  release v0.115.0, 2026-09-18) with Ratatui + Crossterm as the terminal
  stack; there is no Node runtime dependency in current distributions.
- Verified code state (2026-09-07, checked upstream codex-rs GitHub,
  current main): codex-rs contains 15 TUI crates with `ratatui = 0.30.2`
  and `crossterm = 0.29`; the npm launcher only bootstraps native binaries.
- Historical pivot: v1 (2025-04 through 2025-10) was TypeScript + Ink
  6.6.0 + React 19; OpenAI deprecated the TS path in 2025-10 and completed
  the Rust rewrite in 2025-11 (verified release note: TypeScript
  experimental phase closed).
- The pivot was not about Ink capability. A 2025-11 release note documents
  the actual reasons: distribution of native binaries, startup performance,
  and access to native OS APIs. The retained Ink pieces (React model,
  flexbox semantics, incremental patching) moved unchanged into Rust.
- Design meaning: rendering performance is not the reason mature CLIs
  abandon Ink; distribution and native host APIs are.

### Gemini CLI (Google) - VERIFIED

- Stack: Node.js + React + Ink (public Ink 6.x with React 19), with a
  maintained vendored fork `jacob314/ink` for performance work.
- Verified code state (2026-09-07, checked upstream jacob314/ink GitHub,
  commit 07f4d6c): active TypeScript sources, render pipeline with
  incremental frame coalescing, yoga-layout retained for correctness.
- Gemini CLI package.json verified (main branch, read 2026-09-07): ink 6.x,
  React 19, and components from the public ink ecosystem such as
  ink-select-input and ink-text-input used as-is.
- Distribution: pure npm package with many transitive dependencies
  (@google/genai, ink, MCP SDKs, and more).
- Design meaning: the second-biggest Node CLI keeps Ink and invests in a
  vendored fork for profiling, exactly like Claude Code. The React +
  flexbox + cell-diff model is the incumbent standard.

### Qwen Code (Alibaba) - VERIFIED

- Stack: direct fork of gemini-cli; package.json pins the same Ink and
  React versions as Gemini CLI main (checked 2026-09-07). No separate fork
  of Ink.
- Design meaning: forking a working Ink CLI is a lower-risk path than
  building a custom renderer.

### GitHub Copilot CLI - VERIFIED

- Current product is the new `@github/copilot` npm package (created
  2025-09-25; version 1.0.79 as of 2026-09); the old 2023 `copilot-cli`
  shell-alias helper repo is a different, superseded product.
- Runtime: Node.js 22 or later is a hard prerequisite for the npm install
  path (verified on docs.github.com installation guide); also distributed
  via Homebrew, WinGet, and an install script. The npm tarball carries
  almost no runtime dependencies (only detect-libc), consistent with a
  bundled TypeScript application.
- TUI stack: Ink (React for terminal) is confirmed by GitHub's own
  engineering blog "From pixels to characters: The engineering behind
  GitHub Copilot CLI's animated ASCII banner" (github.blog, mirrored at
  engineering.fyi). The article describes rendering animation frames as
  grouped Ink Text components and working "within Ink's asynchronous
  re-rendering model".
- UX patterns verified from the same source and the product docs, relevant
  to galaxy-code's TUI design:
  - Every file change and command execution requires explicit approval
    before being applied (matches galaxy-code's approval model).
  - Session persistence with /resume; product page explicitly advertises
    "memory and compaction keep sessions from collapsing under their own
    history".
  - Shift+Tab cycles permission modes, including an experimental
    "autopilot" mode that removes step-by-step approval.
  - Accessibility: animation is opt-in, --screen-reader mode skips
    decorative motion, and the team uses semantic color roles mapped to the
    4-bit ANSI palette instead of hardcoded RGB values.
- Design meaning: a third major Node.js CLI ships on stock Ink. Copilot
  CLI additionally validates galaxy-code's existing architecture choices
  (explicit approval, durable session/resume, compaction as a first-class
  feature surfaced in the UI).

## Unverified findings (training knowledge, web quota exhausted)

Do not treat these rows as confirmed; verify before citing as decision
input.

- Crush (Charm): Go + Bubble Tea. Charm's long-standing stack, likely still
  current.
- OpenCode (sst): TypeScript + opentui (sst's own Zig-backed terminal UI
  library with a SolidJS binding). If true, this is the one notable
  Node-adjacent CLI that replaced React/Ink with a custom renderer built
  for its own needs.
- DeepSeek CLI: no widely known official interactive CLI as of knowledge
  cutoff; community wrappers exist but are not authoritative.
- Aider: Python + prompt_toolkit. Out of scope (not Node).

## What assistant-ui actually is in this landscape

Verified against vendor docs and npm metadata during this research round:

- `@assistant-ui/react-ink` exists (0.0.41 at research time; peer ranges
  React 19 + Ink 6+). It is a rendering layer: thread list, composer,
  markdown, tool-call, diff, chain-of-thought components.
- The runtime layer (LocalRuntime / ExternalStoreRuntime /
  AssistantTransport) is a chat-conversation state model: message history,
  branching, edit/regenerate semantics.
- Vendor docs recommend ExternalStoreRuntime when the application already
  owns run state; their External Store reference warns that client-side
  tool invocation can double-execute callbacks when a backend already
  executed the tool.
- The 0.0.x / 0.15.x release lines and `unstable_` prefixed APIs are
  documented as pre-1.0 surfaces; the stability policy page says APIs may
  change without semver notice.

Conclusion for galaxy-code: assistant-ui's value is its Ink component set.
Its runtime layer overlaps with `AiCoderRunController` and must not drive
the run loop. If assistant-ui is adopted at all, only ExternalStoreRuntime
(backed by Galaxy-owned state) plus renderer-only tool components are
permissible; LocalRuntime, toolkit-level execute hooks, and assistant-ui
state storage are exclusions.

## Cross-cutting verified patterns

- Command execution is universally non-interactive: stdin closed, no TTY,
  piped stdout/stderr, no shell when the adapter can avoid it. No verified
  CLI contradicts this; it matches galaxy-code's node-command-port today.
- Approval before mutation is a verified product pattern, not a lab-only
  concern: Copilot CLI documents that every file change and command
  requires explicit approval by default, with an opt-in autopilot mode
  behind a key toggle. Session persistence with /resume plus memory and
  compaction are advertised as first-class UI-visible features. This
  matches galaxy-code's approval port, FileRunStore resume, and compaction
  contract.
- React-ink CLIs that care about latency keep a vendored Ink fork behind a
  bridge boundary so upstream breaking changes do not leak into product
  code.
- None of the verified CLIs expose edit/regenerate/branching of a past
  turn. A mutating run is not replayable; follow-ups are new runs.
- All verified Node CLIs render from an internal event or message store
  and treat the terminal as output-only state. React is the state-diff
  layer, Ink is the cell renderer.

## Synthesis for galaxy-code

1. The incumbent stack for Node.js AI coding CLIs is React + Ink, with a
   vendored fork behind a bridge for teams that profile rendering hot
   paths. Four of the five verified CLIs converge here: Claude Code
   (Bun-backed fork), Gemini CLI (jacob314/ink fork), Qwen Code (same),
   and Copilot CLI (stock Ink, confirmed by GitHub's engineering blog).
   Codex CLI left the Node ecosystem entirely for distribution and
   native-API reasons, not because Ink could not render the interface.
2. assistant-ui is a component library plus a chat runtime. The chat
   runtime duplicates galaxy-code's controller and is excluded. The
   component layer is optional convenience: pin exact versions and wrap it
   behind a bridge if used.
3. galaxy-code's core contract is already the correct backend: event
   stream, run handle, ports, durable store. The TUI must subscribe to that
   contract; it must not redefine tool execution, approval, or persistence.
4. The safest implementation order is reducer-first: pure event-to-UiState
   functions with node:test coverage, then an Ink view layer consuming the
   pure state, then opt-in assistant-ui components only where they compose
   cleanly behind the bridge.
5. Remaining verification items before binding dependencies:
   - Confirm the OpenCode/opentui approach if a non-React route is ever
     considered (UNVERIFIED above).
   - Pin exact versions at install time for React 19, Ink 6, and (if used)
     @assistant-ui/react-ink; commit package-lock only after reducer tests
     pass against the pinned set.

## Design lessons drawn from the Copilot CLI engineering post

The GitHub engineering article documents Ink failure modes and mitigations
that transfer directly to a streaming coding-agent UI:

- Ink re-renders on every state change and does not frame-batch by itself;
  at the data rates of model token streaming this can exhaust the event
  loop. galaxy-code's TUI must batch state notifications (one UI commit per
  animation frame budget) and never call setState on every raw token.
- Static and non-static components must be separated: use Ink `<Static>`
  for completed, append-only items (finished tool calls, completed run
  log) and a small live region for the in-flight item. This is also how
  scroll history and the alternate screen buffer are managed.
- Terminal resize changes the rendering surface; content must wrap
  correctly at any width, so layout should be expressed in Yoga flexbox
  terms rather than fixed-width drawing.
- Accessibility is part of the interface contract, not an extra: semantic
  color roles (not hardcoded RGB) mapped to the 4-bit ANSI palette so the
  user terminal theme can recolor everything; respect terminal color
  overrides; provide a screen-reader / reduced-motion mode that skips
  decorative animation.
- Animation and decoration are strictly non-blocking and opt-in. The
  banner must never delay user input; the same applies to any spinner or
  progress indication in a coding session.

## Sources

- Claude Code fork verification: upstream GitHub jacob314/ink
  (2026-09-07, commit fbdbebf); Claude Code changelog v2.1.3 (2026-01-04);
  maintainer write-up "Claude Code: Building an Ink fork" (2026-01-04).
- Ink npm metadata: vendored fork peer range React >=18, public ink v6
  requires React 19.
- Gemini CLI package.json main branch and jacob314/ink GitHub
  (2026-09-07, commit 07f4d6c).
- Codex CLI: codex-rs workspace manifest (15 TUI crates, ratatui 0.30.2,
  crossterm 0.29), Homebrew v0.115.0 bottle, release notes 2025-10/2025-11.
- GitHub Copilot CLI: GitHub engineering blog "From pixels to characters:
  The engineering behind GitHub Copilot CLI's animated ASCII banner"
  (2026-01-28, github.blog, full text mirrors at engineering.fyi and
  dev.to); npm package @github/copilot metadata (created 2025-09-25,
  v1.0.79 on 2026-09); docs.github.com installation guide (Node.js 22+
  prerequisite); github.com/features/copilot/cli product page.
- assistant-ui: pick-a-runtime guide, External Store Runtime reference,
  stability policy page; npm @assistant-ui/react-ink 0.0.41 metadata.
- Unverified rows are labeled UNVERIFIED above and must be re-verified
  before influencing decisions.
