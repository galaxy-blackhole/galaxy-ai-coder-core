# Galaxy Agent Platform — kế hoạch phát triển

Ngày bắt đầu: 2026-09-23. Trạng thái: **P1 nền tảng đã triển khai và kiểm chứng; các phase rollout/memory nâng cao theo TODO**.

## 1. Mục tiêu và quyết định đã được đồng ý

- `galaxy-ai-coder-core` trở thành nền tảng agent dùng chung cho CLI, VS Code và Quasar.
- Coding là một profile trên runtime chung; các bảo đảm về chỉnh sửa code, validation và resume vẫn được giữ.
- `galaxy-code` trở thành sản phẩm terminal có CLI không tương tác và TUI.
- Lab deterministic/live/replay chuyển về repo core và có entrypoint riêng.
- MCP, skills, memory có contract chung; I/O thực hiện ở adapter. UI không tự triển khai agent loop.
- Giữ tên repo, npm package và workflow trusted publishing hiện có. Chưa cần tạo repo/package npm mới để chia module.
- Không gộp hoặc sửa luồng release của Orbit/Nebula trong công việc này.

## 2. Hiện trạng đã kiểm tra

Core hiện có run controller, tool registry, prompt assembly, context manager, checkpoint, completion gate và host ports. Code vẫn thiên về coding ở identity, prompt modules và completion evidence.

CLI hiện là executable lab: `src/lab`, `src/live`, `fixtures`, `live/scenarios`, provider Ollama và Node host adapters. Nhiều bài test có tên live dùng HTTP mock; chúng không phải bằng chứng đã gọi model thật.

Quasar có Memory Tree Python/SQLite/FTS5/embedding và Rust IPC. Binding dữ liệu, migration và credential đang phụ thuộc desktop. `galaxy-retrieval-core` có contract/strategy cũ, chưa phải memory service dùng chung đã tích hợp vào runtime hiện tại.

Workspace root không phải Git repository. Core và CLI đều có thay đổi chưa commit trước đợt này. Khi di chuyển phải giữ nội dung working tree, không reset về HEAD.

## 3. Ranh giới triển khai

| Phần | Trách nhiệm | Phụ thuộc được phép |
|---|---|---|
| Runtime core | Vòng lặp, context, tools, profile, skills/memory policy, cancellation, evidence | Contract thuần TypeScript |
| Node adapters | Provider, MCP client, đọc skills, filesystem/commands, durable store | Node và SDK tích hợp |
| Lab | Fixture, evaluator, record/replay, reference host, báo cáo | Core + cùng adapter sản phẩm sử dụng |
| CLI application | Cấu hình, vòng đời session, composition, CLI output | Core + Node adapters |
| TUI | Input, stream, trạng thái, tool activity, approval, session commands | Application events |

Ban đầu Node adapters dùng subpath export riêng trong package core hiện tại. Root import của core không tải Node, MCP SDK, SQLite hay React. Build/package cần kiểm tra ranh giới này. Tách package/repo độc lập là bước phát hành sau, khi có nhu cầu thật.

## 4. Nghiên cứu TUI và lựa chọn

Nguồn chính đã đối chiếu ngày 2026-09-23:

- assistant-ui Ink: https://www.assistant-ui.com/docs/ink?platform=ink
- Custom backend: https://www.assistant-ui.com/docs/ink/custom-backend
- Gemini CLI package: https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/package.json
- Codex Rust TUI: https://github.com/openai/codex/blob/main/codex-rs/tui/Cargo.toml
- OpenCode: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/package.json

Gemini CLI dùng hệ React/Ink; Codex dùng Rust/Ratatui/Crossterm; OpenCode dùng OpenTUI/Solid. Các lựa chọn đều có thể xây agent terminal, nhưng React/Ink phù hợp nhất với code TypeScript hiện tại và tránh thêm runtime ngôn ngữ mới.

Chọn React + Ink và đánh giá/tích hợp `@assistant-ui/react-ink` cho composer/message primitives. Tài liệu hiện có API nối backend riêng. Không sử dụng UI runtime làm nơi điều phối tool loop. Core/application sở hữu execution; assistant-ui chỉ nhận/sản xuất UI state.

### Tiêu chí TUI

- Có input rõ ràng, model/provider hiện tại, trạng thái running/completed/failed/canceled.
- Streaming không làm mất input, không tự thực thi tool lần thứ hai.
- Enter gửi, Esc hủy lượt đang chạy, Ctrl+C hủy hoặc thoát; khôi phục terminal khi lỗi.
- Hỗ trợ Unicode, tiếng Việt, terminal hẹp và resize; trạng thái có chữ, không chỉ màu.
- Tool activity và lỗi hiển thị ngắn; output dài có giới hạn.
- Có chế độ không tương tác/JSON dành cho CI và pipe.
- UI chỉ gọi application service; cùng service được kiểm thử không cần render terminal.
- Session storage của ứng dụng là nguồn chính; không dùng file thread list không có locking của assistant-ui làm kho chia sẻ nhiều process.

## 5. Chuyển lab

1. Chụp manifest và backup working tree liên quan trước khi di chuyển.
2. Chuyển host/provider adapters sang subpath riêng của core.
3. Chuyển lab runner, fixtures, recordings và test của lab về `core/testing/`.
4. Chuyển các import lab sang adapter dùng chung; core không import galaxy-code.
5. Bổ sung entrypoint/script core để chạy lab, vẫn yêu cầu lựa chọn rõ ràng cho live provider.
6. Giữ test sản phẩm terminal tại CLI; phân biệt baseline mock, recorded replay và live thật.
7. Cập nhật runbook, source baseline và đường dẫn default sau khi di chuyển.

### Điều kiện nghiệm thu

- Lab chạy từ repo core khi CLI không nằm trong dependency graph.
- Fixtures/scenarios được bảo toàn nội dung trước di chuyển.
- Có thể chạy deterministic fixture và wire-mock provider độc lập.
- File runtime npm không chứa fixtures, recordings, secrets hoặc test harness.

## 6. MCP

### Contract

MCP client sống ở adapter. Core nhận tool definitions với ID ổn định có namespace server; mapping không phụ thuộc tên model. MCP không tự cấp trusted workspace effects.

### Đường chạy

Host config → connect stdio/Streamable HTTP → discover tools → kiểm tra schema/names → tạo tool snapshot → core gọi executor → kiểm tra quyền → SDK call → result có giới hạn → context dưới dạng dữ liệu ngoài.

### Yêu cầu

- Timeout và AbortSignal cho connect/list/call; cleanup transport khi thoát.
- Không tự chạy command MCP lấy từ repo chưa được cấu hình rõ ràng bởi người dùng.
- Mỗi server có namespace, allowlist công cụ và cấu hình nguồn quyền host.
- Tool result lỗi được chuẩn hóa; lỗi sau side effect không tự retry.
- Bảo toàn structured content; chặn output vượt hạn; không ghi credential vào transcript.
- Resources/prompts có adapter API riêng; không tự nâng thành system instructions.
- OAuth discovery/token refresh/PKCE đã có trong adapter (C07); UI đăng nhập host-native thuộc rollout G06 qua oauthProviderFactory.

### Kiểm thử

MCP server fixture cục bộ: discovery, call thành công/lỗi, namespace collision, cancellation, malformed payload, timeout, close. Không cần dịch vụ ngoài.

## 7. Skills

- Hỗ trợ chuẩn thư mục có `SKILL.md`, frontmatter name/description và tài nguyên tương đối.
- Catalog metadata được nạp trước; nội dung chỉ khi kích hoạt; tài nguyên chỉ khi cần.
- Scope explicit: user và workspace; đường dẫn canonical, không đọc vượt root qua traversal/symlink.
- Duplicate names có lỗi rõ ràng hoặc qualified ID; không ghi đè âm thầm.
- Nội dung có hash/version để biết skill đổi giữa hai lượt.
- Skill không trực tiếp cấp quyền shell/network. Script được thực thi qua host tool policy.
- Cho phép chọn skill chủ động và tool load skill theo catalog; trace ghi skill ID/hash đã nạp.
- Giới hạn số skill, byte mỗi file, catalog và tổng context.
- Tests: YAML hợp lệ/sai, Unicode, collision, traversal, symlink, lazy read và runtime nhận đúng skill.

## 8. Long-term memory

### Mô hình dữ liệu

Tách run checkpoint, episode, decision/preference/lesson và code index. Memory record có ID, scope, kind, text/summary, source, created/updated time, revision, status, supersedes và điều kiện áp dụng. Dữ kiện code có hash/anchor khi có thể kiểm chứng.

### Storage và phạm vi

- Store dùng chung theo host/user, phân vùng bắt buộc theo repository và worktree khi cần.
- SQLite/FTS là baseline local; transaction, concurrent writers, schema version, retention và forget cần được kiểm thử.
- Không dùng đường dẫn desktop cố định làm contract. Không buộc mở Quasar để CLI đọc memory.
- Cài đặt SQLite thuộc adapter, core chỉ biết MemoryPort.
- Không đưa dữ liệu ký ức cá nhân hoặc DB vào git/npm.

### Read path

Xác định scope từ host → lọc quyền/scope → tìm exact/lexical → chọn hit theo ngân sách → kiểm tra stale/superseded → nạp nguồn chi tiết nếu cần → đưa vào context như lịch sử có nguồn.

### Write path

Sự kiện hoặc yêu cầu remember → kiểm tra nguồn → tạo candidate → redaction → dedupe/idempotency → persist revision → index. Bản ghi do model tự rút ra là candidate, không tự trở thành quy tắc người dùng. Ghi nhớ quyết định explicit của người dùng phải giữ provenance riêng.

### Tính đúng

- Quyết định mới có thể supersede bản cũ, giữ lịch sử nhưng recall mặc định chỉ lấy bản hiệu lực.
- Forget phải có hiệu lực với các đường retrieval và dữ liệu dẫn xuất do hệ thống sở hữu.
- Memory không cấp approval và test cũ không làm task mới đạt completion gate.
- Recall rỗng khác với lỗi storage; timeout/offline fallback phải hiển thị trong trace.
- Tự động tổng hợp chạy nền cần lịch, ngân sách và chống tự củng cố; không coi số lần recall là chứng minh đúng.

### Nguồn tham khảo

- Graphify: https://github.com/Graphify-Labs/graphify — code graph/provenance và reflection.
- Codebase Memory MCP: https://github.com/DeusData/codebase-memory-mcp — incremental index và generation.
- OpenHuman memory split: https://github.com/tinyhumansai/openhuman/blob/main/crates/openhuman-core/src/memory/README.md
- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- Codex memories: https://learn.chatgpt.com/docs/customization/memories
- Graphiti: https://github.com/getzep/graphiti — temporal validity.

Baseline cần dùng được trước khi thêm embedding/graph reranking. Tái sử dụng semantics từ nghiên cứu và Memory Tree hiện tại; migration dữ liệu Quasar phải có backup, kiểm tra scope và không làm mất dữ liệu. Không import nguyên engine desktop vào runtime core.

## 9. Profile và tính tương thích

Profile coding giữ các kiểm tra workspace/write/validation/diff đang có. Profile assistant/research chọn prompt và completion requirements phù hợp, vẫn giữ tool correlation, cancellation, token/deadline budget và policy. Public exports cũ còn hoạt động; API mới là additive.

Provider-specific thinking nằm ở adapter/config. UI nhận capability để hiển thị lựa chọn hợp lệ. Test live phải ghi provider, model, settings và phiên bản adapter; không giả định mọi model có cùng thang thinking.

## 10. Validation và phát hành

1. Typecheck/build core và CLI.
2. Core regression suite; lab deterministic/wire mock/replay.
3. MCP local protocol test, skills filesystem boundary tests, memory persistence/scope/concurrency tests.
4. CLI pipe/JSON tests; TUI render/input/cancel và PTY smoke.
5. `npm pack --dry-run`: package boundaries, không kéo lab hoặc dữ liệu cá nhân vào npm.
6. Một live smoke với model đã cấu hình khi môi trường khả dụng; báo riêng nếu provider không chạy được, không đánh dấu mock là live.
7. `graphify update .` từ workspace root sau sửa code.
8. Release chỉ sau checks; giữ bindings trusted publishing. Version/release cần phản ánh package thực sự tương thích, không tự đánh dấu mọi phase hoàn thành.

## 11. Tiến độ

Theo dõi tại [GALAXY_AGENT_PLATFORM_TODO.md](GALAXY_AGENT_PLATFORM_TODO.md). Mỗi mục chỉ đánh dấu hoàn thành khi có implementation và bằng chứng kiểm thử; các mục future không được tính vào phần đã giao.

## 12. Phạm vi đã triển khai ngày 23/09

- 15 adapter production chuyển từ CLI vào core subpaths; `NodeToolExecutor` dùng chung, deterministic doubles chỉ nằm trong lab private.
- Toàn bộ lab source/test/scripts/fixtures/live/campaigns/docs chuyển về `galaxy-ai-coder-core/testing`. Manifest đối chiếu xác nhận 47 fixture/scenario/recording nguyên byte.
- Core có `agent` contracts, composition executor, `contextData` có giới hạn/trust envelope, và assistant/research profile với completion mặc định phù hợp. Coding profile giữ gate cũ.
- MCP stdio + Streamable HTTP đã thực sự connect/list/call, kiểm tra schema qua SDK, cấp quyền trước dispatch, abort/deadline và đóng kết nối. Resources/prompts có API; chưa có màn hình quản lý/OAuth.
- Skills có catalog user/workspace, namespace, YAML frontmatter, content/resource loading, hash/path/size bounds. Chưa có marketplace/install/update.
- Memory v1 có SQLite/FTS5, scope do host ràng buộc, source/hash/revision/status/trust, dedupe, optimistic concurrency, candidate/confirm, recall/forget. `key + revision + status` biểu diễn supersession; kind/conditions/source commit anchors và graph vẫn là bước sau.
- CLI/TUI có thực thi thật qua core, activity/approval/status, input tiếng Việt, cancellation, JSON mode, conversation session và các lệnh skills/memory/MCP. `--session` phục hồi hội thoại; chưa phải resume execution checkpoint trong sản phẩm CLI.
- Provider đang chạy: Ollama/local/cloud với cấu hình sẵn có và thinking do adapter xử lý. Không coi đây là đã viết xong direct SDK adapters cho Gemini/Claude/DeepSeek.
- Không đổi version/npm identity/repo/workflow publisher identity. Chưa push/publish. Trước khi release CLI độc lập phải thay dependency `file:../galaxy-ai-coder-core` bằng version core đã publish tương thích.

## 13. Phân kỳ tiếp theo và điều kiện qua cổng

| Giai đoạn | Công việc | Điều kiện nghiệm thu |
|---|---|---|
| P1 nền tảng (đợt này) | Core ports/adapters, private lab, CLI/TUI, MCP/skills/memory v1 | Typecheck/build/test; mock protocol; live lab; PTY; npm boundaries |
| P2 host rollout | VS Code port bindings, Quasar IPC adapter, giữ UI riêng | Cùng bộ conformance chạy trên từng host; không phụ thuộc CLI; rollback từng host |
| P3 memory nâng cao | Typed notes/conditions, source revision, stale code invalidation, Graphify/CBM adapter; migration desktop | Recall benchmark với corpus có nhãn; không trộn scope; migration dry-run/backup/rollback, forget lan đến index |
| P4 providers và trải nghiệm | Direct providers, capability/model/thinking picker, MCP OAuth/resources UI, session manager | Contract tests theo provider, retry/cancel/rate-limit, không chung một thang thinking giả định |
| P5 khai thác dài hạn | Background consolidation, embedding/hybrid ranking, temporal relations, retention | So sánh lexical baseline, budget/latency đo được, chống tự củng cố thông tin sai |

### Benchmark memory trước khi chọn graph/vector engine

1. Tạo corpus có decision, preference, lesson, code facts, nguồn lỗi thời và dữ liệu scope khác; đánh dấu câu trả lời đúng bằng tay.
2. Đo Recall@5/10, precision, tỷ lệ stale recall và cross-scope leakage, p50/p95 latency, số token đưa vào model.
3. So sánh FTS baseline với embeddings/hybrid/graph trên cùng corpus và cùng token budget; không chọn graph vì số node lớn.
4. Tình huống bắt buộc: rename/delete file, amend/rebase, workspace khác, supersede decision, forget, crash giữa write/index, hai host cùng ghi.
5. Chỉ đưa backend mới vào default khi chất lượng tốt hơn, invalidation/forget đúng và có đường quay lại FTS.

### Rollout memory từ Quasar

- Liệt kê schema, version, scope và semantics hiện tại trước khi chuyển.
- Tạo backup readonly, báo cáo số row và hash kiểm kê; không sửa DB gốc trong dry-run.
- Map những hàng thiếu provenance thành candidate, không tự xem chúng là preference đã xác nhận.
- Import sang DB mới theo transaction/chunk có resume marker; giữ mapping ID cũ → ID mới.
- Kiểm tra truy vấn, supersession và forget trên bản sao; chỉ chuyển consumer sau khi đạt.
- Không bật hai hệ cùng ghi vào cùng schema chưa có concurrency contract.

### Điều kiện phát hành

Giữ nguyên trusted-publisher bindings. Release core trước; CLI pin version tương thích sau; chạy kiểm thử artifact cài từ tarball rồi mới push release commit. Bản làm việc hiện tại dùng local file dependency có chủ ý, không được coi là một bản CLI npm đã sẵn sàng cài độc lập.


## 14. Sửa TUI theo phản hồi thực tế (2026-09-24)

Mục tiêu: một màn hình terminal có header cố định, vùng giữa cuộn được và input cố định ở đáy. Thinking, nội dung trả lời và tool phải xuất hiện theo thứ tự phát sinh, không gom tool thành log riêng dưới message.

### Phân chia trách nhiệm và cách thực hiện

1. `galaxy-code/src/timeline.ts` chuyển event core thành các phần hiển thị có thứ tự. Thinking lấy từ provider, không tự suy diễn. Text/thinking cùng loại được nối theo từng lượt model; tool được định danh bằng call ID và cập nhật kết quả ngay tại chỗ.
2. Tool dùng data parts của assistant-ui, không dùng tool-call parts có thể bị UI runtime thực thi lần nữa. Core vẫn là bên duy nhất thực thi tool.
3. Tên tool thân thiện kèm command/path/check; trạng thái có chữ và màu. Exit code khác 0 hoặc project validation thất bại phải hiển thị lỗi dù transport trả kết quả thành công.
4. `tui.tsx` dùng alternate screen và kích thước stdout. Không dùng Ink Static cho lịch sử. Chỉ render các dòng nằm trong viewport; header, trạng thái, approval và input có chiều cao riêng. Resize tính lại phần giữa, không đẩy input xuống scrollback.
5. Auto-follow ở cuối khi đang chạy; PageUp tạm dừng follow, PageDown/Ctrl+G trở về cuối. Ctrl+T thu gọn thinking, Ctrl+O mở chi tiết tool. Giữ log ngắn mặc định nhưng cho phép xem kết quả tool khi cần.
6. `composer.tsx` dùng state của assistant-ui và dựng input một dòng, cuộn ngang theo con trỏ. Chia ký tự theo grapheme, đo cell width để không cắt dấu tiếng Việt/emoji. Paste được giữ ở một dòng, phím cuộn không lọt vào prompt.
7. Approval luôn hiện phía trên input; y/n chỉ giải quyết yêu cầu đang chờ. Core tạo AbortSignal riêng cho mỗi request, hủy prompt khi timeout/cancel mà không hủy toàn run. CLI chọn tối đa 5 phút; host khác giữ timeout mặc định nếu không cấu hình.
8. Thư mục không có Git: CLI không cung cấp git_operation và ghép `NodeWorkspaceReviewExecutor`. Adapter này chụp baseline trước tác vụ, trả before/after cùng hash cho thay đổi văn bản, kiểm tra tính ổn định và attestation diff-review. Không tự tạo repository, không bỏ yêu cầu validation của completion gate.

### Điều kiện nghiệm thu

- Transcript có thinking → message → tool → kết quả tiếp theo; kết quả cập nhật đúng call, không lặp final text và không thực thi tool ở UI.
- Stream/hội thoại dài, output lỗi dài, Unicode/emoji và paste dài không làm header/input trôi.
- Cuộn lên không bị stream kéo xuống; thu/phóng terminal giữ vùng nhập và approval nhìn thấy được.
- Pending approval hết hạn/abort phải đóng, không nhận quyết định muộn cho call khác.
- Tool exit nonzero được hiển thị lỗi; chi tiết đọc được qua Ctrl+O.
- Thử tạo project Node.js + node:test ở thư mục không Git đi qua validation và completion gate thực tế.
- Thoát Ctrl+C/SIGINT/SIGTERM dọn runtime và trả terminal khỏi alternate screen.

### Giới hạn hiện tại

- Cuộn bằng chuột/trackpad qua SGR mouse reporting (1000/1006) hoặc ↑/↓/PageUp/PageDown. Terminal cần bật hỗ trợ mouse reporting; không còn dựa vào scrollback của alternate screen.
- Timeline chi tiết hiện giữ trong bộ nhớ của TUI; `--session` phục hồi user/final-answer text. Persist/replay timeline có version schema, giới hạn dung lượng và chính sách retention là việc tiếp theo.
- Reviewer cho thư mục không Git giới hạn baseline text 8 MiB, từng file 128 KiB và report thay đổi 24 KiB; từ chối attestation nếu thiếu/truncated/không ổn định hoặc có special entry. Dùng Git cho các dự án vượt phạm vi này.
- TUI cần terminal ít nhất 12 cột × 8 dòng; nghiệm thu compact ở 40×8 và PTY ở 48×16. Các picker/provider/graph memory đang ở những phase riêng trong mục 13.


## 15. Streaming thật và cuộn chuột (2026-09-24)

Phản hồi người dùng đã chỉ ra hai thiếu sót của bản trước: UI nhận event streaming nhưng Ollama adapter đọc hết HTTP body rồi mới normalize, và list chỉ hỗ trợ PageUp/PageDown nên cuộn chuột không có tác dụng. Lần smoke trước chỉ chứng minh nội dung xuất hiện, chưa chứng minh delta đến trước EOF.

### Thiết kế sửa

- Đọc body dưới dạng async byte iterator; TextDecoder giữ phần UTF-8 dở dang giữa các chunk, tách NDJSON theo newline và phát event ngay. Chỉ giữ phần dòng JSON chưa hoàn tất, không giữ toàn bộ response. Giới hạn tổng response 8 MiB tiếp tục được áp dụng.
- Stateful normalizer dùng chung cho live/replay: duy trì content, thinking, usage, terminal state và tool-call IDs. Replay helper cũ vẫn dùng được. Hủy reader khi abort, lỗi byte limit, lỗi protocol hoặc consumer dừng sớm; không phát thêm một started event khi lỗi xảy ra giữa stream.
- TUI bật SGR mouse reporting trong alternate screen. Wheel/trackpad chỉ cuộn vùng giữa; click/release không thành prompt text. Arrow keys cuộn từng dòng; PageUp/PageDown cuộn từng trang. Cập nhật vị trí theo state trước đó để nhiều wheel events trong một packet không bị mất.
- Auto-follow chỉ chạy khi ở cuối; người dùng đọc lịch sử không bị token mới kéo xuống. Ctrl+G trở về cuối. Ô trạng thái có dải dòng đang xem.
- Tắt mouse reporting và khôi phục màn hình khi thoát, kể cả đường exit đồng bộ không chạy được async finally.

### Điều kiện nghiệm thu bổ sung

1. HTTP vẫn mở nhưng UI đã hiển thị thinking và text; thêm delta sau đó cập nhật tiếp, rồi mới gửi done/EOF.
2. UTF-8 bị chia giữa emoji không bị hỏng; malformed stream/cancel/byte limit vẫn có lỗi rõ ràng và giải phóng reader.
3. Wheel lên/xuống, nhiều wheel events nối nhau, ↑/↓, PageUp/PageDown đều thay đổi viewport mà giữ header/input.
4. Khi người dùng cuộn lên, gửi thêm token không làm thay đổi dòng đang đọc. Draft không nhận chuỗi mã mouse.
5. Provider thật có nhiều frame trước completion; raw PTY ghi nhận bật/tắt mouse reporting và trả alternate screen.

Tham chiếu: [Ollama streaming](https://docs.ollama.com/api/streaming), [terminal control sequences](https://xtermjs.org/docs/api/vtfeatures/). Chi tiết tương tác với phím được đối chiếu thêm với source Ink đang cài trong workspace.


## 16. Composer macOS, footer và activity indicator (2026-09-24)

### Nguyên nhân và thay đổi

1. Composer cũ vẽ caret bằng inverse text nhưng không đặt con trỏ thật của terminal. Bộ gõ tiếng Việt đặt preedit tại vị trí con trỏ sau footer, rồi mới commit vào composer khi kết thúc từ. Dùng `useCursor` của Ink để đồng bộ hàng/cột thật với cửa sổ input; cột tính bằng display width, không dùng độ dài UTF-16.
2. Ink 6.8 nhận byte DEL `0x7f` của phím Delete macOS thành `key.delete`, khiến composer xoá tiến ở cuối câu và không thay đổi gì. Pin Ink 7.1.1, tương thích peer của assistant-ui/React hiện tại, để phân biệt backspace với CSI `3~` (Fn+Delete). Không sửa trực tiếp node_modules.
3. Giữ draft/cursor refs đồng bộ trong handler để nhiều sự kiện xoá/gõ trong một packet không dùng state React cũ. Dấu kết hợp và emoji được xử lý theo grapheme.
4. Kiểm chứng PTY phát hiện Ink 7.1.1 lệch hàng caret trong nhánh render đầy chiều cao không có newline; đặc biệt con trỏ tiếp tục trôi khi chỉ di chuyển caret. Reserve một hàng trống cuối terminal cho newline, giữ header/input cố định và tránh ANSI writer cạnh tranh với Ink. Terminal cao 8 hàng dùng input không border.
5. Token context giữ ý nghĩa dữ liệu cũ, chuyển xuống cùng hàng phím tắt, căn phải; phần help co lại trước token khi màn hình hẹp.
6. Activity chỉ animate khi run còn hoạt động: Connecting → Thinking/Responding → Running tools/Validating/Review theo event thật. Spinner 120 ms và dấu chấm đổi nhịp; thành công unmount indicator/timer, không còn nhãn Hoàn tất. Lỗi, huỷ và yêu cầu quyền vẫn có phản hồi riêng.

### Nghiệm thu

- Input hiển thị đúng ô trước khi gõ space; caret thật đi cùng ký tự kể cả khi dùng ←/→, cuộn ngang input dài, resize.
- Delete xoá lùi; Fn+Delete xoá tiến; dấu ghép/emoji được xoá nguyên grapheme; delete lặp không làm mất draft.
- Footer token căn phải tại 40/100/160 cột, không tăng chiều cao khung; activity thay đổi và dừng timer sau completion.
- Giữ regression HTTP streaming, scroll giữ vị trí, approval và keyboard shortcuts.
- `scripts/verify-tui-input.py` kiểm tra PTY thật với emulator pyte; OS IME không được tự động điều khiển, vì vậy kết quả này xác nhận terminal protocol/caret và committed Unicode, không phải kiểm chứng thủ công mọi bộ gõ macOS.

Tham chiếu: [Ink useCursor](https://github.com/vadimdemedes/ink#usecursor), [Ink 7 sửa phân biệt Backspace/Delete](https://github.com/vadimdemedes/ink/releases/tag/v7.0.0).

## 17. Bundle MCP/skills, E06 migration và C07 OAuth (2026-09-24)

### Quyết định

1. galaxy-code mặc định nạp 2 MCP server first-party (`orbit`, `nebula`) bằng `npx -y @galaxy-stack/...`; `--no-galaxy-mcp` tắt hoàn toàn. Config người dùng ghi đè mặc định.
2. 2 skill `orbit-framework` (từ orbit-mcp) và `galaxy-ui` (từ galaxy-design) đóng gói vào `galaxy-code/skills/`, scope `bundled/`, lazy load như skill thường.
3. Memory desktop (Quasar Memory Tree) chuyển qua `blackhole memory import-quasar <db>`: luôn backup nguồn vào `<state-dir>/import-backups/`, chỉ đọc bản sao, import leaf active thành confirmed với provenance `quasar:<source>`, key ổn định theo source_ref, idempotent.
4. OAuth MCP: dùng SDK flow (RFC 9728 discovery, dynamic registration, PKCE, refresh); callback localhost chạy trong FileOAuthProvider; `blackhole mcp login/logout` quản trị; token 0600. UI host-native để dành cho G06 qua oauthProviderFactory.

### Sửa lỗi phát hiện

- orbit-mcp 0.1.2 trên npm mất shebang → shell thực thi bundle như bash, MCP handshake chết. Build thêm guard script, publish 0.1.4 (trusted publishing), galaxy-code kết nối lại được.
- McpAgentClient.login mất provider khi reconnect (chỉ truyền 3 đối số) → sau login client vẫn không mang token. Đã truyền provider vào open() thứ hai.
- FileOAuthProvider getter sync đọc listener trước khi bind xong → race crash. Callback giờ khởi động trong constructor, mọi method async chờ `ready`, close() trả port.

### Nghiệm thu

- Live: `blackhole mcp` kết nối orbit (scaffold/graphql/security tools) + nebula (component/coverage tools); `blackhole skills` thấy và load 2 skill bundle.
- Core 123/123 (2 test OAuth mới: E2E fixture cục bộ + lưu trữ 0600/clear); CLI 17/17 kèm 2 test migration fixture; typecheck + build qua cả hai repo.
- E06 live với `~/.galaxy/desktop/memory/memory.db`: 15 notes imported, backup lưu, FTS recall được, chạy lại 0 imported/15 skipped.
- Chưa push/publish galaxy-code; orbit-mcp đã push và CI publish 0.1.4 thành công.
