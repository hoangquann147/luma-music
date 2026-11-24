# Luma Rust 1.0.0

Tài liệu build, cài đặt và kiến trúc hiện hành nằm trong [README](README.md).

Bản Windows hiện hành dùng Rust/Tauri và bộ cài NSIS. Không phát hành portable. Bộ đóng gói nội bộ vẫn dùng ZIP overlay đã xác minh cho bộ công cụ âm thanh; overlay được nhúng trong executable do bộ cài cài vào thư mục chương trình.

Thông số bit-perfect mô tả đường phần mềm và thương lượng định dạng, không thay thế phép đo phần cứng/DAC. Rich Presence cần Application ID riêng và cài/gỡ giữ hồ sơ `%APPDATA%\Luma-Rust`.
