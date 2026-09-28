# 2026-09-28 — project.validate ghi đúng phạm vi theo project path

Vùng: tools/executor

## Trước
- Mọi validation sinh từ `project.validate` đều được ghi `scope: "workspace"`,
  kể cả khi check chạy trong một subproject (`path: "frontend"`), và không kèm
  `paths`. Hệ quả: gate coi nó bao phủ cả workspace nên **một write ở package
  khác** cũng void (đo được: sửa `backend/` làm stale `lint:frontend` và
  `build:frontend`, buộc validate lại toàn bộ — mất nguyên một vòng).
- Vì `paths` luôn rỗng, quy tắc staleness theo phạm vi ở gate không có tác dụng
  với evidence thật.

## Sau
- `validationScopeForProjectPath(projectPath)`: `"."`/`""` ⇒ `scope: "workspace"`
  (vẫn nghiêm ngặt như cũ); subproject ⇒ `scope: "paths"`, `paths: [<path đã
  chuẩn hoá>]`.
- Gate nhờ đó chỉ vô hiệu validation khi chính subproject đó bị sửa.

## Test hồi quy
- `test/validation-scope.test.ts` + `test/completion-gate-scope.test.ts`.
- Incident: galaxy-code/docs/TEST_FAILURE_ANALYSIS.md mục 4 (bổ sung).
