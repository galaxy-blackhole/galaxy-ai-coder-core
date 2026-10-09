# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Times are recorded in Asia/Ho_Chi_Minh (+07:00). Per-fix fragments are filed in
[CHANGELOG.d](CHANGELOG.d/README.md) and compiled here at release time.

## [0.3.23] - 2026-10-10 13:10 +0700

### Fixed

- **Pipeline phát hành bị hết giờ.** Job `publish` chạy `npm run verify` (typecheck + toàn bộ test + build +
  test:dist) dưới `timeout-minutes: 15`, trong khi suite đã dài hơn 30 phút — nên **0.3.20, 0.3.21 và 0.3.22 chưa
  từng lên npm** dù đã push `main`. Nay `publish.yml` và `ci.yml` đều để 60 phút.

### Notes

- Bản này không đổi mã nguồn nào ngoài workflow: nó tồn tại để đưa những gì đã có trên `main` lên registry.## [0.3.22] - 2026-10-09 17:10 +0700

### Added (P3 của `docs/design/tool-modes.md`)

- **Đồng hồ của chương trình tạm dừng khi chờ người**: deadline được giữ lại lúc một call con bắt đầu và nạp lại
  khi nó kết thúc. Trước đó, một chương trình hỏi ý kiến người dùng có thể bị giết vì *tội danh xin phép*. Thời
  gian chờ tool do `approvalTimeoutMs` và timeout từng tool quy định, không phải deadline của chương trình.
- **`onCodeEvent` trên `NodeToolExecutor`**: host nhận `code/tool-start`, `code/tool-result`, `code/log` của từng
  call con để dựng đúng những dòng transcript mà một call trực tiếp sẽ có — chương trình không bao giờ kém minh
  bạch hơn cách gọi thường.

### Test

- **Một round `ptc` trọn vẹn qua run controller**: model chỉ được trao **đúng một** tool (`run_code`), SDK đi kèm
  trong mô tả, sandbox chạy chương trình, call con `list_files` đi qua **chính executor của host**, và giá trị
  chương trình trả về nằm trong tool result. Test cũng ghi lại hai bất biến của core mà nó va phải: tool mà model
  gọi phải có trong registry snapshot, và khai báo effect của tool phải khớp catalogue.
- `test/code-runtime.test.ts` lên 7: thêm ca *call chờ người không tiêu đồng hồ của chương trình* và ca
  *call con được báo cho host theo đúng thứ tự* (log → tool-start → tool-result).## [0.3.21] - 2026-10-09 15:40 +0700

### Added (P2 của `docs/design/tool-modes.md`)

- **`CodeRuntimePort`** (`src/ports/code-runtime-port.ts`): `renderSdk`, `run`, giới hạn (`CodeRunLimits`), sự kiện
  (`code/log`, `code/tool-start`, `code/tool-result`) và kết quả có kiểu (`CodeRunResult`).
- **`WorkerCodeRuntime`** (`src/adapters/node/code-runtime/`): mỗi chương trình một worker thread, heap cap,
  deadline, huỷ, và mọi kiểu chết đều là lỗi có kiểu (`RUN_CODE_TIMEOUT`, `RUN_CODE_CANCELLED`,
  `RUN_CODE_CRASHED`, `RUN_CODE_FAILED`) — không bao giờ treo.
- **`renderCodeSdk`** (`src/tools/code-sdk.ts`): sinh façade TypeScript từ `inputSchema`, sắp xếp theo tên, kèm
  luật chương trình (batch, `console` được thu lại, call bị từ chối thì `throw`).
- `code.run` **chạy thật**: executor bắc cầu sang runtime, các call con đi qua đúng `execute()` nên vẫn có duyệt,
  effect profile, cap, spill và trace. Tên được phép gọi = các tool đang hoạt động trong round, trừ chính
  `run_code` (không đệ quy).
- SDK được **gắn vào mô tả của `run_code`** khi có runtime: hướng dẫn đi cùng công cụ, prompt không phải rẽ nhánh
  theo mode (đúng như D3).

### Fixed

- **Sandbox hở hai đường** — test bắt được: bản `new Function` đầu tiên vẫn thấy `process` và `import("node:fs")`
  chạy được. Nay chương trình chạy trong **`node:vm` context rỗng**: không `process`, không `require`, `import()`
  bị từ chối vì script trong vm không có module callback. Đóng bằng **cấu trúc**, không phải bằng quy ước.

### Test

- `test/code-runtime.test.ts` (5): gọi tool + log + trả giá trị; không có quyền môi trường; vòng lặp vô hạn bị
  giết đúng deadline; call bị từ chối thì `throw` và chương trình bắt được; chương trình lỗi trả về lý do kèm log.
- `test/code-sdk-renderer.test.ts` (3): mỗi tool một chữ ký, required/optional, enum/mảng/unknown.## [0.3.20] - 2026-10-09 14:20 +0700

### Added (P1 của `docs/design/tool-modes.md`)

- **`ToolPresentationMode`** (`native | ptc | both`) cùng `projectToolDefinitions`, `parseToolPresentationMode` và
  `assertPresentationAvailable` trong `src/tools/tool-presentation.ts`, xuất ra từ gốc gói. Phép chiếu là **hàm
  thuần** nên test được mà không cần provider, worker hay session.
- **Descriptor `code.run` / `run_code`** (category `command`, profile `approval,inspect`): chương trình **không có
  quyền riêng** — nó chỉ chạm workspace qua từng call con, và mỗi call con tự có attestation của nó.
- **`AiCoderRunRequest.toolPresentation`** (mặc định `native`) + field tương ứng trên session. Bộ tool mỗi round
  nay đi qua phép chiếu; `ptc`/`both` **dừng ngay khi mở phiên** với `CODE_RUNTIME_MISSING` cho tới khi sandbox của
  P2 được compose — thà báo lúc mở phiên còn hơn sau khi model đã viết xong một chương trình.

### Changed

- Mục `tool-policy` của prompt: 2.3.0 → 2.4.0, **trung lập với mode**. Câu cấm viết script ad-hoc trước đây mâu
  thuẫn trực tiếp với PTC, nay đổi thành *"ưu tiên giao diện đã được tài liệu hoá hơn là đoán"* và ghi rõ ở mode
  `ptc` thì một chương trình ngắn chính là hình dạng mong đợi.

### Test

- 4 test mới: chiếu theo từng mode (mode `native` **không bao giờ** thấy `run_code`), định nghĩa lấy từ catalogue
  chứ không chép tay, chốt chặn thiếu runtime, và bộ parse mode.
- Số lượng catalogue và effect profile cập nhật 21 → 22 (có luật "no drift" nên thiếu profile là lỗi ngay).## [0.3.19] - 2026-10-09 13:00 +0700

### Docs

- **Bản thiết kế chi tiết cho tool modes** (`docs/design/tool-modes.md`, 421 dòng): `native | ptc | both` với SDK
  sinh tự động, sandbox worker-thread, duyệt/resume trong chương trình, event bridge cho call con, ảnh hưởng lên
  completion gate, mô hình đe doạ, kế hoạch test (17 mục) và lộ trình P0-P5.
- Kèm phần **mang giao diện hội thoại của blackhole web sang CLI và VS Code**: từ vựng chung (thẻ tool, nhóm tool,
  khối suy luận, checklist kế hoạch, composer) + các việc cụ thể cho từng host.## [0.3.18] - 2026-10-07 19:00 +0700

### Changed

- **Câu báo lỗi trung tính với nhà cung cấp**: *"Ollama stream im lặng 180s — lượt chạy đã dừng."* → *"Không
  nhận được dữ liệu trong 180s — lượt chạy đã dừng."* Người dùng chỉ thấy provider **`auto`** (Galaxy
  Blackhole tự chọn `deepseek-v4.1-flash`); tên hệ thống bên dưới không cần lộ ra.## [0.3.17] - 2026-10-07 16:05 +0700

### Fixed

- **`toolLabel` không còn in cặp ngoặc rỗng**: một chi tiết chỉ có khoảng trắng (ví dụ `query: " "`) trước đây
  cho ra *"Liệt kê thư mục ( )"*; nay chi tiết được `trim` và bỏ hẳn nếu rỗng, nên nhãn chỉ còn *"Liệt kê thư
  mục"*.## [0.3.16] - 2026-10-07 15:40 +0700

### Added

- **`TOOL_LABELS`, `labelForModelName`, `toolLabel`** (xuất qua `@galaxy-stack/ai-coder-core/tools`): bảng tên
  người đọc được cho từng công cụ, ví dụ `list_files` → *"Liệt kê thư mục"*, `detect_project` → *"Nhận diện dự
  án"*, kèm phần chi tiết gọn (`Chạy lệnh (npm test)`, `Đọc tệp (src/app.ts)`) và xử lý tên MCP
  (`mcp_<server>_<tool>_<hash>` → bỏ hash và tiền tố server).

### Changed

- CLI (`galaxy-code/src/timeline.tsx`) và webview của extension nay **dùng chung một bảng** thay vì mỗi nơi giữ
  một bản — thêm công cụ mới chỉ cần đặt tên một lần.## [0.3.15] - 2026-10-07 14:50 +0700

### Fixed

- **Stream model im lặng không còn treo lượt chạy vô hạn**: `readResponseBody` trong `ollama-coding-model` đã
  có trần dung lượng (8 MiB) nhưng **không có giới hạn thời gian im lặng**, nên chỉ cần đường truyền khựng một
  nhịp là lượt chạy đứng mãi (một flow của CLI từng im lặng gần hai tiếng, UI vẫn hiện tool cuối cùng). Nay
  stream im lặng **180 giây** (`OLLAMA_STREAM_IDLE_MS`) là huỷ và báo rõ: *"Ollama stream im lặng 180s — lượt
  chạy đã dừng."*. Đường huỷ theo `AbortSignal` vẫn giữ nguyên.## [0.3.14] - 2026-10-07 03:20 +0700

### Fixed

- **Snapshot workspace không còn giết cả lượt chạy**: trước đây chỉ cần workspace vượt **512 MiB** tệp không-derived
  (hoặc 100 000 entry) là `capture()` ném `LIMIT_EXCEEDED` → extension báo `SESSION_ERROR` và lượt chạy chết ngay
  trước khi gọi model. Nay:
  - **giới hạn theo từng tệp** (`maxFileBytes`, mặc định 8 MiB): tệp lớn hơn được băm bằng **metadata** thay vì
    cộng cả trăm MB vào ngân sách — một file ISO/video/PDF/bản editor tải về không thể làm hỏng snapshot;
  - **vượt ngân sách thì hạ cấp, không ném lỗi**: phần vượt được băm bằng metadata và snapshot được đánh dấu
    `degraded: true` kèm `metadataOnly` (số tệp phải bỏ qua content hash) — công cụ review vẫn chạy, chỉ yếu hơn;
  - nhờ vậy **không cần chạy đua thêm tên thư mục derived**: thư mục lạ nào cũng chỉ khiến snapshot bị đánh dấu,
    không cần phát hành bản mới để thêm vào danh sách.## [0.3.13] - 2026-10-06 18:40 +0700

### Added

- **`thinking-policy` chuyển từ CLI vào core**: một từ vựng chung cho mức suy luận (default/off/on +
  minimal…max), nhãn tiếng Việt, `resolveThinkingPolicy` theo model, `cycleThinking` và`toOllamaThinking`.
  CLI, web GUI và extension VSCode giờ đọc cùng một policy thay vì mỗi nơi một bản.
## [0.3.12] - 2026-10-06 14:30 +0700

### Fixed

- **`update_checkpoint` accepts the step form the model actually sends.** The tool schema asked for
  `steps: ["done: title"]` while the checkpoint record and the checklist both use `{status, title}` objects,
  so a real gymflow run had its very first step rejected (`steps[0] phải có type string`), the tool never
  ran, and the run aborted with "This operation was aborted". Both forms now validate and parse, `id` is
  optional, and the shorthand stays accepted.
## [0.3.11] - 2026-10-06 10:45 +0700

### Added

- **`adapters/node/config/workspace-mcp`**: one reader for a project's MCP servers, the way the editor
  already writes them (`.vscode/mcp.json`, stdio entries only), plus the merge rule hosts share:
  an explicit agent config wins, then the workspace file, then whatever the host calls its defaults.
  Both the CLI and the VS Code extension now read the same file through it.

## [0.3.10] - 2026-10-05 20:35 +0700

### Fixed

- `update_checkpoint` no longer fails every real run: 0.3.8 taught the tool to write plan `steps`
  but never declared them in its **output** schema, so the runtime rejected the result as untrusted
  after dispatch. Found by the extension's new host E2E test, not by the unit suites.

## [0.3.9] - 2026-10-05 15:55 +0700

### Fixed

- `steps` on the task checkpoint state is optional again. Making it required broke every caller that
  mirrors the state type — the lab package (`testing/`) failed to type check, which is what turned CI
  red on 0.3.8.

## [0.3.8] - 2026-10-05 12:05 +0700

### Added

- Rich plan steps (`plan.steps`), the `plan` runtime event, and plan mode: read-only guidance in the
  system prompt, `PLAN_MODE_READ_ONLY` for mutating tools, `setPlanMode`/`planSnapshot` for hosts.
  See [CHANGELOG.d fragment](CHANGELOG.d/2026-10-05-plan-mode-va-checklist.md).

## [0.3.7] - 2026-10-05 10:35 +0700

### Added

- Context compaction on request: `AiCoderContextManager.compactNow`, `AiCoderRunController.compact(runId)`
  and the `compaction` runtime event, so a host `/compact` runs the same pass the threshold trigger runs.
  See [CHANGELOG.d fragment](CHANGELOG.d/2026-10-05-nen-context-thu-cong.md).
- `AiCoderRunRequest.compactOnStart`: the idle half of `/compact` — the next run compacts before its
  first model turn (the state machine now allows `preparing` ↔ `compacting`).

## [0.3.6] - 2026-10-04 16:45 +0700

### Fixed

- Provider failure messages name the protocol, not the vendor: `chat failed (401)` instead of
  `Ollama chat failed (401)`, and the same for the stream, embedding and manual-config messages.
  The core is host-agnostic, so the host brands the text — the CLI's first-run journey must never
  show the runtime's name (see [CHANGELOG.d fragment](CHANGELOG.d/2026-10-04-trung-tinh-hoa-thong-bao-va-ma-loi-xac-thuc.md)).
- An authentication failure keeps its own code: a provider 401/403 now surfaces as
  `PROVIDER_AUTHENTICATION` instead of being flattened into `PROVIDER_ERROR`, so a host can point at
  its key setup rather than reporting a generic provider fault.

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
