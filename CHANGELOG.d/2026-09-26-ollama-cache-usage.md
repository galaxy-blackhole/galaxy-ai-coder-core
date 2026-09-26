# 2026-09-26 — Ollama báo cache; adapter map vào token ledger

Vùng: adapters/provider

## Trước
- Bộ chuẩn hoá Ollama chỉ đọc `prompt_eval_count`/`eval_count`, bỏ qua cache; tài liệu nội bộ cho rằng Ollama không báo cache-hit.

## Sau
- Ollama >= 0.34 báo cache prefix: native `/api/chat` trả `prompt_eval_cached_count`, `/v1` trả `prompt_tokens_details.cached_tokens` (đã đo trực tiếp với `gemma3:latest`: 24/29 cached).
- `ollama-chat-stream.ts` map `prompt_eval_cached_count` → `cachedInputTokens` trong usage; `token-ledger` đã có `cachedInput` nên log `trace.token_ledger` giờ hiển thị số cache-hit.
- ⇒ Cache-hit của H-full **đo được live với Ollama, miễn phí**, không cần adapter DeepSeek-official.

## Test hồi quy
- `test/cache-hit.test.ts`: map `prompt_eval_cached_count` + ledger `cachedInput`.
