# 2026-09-26 — Cache-hit (prefix reuse) harness

Vùng: runtime/prompt

## Sau
- `test/cache-hit.test.ts` mô phỏng prefix cache bằng token hoá request và đo **tỷ lệ tái dùng prefix** khi prompt đổi giữa run:
  - `in-history` (append system prompt sau history) giữ prefix cũ → reuse cao (>90%);
  - `in-place` (ghi đè node 0) → reuse sụp (<50%).
- Assert ledger ghi `cachedInput` từ `prompt_cache_hit_tokens`/`cached_tokens`.
- Đây là công cụ đo deterministic cho H-full; không cần provider.

## Test hồi quy
- `test/cache-hit.test.ts` (2 case); chạy trong `npm run verify`.
