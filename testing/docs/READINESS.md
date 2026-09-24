# CLI/core readiness — integration remains deferred

The user-run audit `2026-09-12T03-54-47-165Z-58ljYm` passed 32 groups on the
current macOS host: 92 core source tests; 105 CLI unit, 83 passing integration
tests (one additional Linux-only skip) and 37 end-to-end tests; deterministic
fixtures; eight live campaign groups; and a real GitHub lifecycle. These are
the historical audit counts, not the expanded candidate's test counts. The
historical audit did not record source hashes, so it cannot cryptographically
certify the later source snapshot as the exact bytes it tested.

The existing advanced-resilience and research extensions add seven live stages,
included in that passed audit. Their deterministic checks exercise both good implementations and
deliberate bugs so an empty or ineffective test harness cannot pass silently.

| Campaign | Added evidence |
| --- | --- |
| `live:advanced-resilience` — four stages | SQLite migration upgrade/downgrade and data preservation; transactional checkout with duplicate requests and independent connection contention; Unicode lookalike/CRLF edits preserving legacy pricing; bounded scanner over 48+ MiB of logs with a 32 MiB V8 heap and a delayed terminal producer |
| `live:research` — three stages | Read a project and verify a proposal from public primary sources; implement a bounded retry policy after research; investigate and fix a partial SQLite migration after consulting transaction docs |

The resilience campaign requires Node >=24. The research SQLite fixture uses
`node:sqlite` on supported Node versions. Neither new application campaign needs
dependency downloads or an external database. Research intentionally calls the
Ollama web API; its queries and source URLs leave the local machine. Only public
concepts belong in those fields, and the checked-in fixtures use synthetic data.

## What a pass establishes

Executable tests can establish exact file/data results, tool correlation,
evidence persistence, observable API behavior and bounded failure handling for
their inputs. Research checks can establish that cited URLs were fetched and
required research happened before the first write. They cannot automatically
prove every natural-language claim, immunity to every prompt injection, or
correctness on arbitrary future tasks. Each live pass is one observed model run.

Successful research discoveries and fetched-source hashes now become bounded,
host-attested checkpoint evidence. They are restored into mandatory run state
after compaction or process resume so the model can cite prior evidence without
repeating the same workspace reads and network fetches. Per-process audit call
counts remain explicitly scoped to the current execution segment.

## Current scope: baseline and stability only

1. Retain a source snapshot plus the historical passed audit; bind future
   audit runs to source hashes before and after execution. Baseline capture
   includes dirty/untracked source, not only a Git HEAD. See
   [STABILITY_CAMPAIGN.md](STABILITY_CAMPAIGN.md).
2. Repeat Kimi live campaigns and add `live:durable-research`: research before
   writing, multiple forced compactions, SIGKILL at an acknowledged persisted
   checkpoint, a fresh process restoring the same run, further implementation,
   more compactions, executable validation and citations without repeated fetches.
   Offline protocol tests include positive and deliberately failing cases.

No VS Code/Desktop changes are part of this phase. Native Windows/Linux
certification and optional real host adapters remain future gates. Seven optional
tools are still doubles (`command.session`, `preview.manage`, `perception.analyze`,
`artifact.create/list/read`, `user.ask`). macOS best-effort containment remains
uncontained; these stability tests do not turn it into a security sandbox.

Passing Kimi does not by itself certify OpenAI, Anthropic or Gemini adapters.
Their stream events, tool IDs and context-overflow behavior need their own
protocol tests when those providers enter the supported release scope.
