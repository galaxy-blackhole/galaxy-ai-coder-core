# 2026-09-26 — Generated-state evidence policy và churn guard

Vùng: runtime/context/host

## Trước
- Snapshotter coi `dist/`, `coverage/`, build output và `*.tsbuildinfo` là durable writes, trong khi evidence verifier bỏ qua `dist/`/`coverage/`. Hai chính sách lệch nhau khiến completion gate đòi validation/diff review cho sản phẩm build, còn fingerprint vẫn đổi mỗi lần typecheck → run lặp build→xoá→validate tới `maxTurns`.
- `cachedInputTokens` có trong port nhưng không vào token ledger.

## Sau
- Policy generated-state dùng chung (`src/adapters/node/host/workspace-generated-state.ts`): snapshotter đánh dấu derived, evidence verifier bỏ khỏi fingerprint; gồm `dist`, `coverage`, `build`, `out`, `node_modules`, các cache, và file `*.tsbuildinfo`/`.DS_Store`/`.eslintcache`.
- Runtime không reset no-progress budget bởi thay đổi generated-only; đếm `generatedChurnEvents` và pause sớm qua no-progress.
- Token ledger ghi `cachedInput` từ `prompt_cache_hit_tokens`/`cached_tokens`.
- Prompt `tool-policy` 2.3.0 (prompt `ai-coder-single/2.7.0`): yêu cầu load first-party skill trước khi tự scaffold.

## Test hồi quy
- `test/workspace-generated-state.test.ts` (predicate + snapshotter + fingerprint).
- `test/dist-smoke.mjs` cập nhật prompt version.
