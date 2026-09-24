# Retry delay theo scenario budget + deadline-aware skip (2026-09-22 07:25 +07:00)

### Changed

- Bảng backoff giữa các model request retry trở thành budget knob
  `modelRetryDelaysMs` (1-8 số nguyên dương, tối đa 600 000 ms mỗi entry) thay
  vì `MODEL_RETRY_DELAYS` hardcode. Schedule được dùng theo thứ tự attempt và
  báo trong sự kiện `model_retry`.
- Retry deadline-aware: trước khi sleep, runtime kiểm tra budget còn lại; nếu
  `deadline - now <= delay + thời gian attempt vừa fail` thì bỏ attempt, fail
  loud với message nêu rõ còn bao nhiêu budget, backoff bao nhiêu và attempt
  trước kéo dài bao nhiêu, thay vì dispatch một request chắc chắn chết.

### Tests

- Core 111/111 pass: budget schedule được dùng đúng thứ tự và report qua
  `onEvent`; retry không đủ budget bị skip trước khi sleep; 6 case schedule
  invalid fail loud tại validation.
