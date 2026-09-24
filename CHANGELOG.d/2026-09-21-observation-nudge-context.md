# Nudge nhận diện bằng arguments hash (2026-09-21 00:55 +07:00)

### Changed

- Advisory observation nudge giờ kèm `arguments_hash` để model thấy chính xác
  lệnh nào đang lặp, thay vì chỉ biết có sự lặp. Đây là phiên bản tiết kiệm
  budget của tư tưởng deepseek-harness "giữ full canonical arguments để nhận
  diện": nhận diện vẫn dùng toàn bộ arguments, lời nhắc chỉ mang hash.

### Tests

- Core 107/107 pass (`npm test`), không có test assert nội dung nudge cũ bị phá.
