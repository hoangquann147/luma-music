# Luma Rust 1.0.0

Bản Windows x64 chạy lõi **Rust/Tauri**, phát hành dưới dạng **bộ cài Setup**.

Tải **Luma-Rust-1.0.0-x64-setup.exe** trong Assets, chạy bộ cài rồi mở Luma từ Start Menu. Có tùy chọn tạo shortcut ngoài Desktop và mục gỡ cài đặt trong Windows. Đây là mốc phiên bản 1.0.0 cho nhánh Rust, thay thế release Electron portable trước đây.

- Phát FLAC, MP3, M4A AAC/ALAC với WASAPI Shared hoặc Exclusive.
- Thư viện/album, hàng đợi, Equalizer, Crossfade và Automix.
- Điều khiển media Windows, khay hệ thống và phát nền.
- Đồng bộ FLAC/MP3/M4A từ PC qua Google Drive xuống Android.
- Discord Rich Presence: bài đang nghe, nghệ sĩ, thời gian và thông số nguồn. Cần Application ID riêng trong Settings.
- Bộ cài kèm FFmpeg/FFprobe, yt-dlp và Deno. WebView2 được cài từ Microsoft nếu máy còn thiếu, khi đó cần Internet.

Thư viện và cấu hình trong `%APPDATA%\Luma-Rust` được giữ khi cài/gỡ. Nhạc nguồn không bị xóa. Google Drive và Spotify cần cấu hình OAuth của người dùng. Rich Presence hiện chỉ dùng ảnh URL HTTPS có sẵn, chưa tự tìm ảnh bìa trên mạng.

Chức năng tải YouTube chuyển âm thanh tải được sang FLAC; không biến nguồn lossy thành lossless gốc. Spotify chỉ cung cấp metadata, không cung cấp âm thanh tải về.

Đối chiếu SHA-256 bằng file `SHA256SUMS.txt`. Mục Source code là mã nguồn, không phải bộ cài.
