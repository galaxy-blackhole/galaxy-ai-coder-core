# Cache hit (prefix reuse) — đo, TUI/log, và in-history

## Đo

Provider báo prompt-cache hits qua usage; core map vào `cachedInputTokens` và
token ledger:

- Ollama native `/api/chat` → `prompt_eval_cached_count` (adapter map → `cachedInputTokens`).
- Ollama/OpenAI `/v1/chat/completions` → `usage.prompt_tokens_details.cached_tokens`.
- DeepSeek official → `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`.

Ledger entry có `actualInput`, `cachedInput`, `cacheHitRate = cachedInput/actualInput`.
- Log: `trace.token_ledger` (JSONL, gồm `cacheHitRate`).
- TUI: footer hiển thị `<tokens> tokens · cache NN%` (từ event `token_ledger`).
- `--json` không in cache; đọc log ở `<state-dir>/logs/cli-*.ndjson`.

### Baseline đo được (Ollama `deepseek-v4.1-flash:cloud`, task inspect ngắn)

| Lượt | actualInput | cachedInput | cache hit |
|---|---|---|---|
| 1 | ~5.7k | 256 | ~4% (lạnh) |
| 2 | ~6.0k | 5.5k | ~92% |
| 3 | ~6.4k | 5.5k | ~86% |

Prompt/context bị dựng lại giữa run (lazy tool activation / finalization / compaction)
có thể làm cache tụt về ~4% vì prefix thay đổi từ token đầu.

## in-history (append thay vì ghi đè node 0)

Quy tắc DSH: khi route đọc **system message mới nhất ở bất kỳ vị trí nào**, prompt
đổi giữa run nên được **append sau history** thay vì viết lại system message đầu;
prefix qua history vẫn tái dùng → cache không sập.

- Core: `ModelCapabilities.systemPromptUpdate` = `in-place` | `in-history` | `unknown`.
- Runtime: `replaceSystemPrompt(..., mode)`; `in-history` thêm một `policy` item
  ở `physicalOrder` cuối, giữ head byte-stable.
- Ollama adapter: option `systemPromptUpdate`; CLI bật bằng `--system-prompt-in-history`.

### Kiểm chứng template trước khi bật

Gửi 2 system message (A ở đầu, B sau history) và hỏi "code word". Nếu model trả B thì
template đọc system message mới nhất.

Kết quả đo với Ollama `gemma3:latest` (local):

| messages | trả lời |
|---|---|
| `[sysA, user]` | ALPHA |
| `[sysA, user, assistant, sysB, user]` | **BETA** |
| `[sysA, user, assistant, user, sysB]` | **BETA** |
| `[user, sysB]` | BETA |

⇒ template đọc system message mới nhất. **Nhưng đây là theo từng model/template** —
hãy kiểm chứng trước khi bật `--system-prompt-in-history` cho model khác.

## Test

- `test/cache-hit.test.ts`: tỷ lệ tái dùng prefix (in-history 98.9% vs in-place 2.2%),
  map `prompt_eval_cached_count`, `cacheHitRate`, và capability `in-history` của adapter.

## A/B live (có prompt bị dựng lại giữa run)

Task dùng web research để buộc model `search_tools` → kích hoạt `research.search`
(lazy) → tool set đổi → runtime gọi `replaceSystemPrompt` giữa run. Chạy qua CLI với
`--research`, so sánh không/có `--system-prompt-in-history`:

| Lượt | A in-place (cached) | B in-history (cached) |
|---|---|---|
| 1 | 256 | 256 |
| 2 (ngay sau khi prompt bị dựng lại) | **256** | **3456** |
| 3 | 5760 | 5760 |
| 4–12 | 5760→6016 | 5888→6016 |

Cả hai arm đều có `prompt_snapshot` giữa run (turn 1). Ngay sau đó:
- **in-place** ghi đè node 0 → prefix sập, chỉ còn 256 token cache.
- **in-history** giữ head byte-stable và append prompt mới → giữ ~3456 token prefix.

Cache % giảm dần theo lượt vì context tăng (tool result thêm vào) trong khi phần prefix
tái dùng bị chặn trên; so sánh đúng nên dùng **cachedInput tuyệt đối** ở lượt ngay sau
khi prompt đổi, không phải % cuối.

### Lặp lại 3 lần/arm (task research ngắn)

| arm | mid-run prompt_snapshot | cached turn 2 | hit turn 2 |
|---|---|---|---|
| in-place ×3 | 1 / 1 / 1 | 256 / 256 / 256 | 4% / 4% / 4% |
| in-history ×3 | 1 / 1 / 1 | 3456 / 3328 / 3456 | 39% / 38% / 39% |

⇒ in-history giữ ~3.3–3.5k token prefix; in-place sập còn 256. Kết quả lặp lại, không đảo chiều.

### Tối ưu lượt finalization

Trước đây lượt finalization bỏ hết tools (6104→1) và project context → prefix sập. Khi
route báo `promptCache: "supported"`, runtime **giữ nguyên prefix** (tools + history) và
chỉ append instruction; tool call vẫn **không bao giờ được dispatch** (guard cũ giữ nguyên).

| Lượt finalization | trước | sau |
|---|---|---|
| cachedInput | 2432 | **6016** |
| cache hit | 66% | 75% |

### Model đã kiểm chứng → mặc định in-history

`verifiedSystemPromptUpdate(model)` trả `in-history` cho model đã probe template:
hiện gồm `gemma3*` và `deepseek-v4.1-flash*`; model khác giữ in-place. Override bằng
`--system-prompt-in-history` / `--no-system-prompt-in-history`.

Thêm model: chạy probe code-word (2 system message, mục trên) → nếu trả BETA thì thêm
pattern vào `VERIFIED_IN_HISTORY_MODELS` trong `ollama-coding-model.ts`.
