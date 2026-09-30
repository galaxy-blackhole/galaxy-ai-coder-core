# 2026-09-30 — Baseline review chỉ tính file nguồn, không chết vì install/build chạy nền

Vùng: host (workspace review)

## Trước
- `NodeWorkspaceReviewExecutor.create` so sánh `stateVersion` của hai lần capture, mà
  `stateVersion` gộp **cả entry `derived`** (`node_modules`, `dist`, cache). Chỉ cần
  `bun install` hoặc build đang chạy nền ghi vào các đường dẫn đó là baseline bị coi là
  "đã đổi" ⇒ factory ném `Error` **ngoài mọi tool call** ⇒ cả run chết với
  `Workspace changed while capturing review baseline. Retry when files are stable.`
  Đo được: một run E2E 25 bước dừng ở bước 4 vì đúng lý do này.

## Sau
- Baseline dùng `durableBaselineFingerprint`: chỉ băm các entry `evidenceClass === "durable"`
  (đúng tập mà review được phép báo cáo), nên thay đổi ở đường dẫn generated **không** còn
  làm hỏng baseline.
- Việc lấy baseline được **thử lại 3 lần** (chờ 250ms × lần) trước khi bỏ cuộc, và thông báo
  lỗi nói rõ nguyên nhân (tiến trình nền còn ghi file nguồn) kèm fingerprint rút gọn để đối chiếu.

## Test hồi quy
- `test/workspace-generated-state.test.ts`: "a background write to a generated path does not
  invalidate the review baseline" — một writer ghi liên tục vào `node_modules/pkg/index.js`
  trong lúc `create` chạy.
