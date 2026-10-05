# Nén context thủ công cho `/compact` ở mọi host (2026-10-05 +07:00)

### Added

- **`AiCoderContextManager.compactNow(turn)`** (`src/context/context-manager.ts`): entry công khai chạy
  đúng pass mà ngưỡng tự động chạy — checkpoint bền, giữ tối đa 5 item tín hiệu cao (≤12k token), một
  summary P1 — nên bản nén thủ công có cùng hình dạng với bản tự động; chỉ khác `reason: "manual"`.
- **`AiCoderRunController.compact(runId)`**: nén context của **lượt đang chạy** theo yêu cầu người dùng,
  `await` xong mới trả (`cancel`/`pause` chỉ lật cờ cho vòng lặp đọc sau), và phát event runtime mới
  `type: "compaction"` để host báo lại cho người dùng. Run không hoạt động → `null`.
- `compact()` nội bộ nay **trả về số liệu** `{ itemsShadowed, tokensBefore, tokensAfter }` để host in
  được câu kiểu web: "đã nén N mục (~X → Y token)".

- **`AiCoderRunRequest.compactOnStart`**: nửa "lúc rảnh" của `/compact` — lượt kế tiếp nén **trước
  turn model đầu tiên**, nên cả lượt đó đã trả giá bằng prompt gọn. Máy trạng thái nay cho phép
  `preparing` ↔ `compacting` (pass trả về đúng trạng thái nó cắt ngang).

### Ghi chú thiết kế

- **Khi có quá ít item để nén, pass có thể tốn hơn phần bị nén** (checkpoint + summary đắt hơn vài
  observation nhỏ). Test ghi nhận đúng điều này thay vì hứa "luôn giảm"; đường ngưỡng (đang chịu áp
  lực thật) mới là đường làm prompt nhỏ đi.
- Ở CLI/VSCode, lịch sử phiên giữa các lượt **đã nằm trong checkpoint** (dạng gọn sẵn), nên `/compact`
  chỉ có việc để làm khi **một lượt đang chạy**; host nói thật điều đó thay vì báo thành công khống.

### Tests

- `test/runtime.test.ts`: gọi `controller.compact(runId)` giữa lúc run đang chạy (microtask, cùng kỹ
  thuật test approval), assert event khớp kết quả pass, checkpoint được lưu với `reason: "manual"`,
  và run không hoạt động trả `null`.
