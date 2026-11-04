# Luma

Ứng dụng nghe nhạc trên Windows và Android, với mã nguồn riêng cho từng nền tảng.

| Thư mục | Nội dung |
| --- | --- |
| [desktop/](desktop/) | Electron, React, TypeScript, Tailwind CSS; FLAC/M4A, album, EQ, playlist Spotify, tải và chuyển đổi âm thanh, Google Drive |
| [android/](android/) | Java, Android; FLAC offline, phát nền, PCM, PEQ và Google Drive |

## Windows

Cần Windows 64-bit, Node.js >= 22.12 và npm.

```powershell
cd desktop
npm ci
npm run tools:fetch
npm run dev
```

`tools:fetch` tải yt-dlp, FFmpeg/ffprobe và Deno từ nguồn chính thức, kiểm tra SHA-256 theo manifest. Công cụ không nằm trong Git. Nếu checksum không khớp do upstream thay đổi, lệnh sẽ dừng; xem [hướng dẫn desktop](desktop/README.md) trước khi cập nhật manifest.

```powershell
npm run typecheck
npm test
npm run build
npm run dist:win
```

File Windows được tạo trong `desktop/release/`. Kiểm thử M4A thực cần FFmpeg và ffprobe; khi không có FFmpeg, nhóm kiểm thử này sẽ được bỏ qua. Nếu dùng bộ công cụ bên ngoài thay vì `tools:fetch`, đặt `FFMPEG_TEST_PATH` và `FFPROBE_PATH` tới hai executable tương ứng trước khi chạy kiểm thử.

## Android

Cần JDK 17, Android SDK platform 36 và build-tools 36.0.0. Cấu hình `ANDROID_HOME` trên máy build hoặc `android/local.properties` riêng, rồi chạy:

```powershell
cd android
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

APK debug nằm trong `android/app/build/outputs/apk/debug/`. Xem [hướng dẫn Android](android/README.md) để build release bằng khóa ký riêng.

USB bit-perfect dùng API Android 14+ và cần thiết bị/DAC công bố hỗ trợ. Đây không phải driver USB riêng của HiBy. Bản PC dùng bộ trộn âm thanh của hệ điều hành.

## Tài khoản và dữ liệu

- Nhạc local hoạt động không cần đăng nhập. Kho mã nguồn không chứa nhạc, dữ liệu thư viện hay token tài khoản.
- Nhập playlist Spotify cần cấu hình ứng dụng Spotify của bạn trong Settings. Xem [hướng dẫn desktop](desktop/README.md).
- Đồng bộ Drive cần hai OAuth clients Desktop/Android trong cùng dự án Google Cloud. Xem [thiết lập Google Drive](desktop/GOOGLE-DRIVE-SETUP.md).
- Nhận diện album ở PC dựa vào tag trong file; cũng có thể tạo album và thêm bài thủ công. Thư viện chung có thư mục con cho từng album.
- Chuyển nguồn nén mất dữ liệu sang FLAC không khôi phục chất lượng đã mất. Chỉ tải nội dung mà bạn được phép tải.

## Đưa lên GitHub

Xem [PUSH-TO-GITHUB.md](PUSH-TO-GITHUB.md). Chỉ push repository này; các bản build, khóa ký và cấu hình riêng được giữ ngoài Git. Có thể đính kèm EXE/APK trên GitHub Releases riêng khi cần phân phối.

Mã dự án theo [MIT License](LICENSE). Công cụ đi kèm có giấy phép riêng tại [THIRD-PARTY-NOTICES](desktop/THIRD-PARTY-NOTICES.md).
