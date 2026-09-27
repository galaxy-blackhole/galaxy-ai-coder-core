# 2026-09-27 — Build output là derived, manifest workspace

Vùng: runtime/host

## Sau
- Snapshotter dùng `isGeneratedWorkspacePath(segments)` nên `dist/`, `build/`,
  `coverage/` và `*.tsbuildinfo` được xếp `derived` thay vì `durable write`.
  Validation/diff-review không còn stale khi build sinh lại output — trước đây
  gate lặp tới `maxTurns`.
- Hợp nhất derived dirs từ `.gitignore` (pattern thư mục) và từ
  `.galaxy/workspace.json` — manifest agent cập nhật khi dự án mở rộng.
  `.galaxy/` là generated state nên ghi manifest không void validation.
- Prompt nhắc ghi `.galaxy/workspace.json` sau khi validation sinh build output.

## Test hồi quy
- `npm run verify` (core) + `npm test` galaxy-code (90/90).
