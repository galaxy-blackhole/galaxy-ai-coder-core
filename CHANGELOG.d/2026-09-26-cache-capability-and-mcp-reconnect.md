# 2026-09-26 — Cache capability và MCP reconnect

Vùng: runtime/prompt/adapters

## Trước
- Không có cách để route khai báo prefix cache hay cách cập nhật system prompt; runtime luôn ghi đè node 0 khi prompt đổi (lazy activation) → mất prefix cache.
- MCP client không reconnect khi transport lỗi giữa run.

## Sau
- `ModelCapabilities` thêm `promptCache` và `systemPromptUpdate` (tùy chọn, mặc định coi như in-place).
- `AiCoderContextManager.replaceSystemPrompt(..., mode)` hỗ trợ `in-history`: append system prompt mới sau history (giữ head byte-stable) khi route khai báo `in-history`; `in-place` giữ hành vi cũ và dọn các node in-history. `addItem` dedup theo content.
- Ollama adapter khai báo `promptCache: "unknown"`, `systemPromptUpdate: "unknown"` (không tự nhận hỗ trợ).
- `McpAgentClient` reconnect sau lỗi transport và retry **chỉ** tool read-only; mutation giữ unknown outcome.

## Test hồi quy
- `test/cache-prompt.test.ts`: in-history append + dedup; in-place rewrite + dọn node in-history.
