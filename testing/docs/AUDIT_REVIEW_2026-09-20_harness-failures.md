# Đánh Giá Audit 19-20/09/2026: 5hqluS, dcT8VR, jJ6jGR, HCLA6r

Thời điểm đánh giá: **21/09/2026, 00:30 +07:00** (2026-09-19T17:30Z).

Phạm vi: đọc lại 4 audit mới nhất trên **core 0.3.0-alpha.2 / CLI 2.0.0-alpha.2**, model `glm-5.3-flash:cloud`, đối chiếu [TEST_ERROR_LOG.md](<../TEST_ERROR_LOG.md>) và [AUDIT_REVIEW WZk499](<./AUDIT_REVIEW_2026-09-19_WZk499.md>) để phân loại: lỗi cũ tái phát, regression từ bản sửa alpha.2, hay nguyên nhân khác. **Chưa fix; tài liệu này chỉ chẩn đoán và đề xuất phương án.**

## 1. Tổng Quan 4 Run

| Run | Thời gian (+07) | Kết quả | Fail |
| --- | --- | --- | --- |
| [5hqluS](<../.galaxy/audit/2026-09-19T17-36-38-525Z-5hqluS/summary.json>) | 20/09 00:36 -> 04:04 | 48/50 | smoke:repeat-2 (pause loop write); durable-research:repeat-2 (thiếu report bền vững) |
| [dcT8VR](<../.galaxy/audit/2026-09-20T00-07-26-469Z-dcT8VR/summary.json>) | 20/09 07:07 -> 10:23 | 47/50 | smoke:repeat-1 (pause loop write); smoke:repeat-2 (MAX_TOOL_CALLS); durable-research:repeat-3 (vi phạm research trước write) |
| [jJ6jGR](<../.galaxy/audit/2026-09-20T05-05-41-898Z-jJ6jGR/summary.json>) | 20/09 12:05 -> bị dừng | 47/47 pass, **không hoàn tất** | bị dừng ngay khi bắt đầu durable-research:repeat-1; không dùng kết luận durable |
| [HCLA6r](<../.galaxy/audit/2026-09-20T13-27-40-757Z-HCLA6r/summary.json>) | 20/09 20:27 -> 00:40 | 45/50 | polyglot:repeat-1 (DEADLINE, environmental); resilience:repeat-1 (CONFLICT loop); durable-research 0/3 (citation search-only) |

`keep-going` hoạt động: HCLA6r đi đến đủ 50/50 bước (45 pass, 5 fail) — INC-005 tiếp tục PASS.

## 2. Đối Chiếu Incident Cũ — Tái Phát Hay Không

Kết luận chỉ áp dụng cho 4 run này; version là alpha.2 chưa publish.

| INC | Trạng thái trước | Kết quả 4 run mới | Verdict |
| --- | --- | --- | --- |
| INC-001 citation Markdown | fix alpha.1, PASS live WZk499 | Research 3/3 ở cả 3 run hoàn tất; không thấy rejection suffix Markdown cũ | **KHÔNG tái phát** |
| INC-002 oracle Vite | fix alpha.1, 6/6 live | dependency-backed 3/3 × 3 run | **KHÔNG tái phát** |
| INC-003 evidence 512MiB | fix alpha.2, offline | full-application 3/3 × 3 run | **KHÔNG tái phát (offline-verified; live pass 3 run)** |
| INC-004 timeout/deadline | OPEN, NOT OBSERVED | polyglot repeat-1: **69.7 phút** cho deadline 30 phút -> DEADLINE_EXCEEDED; repeat 2/3 pass 5.6/6.4 phút | **OBSERVED, họ INC-004** — latency provider, phân loại environmental |
| INC-005 keep-going | LIVE VERIFIED | 50/50 bước chạy hết trong HCLA6r | **PASS tiếp** |
| INC-006 journal | alpha.2 có timestamps/candidate/diagnosedCause | Run trace từng bước đầy đủ; nhưng `candidateIncidentIds: []`, `diagnosedCause: null` cho mọi fail mới — matcher tự động không nối được vào INC cũ | hoạt động; **gap: signature matcher** |
| INC-007 durable worker timeout | regression alpha.1, fix alpha.2 offline | durable workers chạy trọn vòng đời (SIGKILL sau checkpoint, resume, `finalStatus: completed`) | **FIX LIVE VERIFIED** — worker không bị giết trước deadline nữa |
| INC-008 smoke loop | OPEN (pause cũ) | 3 smoke fail (2 run): loop write với precondition | **TÁI PHÁT cùng họ** — cơ chế mới rõ hơn (mục 3.1) |
| INC-009 CONFLICT loop | OPEN | resilience repeat-1 CONFLICT 5 lần -> pause; repeat 2/3 pass | **TÁI PHÁT cùng họ** — root cause chính xác được tìm thấy (mục 3.2) |
| INC-010 citation search-only | fix alpha.2 (diagnostics) | durable-research **0/3** ở HCLA6r | **TÁI PHÁT** — nhưng nguyên nhân là gap harness (mục 3.3), gate đã sửa hoạt động đúng ở research thường 3/3 |

**Không có failure nào thuộc code fix alpha.2.** Các fix (parser, oracle, fingerprint, timer, feedback gate) không xuất hiện trong đường gây lỗi; ngược lại, fix timer INC-007 chính là thứ để durable worker chạy tới cuối — giúp lộ ra gap harness có sẵn của INC-010 (exposure, không phải regression).

## 3. Nguyên Nhân Gốc (Bằng Cấc Từ Workspace Lưu Trong Audit)

### 3.1 INC-008 họ smoke: model ghi sai byte content, sau đó loop với precondition cũ

Scenario `01-write-and-validate` yêu cầu `hello.txt` = `hello\n` (sha256 `5891b5b5…`); file cuối trong workspace các run fail:

| Run | File cuối | Ý nghĩa |
| --- | --- | --- |
| 5hqluS repeat-2 | `hello` (5 byte, hash `2cf24dba…`) | model xóa luôn newline (over-correct) |
| dcT8VR repeat-1 | `hello` | như trên |
| dcT8VR repeat-2 | `hello\n\n` (hash `50adea61…`) | thừa một newline |

Giữa chừng, model còn ghi `hello\n` **literal** (backslash + n, 7 byte, hash `2d694424…` — chính là kết quả experiment `run_command` model tự chạy để đoán hash). Sau write đầu, model retry **giữ nguyên argument** (kể cả precondition `must_not_exist` theo đúng câu constraint của scenario) → `PRECONDITION_FAILED` vì file đã tồn tại; retry khác → `CONFLICT`; guard no-progress (advisory, `maxNoProgressEpisodes: 2` của smoke) pause đúng thiết kế.

Gốc: **model behavior** (lẫn lộn escaped/literal newline; tái dùng precondition cũ) + **thông báo lỗi không chỉ hướng phục hồi**. Câu constraint của scenario "Use write_file with a must_not_exist precondition" cũng là bẫy: chỉ đúng cho lần write đầu tiên.

### 3.2 INC-009 họ resilience: CRLF vs LF trong `oldText` của edit_file

Bằng chứng [workspace](<../.galaxy/audit/2026-09-20T13-27-40-757Z-HCLA6r/042-live-advanced-resilience-repeat-1/workspace/src/pricing.mjs>): file dùng **CRLF** (`0d 0a`), có cặp chuỗi Unicode lookalike `Café` NFC (`c3 a9`) và `Cafe\u0301` NFD (`65 cc 81`). `oldText` model gửi chỉ có **LF** (`0a`) — 5 lần edit, 2 arguments hash khác nhau, đều CONFLICT "Patch target was not found", trong khi precondition hash khớp (hash toàn file). Nudge advisory bắn đúng ngưỡng, guard pause sau 3 episodes.

Gốc: **model behavior** (không giữ đúng line-ending khi dựng oldText dù đã read) + **product gap nhỏ**: lỗi CONFLICT không nói cho model biết khác biệt nào khiến match thất bại, và precondition hash toàn file không phát hiện được sự lệch đó.

### 3.3 INC-010 durable-research: harness không bật gate citation cho core

`scripts/durable-research-scenario.mjs` export `researchRequirements` (`requireCitations: true`) nhưng **không** đưa vào `expected.research` của scenario — có comment "Research is checked over the two process journals by the supervisor". Hệ quả trong HCLA6r (0/3):

- `completionRejections: 0`, `finalStatus: "completed"` — core gate không được cấu hình nên không chặn citation search-only.
- Supervisor oracle (`observeResearch` với `researchRequirements`) bắt được `unsupportedCitations` sau khi mọi thứ đã hoàn tất: repeat-1 trích `github.com/nodejs/node/commit/…` (chỉ search), repeat-2 trích `developer.mozilla.org/…/AbortSignal` (chỉ search) dù đã fetch thành công `Window/fetch` và `nodejs globals`.
- Model chạy dưới fault-injection compaction 10-13 lần — đúng bối cảnh mà alpha.2 đã xây feedback `RESEARCH_CITATION_UNSUPPORTED` (liệt kê fetched/search-only/unsupported) để model tự sửa; nhưng feedback đó chỉ bắn khi requirement được đưa vào run request.

Chứng minh gate đúng khi được bật: `live:research` (scenario JSON chuẩn, có `expected.research.requireCitations`) pass 3/3 ở cả 3 run, với 1 completion rejection mỗi run và model tự sửa theo feedback — cùng cơ chế alpha.2.

Gốc: **harness gap** (requirement không nối vào run request của custom scenario) + model behavior dưới compaction cao. Không phải regression của fix alpha.2.

### 3.4 INC-004 họ polyglot: latency provider

Repeat-1 kéo dài 69.7 phút cho deadline 30 phút với chỉ 15 tool calls (~4.6 phút/lần round model); repeat 2/3 của cùng scenario hoàn thành trong ~6 phút với số tool calls tương đương. Không có model retry. Gốc: **môi trường/provider chậm cục bộ**, không phải code. Phân loại `environmental` của audit là chính xác.

## 4. Các Hệ Thống Khác Xử Lý Thế Nào

| Hệ thống | Cơ chế liên quan | Bài học cho Galaxy |
| --- | --- | --- |
| deepseek-harness `repeat-tool-reminder` (đã đọc source local, thresholds 3/5/8) | Nudge 2 tầng: gentle ("analyze the previous result… try a different approach") rồi detailed nêu rõ tool + số lần + **canonical arguments** (capped 500 ký tự), không veto. Galaxy đã có advisory 3/5/8 nhưng nudge vẫn generic ("act on the retained evidence") | Nudge nên nêu cụ thể arguments hash + hướng: với PRECONDITION_FAILED → "re-read to get current hash"; với CONFLICT → "your oldText differs from file bytes — re-read exact range" |
| Claude Code (Edit tool) | Lỗi not-found nêu rõ chuỗi cần khớp và gợi ý whitespace/line endings; một số phiên bản match tolerant với CRLF | Thêm gợi ý line-ending/whitespace vào lỗi CONFLICT của edit_file |
| Gemini CLI `loopDetectionService` | Phát hiện chu kỳ tool lẫn chu kỳ nội dung; can thiệp sớm thay vì để model đốt budget; deadline là một tín hiệu loop | Signature matcher của INC-006 nên khớp theo **họ cấu trúc** (edit-CONFLICT-loop, write-precondition-loop, unsupported-citation) thay vì hash message thô |
| Codex CLI apply_patch | Patch thất bại trả về hunk cụ thể + ngữ cảnh, model tự sửa | Trả trong lỗi CONFLICT đoạn context xung quanh điểm gần giống nhất |
| DeepSeek harness `test:snapshot` | Record live một lần, replay offline không key — kiểm tra logic harness mà không tốn thời gian live | Smoke/exact-byte và durable citation logic nên có replay offline để bắt loop trước khi chạy live 3-4 tiếng |

## 5. Phương Án Đề Xuất (Chưa Fix)

Ưu tiên theo hiệu quả/giá trị trace, không đụng ngưỡng smoke 2/2/2 và không đổi model.

1. **Nối `researchRequirements` vào run request của durable scenario** (sửa `expected.research` trong `durable-research-scenario.mjs` hoặc inject từ supervisor). Model sẽ nhận feedback fetched/search-only/unsupported ngay trong run và tự sửa như research thường đã làm. Kỳ vọng: durable-research hết 0/3 kiểu "completed nhưng oracle fail". Trước khi chạy live, thêm replay/mock cho 2 lượt (compaction cao + citation search-only) để xác minh feedback xuất hiện.
2. **Nudge có hành động cụ thể theo mã lỗi**: PRECONDITION_FAILED → yêu cầu re-read + hash mới (và lưu ý `must_not_exist` chỉ dùng một lần); CONFLICT edit_file → gợi ý re-read đúng vùng và khớp byte (line-ending, unicode). Giữ nguyên ngưỡng 3/5/8.
3. **Signature matcher INC-006 theo họ cấu trúc**: map loop write/edit/citation vào INC-008/009/010 để `diagnosedCause` tự động có giá trị gợi ý (không tự đóng incident); giữ nguyên raw.
4. **Constraint scenario smoke**: đổi câu "Use write_file with a must_not_exist precondition" thành "for the first write only; after that use matches_sha256 with the current hash" — bỏ bẫy instruction.
5. **INC-004 (environmental)**: ghi nhận thêm timing từng model round vào report (đã có phase timestamp); cân nhắc `requestTimeoutMs` ngắn hơn cho scenario không durable để deadline không bị nuốt bởi một request chậm. Không fix ngay; theo dõi thêm run.
6. **Không cần sửa** gate citation, parser INC-001, verifier INC-003, timer INC-007 — các đường đó đã được các run mới xác nhận hoạt động.

## 6. Trạng Thái

- Đã đọc: 4 summary + stdout/stderr của các bước fail, workspace/store của 3 nhóm fail chính, scenario JSON/MJS, completion-gate + run-controller (core), repeat-tool-reminder (deepseek-harness), TEST_ERROR_LOG.md và review WZk499.
- Chưa sửa code, chưa đổi version, chưa chạy test mới; các kết luận dựa trên artifact audit hiện có.
- Các incident INC-008/009/010 được coi là **tái phát có bằng chứng mới**; INC-004 chuyển từ NOT OBSERVED sang OBSERVED (environmental); INC-007 chuyển thành LIVE VERIFIED FIXED; INC-001/002/003/005 không tái phát.

## 7. Fix Record — 21/09/2026, 00:55 +07:00 (core 0.3.0-alpha.3, CLI 2.0.0-alpha.3)

Người dùng duyệt fix theo phương án mục 5. Trạng thái: **OFFLINE VERIFIED**, chưa live. Chi tiết đầy đủ (kèm lỗi phát sinh khi fix): [Addendum trong TEST_FAILURE_ANALYSIS.md](./TEST_FAILURE_ANALYSIS.md).

| Fix | File | Hệ thống tham khảo | Kiểm chứng offline |
| --- | --- | --- | --- |
| Nối `researchRequirements` vào `expected` của durable scenario; seed research từ checkpoint khi resume | `scripts/durable-research-scenario.mjs`, `src/live/research-observations.ts`, `src/live/run-live-health.ts` | Gate feedback in-run kiểu Claude Code; oracle offline kiểu deepseek snapshot replay | durable mock 6/6 |
| Nudge kèm `arguments_hash` (core) | `galaxy-ai-coder-core/src/runtime/run-controller.ts` | deepseek repeat-tool-reminder (canonical args, bản rút gọn bằng hash) | core 107/107 |
| Tool error có hướng phục hồi (PRECONDITION_FAILED/CONFLICT) | `src/host/node-workspace-port.ts` | Claude Code not-found hint; Codex CLI hunk context | unit/integration/e2e pass |
| Constraint smoke bỏ bẫy `must_not_exist` | `live/scenarios/01-write-and-validate.json` | — | unit/integration/e2e pass; fixture replay được vá fingerprint (trade-off đã ghi CHANGELOG) |
| Matcher họ incident INC-001/004/008/009/010 | `scripts/audit-journal.mjs` | Gemini loop detection theo chu kỳ cấu trúc | test matcher mới pass |

Lỗi phát sinh khi fix (đã xử lý, giữ để trace): durable mock success false-fail do oracle runner-level process-scoped (fix bằng seed checkpoint); e2e replay fixture hash mismatch (vá fixture in-place, re-record live khi có phiên mới); expectation matcher INC-001 phải nhận cả INC-010 (đúng ngữ nghĩa).

## 8. Xác Minh Live Bản Sửa — Run [OycseO](../.galaxy/audit/2026-09-20T18-36-41-606Z-OycseO/summary.json), 21/09/2026 01:36 +07:00

Kết quả: **49/50**. Durable-research **2/3 PASS** (trước đây 0/3): gate in-run hoạt động live, hai lượt pass có search/fetch đúng requirement và không refetch sau resume. Các họ cũ không tái phát: smoke 3/3, resilience 3/3, research 3/3, dependency/full/polyglot 3/3, không DEADLINE.

Fail duy nhất `durable-research:repeat-3` — nguyên nhân: model bỏ bước search (0 `search_web`, 3 `fetch_url`), gate từ chối đúng 2 lần (`RESEARCH_EVIDENCE_MISSING: search calls 0/1`), model không sửa (candidate 2 vẫn tuyên bố requirements satisfied; final response không có citation nào) → NO_PROGRESS. Không phải tái phát INC-010 cũ; là model behavior + gap nhỏ: `RESEARCH_EVIDENCE_MISSING` chưa có remediation line chỉ hành động như citation đã có. Chi tiết và phương án: [Addendum TEST_FAILURE_ANALYSIS](./TEST_FAILURE_ANALYSIS.md).

## 9. Fix Alpha.4 Cho Failure Còn Lại — 21/09/2026, 02:20 +07:00 (core 0.3.0-alpha.4, CLI 2.0.0-alpha.4)

- Core: remediation line cho `RESEARCH_EVIDENCE_MISSING` nêu tên `search_web`/`fetch_url` (đối xứng với feedback citation).
- Harness: task durable scenario nói rõ "at least one search_web query" — requirement vào prompt.
- Không đổi ngưỡng rejection (2) và không thêm nudge — chỉ mở lại nếu live tiếp theo vẫn fail cùng kiểu.
- Kiểm chứng offline: core 108/108 (test regression mới), durable mock 6/6, CLI unit + e2e pass, typecheck pass. Live do người dùng chạy; chi tiết trong [Addendum TEST_FAILURE_ANALYSIS](./TEST_FAILURE_ANALYSIS.md).

## 10. Xác Minh Live Alpha.4 — Run [Ap63fW](../.galaxy/audit/2026-09-21T06-23-21-400Z-Ap63fW/summary.json), 21/09/2026 13:23 +07:00

**47/50.** Smoke/progressive/commerce/polyglot/dependency/full/research 3/3; resilience 2/3; durable 1/3 (repeat-2 PASS).

Alpha.4 xác nhận live: remediation line xuất hiện trong error message; cả 3 lượt durable đều search đúng requirement (hết failure "0 search"); repeat-2 pass trọn vòng đời. Ba fail mới: 2 environmental (provider timeout ở resilience-3; DNS ENOTFOUND ở durable-3 — lần đầu ghi nhận), 1 model-behavior (durable-1: CONFLICT/PRECONDITION loop sau 19 compaction, guard pause đúng thiết kế). Không có regression từ code fix; chi tiết trong [Addendum TEST_FAILURE_ANALYSIS](./TEST_FAILURE_ANALYSIS.md).
