# Remediation cho RESEARCH_EVIDENCE_MISSING (2026-09-21 02:20 +07:00)

### Changed

- Completion rejection giờ có dòng remediation riêng cho `RESEARCH_EVIDENCE_MISSING`,
  nêu tên tool (`search_web` cho discovery, `fetch_url` cho đọc nguồn) và nói rõ
  fetch-only không thỏa search requirement. Trước đây issue chỉ nêu số lượng
  ("search calls 0/1") nên model dưới compaction cao không có hướng hành động
  (run [OycseO](../../galaxy-code/.galaxy/audit/2026-09-20T18-36-41-606Z-OycseO/summary.json)
  durable repeat-3: 0 search, 3 fetch, 2 rejection, NO_PROGRESS).

### Tests

- Core 108/108 pass, thêm regression: model fetch-only bị từ chối, nhận feedback
  nêu tên tool, gọi `search_web` sau rejection rồi hoàn thành.
