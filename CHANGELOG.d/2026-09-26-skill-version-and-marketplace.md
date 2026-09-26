# 2026-09-26 — Skill versioning và marketplace

Vùng: adapters/skills

## Trước
- Skill chỉ có name/description; không version, không cài/update; không có registry.

## Sau
- Frontmatter nhận thêm `version` (semver) và `tags`; `SkillDescriptor` expose `version`/`tags`. Sai định dạng bị từ chối.
- `SkillMarketplace`: index JSON (schemaVersion 1) từ **path hoặc HTTP(S) URL**; resolve semver (`*`, exact, `^`, `~`); tải nội dung (bounded), **verify sha256**, ghi atomic mode 0600 ngoài workspace; `search/install/update/remove/listInstalled`; chặn downgrade ngầm và path traversal.
- Vì core là typed ports, marketplace không tự chạy; host cấu hình index.

## Test hồi quy
- `test/skill-marketplace.test.ts`: install/resolve/update/remove, idempotent, verify sha256 (tamper reject), discoverable qua `DirectorySkills`.
