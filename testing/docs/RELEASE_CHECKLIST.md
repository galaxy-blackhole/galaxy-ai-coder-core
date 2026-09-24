# Release checklist — ai-coder-core

Quy trình chuyển từ `0.3.0-alpha.N` sang bản release. Điền ngày khi tick; không tick trước khi có bằng chứng.

## Gate 1 — độ ổn định live

- [ ] Ít nhất **3 audit full-pass (50/50)** liên tiếp trên cùng một version alpha, `sourceUnchanged: true`, không incident mới. (Đã có: SjeiEj alpha.6 — 50/50, 22/09.)
- [ ] Ít nhất 1 audit có trigger thật của đường retry mới: model retry ≥ 1 lần (đã có trong SjeiEj: 042 `[5000]`, 043 `[5000,15000,30000]`, 044 `[5000]`).
- [ ] Ít nhất 1 lần quan sát "Model retry N skipped" live HOẶC quyết định chấp nhận bỏ qua (path phòng ngừa chưa từng kích hoạt).
- [ ] Một run đạt ≥ 16 compactions và hoàn thành (kiểm tra recovery turn dưới compaction cao — mức Ap63fW từng loop). Kể cả khi không đạt, ghi rõ trong analysis doc.

## Gate 2 — độ bao phủ

- [ ] Core `npm test` + `typecheck` pass trên bản release candidate.
- [ ] CLI `test:unit`, `test:integration`, `test:e2e` pass.
- [ ] Không có symptom signature mới trong TEST_ERROR_LOG.md của 2 audit gần nhất (đối chiếu `npm run test:audit:log`).

## Gate 3 — tài liệu và consumer

- [ ] Compile toàn bộ `CHANGELOG.d` còn thiếu vào CHANGELOG.md của core.
- [ ] README core: install/usage/API đúng với API hiện tại (đã có từ alpha.2; rà lại phần budget mới).
- [ ] Consumer: galaxy-code CLI đã pin/upgrade đúng core mới; các consumer khác (vscode-extension, desktop) chưa tồn tại thì ghi chú trong README.

## Gate 4 — quyết định version

- [ ] Chọn version release: đề xuất **core 0.4.0** (không phải 1.0.0 — giữ dư địa breaking change mà không cần major), CLI theo core minor.
- [ ] Bump version: core `package.json`, CLI `package.json`, `src/ui/help.ts` `GALAXY_CODE_VERSION`, `test/unit/help.test.ts`, package-lock (npm install --package-lock-only).
- [ ] CHANGELOG.md: đổi heading cuối từ `[x.y.z-alpha.N]` sang release entry với ngày giờ +07:00, gộp nội dung các alpha cùng chuỗi.

## Publish

- [ ] `npm run check` (core build + typecheck + test + build CLI) pass.
- [ ] Commit 2 repo với message release, push. Workflow `publish.yml` (trusted publisher OIDC) tự publish lên npm.
- [ ] Verify: `npm view @galaxy-stack/ai-coder-core versions` thấy bản mới; `npm view @galaxy-stack/blackhole-cli version` khớp; install thử trong workspace tạm: `npm i @galaxy-stack/ai-coder-core@latest` rồi chạy smoke import.
- [ ] Tạo git tag `core-v0.4.0` / `cli-v2.1.0` (hoặc đúng version đã chọn) trên commit publish.

## Sau release

- [ ] Ghi vào TEST_FAILURE_ANALYSIS.md: ngày release, version, audit certifying (link summary).
- [ ] Mọi fix sau release dùng version tiếp theo (`0.4.1` patch hoặc `0.5.0-alpha.N` cho feature lớn).
