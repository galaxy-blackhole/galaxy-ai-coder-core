# 2026-09-26 — Failure-injection test cho MCP reconnect

Vùng: adapters/mcp

## Sau
- Thêm fixture `test/mcp-crash-fixture.mjs` (tự `process.exit` giữa call) và `test/mcp-reconnect.test.ts`:
  - tool read-only được reconnect + retry và thành công;
  - tool mutating **không** bị retry ngầm, nhưng kết nối được phục hồi cho call sau.

## Test hồi quy
- `npx tsx --test test/mcp-reconnect.test.ts` (2 case).
