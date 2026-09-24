## 0.3.0-alpha.7 — 2026-09-23 07:00 +07:00

### Conservative profile output reserve bump (Mode B fix)

**Lỗi:** `INVALID_MODEL_STREAM "length"` — model dùng hết output tokens (conservative profile chỉ reserve 24 000) chỉ để sinh thinking + tool-call JSON, chưa kịp write file nào (0 writes trên 14 chat requests).

**Hệ thống khác xử lý:**
- Codex CLI: tách budget riêng cho thinking và tool-call JSON, không chia sẻ cùng một output cap.
- Claude Code: mỗi tool call có output budget riêng, không trộn với thinking.
- Gemini CLI: dùng `thinking_config` để cấp thinking budget riêng khỏi output budget.

**Fix Galaxy:** nâng `outputReserveTokens` của profile `conservative` từ 24 000 lên 32 768 (khớp balanced/extended). Không đổi toolDefinitionBudget hay softInputTokens. `AI_CODER_CONTEXT_PROFILE_CONFIG_VERSION` bump thành `"1.1.0"`.

**File sửa:** `src/context/context-profile.ts`.

**Test:** 112/112 core offline (chạy sau build). Không cần unit test mới — profile không được assert trực tiếp trong unit suite.
