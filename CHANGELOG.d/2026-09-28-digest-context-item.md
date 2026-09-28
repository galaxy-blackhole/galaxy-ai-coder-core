# 2026-09-28 — Fingerprint từng context item mỗi lượt (chẩn đoán cache)

Vùng: context/diagnostics

## Trước
- `context_diagnostic` chỉ có tổng token theo nhóm; khi cache hit thấp không thể
  biết block nào đổi đã reset prefix cache.

## Sau
- Mỗi lượt ghi thêm `itemDigests` (index, id, kind, tokens, hash theo đúng thứ tự
  gửi, tối đa 24 item) và `toolHash`/`toolTokens` của block tool. Diff hai lượt
  liên tiếp là ra item phá cache — chính cách tìm ra mục 6 của journal.
- Chỉ thêm dữ liệu chẩn đoán; không đổi cách chọn context hay nội dung prompt.

## Test hồi quy
- `npm run verify`; dùng thực tế trong E2E 2026-09-28.
