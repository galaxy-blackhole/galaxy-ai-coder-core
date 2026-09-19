# Sửa parser citation bị nhiễu Markdown (2026-09-19 11:55 +07:00)

### Fixed

- `researchCitations` strip đuôi emphasis/punctuation lặp (`**`, `*`, `_`,
  backtick, `:`, `;`) trước khi canonicalize, nên URL được model viết kiểu
  `**https://example.com/a**:` khớp với URL đã fetch. Trước đó report
  durable-research bị oracle từ chối sai hai citation hợp lệ
  (INC-001 trong `galaxy-code/docs/TEST_FAILURE_ANALYSIS.md`).
- Giữ nguyên xử lý ngoặc cân bằng; URL chỉ-search (model tự ghi "not fetched")
  vẫn bị từ chối đúng.

### Tests

- Test mới: bold/italic/backtick/colon, dedupe, và trường hợp URL thật kết thúc
  bằng `*` (được strip — trade-off đã ghi trong incident register).
