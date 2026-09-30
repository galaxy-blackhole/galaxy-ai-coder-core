# 2026-10-01 — Mutation không xác minh được là lỗi tool retryable, không giết bước

Vùng: host (tool executor)

## Trước
- Khi evidence của một mutation không áp được (workspace đổi giữa hai lần chụp snapshot, ví dụ
  `npm install`/build chạy nền), executor ném `UnknownSideEffectOutcomeError` — một `Error` thường.
  Runtime đọc đó là **unknown outcome** và **dừng cả run**.
- Đo được trên flow đối chứng NestJS + Vite: mất 3 bước — `s02` (`validate_project`),
  `s05` (`write_file`), `s11` (`edit_file`) — dù công việc của các bước đó đã làm xong.

## Sau
- `UnknownSideEffectOutcomeError` trở thành lớp con của **`ToolAdapterError`** với
  `code = "CONFLICT"`, `retryable = true`, và thông điệp nói rõ: *"Việc ghi có thể đã xảy ra một
  phần: hãy đọc lại file để kiểm tra rồi thử lại."*
- Nhờ vậy model **đọc được lỗi và tự retry**, đúng kênh lỗi tool bình thường của executor; run
  không còn bị giết vì một mutation chưa xác minh được.
