# Skill marketplace — index, ký số (trust), CLI và TUI

## Index

JSON `schemaVersion: 1`:

```json
{
  "schemaVersion": 1,
  "skills": [
    {
      "id": "orbit-framework",
      "name": "Orbit Framework",
      "description": "...",
      "tags": ["orbit"],
      "versions": [
        { "version": "0.1.0", "path": "orbit-framework/0.1.0/SKILL.md", "sha256": "<64 hex>" }
      ]
    }
  ],
  "signature": "<base64 ed25519>"
}
```

- `path` tương đối theo index (hoặc `url` tuyệt đối HTTP(S)).
- Nội dung mỗi skill được **verify sha256** trước khi ghi (atomic, mode 0600).
- Semver hỗ trợ: `*`, exact, `^`, `~`.

## Ký số index (trust)

- Chữ ký Ed25519 trên **canonical JSON** (object key sắp xếp, bỏ field `signature`); cả publisher và verifier dùng chung `stableSkillIndexJson`.
- Host cấp public key tin cậy qua `--skills-public-key <pem>`; khi có key, index **bắt buộc** phải có chữ ký hợp lệ (thiếu/sai → từ chối), fail-closed.
- Không cấp key: chấp nhận index chưa ký (tương thích ngược).

Sinh khoá và ký:

```sh
openssl genpkey -algorithm ed25519 -out private-key.pem
openssl pkey -in private-key.pem -pubout -out public-key.pem
node scripts/sign-skill-index.mjs index.json private-key.pem signed.json
blackhole skills install orbit-framework --skills-index signed.json --skills-public-key public-key.pem
```

## CLI

```sh
blackhole skills search <query>      --skills-index <path-or-url>
blackhole skills install <id>        [--skill-version <range>]
blackhole skills installed | update | remove <id>
```

Skill cài vào managed root (`<state-dir>/skills` hoặc `--skills-dir`), xuất hiện qua
`DirectorySkills` với namespace `managed/`.

## TUI

- `Ctrl+S`: mở/đóng panel SKILLS.
- Liệt kê skill đã cài (catalog) và entry từ index (nếu cấu hình `--skills-index`).
- `↑/↓` chọn, `Enter` cài entry index đang chọn, `Esc`/Ctrl+S đóng.
