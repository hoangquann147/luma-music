# Luma — đồng bộ PC → Google Drive → Android

Đồng bộ dùng Google Drive API và hai OAuth clients trong cùng dự án Google Cloud. Nhập và nghe FLAC local trên Android hoạt động độc lập với Google Drive. Tải YouTube, nhập playlist Spotify và chuyển đổi âm thanh thực hiện trên PC.

## Chuẩn bị ứng dụng

Build Android theo [README](README.md), cài APK từ `app/build/outputs/apk/` lên Android 8.0 trở lên. Phần Google Drive cần Google Play services. Build và mở Luma Desktop theo hướng dẫn ở thư mục `desktop` của repository.

Nếu build release, dùng keystore riêng qua biến môi trường `LUMA_KEYSTORE` và `LUMA_KEYSTORE_PASSWORD`, alias `luma`. Giữ khóa này để ký các bản cập nhật. Không commit keystore, mật khẩu, token hoặc cấu hình OAuth cá nhân.

## Tạo dự án Google Cloud

1. Mở [Google Cloud Console](https://console.cloud.google.com/), tạo hoặc chọn một dự án và bật [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com).
2. Hoàn tất phần Branding và Audience trong Google Auth Platform. Nếu dùng chế độ Testing, thêm tài khoản sẽ dùng ở cả hai thiết bị vào Test users.
3. Thêm scope `https://www.googleapis.com/auth/drive.file` trong Data Access. Quyền này dùng cho các tệp do ứng dụng tạo hoặc được cấp quyền; xem [tài liệu scope](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

Không cần tạo service account hoặc chia sẻ nhạc công khai.

## Tạo OAuth client Desktop

Tạo client loại **Desktop app** trong Google Auth Platform → Clients. Trên Luma PC, vào **Settings → Đồng bộ Google Drive**, nhập Client ID và Client Secret, chọn thư mục FLAC rồi lưu. Nhập thông tin trực tiếp trong ứng dụng và giữ riêng trên máy.

Luồng Desktop dùng trình duyệt và callback loopback cổng ngẫu nhiên; xem [OAuth Desktop](https://developers.google.com/identity/protocols/oauth2/native-app).

## Tạo OAuth client Android

Dùng loại **Android**, package `app.luma.music`, và SHA-1 chứng chỉ ký của đúng bản APK được cài. Lấy thông tin chứng chỉ bằng:

```powershell
.\gradlew.bat :app:signingReport
```

Chứng chỉ debug và release khác nhau. Để lấy báo cáo release, thiết lập biến môi trường signing trước khi chạy lệnh. Nếu dùng cả hai variant, đăng ký Android OAuth client tương ứng cho từng chứng chỉ trong cùng dự án Google Cloud.

Không cần nhúng Android Client ID hoặc client secret vào mã nguồn. Google nhận diện ứng dụng qua package và chứng chỉ ký. Xem [Google authorization trên Android](https://developer.android.com/identity/authorization).

Nếu gặp `DEVELOPER_ERROR`/mã 10, kiểm tra package, SHA-1 của APK đang cài, project, API và test user.

## Đăng nhập và đồng bộ

1. PC: **Settings → Đồng bộ Google Drive → Kết nối Google**. Đăng nhập và cấp quyền trong trình duyệt.
2. Nhấn **Đồng bộ ngay**. Luma quét FLAC trong thư mục đã chọn và thư mục con, tạo thư mục **Luma Music** riêng trên Drive rồi upload.
3. Android: **Drive → Kết nối Google Drive**, dùng cùng tài khoản và cấp quyền.
4. Nhấn **Đồng bộ ngay**. Các tệp đã tải và kiểm tra xong xuất hiện trong thư viện, có thể nghe offline.
5. Bật **Tự động đồng bộ** nếu muốn. PC kiểm tra mỗi 2 phút khi ứng dụng mở; Android dùng lịch nền khoảng 15 phút, phụ thuộc mạng, pin và giới hạn nền.

Mặc định Android tải trên mạng không tính phí và áp dụng điều kiện pin/dung lượng. Sau khi PC upload xong, điện thoại có thể tải từ Drive mà không cần PC tiếp tục mở. Không cần cài Google Drive for Desktop.

## Dữ liệu và giới hạn

- FLAC được chuyển nguyên byte. Android kiểm tra SHA-256, MD5/kích thước và phiên bản Drive trước khi cập nhật thư viện offline.
- Đây là đồng bộ **PC → điện thoại**. Xóa ở một thiết bị không tự xóa trên Drive hoặc thiết bị còn lại. Nhạc đã gỡ trên Android có thể được tải lại nếu vẫn còn trên Drive.
- Giới hạn 2 GiB/tệp và 10.000 tệp trong thư mục nguồn. Khi cập nhật, bản offline cũ được giữ đến khi bản mới kiểm tra và lưu thành công.
- PC báo xung đột nếu nội dung cùng mã bài bị sửa ngoài Luma. Tên trên Drive dùng mã ổn định; ứng dụng hiển thị metadata bài hát.
- Google OAuth Testing có thể yêu cầu đăng nhập lại khi quyền hoặc refresh token hết hạn; xem [thời hạn refresh token](https://developers.google.com/identity/protocols/oauth2#expiration).

Build/test cục bộ không thay thế kiểm thử đăng nhập và đồng bộ trên tài khoản thật. Cần kiểm tra riêng luồng OAuth sau khi đăng ký clients và cài đúng APK đã ký.
