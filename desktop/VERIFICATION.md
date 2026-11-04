# Kiểm chứng Luma Desktop

Tài liệu ghi lại phạm vi kiểm thử của nguồn Desktop 1.5.0. Kết quả tham chiếu không thay thế việc kiểm tra bản build và môi trường triển khai mới.

## Chạy kiểm thử từ nguồn

Từ thư mục `desktop/`, sau `npm ci`:

```powershell
npm run typecheck
npm test
npm run build
```

Để chạy kiểm thử chuyển đổi âm thanh thật trên Windows, chuẩn bị công cụ bằng `npm run tools:fetch` rồi đặt:

```powershell
$env:FFMPEG_TEST_PATH = (Resolve-Path resources/tools/ffmpeg.exe).Path
npm test
```

FFprobe cần nằm cạnh FFmpeg. Có thể trỏ biến môi trường tới một bộ công cụ tương thích riêng. Các test âm thanh thật sẽ skip nếu không tìm thấy FFmpeg; đọc tổng kết test để phân biệt số đạt và số skip.

## Kết quả tham chiếu

- TypeScript và electron-vite production build đạt.
- 116/116 Vitest tests đạt khi có FFmpeg thật, không skip. Phạm vi gồm validation, Spotify / Google OAuth với HTTP mock, thư viện, metadata, protocol media / byte ranges, tiến trình con và chuyển đổi âm thanh.
- 24 test album / store / M4A gồm nhận diện và gán album thủ công, bảo toàn hash file nguồn, chống ghi đè tên bài trùng, gom thư viện có lỗi từng file, đổi thư mục gốc, rollback khi ghi thất bại, bảo vệ marker / checksum, album tổng hợp và giữ metadata đã lưu khi file thiếu tag.
- Kiểm thử FFmpeg kiểm tra M4A AAC / ALAC, metadata và PCM ALAC 96 kHz / 24-bit giải mã trùng byte. Test EQ kiểm tra tham số, headroom và quản lý graph.
- Giao diện production đã được kiểm tra riêng trong Chrome với IPC / media fixture và âm thanh thử: hàng đợi album, chuyển bài / dừng cuối album, tạo / gán album, lưu thư mục / gom thư viện, EQ và tải lại trạng thái. Không ghi nhận lỗi console hoặc page trong phiên kiểm tra đó.
- Giao diện Albums / Settings đã được xem ở 1000×680, 1320×860 và 1920×1080, không tràn ngang.

Các fixture kiểm tra Chrome và script đóng gói bên ngoài dự án không thuộc bộ Vitest trong repository. Kết quả UI này chỉ là kiểm tra giao diện qua bridge mô phỏng.

## Giới hạn

Electron native chưa được xác minh trong môi trường kiểm thử tham chiếu: ACL thư mục runtime chặn khởi tạo trước khi mã ứng dụng chạy. Không thay ACL hoặc tắt sandbox để vượt qua lỗi đó. Kết quả Chrome không chứng minh EXE native hay đầu ra âm thanh trên thiết bị thật.

Chưa kiểm tra Spotify / Google Drive / YouTube với tài khoản thật trong phiên tham chiếu. Tests mock chỉ xác minh xử lý phía ứng dụng. Cần kiểm tra đăng nhập, quyền API, đồng bộ và tải một nguồn được phép trên môi trường đích.

Album được nhóm từ tag nhúng và thao tác thủ công, không dùng dịch vụ nhận diện âm nhạc trực tuyến. Gom thư viện sao chép file và cần thêm dung lượng; file nguồn bên ngoài được giữ. Google Drive chỉ đồng bộ FLAC và không phản chiếu thao tác xóa hoặc tự dọn bản cloud cũ khi đổi đường dẫn.
