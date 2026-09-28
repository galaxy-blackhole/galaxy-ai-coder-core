# 2026-09-28 — Gate không đòi validation cho path đã bị xoá

Vùng: runtime/completion-gate

## Trước
- Mọi write trong evidence đều bị đòi validation sau nó, kể cả khi path **đã bị xoá**
  trong cùng run. Một bước E2E viết file probe `.e2e-sale-check.ts` để chạy thử
  luồng bán gói rồi xoá đi, và vẫn nhận 2 mục
  `WRITE_NOT_VALIDATED: .e2e-sale-check.ts` ⇒ phải validate lại vô ích.

## Sau
- `removedPaths` = các path có `afterHash === null` (đã xoá); write tới path đó
  (hoặc chính write xoá) **không** còn đòi validation. Kiểm tra
  `WRITE_EVIDENCE_INVALID` vẫn áp dụng cho mọi write như cũ.
- Không nới lỏng gì khác: write còn tồn tại vẫn phải có validation sau nó.

## Test hồi quy
- `test/completion-gate-scope.test.ts`: "a path written and then removed does not
  demand validation".
- Incident: galaxy-code/docs/TEST_FAILURE_ANALYSIS.md mục 11.
