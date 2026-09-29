# 2026-09-29 — Advisory khi đọc source node_modules bằng shell

Vùng: tools/adapter

## Trước
- Guard của host chặn `read_file`/`search_text` trong `node_modules`, nhưng **lệnh
  shell thì không**: bước `s09-security` của E2E đã chạy
  `cd backend/node_modules/@galaxy-stack/orbit-security/dist && cat …` để đọc source
  thư viện — tốn context vào phần không phải tài liệu, đúng thứ guard sinh ra để tránh.

## Sau
- `dependencyShellReadAdvisory(command)`: khi lệnh vừa có trình đọc
  (`cat|bat|head|tail|less|more|sed|awk|grep|rg|strings`) vừa trỏ vào `node_modules/`,
  `command.run` trả advisory nói rõ: đọc source thư viện qua shell cũng tốn như qua file
  tools; hãy đọc một `package.json`/`README.md`/`*.d.ts` cụ thể (được phép) hoặc dùng
  MCP knowledge + skill.
- Không chặn: đọc file workspace, `ls` thư mục dependency hay lệnh không có trình đọc
  vẫn im lặng.

## Test hồi quy
- `test/command-shape.test.ts`: "reading library source through the shell is called
  out, a declaration read is not".
- Incident: galaxy-code/docs/TEST_FAILURE_ANALYSIS.md — mục "Quan sát chính sách" và
  phần "Xác minh release".
