# 2026-09-26 — Ký số skill index (Ed25519 trust)

Vùng: adapters/skills

## Sau
- Index nhận `signature` (base64 Ed25519) trên canonical JSON (key sắp xếp, bỏ `signature`).
- `SkillMarketplace` nhận `publicKey` (PEM); khi có key thì index **bắt buộc** chữ ký hợp lệ, sai/thiếu bị từ chối (fail-closed). Không key → unsigned chấp nhận.
- Export `stableSkillIndexJson`, `signSkillIndex`, `verifySkillIndexSignature`; script publisher `scripts/sign-skill-index.mjs`.

## Test hồi quy
- `test/skill-marketplace.test.ts`: ký hợp lệ cài được; tamper/thiếu chữ ký/sai key đều bị từ chối.
