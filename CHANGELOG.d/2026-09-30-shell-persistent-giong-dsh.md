# 2026-09-30 — Shell persistent cho run_command, giống DeepSeek Harness

Vùng: host (command port), runtime

## Trước
- Mỗi lệnh `run_command` spawn một tiến trình mới: `cd`/biến môi trường không giữ, tiến trình nền
  (dev server, watcher) chết cùng lệnh, và không có gì dọn chúng khi bước kết thúc — đo được cảnh
  `vite`/`bun run dev` còn sống sót qua nhiều run và tranh chấp với run sau.
- Interface `CommandSessionPort` (start/read/write/interrupt/kill/list) đã có trong core nhưng
  **chưa có implementation** nào ở host; tool `manage_session` chỉ chạy được với contract double.

## Sau
- Thêm `PersistentShell`: **một shell cho mỗi run**, đúng mô hình `@deepseek-ai/dsh-tool-bash-persistent`:
  - lệnh chia sẻ `cwd`, biến đã `export`, và tiến trình nền; các lệnh **tuần tự hoá**;
  - `timeoutMs` vẫn là **maximum**: xong sớm trả sớm; chạm trần thì **kill shell + trả partial**
    và lần chạy sau bắt đầu shell mới (reset), đúng như harness;
  - chỉ `cd` khi caller truyền `cwd` — không có `cwd` thì lệnh chạy ở nơi lệnh trước để lại;
  - stdout/stderr **gộp một luồng** như tool bash của harness.
- `NodeCommandPort` dùng shell này khi command containment không bắt buộc (macOS/best-effort),
  và có `dispose()`; CLI gọi `dispose()` khi run kết thúc nên **mọi thứ bước đó khởi động đều bị dừng**.
- Profile containment `required` giữ nguyên đường spawn một lần (không thể host shell dùng chung).

## Test hồi quy
- `test/persistent-shell.test.ts`: cwd/biến/tiến trình nền giữ qua các lệnh; lệnh chạm trần bị kill
  và trả partial rồi shell được reset.
