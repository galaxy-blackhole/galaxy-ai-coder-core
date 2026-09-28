# 2026-09-28 — Đặt run state đổi-mỗi-lượt ra sau prefix ổn định (cache)

Vùng: context/runtime

## Trước
- `runtime-mandatory-state` (turn budget, editedFiles, phase, nextAction — viết
  lại mỗi lượt) nằm ở thứ tự mặc định của checkpoint, ngay sau system prompt.
- Đo trên E2E: item này **đổi đầu tiên trên 38/40 lượt**, `cachedInput` kẹt ở
  10.752 token suốt 17 lượt dù context tăng tới 60–90k ⇒ cache hit 40%, 1,42M
  token bị tính lại.

## Sau
- Block đó mang `physicalOrder` muộn (sau history, ngay trước message của lượt
  mới) nên toàn bộ prefix ổn định (policy, goal, checkpoint, files, tools, history)
  vẫn cache được; đo lại: 40% → 61% toàn run, bước 1 từ 10% → 59–73%.

## Test hồi quy
- `test/context.test.ts`: "the mutable mandatory state is ordered after the stable
  prefix".
- Incident: galaxy-code/docs/TEST_FAILURE_ANALYSIS.md mục 6.
