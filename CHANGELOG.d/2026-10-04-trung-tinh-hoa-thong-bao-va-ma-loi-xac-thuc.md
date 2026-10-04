# Trung tính hoá thông báo provider và giữ mã lỗi xác thực (0.3.6)

**Ngày:** 2026-10-04 · **Core:** 0.3.6 · **CLI đi kèm:** 2.1.1

## Vì sao

Lần chạy đầu tiên khi chưa có API key in ra `Ollama chat failed (401): Unauthorized`. Câu đó vừa lộ tên
runtime (hệ thống bán ra là **Galaxy Blackhole**, Ollama chỉ là chi tiết thực thi), vừa không cho người
dùng biết phải làm gì. Cùng lúc, run-controller bóp mọi lỗi provider thành `PROVIDER_ERROR`, nên host
không thể phân biệt "key sai" với "provider hỏng".

## Đã đổi

- Message của provider/stream/embedding/manual-config nay **trung tính** (`chat failed (401)`,
  `embedding failed (404)`, `Base URL must be …`): core là host-agnostic, host tự gắn brand.
- Thêm mã runtime `PROVIDER_AUTHENTICATION` và giữ nó khi provider trả 401/403
  (`src/runtime/run-controller.ts`), để host biết đây là lỗi key.
- Định danh máy (`modelIdentity.provider = "ollama"`, hash compatibility) **không đổi**.

## Kiểm chứng

- Core: 191 pass / 1 skip / 0 fail (một assertion phải cập nhật: `/embedding failed \(404\)/`).
- CLI 2.1.1: 193 pass / 0 fail, gồm test khoá branding của luồng setup (transcript màn hình 1 không được
  chứa "Ollama").
- Smoke thật: `Galaxy Blackhole: chat failed (401): Unauthorized` + `Chạy "blackhole setup" để nhập lại.`, exit 3.
