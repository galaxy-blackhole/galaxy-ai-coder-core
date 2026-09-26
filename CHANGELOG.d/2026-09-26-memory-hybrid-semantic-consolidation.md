# 2026-09-26 — Memory hybrid ranking, semantic port và consolidation

Vùng: adapters/memory

## Trước
- `search` chỉ sắp theo bm25 + updated_at; không có semantic, không có consolidation; vector/embedding không tồn tại.

## Sau
- Xếp hạng hybrid: lexical (FTS5 bm25) + **optional** semantic cosine + recency (half-life 14 ngày) + trust, trên cùng một candidate pool.
- `AgentEmbeddingPort` (tùy chọn, capability-gated): host cấp provider thì lưu vector `Float32` vào `memory_embeddings(model, dims, vector)`; không có provider thì giữ lexical + recency. Vector được dọn bằng trigger khi xoá memory.
- Không có lexical hit mà có embedding → fallback về recent active để rank semantic.
- `consolidate({ keepSupersededRevisions })`: prune revision đã superseded + xoá orphan embedding; port có method tùy chọn.
- CLI thêm `blackhole memory consolidate`.

## Test hồi quy
- `test/memory-hybrid.test.ts`: trust tie-break, semantic không cần lexical hit, prune superseded, embedding bị xoá khi forget.
