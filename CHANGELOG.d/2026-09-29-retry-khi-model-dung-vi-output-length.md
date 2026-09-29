# 2026-09-29 — Dừng vì trần output ('length') là lỗi tạm thời, không phải fail run

Vùng: runtime

## Trước
- Khi model dừng với `stopReason: 'length'` (đốt hết ngân sách output, thường là cho
  hidden thinking, trước khi gọi tool hay trả lời), runtime ném
  `INVALID_MODEL_STREAM` **không retryable** ⇒ cả run fail. Đo được: bước
  `s22-seed-50` của E2E chết ở trạng thái `planning` với
  `Model stopped with non-final reason 'length'.`, 0 lần retry.

## Sau
- `length` được phân loại là `CodingProviderError("MALFORMED_STREAM", …, retryable: true,
  retryMode: "without_thinking")` ⇒ vòng retry có sẵn của runtime thử lại **đúng context
  đã kiểm chứng** với hidden thinking tắt, trong ngân sách `maxModelRetries`; thông báo
  ghi rõ số tool call và số ký tự content đã phát trước khi hết ngân sách.
- `unknown` vẫn fail như cũ (có thể là lỗi stream thật).

## Test hồi quy
- `test/runtime.test.ts`: "an output-limit stop retries the verified context with
  thinking disabled".
