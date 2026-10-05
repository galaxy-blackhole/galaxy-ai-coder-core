# Plan mode và checklist kế hoạch cho mọi host (2026-10-05 +07:00)

### Added

- **Kế hoạch giàu hơn**: tool effect `plan` và checkpoint payload `plan` nhận thêm `steps[]`
  (`{ id, status: completed | in_progress | pending | skipped, title }`). Tool `task.checkpoint` nhận
  `steps` dạng chuỗi gọn `"doing: <việc>"` / `"done: ..."` / `"todo: ..."`, id suy ra từ tiêu đề nên
  model không phải nghĩ ra id. Checkpoint cũ vẫn đọc được (field optional, **không** bump schemaVersion).
- **Event runtime `plan`**: `{ plan: AiCoderPlanSnapshot, planMode, toolCallId?, turn }` phát mỗi khi một
  tool công bố kế hoạch hoặc khi chế độ kế hoạch đổi — host vẽ được checklist sống, không phải chờ checkpoint.
- **Plan mode**: `AiCoderRunRequest.planMode` để bắt đầu ở chế độ chỉ-đọc; `AiCoderRunController.setPlanMode(runId, on)`
  để người dùng duyệt/thoát giữa lượt; `planSnapshot(runId)` để host đọc lại. Khi bật: một **guidance
  section** được chèn vào system prompt và mọi tool có capability `write` bị từ chối với mã
  `PLAN_MODE_READ_ONLY` (kèm gợi ý cập nhật `steps`). Catalog tool **không đổi** khi bật/tắt ⇒ phần
  prefix của request vẫn ổn định như thiết kế của web.

### Ghi chú

- `plan.ts` là module thuần (parse bước, suy bucket cũ, gộp snapshot) nên test được offline.
- Không có hệ "user questions" mới: cổng duyệt dùng chính affordance sẵn có của từng bề mặt (CLI `/plan off`,
  VSCode nút trên dải) ⇒ nhất quán giữa hai host.

### Tests

- `test/plan.test.ts`: parse/merge/suy diễn bucket, id tiếng Việt (`đ → d`), chống trùng id.
- `test/runtime.test.ts`: event `plan` mang đủ `steps` + mode, checkpoint lưu `planMode`/`steps`, guidance
  vào system prompt, tool ghi bị chặn khi plan mode bật, guidance biến mất sau khi duyệt, catalog tool
  không đổi giữa hai lần request.
