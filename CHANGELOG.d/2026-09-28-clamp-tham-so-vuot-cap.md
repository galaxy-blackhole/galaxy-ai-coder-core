# 2026-09-28 — Clamp tham số vượt cap thay vì từ chối tool call

Vùng: tools/adapter

## Trước
- `run_command` với `timeoutMs` > 600000 trả `INVALID_TOOL_ARGUMENTS`
  (`$.timeoutMs lớn hơn maximum=600000.`): cả lệnh không chạy, mất một lượt model,
  dù host luôn tự chặn ở 10 phút.

## Sau
- `clampAiCoderJsonSchemaNumbers` kéo số vượt `maximum` về đúng cap, đi đệ quy
  theo `properties`/`items`/`$ref`, và nối ghi chú
  `Arguments clamped to host limits: …` vào summary trả cho model.
- Giá trị dưới `minimum`, sai kiểu và mọi vi phạm khác vẫn fail như cũ.
- Kèm sửa test `contracts.test.ts` còn đọc `input.precondition.kind` sau khi
  precondition thành optional — lỗi này làm `npm run typecheck` (và CI) đỏ ở HEAD.

## Test hồi quy
- `test/json-schema-clamp.test.ts` (5 case), `npm run verify`.
- Incident: galaxy-code/docs/TEST_FAILURE_ANALYSIS.md mục 2 và 3.
