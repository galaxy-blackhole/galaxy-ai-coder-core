# Lưu evidence khi citation bị từ chối (2026-09-19 23:15 +07:00)

### Added

- Event `completion_rejected` lưu nguyên candidate và ba tập URL: fetch thành
  công, chỉ xuất hiện ở search, và citation không có fetch evidence; source
  ledger giữ `toolCallId` và `contentHash` để ghép lại tool result.
- Feedback cho model liệt kê nguồn đã fetch để model sửa report thay vì lặp
  nguyên candidate hoặc tự đoán URL khác. Đây là phần core của INC-010 trong
  `galaxy-code/docs/TEST_FAILURE_ANALYSIS.md`.

### Tests

- Regression runtime tạo search-only + fetched source, từ chối candidate đầu,
  kiểm tra event/feedback có đủ ledger, rồi hoàn thành bằng citation đã fetch.
