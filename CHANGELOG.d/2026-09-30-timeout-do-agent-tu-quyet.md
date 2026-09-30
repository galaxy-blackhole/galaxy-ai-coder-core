# 2026-09-30 — Agent tự quyết timeout của lệnh, host chỉ giữ backstop suy ra từ lựa chọn đó

Vùng: tools (command.run, project.validate), runtime

## Trước
- Schema của `run_command`/`project.validate` khoá `timeoutMs` ở `maximum: 600000`, và runtime
  bọc mỗi lần dispatch bằng một hạn mức **cứng** đúng 600000ms. Model xin 600000ms cho một lệnh
  scaffolder chạy lâu hơn ⇒ hai hạn mức bằng nhau ⇒ host luôn thắng ⇒ bước chết với
  `Tool run_command did not return within 600000ms` thay vì nhận kết quả timeout để xử lý tiếp.
- Đo được: run E2E chết ở bước 1 vì đúng lý do này (`bunx orbit-cli new`).

## Sau
- **Agent tự quyết**: schema không còn `maximum`, mô tả nói rõ phải chọn theo lệnh (scaffolder,
  typecheck + verify, test dài cần vài phút), mặc định 120000ms; executor truyền thẳng giá trị
  model chọn, không kẹp.
- **Host chỉ giữ backstop suy ra**: `dispatchGuardMs(requested) = requested + 60s` (mặc định
  `120s + 60s`), nên timeout của chính tool luôn nổ trước và trả kết quả bình thường; hạn cứng
  duy nhất còn lại là deadline của run (`--run-minutes`), và port lệnh vốn đã tự kẹp theo deadline.
- Thêm `description` (tuỳ chọn) vào schema `run_command` để lệnh có mô tả ngắn hiện trong transcript.

## Test hồi quy
- `test/tool-timeouts.test.ts`: guard suy ra từ timeout agent chọn (600s → 660s, 900s → 960s), và
  trường hợp không truyền timeout thì dùng mặc định + head-room.
