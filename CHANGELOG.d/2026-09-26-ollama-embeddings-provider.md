# 2026-09-26 — Ollama embedding provider

Vùng: adapters/memory/config

## Sau
- `adapters/node/memory/ollama-embeddings.ts`: `OllamaEmbeddings` gọi `/api/embed`, batch ≤64, response bounded 4 MiB, timeout, kiểm tra vector hợp lệ; **không gửi credential tới endpoint localhost**.
- `ResolvedOllamaConnection` thêm optional `embeddingModel`/`embeddingBaseUrl` đọc từ cùng entry manual.
- `test/ollama-embeddings.test.ts` (fake fetch): batch, credential localhost vs remote, response lỗi.
- `test/embedding-live.test.ts` (skip mặc định, bật bằng `GALAXY_LIVE_EMBEDDINGS=1`): semantic recall cho paraphrase tiếng Việt và cross-lingual; đã chạy live với `bge-m3`.

## Test hồi quy
- Deterministic: `test/ollama-embeddings.test.ts`.
- Live: `GALAXY_LIVE_EMBEDDINGS=1 GALAXY_EMBEDDING_MODEL=bge-m3 GALAXY_EMBEDDING_BASE_URL=http://127.0.0.1:11434 npx tsx --test test/embedding-live.test.ts`.
