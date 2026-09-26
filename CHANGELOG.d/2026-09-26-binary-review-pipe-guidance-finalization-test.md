# 2026-09-26 — Binary review không chặn, pipe guidance, test finalization

Vùng: adapters/tools, prompt, runtime/test

## Sau
- `NodeWorkspaceReviewExecutor`: file **nhị phân/quá lớn** (không đọc được text ổn định) được review **theo hash** với `textReviewed: false` và `opaquePaths` disclosure, thay vì throw `WORKSPACE_REVIEW_FAILED`. `diff_review` evidence vẫn được cấp (hash bao gồm hash file). Entry đặc biệt (symlink/other) và thay đổi đồng thời vẫn fail-closed.
- Prompt `editing-command-policy` 2.2.0 (prompt `ai-coder-single/2.8.0`): cấm pipe khi cần exit code (`| tail/head/cat/grep` che mã thoát), dùng `validate_project`.
- Test deterministic `cache-hit.test.ts`: finalization append-only giữ prefix (>95%) còn projection thì sập (<50%).

## Bối cảnh
- Run GymFlow: `review_changes` fail trên `hero.png` ở turn ~31 rồi lại pass ở turn ~40 (không nhất quán), và model từng đọc sai exit code do pipe.

## Test hồi quy
- `test/workspace-review.test.ts` (binary), `test/cache-hit.test.ts` (finalization), `test/dist-smoke.mjs` (prompt version).
