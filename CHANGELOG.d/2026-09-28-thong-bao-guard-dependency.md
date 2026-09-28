# 2026-09-28 — Lỗi guard dependency nói rõ đường đọc được phép

Vùng: host/workspace-port

## Trước
- `readText` trong `node_modules` đã cho phép `package.json`, `README.md`,
  `*.d.ts` (đúng như orbit-mcp docs mô tả: "đọc .d.ts và package.json trong
  node_modules (được phép) — KHÔNG grep cả cây"), nhưng `searchText`/`searchPaths`
  bị chặn bằng message chung *"không đọc source thư viện bằng file tools"*.
- Hệ quả đo được: model thử lại grep/glob 8 lần trong chiến dịch E2E — đây là mã
  lỗi tool **nhiều nhất**, mỗi lần mất một lượt, vì message không nói rằng đọc
  thẳng một file `.d.ts` là hợp lệ.

## Sau
- `dependencySearchError` cho search/glob: nói rõ grep/glob cả cây không được phép
  **và** `read_file` trên `package.json`/`README.md`/`*.d.ts` trong node_modules
  thì hợp lệ; suggestedAction trỏ về MCP tools/skill docs.
- Không nới quyền đọc source: `.js`/`.mjs`/`.cjs` vẫn bị chặn như cũ.

## Test hồi quy
- `test/workspace-generated-state.test.ts`: "dependency trees allow ground-truth
  reads but refuse search and glob".
- Incident: galaxy-code/docs/TEST_FAILURE_ANALYSIS.md mục "không phải lỗi" (guard
  node_modules) — nay có hướng dẫn đúng trong message.
