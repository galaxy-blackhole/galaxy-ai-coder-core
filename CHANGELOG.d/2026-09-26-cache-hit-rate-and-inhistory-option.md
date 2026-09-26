# 2026-09-26 — Cache hit rate, token_ledger event, và systemPromptUpdate option

Vùng: runtime/context/adapters

## Sau
- `AiCoderTokenLedgerEntry` thêm `cacheHitRate`; log `trace.token_ledger` giờ có số này.
- Runtime phát event `token_ledger` (`actualInput/cachedInput/cacheHitRate/outputTokens/turn`) để host hiển thị live.
- `OllamaCodingModel` nhận option `systemPromptUpdate` (`in-place|in-history|unknown`, mặc định unknown).
- `docs/CACHE_HIT.md`: cách đo, baseline Ollama, và quy trình kiểm chứng template trước khi bật in-history (kết quả gemma3: đọc system message mới nhất).

## Test hồi quy
- `test/cache-hit.test.ts`: cacheHitRate, capability in-history của adapter.
