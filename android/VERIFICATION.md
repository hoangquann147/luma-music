# Luma Android 1.4.0 — kiểm chứng

Kết quả ghi nhận cho bản Android 1.4.0. Khi thay đổi mã hoặc môi trường build, chạy lại kiểm tra theo [README](README.md).

- Package `app.luma.music`, versionCode 140 / versionName 1.4.0, minSDK 26 / target 35 / compile 36.
- Gradle 8.13 + AGP 8.13.2: `assembleRelease` và `lintRelease` thành công trong môi trường build đã có dependency offline.
- 23/23 JUnit tests đạt qua JDK 17/JUnitCore độc lập; chưa xác minh Gradle test worker. Bao gồm đáp tuyến sine peak/shelf, tách kênh, bypass USB, headroom nhiều dải, balance, ổn định Q, round-trip PCM 16/24/32 từng bit, giới hạn chính xác float, STREAMINFO/malformed header, checksum và tên tệp an toàn.
- Android Lint: 0 lỗi, 41 cảnh báo; không dùng baseline/suppress để bỏ qua lỗi.
- APK đã kiểm tra chữ ký v2, CRC32, thông tin version/permission `MODIFY_AUDIO_SETTINGS` và sự có mặt của engine/UI/USB trong DEX.

Các kết quả trên thuộc bản đã kiểm tra, không xác nhận mọi APK tự build. Dùng chứng chỉ riêng khi ký release và kiểm tra chữ ký của APK đầu ra trước khi phát hành. Không commit khóa ký hoặc mật khẩu.

## Giới hạn kiểm chứng

Chưa xác minh phát nhạc trên điện thoại thật hoặc emulator, đầu ra USB DAC, Google OAuth hoặc đồng bộ Drive trên tài khoản thật. Cần kiểm thử riêng các tích hợp này trên thiết bị và cấu hình sử dụng thực tế.

USB bit-perfect dùng API preferred mixer của Android 14+, không có driver USB Host riêng. Không hỗ trợ DSD native/DoP hoặc MQA. PCM thường có thể bị Android resample. API xác nhận cấu hình/routing không thay thế đo tín hiệu phần cứng hoặc đảm bảo mọi ROM/DAC hỗ trợ BIT_PERFECT.

Chế độ USB kiểm tra độ sâu bit và bypass DSP; lỗi cấu hình hoặc mất thiết bị yêu cầu dừng khi phát hiện sự kiện. Sự kiện phần cứng bất đồng bộ, không đảm bảo dừng với độ trễ bằng không.
