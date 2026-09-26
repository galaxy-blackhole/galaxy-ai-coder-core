# 2026-09-26 — Memory recall benchmark

Vùng: adapters/memory (test)

## Sau
- Bộ nhãn dùng chung `test/helpers/recall-set.ts`: 8 note tiếng Việt + 8 truy vấn paraphrase/cross-lingual, cùng embedder giả deterministic.
- `test/memory-recall.test.ts` (offline): so recall@1/@3 lexical vs hybrid+semantic; kết quả đo `lexical@1=0% @3=13%` vs `semantic@1=100% @3=100%`.
- `test/embedding-live.test.ts` (env-gated) chạy cùng bộ nhãn với model thật; live `bge-m3` cho `lexical@1=0% @3=13%` vs `semantic@1=88% @3=100%`.

## Test hồi quy
- Offline: `test/memory-recall.test.ts`.
- Live: `GALAXY_LIVE_EMBEDDINGS=1 GALAXY_EMBEDDING_MODEL=bge-m3 GALAXY_EMBEDDING_BASE_URL=http://127.0.0.1:11434 npx tsx --test test/embedding-live.test.ts`.
