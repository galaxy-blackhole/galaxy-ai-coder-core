# 2026-10-02 — Log server đang chạy không được giết bước, và hợp đồng version skill ↔ MCP

Vùng: runtime (workspace evidence), skills (frontmatter), adapter MCP.

## Trước

- Một tiến trình nền ghi log **trong workspace** (`nohup bun run dev > .dev-frontend.log`) làm
  `run_command` ghi nhận file log là *write có hash*. Khi một tool có khả năng ghi trả về `ok=false`,
  runtime chụp lại fingerprint để phân loại "failure family" — đọc lại log đang bị ghi ⇒
  `Active file content hash changed` ⇒ `AiCoderRuntimeError(TOOL_EXECUTION)` **kết thúc cả bước**.
  Đo được ở flow gymflow 2026-10-02: mất `s13-connect-api` (24/25 thay vì 25/25) dù việc của bước đã
  xong trên đĩa; các bước sau đó agent còn học cách *né* chạy server thật.
- Skill dạy shape gọi tool nhưng không nói MCP phải từ version nào, và host không đọc version server
  báo. CLI 2.0.13 (skill dạy `{ symbol }`) đi với orbit-mcp 0.4.0 (schema `required: ["id"]`) ⇒
  harness chặn 4 call với `data must have required property 'id'`.

## Sau

- `.log` là **generated state** (snapshotter không ghi nhận là write bền vững; verifier bỏ qua khi
  duyệt cây), và **churning active file** chỉ được hash theo *đường dẫn*, không đọc nội dung: log của
  dev server không còn làm hỏng fingerprint, kể cả khi bị xoá giữa chừng.
- Chụp fingerprint để **phân loại failure family** là best-effort: workspace đang churn thì bỏ qua phân
  loại và dùng `stateVersion` của tool call. Lỗi tool vẫn tới model như một tool error bình thường —
  không còn giết run.
- `SkillDescriptor.requires` + `parseSkillRequires/satisfiesVersion`: skill khai báo
  `requires: { orbit: ">=0.4.1" }`; `McpAgentClient.serverVersion` đọc version server báo lúc
  initialize để host cảnh báo khi lệch.
