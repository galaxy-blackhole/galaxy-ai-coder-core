# 2026-09-28 — Advisory khi lệnh shell trùng check dự án hoặc chạy server

Vùng: tools/prompt

## Trước
- Model chạy `bun test`/`tsc --noEmit` bằng shell song song với `validate_project`
  — tốn lượt mà **không** sinh completion evidence (3 lần trong một bước E2E).
- Model tự bật dev server để "chứng minh" dự án chạy được (xem mục 1 của journal).

## Sau
- `command.run` trả advisory khi lệnh là check **toàn dự án** hoặc khi lệnh giống
  server/watch. Advisory của check nói **đúng call cần gọi**, suy ra từ chính lệnh:
  `cd gymflow-backend && bunx tsc --noEmit` ⇒
  `validate_project {"path":"gymflow-backend","checks":["typecheck"]}` (đường dẫn lấy
  từ `cd` trong lệnh, nếu không có thì lấy `cwd` của tool call); nhận cả dạng
  runner `bunx`/`npx`/`pnpx`/`exec`/`dlx`.
- Lệnh nhắm một file (`bun test src/x.spec.ts`) **không** bị nhắc, vì
  `validate_project` không diễn đạt được; package reference (`vite@latest`) và
  đường dẫn (`assets/vite.svg`) không bị coi là server.
- Prompt `editing-command-policy` v2.3.0: server nền không phải supervision cũng
  không phải evidence; xoá file probe trước khi validate; không probe API bằng
  `bun -e`/`node -e`.

## Test hồi quy
- `test/command-shape.test.ts`.
- Incident: galaxy-code/docs/TEST_FAILURE_ANALYSIS.md mục 7, 8, 9.
