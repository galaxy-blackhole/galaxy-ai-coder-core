# 2026-09-26 — Finalization giữ prefix cache và allowlist in-history

Vùng: runtime/adapters

## Sau
- Khi `ModelCapabilities.promptCache === "supported"`, lượt finalization **không** project context và **không** rỗng hoá tool list; giữ nguyên prefix (system+tools+history), chỉ append instruction. Tool call ở finalization vẫn không dispatch (guard cũ). Đo live: cached 2432 → **6016** (hit 66% → 75%).
- `OllamaCodingModel` map `promptCache: "supported"` (Ollama báo `prompt_eval_cached_count`).
- `verifiedSystemPromptUpdate(model)`: mặc định `in-history` cho model đã probe template (`gemma3*`, `deepseek-v4.1-flash*`); còn lại in-place. Option `systemPromptUpdate` luôn thắng.

## Test hồi quy
- `test/cache-hit.test.ts`: allowlist verified/unverified + capability override.
- A/B lặp 3 lần/arm trong `docs/CACHE_HIT.md`.
