# Recovery turn trước no-progress pause (2026-09-22 01:07 +07:00)

### Changed

- Khi `noProgressEpisodes` chạm ngưỡng pause lần đầu, runtime không pause ngay
  mà chèn một feedback turn `[GALAXY NO-PROGRESS RECOVERY]` liệt kê failed
  tools của round kèm remediation (re-read vùng đúng, whole-file write, đổi
  nguồn), rồi cho model đúng một round nữa. Nếu round đó vẫn không tiến triển
  thì pause như cũ. Đây là phiên bản two-strike của Gemini CLI
  loopDetectionService cho Galaxy: giữ nguyên ngưỡng 2/2/2, không bỏ pause,
  chỉ thêm đúng một cơ hội phục hồi có kiểm soát.
- Trace runtime ghi `policy_decision` với `action:
  "no_progress_recovery_turn"` để audit phân biệt lượt recovery với lượt pause.

### Tests

- Core 108/108 pass. Hash-cycle, resume-cycle, observation recovery, validation
  recovery có fixture xác minh: recovery round được cấp đúng một lần; round
  phục hồi thành công (đổi chiến lược) thì complete; round vẫn lặp thì pause.
