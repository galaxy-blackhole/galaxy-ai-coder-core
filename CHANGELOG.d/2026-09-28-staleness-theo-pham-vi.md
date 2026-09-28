# 2026-09-28 — Validation chỉ stale theo phạm vi nó bao phủ

Vùng: runtime/completion-gate

## Trước
- Gate so fingerprint **toàn workspace**, nên viết `README.md` hay sửa package
  khác cũng void **mọi** validation ⇒ bắt validate lại (một ngày chạy: 21
  write-sau-validation, 5 lần chặn `WORKSPACE_EVIDENCE_STALE`, 340 mục
  `WRITE_NOT_VALIDATED`).

## Sau
- Validation chỉ bị void khi có **write trong phạm vi nó bao phủ** sau nó.
- Write tài liệu (`.md/.mdx/.txt`, `docs/`, LICENSE/CHANGELOG) không đòi và
  không void validation.
- Nếu fingerprint workspace lệch mà **không hoạt động nào giải thích được** (thay
  đổi ngoài luồng) thì mọi validation vẫn bị void; scope `workspace` vẫn nghiêm
  ngặt như cũ.

## Test hồi quy
- `test/completion-gate-scope.test.ts` (6 case) + test staleness cũ trong
  `test/runtime.test.ts`.
- Incident: galaxy-code/docs/TEST_FAILURE_ANALYSIS.md mục 4.
