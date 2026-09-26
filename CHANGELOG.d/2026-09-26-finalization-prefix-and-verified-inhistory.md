# 2026-09-26 — Finalization tool-free, allowlist in-history, cache accounting

Vùng: runtime/adapters/context

## Sau
- Lượt finalization vẫn **tool-free** + project context (host conformance): lượt cuối không gửi tool definitions và không dispatch tool call. (Thử nghiệm giữ tools để tối ưu cache đã bị revert vì vi phạm conformance.)
- `OllamaCodingModel` map `promptCache: "supported"` (Ollama báo `prompt_eval_cached_count`).
- `verifiedSystemPromptUpdate(model)`: mặc định `in-history` cho model đã probe template (`gemma3*`, `deepseek-v4.1-flash*`); còn lại in-place. Option `systemPromptUpdate` luôn thắng.
- Token ledger thêm `cachedInput`, `cacheHitRate` và luỹ kế phiên (`cumulativeCacheHitRate`); map `prompt_eval_cached_count` → `cachedInputTokens`.

## Test hồi quy
- `test/cache-hit.test.ts`: allowlist verified/unverified, capability override, cumulative ledger.
