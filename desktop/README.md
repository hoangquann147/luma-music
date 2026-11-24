# Luma Rust 1.0.0

Trình phát nhạc Windows x64 dùng **Rust/Tauri + React**, phát hành bằng bộ cài **NSIS Setup**.

## Cài đặt

Tải `Luma-Rust-1.0.0-x64-setup.exe` từ [GitHub Releases](https://github.com/hoangquann147/luma-music/releases/latest), chạy bộ cài rồi mở Luma trong Start Menu. Có tùy chọn shortcut ngoài Desktop và mục gỡ cài đặt trong Windows. Bộ cài dùng tài khoản hiện tại, không yêu cầu quyền quản trị để cài Luma.

Thư viện và cấu hình ở `%APPDATA%\Luma-Rust` được giữ khi cài/gỡ. Nhạc nguồn không bị xóa. Nếu máy chưa có WebView2, bộ cài sẽ chạy bootstrapper chính thức của Microsoft và cần Internet.

## Tính năng

- Phát FLAC, MP3 và M4A AAC/ALAC; WASAPI Shared/Exclusive, nhãn nguồn và thông số âm thanh.
- Thư viện/album, hàng đợi, EQ, Crossfade và Automix; giữ nguyên file nhạc nguồn.
- Khay hệ thống, Windows media controls và phát nền.
- Đồng bộ FLAC/MP3/M4A từ PC qua Google Drive xuống điện thoại. Cần cấu hình OAuth riêng.
- Discord Rich Presence: bài, nghệ sĩ, đồng hồ và chất lượng nguồn. Cần Discord desktop và Application ID trong Settings. Chưa tự tìm ảnh bìa trên mạng; chỉ dùng URL HTTPS có sẵn.
- Tải nguồn âm thanh được phép tải qua yt-dlp, chuyển sang FLAC bằng FFmpeg. Spotify chỉ cung cấp metadata; chuyển nguồn lossy sang FLAC không tạo lossless gốc.

## Build trên Windows

Cần Windows x64, Node.js >=22.12, Rust MSVC stable, MSVC Build Tools + Windows SDK, PowerShell 7 và `tar.exe` của Windows.

```powershell
npm ci
npm run tools:prepare
npm run rust:test -- --release -- --test-threads=1
npm run dist:win
```

Bộ cài nằm ở `artifacts/Luma-Rust-1.0.0-x64-setup.exe`, kèm `SHA256SUMS.txt`. Công cụ âm thanh được tải từ release chính thức và kiểm tra SHA-256; NSIS được ghim phiên bản và checksum. Bootstrapper WebView2 được kiểm tra chữ ký Microsoft trước khi nhúng.

Kiểm tra cài/gỡ trong môi trường chưa có Luma Rust đăng ký:

```powershell
./scripts/verify-installer.ps1 -Installer ./artifacts/Luma-Rust-1.0.0-x64-setup.exe
```

Script dùng thư mục test trong `.build-tools`, xác minh phiên bản, công cụ, Start Menu và uninstall; không dùng hồ sơ thư viện thật. `src-tauri/target` và `.build-tools/installer-payload` là đầu ra trung gian, không phải bản phân phối cho người dùng.

Mã Electron cũ còn trong lịch sử/thư mục legacy, không phải backend của bản 1.0.0 này. Xem [ghi chú phát hành](RELEASE-NOTES-1.0.0.md), [Google Drive](GOOGLE-DRIVE-SETUP.md) và [giấy phép công cụ](THIRD-PARTY-NOTICES.md).
