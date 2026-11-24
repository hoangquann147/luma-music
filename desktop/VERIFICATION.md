# Kiểm chứng Luma Rust 1.0.0

Kiểm tra trên Windows x64 ngày 24/11/2026:

- TypeScript và Vite production build đạt.
- Rust release build đạt; 41 kiểm thử Rust đạt, không có lỗi.
- Bộ cài NSIS đã được cài im lặng vào thư mục kiểm tra riêng. Metadata phiên bản 1.0.0 và shortcut Start Menu đúng.
- Chạy `Luma.exe --verify-package` từ bản đã cài: xác minh checksum toàn bộ công cụ tích hợp và phiên bản 1.0.0 thành công.
- Gỡ cài đặt loại bỏ ứng dụng, shortcut và khóa đăng ký do bộ cài tạo. Tệp bổ sung không thuộc bộ cài được giữ lại. Bộ cài không xóa hồ sơ `%APPDATA%\Luma-Rust` hoặc thư viện nhạc.
- Bootstrapper WebView2 được tải từ Microsoft và kiểm tra chữ ký Microsoft hợp lệ trước khi đóng gói.

## Tái kiểm tra

Dùng Windows x64, Node.js 24, PowerShell 7, Rust stable MSVC, Visual Studio C++ và Windows SDK:

```powershell
npm ci
npm run tools:prepare
npm run build
npm run rust:test -- --release -- --test-threads=1
npm run dist:win
./scripts/verify-installer.ps1 -Installer ./artifacts/Luma-Rust-1.0.0-x64-setup.exe
```

Chỉ chạy kiểm tra cài/gỡ trong môi trường chưa đăng ký Luma Rust qua bộ cài. Kết quả được ghi vào `INSTALLER-VERIFICATION.json` cạnh bộ cài.

## Giới hạn

Kiểm tra đóng gói này không thay thế kiểm tra nghe trên từng USB DAC. Chưa xác minh đăng nhập Google Drive hoặc Rich Presence với tài khoản Discord thật trong lần phát hành này. Bộ cài Luma chưa được ký mã; kiểm tra chữ ký Microsoft ở trên chỉ áp dụng cho bootstrapper WebView2.
