# 2026-09-26 — Generated-state evidence boundary

Vùng: runtime/host

## Trước
- Snapshotter coi `dist/`, `coverage/`, build output là durable writes, trong khi evidence verifier bỏ qua chúng. Hai chính sách lệch nhau khiến completion gate đòi validation/diff review cho build output, fingerprint đổi mỗi lần typecheck → run lặp build→xoá→validate tới `maxTurns`.

## Sau
- Policy generated-state **runtime-neutral** (`src/runtime/workspace-generated-path.ts`; adapter `workspace-generated-state.ts` re-export).
- **Snapshotter** vẫn báo build output (`dist`, `build`, `coverage`, `out`) là **durable host effect** để `run_command` chứng minh mutation nó tạo; chỉ caches/`node_modules`/`*.tsbuildinfo`/`.DS_Store`/`.eslintcache` là derived. Evidence verifier luôn verify active files kể cả trong ignored dir.
- **Runtime** lọc generated path khỏi **authored evidence** (`session.evidence.writes`) và khỏi `durableAuthoredProgress`: build output không reset no-progress budget cũng không đòi validation/write evidence.
- Prompt `tool-policy` 2.3.0 (prompt `ai-coder-single/2.8.0`): load first-party skill trước; không pipe khi cần exit code.

## Test hồi quy
- `test/workspace-generated-state.test.ts`: predicate + snapshot durable/derived + fingerprint.
- `test/dist-smoke.mjs` cập nhật prompt version.
