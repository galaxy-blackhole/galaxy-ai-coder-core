# Advisory guard policy cho observation (2026-09-19 00:15 +07:00)

### Added

- `AiCoderRunBudget.noProgressPolicy`: `advisory` (mặc định) và `strict`.
- `AiCoderRunBudget.observationNudgeThresholds` (mặc định `[3, 5, 8]`, theo
  tư tưởng repeat-tool-reminder của DeepSeek Harness): các mốc nhắc advisory
  cho observation đọc-only; block chỉ xảy ra sau mốc cuối.
- Checkpoint lưu `noProgress.policy` và `noProgress.observationNudgeThresholds`;
  resume với cấu hình khác bị từ chối `CHECKPOINT_INCOMPATIBLE`, checkpoint cũ
  không có trường này vẫn resume được (legacy).
- Trace `policy_decision` cho `observation_nudge` và `observation_blocked`.

### Changed

- Nudge advisory không còn tăng `noProgressEpisodes`; quyết định pause chỉ đến
  từ block thật hoặc guard mutation/validation/cycle. Chế độ `strict` giữ nguyên
  hành vi cũ (nudge đầu tiên đếm episode, block theo `maxRepeatedToolRequests`).
- Bộ đếm observation family đếm mọi lượt dispatch (kể cả thất bại), khớp hợp
  đồng "requested" trong ARCHITECTURE.md.

### Tests

- 3 test runtime mới: advisory thresholds + block sau mốc cuối; advisory không
  đếm episode; cấu hình fail-loud + checkpoint-bound trên resume.
