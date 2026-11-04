# Luma — đồng bộ PC → Google Drive → Android

Hướng dẫn cấu hình dịch vụ cho bản desktop và Android tự build từ repository. Phát nhạc local không yêu cầu Google. Đồng bộ cần Google Play services trên Android, Google Drive API và hai OAuth clients trong cùng dự án Google Cloud.

## 1. Chuẩn bị ứng dụng

- Build desktop theo [README](README.md) và Android theo [hướng dẫn Android](../android/README.md).
- Android hỗ trợ Android 8.0 trở lên; dùng đúng chứng chỉ ký của APK sẽ cài khi đăng ký OAuth.
- Tải YouTube, nhập playlist Spotify và chuyển đổi được thực hiện trên PC. Android nhận file FLAC hoàn chỉnh, không chạy FFmpeg hoặc công cụ Windows.

## 2. Tạo dự án Google Cloud

1. Mở [Google Cloud Console](https://console.cloud.google.com/), tạo hoặc chọn một project cho Luma.
2. Trong [API Library](https://console.cloud.google.com/apis/library/drive.googleapis.com), chọn đúng project và bật **Google Drive API**.
3. Mở **Google Auth Platform**, hoàn tất **Branding** và thông tin hỗ trợ. Với ứng dụng cá nhân đang thử nghiệm, cấu hình **Audience → External → Testing** và thêm tài khoản dùng ở hai thiết bị vào **Test users**.
4. Trong **Data Access**, thêm scope `https://www.googleapis.com/auth/drive.file`. Quyền này dùng cho file do Luma tạo; nhạc không được chia sẻ công khai. Xem [hướng dẫn scope](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

Không cần service account hoặc public link cho thư viện nhạc.

## 3. Tạo OAuth client Desktop

Trong **Google Auth Platform → Clients → Create client**:

- Chọn loại **Desktop app**, ví dụ tên `Luma Desktop`.
- Lưu **Client ID** và **Client Secret** trong nơi riêng tư.
- Trong Luma PC, mở **Settings → Đồng bộ Google Drive**, nhập hai giá trị, chọn thư mục thư viện FLAC rồi lưu. Secret lưu trên máy được mã hóa; không đưa secret vào mã nguồn.
- Desktop dùng trình duyệt và callback loopback cổng ngẫu nhiên. Chọn đúng loại Desktop app; xem [OAuth cho ứng dụng desktop](https://developers.google.com/identity/protocols/oauth2/native-app).

## 4. Tạo OAuth client Android

Chọn loại **Android** trong cùng project. Package mặc định của nguồn:

```text
app.luma.music
```

Lấy SHA-1 của chứng chỉ ký bằng terminal ở thư mục `android/`:

```powershell
.\gradlew.bat :app:signingReport
```

Với bản debug, dùng SHA-1 của variant debug. Với bản release, cấu hình `LUMA_KEYSTORE` và `LUMA_KEYSTORE_PASSWORD` theo hướng dẫn Android trước khi chạy report, rồi dùng SHA-1 của variant release. Cũng có thể đọc chứng chỉ trực tiếp từ keystore riêng:

```powershell
keytool -list -v -keystore "C:\Private\luma-release.p12" -alias luma
```

Lệnh `keytool` hỏi mật khẩu tại terminal; không đưa mật khẩu vào dòng lệnh, chat hoặc repository. Đường dẫn trên là ví dụ, thay bằng keystore của bạn. Đăng ký thêm client cho chứng chỉ debug nếu cần chạy cả debug và release; đổi khóa ký cũng đổi SHA-1 cần đăng ký.

Điền package và SHA-1 vào Android OAuth client rồi lưu. Google nhận diện ứng dụng theo package / chứng chỉ; không dán Desktop Client Secret vào Android. Xem [Google authorization trên Android](https://developer.android.com/identity/authorization).

Hai OAuth clients cần thuộc cùng dự án Google Cloud. Dùng cùng một tài khoản Google ở cả hai thiết bị. Với lỗi `DEVELOPER_ERROR` / mã 10, kiểm tra package, chứng chỉ của đúng APK, project, API và test user.

## 5. Đăng nhập và đồng bộ

1. PC: **Settings → Đồng bộ Google Drive → Kết nối Google**, tự đăng nhập và cấp quyền trong trình duyệt.
2. Chọn **Đồng bộ ngay**. Luma quét FLAC trong thư mục nguồn và các thư mục con, tạo thư mục **Luma Music** trên Drive rồi upload. Nên chọn đúng thư mục thư viện chung để tránh quét cả file gốc và bản sao album.
3. Android: **Drive → Kết nối Google Drive**, chọn cùng tài khoản và cấp quyền.
4. Nhấn **Đồng bộ ngay** trên Android. File đã tải hoàn chỉnh xuất hiện trong **Thư viện** và phát offline.
5. Bật **Tự động đồng bộ** nếu cần. PC kiểm tra mỗi 2 phút khi ứng dụng đang mở; Android dùng lịch nền định kỳ 15 phút, chịu ràng buộc mạng, pin và hệ điều hành.

Android mặc định tải trên mạng không tính phí, thường là Wi-Fi. Nếu đang chờ, kiểm tra mạng, pin và dung lượng. Sau khi upload hoàn tất, PC có thể tắt mà Android vẫn tải từ Drive được.

## Bảo toàn dữ liệu và cấu hình

- FLAC được chuyển nguyên byte. Android kiểm tra SHA-256 từ PC cùng MD5 / kích thước của Drive trước khi thêm vào thư viện.
- Chiều đồng bộ là **PC → điện thoại**. Xóa ở một thiết bị không tự xóa trên Drive hoặc thiết bị còn lại. Nếu xóa bản offline trên Android nhưng file còn trên Drive, lần đồng bộ sau có thể tải lại.
- Giới hạn 2 GiB / file và 10.000 file nguồn. Cần đủ dung lượng Drive / điện thoại; Android giữ bản cũ đến khi bản mới kiểm tra và lưu thành công.
- File cloud bị sửa ngoài Luma sẽ được báo xung đột thay vì ghi đè. Đổi đường dẫn nguồn có thể để lại bản cloud cũ; thao tác xóa không được phản chiếu.
- Trong chế độ Google OAuth Testing, có thể cần đăng nhập lại sau thời hạn kiểm thử; xem [thời hạn refresh token](https://developers.google.com/identity/protocols/oauth2#expiration).
- Giữ keystore và mật khẩu ký release ngoài repository, sao lưu riêng để có thể phát hành bản cập nhật cài đè. Không commit OAuth secrets, token, file hồ sơ hoặc thư viện nhạc.

Kiểm thử tự động dùng HTTP mock và không thay thế việc xác minh đăng nhập / đồng bộ với project Google Cloud thực. Xem [giới hạn kiểm chứng desktop](VERIFICATION.md).
