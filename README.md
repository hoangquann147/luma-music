# Luma Rust 1.0.0

Luma PC dùng **Rust/Tauri + React**, phát hành dưới dạng bộ cài Windows x64. Phiên bản 1.0.0 là mốc phát hành cho nhánh Rust, thay release Electron portable trước đây.

## Tải và cài

Tải `Luma-Rust-1.0.0-x64-setup.exe` tại [Releases](https://github.com/hoangquann147/luma-music/releases/latest), chạy bộ cài và mở Luma từ Start Menu. Có tùy chọn shortcut Desktop, mục gỡ cài đặt và kiểm tra WebView2. Không cần cài Node.js, Rust hay công cụ tải nhạc riêng để sử dụng app.

Cài/gỡ giữ thư viện và cấu hình trong `%APPDATA%\Luma-Rust`, không xóa nhạc nguồn. Xem [hướng dẫn Windows](desktop/README.md) và [ghi chú 1.0.0](desktop/RELEASE-NOTES-1.0.0.md).

## Mã nguồn

| Thư mục | Nội dung |
| --- | --- |
| [desktop/](desktop/) | Luma Rust Windows: WASAPI, thư viện/album, EQ/Crossfade/Automix, Google Drive, Discord Rich Presence và bộ cài NSIS |
| [android/](android/) | Mã Android có sẵn được giữ nguyên; không thuộc lần phát hành PC này |

Các file Electron cũ được giữ để tham khảo lịch sử; backend PC hiện hành là Rust trong `desktop/src-tauri/`.

## Build Windows

Cần Node.js >=22.12, Rust MSVC stable, MSVC Build Tools, Windows SDK, PowerShell 7 và tar.exe:

```powershell
cd desktop
npm ci
npm run tools:prepare
npm run build
npm run rust:test -- --release -- --test-threads=1
npm run dist:win
```

Bộ cài được tạo ở `desktop/artifacts/`. Công cụ đi kèm được kiểm tra checksum; NSIS được ghim phiên bản và bootstrapper WebView2 được kiểm tra chữ ký Microsoft. Mã nguồn không chứa nhạc, token, Client Secret hay khóa ký.

Google Drive/Spotify cần cấu hình OAuth riêng. Discord Rich Presence cần Application ID riêng. Chuyển nguồn YouTube lossy sang FLAC không biến thành lossless gốc. Rich Presence chưa tự tìm ảnh bìa trên mạng.

Giấy phép dự án: [MIT](LICENSE). Công cụ có [giấy phép riêng](desktop/THIRD-PARTY-NOTICES.md).
