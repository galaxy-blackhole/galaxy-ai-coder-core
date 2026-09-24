# Galaxy Agent Platform — TODO và tiến độ

Ngày: 2026-09-23. Trạng thái: đang triển khai.

## Quy tắc theo dõi

`[x]` hoàn thành và có bằng chứng; `[ ]` chưa hoàn thành. Ghi rõ mock/live. Kế hoạch: [GALAXY_AGENT_PLATFORM_PLAN.md](GALAXY_AGENT_PLATFORM_PLAN.md).

## A. Kiến trúc và baseline

- [x] A01 Đọc core/CLI hiện tại, xác định lab và dependency adapters.
- [x] A02 Đối chiếu assistant-ui Ink, Gemini CLI, Codex TUI, OpenCode.
- [x] A03 Viết kế hoạch chi tiết, ranh giới và tiêu chí nghiệm thu.
- [x] A04 Ghi baseline tests và bảo toàn working tree trước khi di chuyển.

## B. Lab và adapter dùng chung

- [x] B01 Tách Node host/provider thành adapter subpaths, root core vẫn trung lập.
- [x] B02 Chuyển fixture/live runners, scenarios và tests vào core/testing.
- [x] B03 Lab có scripts/entrypoint độc lập; CLI không là dependency của core.
- [x] B04 Cập nhật runbook, default paths, source-baseline và migration map.
- [x] B05 Chạy regression suite, fixture và wire-mock sau di chuyển.
- [x] B06 Kiểm tra npm artifact không chứa testing/scenarios/recordings.

## C. MCP

- [x] C01 Contract tool source/executor và stable namespace.
- [x] C02 Adapter SDK stdio và Streamable HTTP; close/cancel/timeout.
- [x] C03 Discovery, schema validation, output/error bounds, permissions.
- [x] C04 Nối MCP tools vào agent runtime và CLI config.
- [x] C05 Test server local end-to-end.
- [x] C06 Resources/prompts adapter API và trust boundary.
- [x] C07 OAuth lifecycle: SDK discovery + dynamic client registration + PKCE + auto-refresh; `blackhole mcp login/logout`; token 0600 trong state dir. UI host-native (VS Code/desktop) dùng oauthProviderFactory khi rollout G06.

## D. Skills

- [x] D01 Metadata/content contracts, catalog và lazy activation.
- [x] D02 Loader SKILL.md, scope, collision, traversal/symlink protection.
- [x] D03 Nối catalog/load vào runtime và CLI.
- [x] D04 Tests metadata/path/size/hash bounds và runtime registration của skill tools.
- [ ] D05 Marketplace/install/update và UI quản lý đa host (giai đoạn mở rộng).

## E. Memory

- [x] E01 MemoryPort, scoped records, source/revision/supersession.
- [x] E02 Durable SQLite/FTS adapter và schema v1 initialization (migration Quasar tách ở E06).
- [x] E03 Query/remember/forget và bounded recall trong agent.
- [x] E04 Kiểm thử restart, scope isolation, supersede, concurrency và forget.
- [x] E05 CLI controls đọc/ghi/confirm/forget memory theo workspace; tự recall cho session.
- [x] E06 `blackhole memory import-quasar <db>`: backup nguồn vào state dir, import leaf active thành confirmed kèm provenance, idempotent khi chạy lại; đã chạy với memory.db thật (15 notes, backup giữ nguyên bản gốc).
- [ ] E07 Graphify/CBM backend evaluation và stale-code invalidation.
- [ ] E08 Background consolidation, embeddings và hybrid ranking có benchmark.

## F. CLI/TUI

- [x] F01 Application service ghép core và adapters; không dùng lab runner cho chat.
- [x] F02 CLI task input, JSON/text output, cancellation và error exit.
- [x] F03 Ink/assistant-ui bridge, composer, messages và streaming.
- [x] F04 Tool activity, approval, status, context/model và keyboard controls.
- [x] F05 Durable sessions và commands memory/skills.
- [x] F06 Tests render, input, stream, cancel, resize và PTY smoke.
- [ ] F07 Provider/model/thinking picker đầy đủ theo capability (giai đoạn mở rộng).
- [x] F08 Fullscreen alternate screen, header/input cố định, viewport cuộn và resize.
- [x] F09 Timeline có thứ tự cho thinking/message/tool; nhãn command/path và badge kết quả.
- [x] F10 Approval luôn nhìn thấy, timeout/cancel đóng prompt; input Unicode cuộn ngang.
- [x] F11 Ctrl+T thinking, Ctrl+O chi tiết tool, PageUp/PageDown và Ctrl+G.
- [x] F12 Scratch workspace không Git: baseline review adapter, validation và completion gate giữ nguyên.
- [x] F13 Regression tests + PTY live coding end-to-end theo lỗi người dùng báo.
- [ ] F14 Persist/replay timeline chi tiết theo session, schema version và retention.
- [x] F15 Mouse/trackpad scrolling, ↑/↓ và giữ vị trí khi stream; dọn mouse mode lúc thoát.
- [ ] F16 Điều hướng/mở chi tiết từng tool riêng biệt.
- [x] F17 Streaming từ HTTP đến UI trước EOF, incremental UTF-8/NDJSON, cancellation và regression tests.

## G. General agent profiles và bàn giao

- [x] G01 Coding compatibility và profile assistant/research.
- [x] G02 Typecheck/build/test core, lab và CLI.
- [x] G03 Ghi kết quả live smoke riêng với deterministic/wire mock.
- [x] G04 Cập nhật README, docs, TODO theo thực tế, kiểm tra package.
- [x] G05 Cập nhật graphify: 58.003 nodes, 81.722 edges, 3.717 communities; AST-only.
- [ ] G06 VS Code/Quasar consume API mới và conformance (giai đoạn rollout đa host).

## Nhật ký kiểm chứng

Các kết quả được phân biệt giữa kiểm thử tự động, giao thức mock và provider thật bên dưới.

### Kết quả ngày 2026-09-23

| Nhóm | Kết quả |
|---|---|
| Baseline trước di chuyển | Core 112/112 |
| Core sau triển khai | 119/119; typecheck/build/dist smoke qua |
| Private lab unit | 120/120 |
| Private lab integration | 88/88 |
| Private lab E2E | 44/44; gồm crash/resume/research protocol fixtures |
| CLI/TUI mới | 7/7; typecheck/build qua |
| Live lab | `01-write-and-validate` với Ollama `glm-5.3-flash:cloud`: passed=true, completed, failures=[] |
| TUI live | PTY gửi tiếng Việt → nhận “Xin chào.” từ provider thật, completed; Ctrl+C thoát |
| Migration data | 47 fixture/scenario/recording đối chiếu nguyên byte |
| Publish | Chưa push/publish; không đổi publisher/repo/npm identity |

Backup trước migration có 243 file và working-tree diff; vị trí local được ghi trong `.agent-migration-backup` cùng thư mục này. Lab regression logs ở `galaxy-ai-coder-core/testing/.galaxy/audit/`; core test journal ở repo core. Không commit log/DB cá nhân vào npm.

### Phần chưa đánh dấu xong có chủ ý

- D05/E07–E08/F07/G06 là các phase mở rộng có điều kiện nghiệm thu trong kế hoạch, không phải API đã hoạt động. C07 đã giao lifecycle + CLI login/logout; màn hình OAuth/resources riêng trong TUI chưa có.
- UI quản lý memory/resources/prompts trực tiếp trong TUI, production checkpoint resume, direct provider adapters, graph/embedding retrieval và migration Quasar chưa được tính là đã giao.
- Bản TUI hiện tại là giao diện vận hành cơ bản; chưa có slash command palette, sidebar session, multi-tab hay provider picker.

- PTY tự động: resize từ 80 xuống 40 cột, kiểm tra border 38 ký tự, Esc cập nhật trạng thái huỷ, Ctrl+C thoát mã 0. Transcript smoke lưu tại `/tmp/galaxy-tui-resize-smoke.txt`.
- Npm dry-run: core và CLI không chứa `testing/`, fixture, recording, SQLite DB hay output lab cũ; CLI sau clean build có 23 file artifact.

- Runtime extension smoke: `skill.list → skill.load → memory.remember → memory.search` chạy qua cùng agent loop, tất cả tool result thành công; candidate không xuất hiện trong recall mặc định.
- Root/agent import closure: kiểm tra 49 module compiled, không kéo Node/MCP/SQLite/React vào entrypoint thuần core.
- Graphify hoàn tất. Giới hạn công cụ: 12 file SQL không được parser vì thiếu `tree_sitter_sql`; 8 file ở phần khác workspace chỉ parse một phần do syntax. Không sửa các file ngoài phạm vi đợt này.


### Kết quả sửa TUI ngày 2026-09-24

- Core: `npm run verify` qua, 121/121 test (gồm timeout đóng approval và workspace review).
- CLI: `npm run check` qua, 12/12 test. Có kiểm thử trình tự thinking/tool, exit code khác 0, thao tác approval, input dài, resize và viewport 40×8.
- Private lab: 16/16 test `lab-tool-executor.test.ts` qua; Git review, approval và evidence cũ giữ hành vi.
- Live PTY với Ollama `glm-5.3-flash:cloud`, thinking bật: tạo 3 file dự án Node.js trong thư mục không Git; validation chạy 6/6 test pass; final report được lưu và run completed.
- PTY xác nhận thinking, approval ở đáy, scroll lịch sử, resize 110×30 → 48×16, Ctrl+T/Ctrl+O/Ctrl+G và Ctrl+C thoát mã 0; alternate screen được khôi phục.
- Evidence local: `/var/folders/1k/56z811sj31zfd6xkvg4r65vm0000gn/T/galaxy-tui-final-l79zgb85/` (`result.json`, `completed.txt`, `resized.txt`, `terminal.ansi`, final report trong state/runs). Không đưa transcript/provider output vào npm.
- Lần thử trước dừng vì bộ điều khiển QA hết thời gian chờ trước khi duyệt test; không tính đó là một lần live completed. Một lần QA khác bắt frame chưa vẽ xong đã được sửa cách chờ frame rồi chạy lại.
- Chưa push/publish; không thay repo, npm identity hay trusted-publisher bindings.
- Graphify AST update hoàn tất: 58.115 nodes, 81.898 edges, 3.706 communities. Cảnh báo parser SQL và syntax ở phần khác workspace vẫn như lần trước.


### Sửa streaming và scrolling theo phản hồi tiếp theo (2026-09-24)

- Root cause xác nhận bằng source: `readNdjson` chờ toàn bộ body trước khi phát events; viewport trước đó không bật mouse protocol. Đã thay bằng incremental reader + normalizer dùng chung live/replay và SGR mouse reporting.
- Core verify: 121/121 qua; provider transport: 13/13; normalizer: 7/7; recorded replay: 1/1. Private lab typecheck qua.
- CLI check: 13/13 qua. Test HTTP→core→Ink giữ response mở, xác nhận thinking/text xuất hiện trước EOF, mouse cuộn giữ dòng đang đọc trong khi delta mới đến và không làm hỏng draft.
- Live Ollama `glm-5.3-flash:cloud` với thinking off để đo text: partial frame đầu ở 7,48 giây; 60 frame khác nhau trước completed ở 14,04 giây. Wheel lên/xuống, draft, Ctrl+G và Ctrl+C đều qua; mouse mode được tắt và alternate screen được khôi phục.
- Evidence local: `/var/folders/1k/56z811sj31zfd6xkvg4r65vm0000gn/T/galaxy-stream-scroll-_sqb5j8d/`. Bài thử dài với thinking on được dừng trước completion, không tính là run completed; test streaming thinking trước EOF đã được kiểm chứng bằng HTTP giữ mở.
- Kiểm tra PTY riêng cho SIGTERM và SIGINT: cả hai đều tắt mouse reporting và khôi phục alternate screen khi thoát. CLI typecheck/build và diff whitespace check cuối cùng qua.
- Graphify AST update hoàn tất sau sửa: 58.134 nodes, 81.926 edges, 3.719 communities; cảnh báo parser ngoài phạm vi giữ nguyên.


### Composer và activity theo ảnh phản hồi (2026-09-24)

- [x] F18: Native caret cho IME, Delete/Fn+Delete, grapheme và packet nhiều thao tác nhập.
- [x] F19: Token căn phải footer; spinner + text động theo stage; ẩn activity thành công và dọn timer.
- [x] F20: Regression Unicode/delete/animation/footer; PTY caret ở màn hình thường, hẹp và rất thấp, cộng cleanup khi thoát.
- [ ] Kiểm chứng thủ công preedit với bộ gõ tiếng Việt đang bật trong iTerm2 của người dùng; automation hiện kiểm chứng terminal protocol và committed Unicode.
- CLI `npm run check`: typecheck, 15/15 test và build qua; `git diff --check` sạch. Dependency peer Ink 7.1.1 / React 19.3 / assistant-ui 0.0.44 hợp lệ.
- PTY 14 checkpoint qua: input trước space, DEL/Fn+Delete, caret trái, emoji/dấu kết hợp, nhiều delete trong packet, input dài, resize 110×30 → 40×16 → 40×8 → 110×30; Ctrl+C khôi phục terminal. Evidence: `/var/folders/1k/56z811sj31zfd6xkvg4r65vm0000gn/T/galaxy-input-cursor-m2sphvql/`.
- Chưa push/publish trong đợt sửa UI này.

### Bundle MCP/skills, E06 migration và C07 OAuth (2026-09-24)

- Tích hợp sẵn 2 MCP server (`orbit`, `nebula` qua npx, tắt bằng `--no-galaxy-mcp`) và 2 skill bundle (`bundled/orbit-framework`, `bundled/galaxy-ui`). Live verify: `blackhole mcp` liệt kê tool của cả hai server; `blackhole skills` thấy 2 skill và load nội dung.
- orbit-mcp 0.1.2 trên npm hỏng bin (mất shebang, shell chạy JS như bash). Sửa build (banner + `scripts/fix-bin-shebang.mjs`), publish 0.1.4 qua CI trusted publishing; npx -y hoạt động lại, galaxy-code kết nối OK.
- C07: sửa lỗi reconnect sau login (provider không được truyền lại), viết lại FileOAuthProvider khởi động callback server trong constructor với `ready` promise (hết race getter sync), thêm close() trả port; test E2E fixture OAuth cục bộ: 401 discovery, đăng ký client, PKCE, đổi token, reconnect kèm Bearer, token 0600, clear/logout.
- E06: `blackhole memory import-quasar` tạo backup nguồn, import leaf active thành confirmed với provenance `quasar:<source>`, key ổn định từ source_ref, bỏ trùng/superseded, chạy lại không nhân bản. Live với `~/.galaxy/desktop/memory/memory.db`: 15 notes imported, FTS recall được, chạy lại 0 imported/15 skipped; bản gốc chỉ đọc qua bản sao backup.
- Core verify 123/123; CLI check 17/17 + typecheck/build. Xoá `test/oauth-flow.test.ts` (phiên cũ treo vì hostname giả) và gộp assertion 0600/clear vào `test/mcp-oauth.test.ts`. Chưa push/publish galaxy-code trong đợt này.
