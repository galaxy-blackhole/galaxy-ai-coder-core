# 2026-09-30 — Tài liệu credential dùng chung cho mọi Galaxy host

Vùng: adapters/node/config

## Thêm
- `galaxy-credentials`: một tài liệu YAML chỉ chủ sở hữu đọc được
  (`~/.galaxy/credentials.yaml`, shape `version: 1`, `refs: <ref> -> <secret>`) để desktop app,
  CLI, extension VS Code và web GUI cùng đọc/ghi một nguồn secret. Module sửa theo dòng thay vì
  parse/ghi lại YAML để không phá comment/định dạng của writer khác.
- Test `test/galaxy-credentials.test.ts`.

## Vì sao cần phát hành
- CLI 2.0.3 (đã lên npm) import `@galaxy-stack/ai-coder-core/adapters/node/config/galaxy-credentials`;
  core 0.3.2 chưa có module này nên bản CLI đó crash lúc khởi động
  (`ERR_MODULE_NOT_FOUND`). 0.3.3 đưa module vào bản phát hành, và CLI 2.0.4 pin core 0.3.3.
