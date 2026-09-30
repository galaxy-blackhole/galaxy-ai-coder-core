# 2026-09-30 — Timeout của run_command theo đúng cơ chế DeepSeek Harness

Vùng: host (command port), tools

## Bối cảnh
Đọc `@deepseek-ai/dsh-tool-bash-persistent` và `@deepseek-ai/dsh-tool-call-timeout-policy`:
- Tool `bash` có **một** tham số `command`; `timeoutMs` là **config của tool**, mặc định **300000ms (5 phút)**.
- Khi chạm trần: **kill và reset shell**, trả về partial output kèm câu
  *"Your command timed out after N seconds or experienced an OOM error. Below is partial output:"*
  và marker `[Command timed out or OOM]`.
- Policy của wrapper: *"A tool declares timeoutMs and promises to honor exec.signal; this wrapper
  arms that deadline and maps its own expiry to TOOL_TIMEOUT **without racing or abandoning the tool
  promise**"* — tức wrapper chỉ là backstop **cùng mốc**, không đua với tool.

## Thay đổi
- `DEFAULT_TIMEOUT_MS` của command port: **120000 → 300000**, khớp DSH.
- Tóm tắt kết quả khi lệnh bị kill đổi thành đúng thông điệp DSH:
  `Command timed out after <duration>s. Below is partial output:` (kèm stdout/stderr một phần,
  `timedOut: true`), thay vì `Command timed_out with exit code -1.`.
- Guard của runtime giữ nguyên nguyên tắc DSH đã đối chiếu: **suy ra từ timeout của chính tool**
  (requested + 60s) nên tool luôn trả kết quả trước; hạn cứng duy nhất là deadline của run.

## Ghi chú
- Khác biệt còn lại so với DSH: DSH dùng **shell persistent** (một shell sống qua nhiều lệnh, có
  session/queue theo agent); Galaxy hiện spawn tiến trình mới cho mỗi lệnh. Đây là hạng mục riêng,
  cần thêm port + wiring + test nếu muốn parity đầy đủ.
