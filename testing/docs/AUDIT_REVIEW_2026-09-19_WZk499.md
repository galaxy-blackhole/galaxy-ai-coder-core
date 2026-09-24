# Đối chiếu audit IZ0QFZ và WZk499

Mốc chốt dữ liệu: **19/09/2026 19:20:01 +07:00**, tương ứng **2026-09-19T12:20:01Z**. Phần đánh giá ban đầu chưa triển khai bản sửa; addendum cuối tài liệu ghi code và gate offline hoàn thành lúc 22:45 +07:00. Không chạy lại live.

Điểm tra cứu chính: [TEST_ERROR_LOG.md](../TEST_ERROR_LOG.md). Đối chiếu incident trước đây trong [TEST_FAILURE_ANALYSIS.md](TEST_FAILURE_ANALYSIS.md); nhận định có timestamp trong tài liệu này cập nhật các nhận định cũ, không xóa lịch sử.

## Kết quả và phiên bản

| Audit | Thời gian ngày 19/09, +07:00 | DONE | PASS | FAIL | Bước lỗi |
| --- | --- | --- | --- | --- | --- |
| [2026-09-19T05-09-02-850Z-IZ0QFZ](../.galaxy/audit/2026-09-19T05-09-02-850Z-IZ0QFZ/summary.json) | 12:09:03 đến 15:14:25 | 50/50 | 46/50 | 4 | 40, 48, 49, 50 |
| [2026-09-19T08-14-55-433Z-WZk499](../.galaxy/audit/2026-09-19T08-14-55-433Z-WZk499/summary.json) | 15:14:55 đến 18:34:52 | 50/50 | 45/50 | 5 | 41, 45, 48, 49, 50 |

Cả hai dùng core `0.3.0-alpha.1`, CLI `2.0.0-alpha.1`, model `glm-5.3-flash:cloud` ở các scenario có khởi chạy model. Ba bước durable mỗi audit thất bại trước khi có model metadata; không gán lỗi của chúng cho GLM.

- WZk499: core commit `daa3a02320d4412b8c64bb7c4a7fc48bd5ada52a`; CLI commit `b797c760afc60e00e3b1b772d167ca3adaa710f6`; source SHA-256 `f205e2522e9d74303462804afa14f96e8116f2170d027a1a62e5c3036b89b4e0`; `sourceUnchanged=true`.
- IZ0QFZ: `sourceUnchanged=false`; hash đầu `af3ce8c25e3a736b08e6de71446eb5b3c885eb9f48a7e04e7bcf454e2baf3539`, hash cuối trùng hash WZk499. So sánh hai manifest đầu run chỉ thấy `core/README.md` khác; không có bằng chứng runtime khác giữa hai snapshot này. Vẫn giữ cảnh báo source drift của IZ0QFZ.
- Kiểm tra hiện tại: CLI khai báo `file:..` và resolve tới `galaxy-ai-coder-core/dist/index.js`. Đây là audit checkout local; không tự xem là kiểm thử tarball đã tải từ npm.
- Registry npm tại thời điểm đánh giá trả `latest=0.1.0`, `alpha=0.3.0-alpha.1`; alpha được publish `2026-09-19T05:17:43.911Z`, tức 12:17:43 +07:00. Dòng “unpublished” trong changelog và nhận định “npm chỉ có 0.1.0” trong tài liệu cũ đã lỗi thời. Chưa chỉnh release metadata trong đợt đánh giá này.

Các nhóm deterministic 1-23 đều PASS ở cả hai audit. Kết quả assertion đã được audit ghi: core **106 PASS**, CLI unit **116 PASS**, integration **87 PASS / 1 SKIP**, e2e **43 PASS**. Đây là kết quả người dùng đã chạy, không phải test mới của phiên đánh giá.

Đã kiểm tra bằng chương trình: cả **100 dòng trạng thái bước** của hai run trong Markdown khớp `summary.json`. Tuy nhiên, DONE 50/50 là số nhóm audit đã kết thúc; WZk499 research repeat-1 dừng ở scenario 1/3, nên scenario 2 và 3 của lượt đó chưa chạy.

## Ma trận lỗi cũ

| Incident / phạm vi | IZ0QFZ | WZk499 | Kết luận tại mốc đánh giá |
| --- | --- | --- | --- |
| INC-001: parser URL kèm dấu Markdown | Research 3/3 nhóm PASS | Research 2/3 nhóm PASS; lỗi còn lại là URL thiếu fetch evidence | Test parser vẫn PASS; không thấy suffix Markdown cũ trong rejection mới. Chưa xác minh lại durable research vì worker không khởi chạy được. Không gộp lỗi research mới vào INC-001. |
| INC-002: oracle Vite xét cách viết export | Dependency-backed 3/3 PASS | Dependency-backed 3/3 PASS | LIVE VERIFIED cho 6 lượt campaign quan sát được; không có lỗi oracle định dạng cũ. |
| INC-003: evidence vượt 512 MiB | FAIL bước 40, Next | FAIL bước 41, Angular | Vẫn OPEN, đã tái hiện offline đường gây lỗi. Đây là lỗi cũ chưa được sửa hoàn chỉnh, không phải lỗi mới do parser/advisory. |
| INC-004: provider timeout/deadline | Không thấy model retry/deadline gây fail | Không thấy model retry/deadline gây fail | NOT OBSERVED trong hai run; chưa đủ bằng chứng đóng incident timeout thật trước đây. |
| INC-005: `--keep-going` | Đến 50/50 dù bước 40 fail | Đến 50/50 dù bước 41/45 fail | LIVE VERIFIED. |
| INC-006: journal và timestamps | Đủ 50 dòng kết quả | Đủ 50 dòng kết quả | Phần ghi kết quả hoạt động; còn thiếu liên kết incident, phân loại nguyên nhân và candidate/payload để replay chính xác. |
| INC-007: timeout worker durable | 0/3 PASS | 0/3 PASS | Bản sửa có regression ở đường mặc định. Nhãn OFFLINE VERIFIED trước đây chỉ được hỗ trợ bởi test truyền timeout tường minh, không xác minh đường live mặc định. |
| INC-008: vòng ghi/xóa trong smoke | 3/3 PASS | 3/3 PASS | Không tái hiện pause kiểu cũ trong 6 lượt; không kết luận model hết mọi lỗi tool. |
| INC-009: stale edit lặp trong resilience | 3/3 PASS | 3/3 PASS | Vẫn có CONFLICT nhưng phục hồi được; không gặp pause thất bại cũ. Tiếp tục theo dõi, không bỏ guard mutation. |
| Guard advisory | Test và smoke PASS | Test và smoke PASS | Các test nudge không tăng episode và block sau mốc cuối vẫn PASS. Không có bằng chứng cần đổi ngưỡng để chữa ba nhóm lỗi hiện tại. |

Chứng cứ parser/guard của WZk499: [core test stdout](../.galaxy/audit/2026-09-19T08-14-55-433Z-WZk499/002-core-tests/stdout.log), các test `citation extraction accepts Markdown-emphasized and colon-prefixed URLs from the durable report style`, `advisory observations nudge at configured thresholds and block after the final threshold`, `advisory nudges do not count no-progress episodes`.

## INC-007: regression timeout mặc định

**Lỗi và nguyên nhân đã xác định**

WZk499 bước 48-50 kết thúc lúc 18:34:52 +07:00, lần lượt chỉ mất **167 / 130 / 133 ms**, nhưng cùng báo “timed out after 1500000ms”. IZ0QFZ cũng gặp ở bước 48-50, mất **241 / 208 / 191 ms**. Đây là duration do runner ghi, không phải thời gian model chạy.

[durable-research-health.mjs](../scripts/durable-research-health.mjs), dòng 30 tính `phaseTimeoutMs = timeoutMs ?? (deadlineMs + 600000)`, nhưng dòng 57 vẫn gọi timer với `timeoutMs`. Đường CLI tại dòng 137 không truyền `timeoutMs`. Bản sửa trước bỏ default `timeoutMs=900000` khỏi tham số hàm nhưng chưa thay biến đưa vào timer; diff local xác nhận thay đổi này.

Node mặc định delay là 1 ms khi không truyền giá trị. Probe cục bộ trả `requested=1500000`, `passedToTimer=null`, `nodeTimerDelay=1`, `elapsedMs=1`. Đây là kiểm tra semantics timer, không phải một live audit mới. [Node timers](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args).

[Test durable hiện có](../scripts/durable-research.test.mjs), dòng 67, luôn truyền `timeoutMs:45000`. Vì vậy test PASS không cover lỗi mặc định. Report `TIMEOUT` làm classifier gắn `environmental`, nhưng nguyên nhân thực tế là code harness; cần ghi đè phân loại trong phần chẩn đoán, giữ nguyên raw report.

**Hệ thống tham khảo**

DeepSeek tách `resolve(request)` thành spec đã chuẩn hóa; executor dùng `spec.timeoutMs` cho deadline và kết quả. Xem [bash-local](../../deepseek-harness-master/packages/shell/bash-local/src/index.ts), dòng 148-160 và 229-264. [Testing policy](../../deepseek-harness-master/docs/testing.md) yêu cầu mock LLM/network/clock nhưng giữ đường thực thi phía sau là thật. Cách này phù hợp để test default mà không chờ 25 phút.

**Phương án đề xuất**

1. Ở CLI harness, chuẩn hóa và validate timeout một lần; timer, log và report sử dụng cùng giá trị đã chuẩn hóa. Ghi thêm thời lượng thực tế, deadline cấu hình và nguyên nhân dừng riêng.
2. Thêm regression đi qua lời gọi không truyền `timeoutMs`, rồi một test cho override. Dùng clock/scheduler kiểm soát được để chứng minh worker không bị kill trước hạn và có timeout khi đến hạn.
3. Giữ kiểm tra handshake, checkpoint đã lưu, SIGKILL chủ động, resume process mới và không replay mutation. Test timeout phải phân biệt SIGKILL do fault injection với SIGKILL do hết thời gian.

Owner chính: `galaxy-code/scripts/durable-research-health.mjs`. Không cần đổi provider/model hoặc API core để sửa lỗi này. Chỉ sau khi worker thực sự chạy mới đánh giá lại vấn đề thời lượng của INC-007 ban đầu.

## INC-003: list dependency làm evidence vượt budget

**Lỗi và nguyên nhân đã tái hiện**

- IZ0QFZ bước 40: 13:23:11.808 đến 13:24:53.317 +07:00; `edit_file` của Next thất bại khi áp dụng evidence. Run ID `live-7333bfad-d2f0-4fc3-8844-ef6d8290a97c`.
- WZk499 bước 41: 16:51:39.903 đến 17:04:16.507 +07:00; Angular là scenario thứ tư, `validate_project` thất bại khi áp dụng evidence. Run ID `live-47180eb6-152c-4e78-ba67-2057ef4fb311`.
- Cả hai đều có `list_files(path="node_modules", depth=1)` trước tool gây lỗi. WZk499 chỉ yêu cầu tối đa 15 entry; IZ0QFZ tối đa 10. [WZk499 stdout](../.galaxy/audit/2026-09-19T08-14-55-433Z-WZk499/041-live-full-application-repeat-3/stdout.log), [IZ0QFZ stdout](../.galaxy/audit/2026-09-19T05-09-02-850Z-IZ0QFZ/040-live-full-application-repeat-2/stdout.log).

Chuỗi source xác nhận nguyên nhân: [tool-executor.ts](../src/lab/tool-executor.ts), dòng 721, đưa path thư mục đã list vào `inspectedPaths`; [run-controller.ts](../../src/runtime/run-controller.ts), dòng 2361-2376, gom các path đó vào `activeFiles`; [node-workspace-evidence-verifier.ts](../src/host/node-workspace-evidence-verifier.ts), dòng 292-293, duyệt toàn bộ thư mục ignored khi thư mục đó active. `visitExplicitDirectory` đọc content mọi file; bộ đếm dừng ở 512 MiB.

Probe bằng chính verifier trên retained workspace WZk499:

| Đầu vào | Kết quả | Thời lượng quan sát |
| --- | --- | --- |
| `activeFiles` từ checkpoint Angular trước lần list dependency | PASS; fingerprint `sha256:50d3450dbc409e3bfce4d250c183f5a3c1b573d50215e62c9ed4020e35080a4f`, trùng checkpoint | 31 ms |
| Cùng đầu vào, thêm thư mục active `node_modules` | `LIMIT_EXCEEDED: Workspace evidence exceeded its byte limit.` | 24.142 ms |

Probe không ghi hoặc sửa workspace. Hash source verifier hiện tại khớp manifest WZk499. Không cần suy đoán cache Angular hay chất lượng code model để giải thích lỗi này. Thông báo “Required tool project.validate was not used” phản ánh thiếu evidence đã áp dụng thành công, không đủ để nói model chưa gọi validate.

**Hệ thống tham khảo**

[Gemini GitService](https://github.com/google-gemini/gemini-cli/blob/09e048fd61bc56df18676211f65703e7f0075f3a/packages/core/src/services/gitService.ts) dùng shadow Git repository, đọc `.gitignore` và tạo snapshot qua Git. Bài học phù hợp là phạm vi snapshot có chính sách rõ ràng. Cơ chế checkpoint đó không tương đương chứng nhận validation của Galaxy; không nhập nguyên cách ignore Git để bỏ xác minh file liên quan.

**Phương án đề xuất**

1. Tách observation thư mục với evidence content của file. `list_files` không mặc nhiên tạo yêu cầu hash đệ quy toàn bộ dependency. Listing có thể giữ fingerprint tên/kind/metadata hoặc đúng phạm vi quan sát; file được đọc hay sửa trực tiếp vẫn cần evidence content theo hợp đồng của nó.
2. Dùng chung chính sách authored/derived giữa snapshotter và verifier. Với derived state, ghi thay đổi theo metadata như host hiện đã hỗ trợ, nhưng không biến metadata thành content hash của authored file hoặc chứng nhận validation còn mới khi dependency thay đổi.
3. Log byte/file/path/scope tại điểm vượt limit; giữ nguyên fail-closed và trạng thái outcome unknown sau side effect. Không tự chạy lại mutation chưa biết kết quả.
4. Regression với budget nhỏ có thể cấu hình: list dependency lớn rồi edit/validate source; đọc trực tiếp file dependency rồi thay content; thay file source cùng kích thước; symlink và path-kind change; resume sau dependency thay đổi; evidence capture fail sau side effect.

Owner triển khai đầu tiên: host `galaxy-code`. Nếu cần thêm loại observation để phân biệt listing và content ở public effects/checkpoint, mới sửa interface core có version, cập nhật mọi consumer và test resume tương thích. Chưa cần thay kiến trúc runtime toàn bộ hoặc chỉ tăng 512 MiB.

## INC-010: research không phục hồi sau fetch lỗi

**Lỗi và mức chắc chắn**

WZk499 bước 45 từ 17:59:15.473 đến 18:06:24.742 +07:00, run `live-68f79904-8843-4226-95fd-861cbeaba5c0`, dùng 16 tool calls, không compaction, bị từ chối final report 3 lần. [Stdout](../.galaxy/audit/2026-09-19T08-14-55-433Z-WZk499/045-live-research-repeat-1/stdout.log).

Model có 4 nguồn fetch thành công: Node globals, MDN fetch, AbortSignal.timeout và Retry-After. URL `https://github.com/nodejs/undici/issues/2171` chỉ có search evidence; hai lần fetch đều trả `PROVIDER_ERROR: Ollama web fetch returned an invalid page schema.` Model vẫn trích URL này sau rejection; candidate cuối thêm hai URL Undici khác cũng chỉ có search evidence. Gate từ chối đúng theo quy định hiện tại. Đây không phải lỗi dấu `**:` của INC-001.

Ở bước 46, cùng URL issue lại fetch lỗi và report bị từ chối 2 lần, nhưng model sửa được rồi campaign PASS. Điều đó cho thấy recovery có thể thành công trong budget hiện tại, không chứng minh tăng số lần retry là giải pháp cần thiết.

[OllamaResearchPort](../src/provider/ollama-research-port.ts), nhánh `extract`, xác thực `title`, `content` và `links`. [Tài liệu Ollama](https://docs.ollama.com/capabilities/web-search#web-fetch-api) mô tả các trường này. Raw payload lỗi chưa được lưu nên **chưa thể kết luận trường nào sai, upstream lỗi hay adapter từ chối quá chặt**. Không nới schema hoặc coi dữ liệu search là fetch chỉ từ message tổng quát này. Final candidate bị reject cũng không được giữ đầy đủ trong report; `finalResponse=""` không phải bằng chứng model không viết report.

**Hệ thống tham khảo**

- [Gemini web-search](https://github.com/google-gemini/gemini-cli/blob/09e048fd61bc56df18676211f65703e7f0075f3a/packages/core/src/tools/web-search.ts) gắn citation vào grounding source indices và trả danh sách nguồn có cấu trúc. Galaxy có thể mượn cách dùng định danh nguồn; điều kiện “fetch thành công” vẫn do Galaxy quyết định.
- [Claude Code Stop hooks](https://code.claude.com/docs/en/hooks#stop) trả lý do/feedback cho model tiếp tục và có cơ chế hạn chế việc chặn lặp. Chỉ tham khảo protocol công khai này, không tuyên bố đã đọc engine nội bộ.
- [DeepSeek repeat-tool-reminder](../../deepseek-harness-master/packages/guard/repeat-tool-reminder/src/index.ts) nhắc model xem kết quả và đổi cách làm. Nudge 3/5/8 không thể tự sửa việc provider trả payload sai hoặc citation không có nguồn.

**Phương án đề xuất**

1. Adapter giữ chẩn đoán đã redact, có giới hạn: status/content-type, trường sai và kiểu nhận được, hash payload, request/attempt ID. Chỉ tạo fixture từ payload thật sau khi thu được nó; hiện chỉ đủ dữ liệu cho fixture scripted theo lỗi đã quan sát.
2. Core dùng ledger nguồn hiện có để phát feedback có cấu trúc: nguồn nào `fetched`, nguồn nào `search-only`, nguồn nào `fetch-failed`; đưa danh sách citation được chấp nhận và hành động “bỏ/thay citation không xác minh được, hoặc fetch nguồn khác”. Dùng URL dưới dạng dữ liệu, không đưa nội dung web vào phần chỉ thị tin cậy.
3. Khi một URL có lỗi không retryable, các vòng sau cần nhận biết lỗi đã xảy ra và lựa chọn nguồn khác/báo giới hạn. Bất kỳ chính sách retry mới nào đều phải hữu hạn và dựa vào loại lỗi; không tự coi mỗi request tương tự là cơ hội vô hạn.
4. Lưu từng candidate bị reject, reason, source IDs và feedback vào trace. Có thể tiến tới final report chọn source IDs để renderer tạo citation; bước đầu dùng ledger hiện có để tránh mở rộng public API quá sớm.
5. Regression: fetch lỗi sau search; candidate vẫn dẫn URL lỗi; feedback chỉ rõ nguồn được phép; candidate sửa hợp lệ PASS; URL chưa fetch vẫn FAIL; parser Markdown, read-only mode, compaction/resume không mất trạng thái nguồn vẫn PASS.

Owner: adapter CLI cho schema diagnostics; core cho feedback/ledger/completion trace; oracle CLI dùng cùng quy tắc với core. Giữ giới hạn completion rejection và yêu cầu evidence hiện tại trong bước sửa đầu tiên.

## INC-006: nhật ký phải phân biệt triệu chứng và nguyên nhân

Sổ Markdown hiện ghi đúng tiến trình hai run nhưng chưa đủ để tự kết luận hồi quy:

- INC-003 xuất hiện ở scenario/tool khác nhau nên hash symptom khác, và dòng `Earlier matching runs: none among retained logs` không nhận ra cùng nguyên nhân. Hàm [failureSignature](../scripts/audit-journal.mjs) dùng cả tên scenario và toàn message.
- `TIMEOUT` của lỗi timer bị xếp environmental; `NO_PROGRESS` do citation thiếu evidence bị xếp product. Đây là phân loại tự động theo mã lỗi, chưa phải chẩn đoán nguyên nhân.
- Trong `.galaxy/audit` hiện chỉ còn hai run mới; các link raw của nhiều run cũ trong Markdown không còn đích. Vẫn đọc được bản tóm tắt cũ, nhưng không thể tuyên bố đã kiểm chứng lại raw artifact đã mất.

**Phương án:** giữ Markdown làm nơi tra cứu và quyết định trạng thái incident; giữ JSON/JSONL/stdout/checkpoint làm bằng chứng gốc. Append một bản đánh giá có timestamp, run/version/source hash, incident ID bền vững, nguyên nhân và mức chắc chắn, trạng thái trước/sau, test hồi quy, số PASS/DONE/scenario chưa chạy, link artifact. Tách `automaticCategory` khỏi `diagnosedCause`. Không thay raw report và không đóng incident bằng “không gặp lại”.

[Codex RolloutRecorder](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/rollout/src/recorder.rs) giữ session JSONL để tra cứu; [Kimi WireFile](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/wire/file.py) lưu envelope có timestamp/protocol version; [Gemini RecordingContentGenerator](https://github.com/google-gemini/gemini-cli/blob/09e048fd61bc56df18676211f65703e7f0075f3a/packages/core/src/core/recordingContentGenerator.ts) ghi response để FakeContentGenerator replay. Đây là cơ sở cho trace có thể phát lại, không chỉ giữ vài dòng lỗi cuối.

Các lỗi orchestration cần fixture offline đi qua controller/tool/host thật. Chỉ mock model/network/clock ở ranh giới tương ứng. Ưu tiên recorded response khi có đủ dữ liệu; ghi rõ scripted reconstruction khi thiếu transcript/payload. Đối với artifact lỗi chưa đóng, cần archive có checksum và đường dẫn có thể truy cập trước khi dọn workspace nặng.

## README core cần bổ sung

[README core](../../README.md) hiện có kiến trúc/invariants/development, nhưng chưa đủ cho người dùng npm tích hợp thư viện. Đề xuất cấu trúc:

1. Cài đặt Node/ESM/TypeScript và package: `npm install @galaxy-stack/ai-coder-core@alpha`; dùng `@0.3.0-alpha.1` khi cần tái hiện chính xác. Nêu rõ `latest` hiện là 0.1.0 và core không kèm Node/Ollama host adapter hoàn chỉnh.
2. Quick start chạy được với adapter mẫu thật hoặc scripted/in-memory adapter, thể hiện dependencies, task, event listener, chờ `handle.result`, đọc completed/paused/failed. Không dùng ví dụ import một factory chưa export.
3. Lifecycle của `AiCoderRunController`: `start`, `resume`, `pause`, `cancel`, `resolveApproval`; request/result/error, lưu checkpoint, quyền thực thi, outcome unknown.
4. Tài liệu API theo các subpath export: `runtime`, `ports`, `tools`, `context`, `prompt`, `approval`, `retrieval`; mỗi API chính có input/output, ví dụ, ownership và lỗi thường gặp. Chi tiết dài nằm trong `docs`, README dẫn đường.
5. Budget/advisory/strict, model/provider adapter, research evidence, validation/diff gate; hướng dẫn chạy unit/conformance/audit và đọc version trong log. Nêu đúng giới hạn host hiện đã kiểm chứng.
6. Kiểm tra ví dụ bằng typecheck và package đã pack/cài đặt; không chỉ test source. Bản sửa code/public API tiếp theo có alpha mới và fragment `CHANGELOG.d` ngày giờ rõ ràng, cập nhật cả README/changelog theo version.

Không sửa README trong phiên này; đây là đề xuất tài liệu đi cùng đợt sửa sau.

## Thứ tự triển khai đề xuất

1. Sửa timeout mặc định và thêm test default/override, kiểm chứng crash/resume bằng mock offline. Đây là blocker che toàn bộ live durable research.
2. Sửa phạm vi evidence theo nguyên nhân đã tái hiện, giữ kiểm tra authored content và side-effect unknown. Kiểm chứng bằng retained-workspace probe và fixture budget nhỏ.
3. Bổ sung research diagnostics, feedback nguồn và candidate trace; giữ parser regression cũ và rejection cho citation không đủ bằng chứng.
4. Hoàn thiện incident matrix/README/API examples, gắn bản sửa với alpha version và artifact thực sự được nạp. Chỉ bump core khi core hoặc gói phát hành của core có thay đổi; lỗi CLI riêng có version CLI riêng.
5. Chạy offline gate phù hợp rồi để người dùng chạy full live audit trên source cố định. So sánh từng incident và các campaign đã PASS, không chỉ tổng 50 nhóm; chỉ đóng lỗi khi regression và đường live liên quan đều đã được xác minh.

Memory/graph integration, thêm provider hoặc thay model không phải giải pháp trực tiếp cho ba nhóm lỗi đã có bằng chứng ở đây.

## Addendum triển khai 19/09/2026 22:45 +07:00

Đã triển khai đúng thứ tự đề xuất trên `core 0.3.0-alpha.2` và `CLI 2.0.0-alpha.2`; chưa publish và chưa chạy live trong phiên này.

- INC-007: timer dùng đúng timeout đã resolve/validate, report lưu `phaseTimeoutMs`; test default/override/invalid và durable mock e2e PASS.
- INC-003: active dependency directory dùng metadata fingerprint, không đọc toàn bộ package bytes; active dependency file trực tiếp vẫn content-hash. Regression budget 64 byte PASS và vẫn phát hiện dependency thay đổi.
- INC-010: completion rejection giữ candidate cùng fetched/search-only/unsupported URLs; feedback chỉ rõ nguồn hợp lệ. Adapter schema error giữ SHA-256 + type của các field mong đợi, không giữ payload value. Journal giữ các trường này và tool arguments/error.
- INC-006: automatic category được tách khỏi `diagnosedCause`; candidate incident ID chỉ là gợi ý tra cứu, không tự kết luận regression.
- Core README có hướng dẫn cài `@alpha`, sử dụng controller, lifecycle, public exports và ownership adapter. Changelog/lockfile/version của hai repo đã cập nhật.

Kết quả: core 107/107 PASS; CLI unit 118/118 PASS; integration 88 PASS + 1 SKIP; e2e 44/44 PASS; CLI build PASS. Evidence nằm trong [incident register](TEST_FAILURE_ANALYSIS.md#triển-khai-alpha2-sau-audit-wzk499-19092026-2245-0700). Trạng thái là **OFFLINE VERIFIED**, chưa phải LIVE VERIFIED.
