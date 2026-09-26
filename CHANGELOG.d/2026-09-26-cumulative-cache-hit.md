# 2026-09-26 — Cache hit luỹ kế

Vùng: context/runtime

## Sau
- `AiCoderTokenLedgerEntry` thêm `cumulativeActualInput`, `cumulativeCachedInput`, `cumulativeCacheHitRate`.
- Event `token_ledger` mang thêm `cumulativeCacheHitRate` để host hiển thị số kiểu phiên (như DSH), tách khỏi per-turn.

## Lý do
- Per-turn `cacheHitRate` dao động mạnh khi context phình/đổi prefix; số luỹ kế phản ánh tỷ lệ prefix tái dùng của cả phiên.

## Test hồi quy
- `test/cache-hit.test.ts`: cộng dồn qua 2 lượt (200 actual / 120 cached → 0.6).
