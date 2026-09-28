# 2026-09-28 — Hết ngân sách lượt thì finalize một lượt trước khi fail

Vùng: runtime

## Trước
- Chạm `maxTurns` là ném `MAX_TURNS` ngay, kể cả khi evidence đã đủ: một bước E2E
  fail với `reached maxTurns=48` ngay sau khi tool cuối trả "Project validation
  passed" (11 validation pass, 21 mutation, hai call cuối là review → validate).
- CLI không có cách nâng trần, deadline host còn bị hard-code 15 phút.

## Sau
- Hết lượt ⇒ cấp **đúng một lượt finalization không tool** để model báo cáo trạng
  thái đã có; completion gate vẫn là bên quyết định; hết lượt lần hai mới fail
  `MAX_TURNS`. Có trace `policy_decision: budget_finalization_turn`.
- CLI thêm `--max-turns <n>` và `--run-minutes <n>`; budget controller được canh
  thẳng với deadline host.

## Test hồi quy
- `npm run verify` (core) + `npm run check` (galaxy-code, test parse flag).
- Incident: galaxy-code/docs/TEST_FAILURE_ANALYSIS.md mục 5.
