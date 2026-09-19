# CHANGELOG.d

Mỗi bản sửa đáng chú ý (behavior/API/tooling) được ghi thành một fragment trong
thư mục này ngay khi hoàn thành, đặt tên `YYYY-MM-DD-ten-ngan.md`. Khi cắt một
version, gom các fragment thành một mục trong [CHANGELOG.md](../CHANGELOG.md)
với version, ngày, giờ (+07:00), rồi chuyển trạng thái fragment sang đã phát
hành. Không sửa nội dung fragment đã gom; chỉ xóa khi mục tương ứng đã nằm
trong CHANGELOG.md.

Nội dung fragment phải ghi: vùng thay đổi (runtime/prompt/tools/docs/dev), hành
vi trước và sau, yêu cầu test hồi quy hoặc link incident tương ứng trong
`galaxy-code/docs/TEST_FAILURE_ANALYSIS.md` khi bản sửa xuất phát từ một lỗi
live.

CHANGELOG.md (file công khai trên npm/GitHub) viết tiếng Anh; fragment ở đây là
ghi chú làm việc nội bộ, viết tiếng Việt cũng được.
