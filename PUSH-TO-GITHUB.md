# Đưa Luma lên GitHub

Thực hiện trong thư mục chứa `README.md` này. Repository gồm `desktop/` và `android/`, không chứa lịch sử của thư mục làm việc khác.

## Repository trống

1. Tạo repository GitHub, ví dụ `luma`. Chọn **Private** nếu chỉ muốn tài khoản được cấp quyền xem mã. Khi tạo, bỏ chọn khởi tạo README, license và `.gitignore` vì mã nguồn đã có các file này.
2. Đăng nhập tài khoản GitHub bằng Git Credential Manager hoặc GitHub Desktop. Không chèn token vào URL hay file dự án.
3. Nếu dùng bản ZIP chưa có Git, chạy:

```powershell
git init -b main
git add .
git diff --cached --stat
git commit -m "Initial Luma source"
```

4. Thay URL mẫu bên dưới bằng repository của bạn:

```powershell
git remote add origin https://github.com/YOUR-ACCOUNT/luma.git
git push -u origin main
```

Nếu Git yêu cầu danh tính cho commit, cấu hình tên và email GitHub hoặc email noreply của bạn bằng `git config user.name` / `git config user.email` trong repository này.

## Repository đã có nội dung

Không dùng `--force`. Kiểm tra remote và lịch sử trước, rồi nhập nguồn sạch vào nhánh phù hợp; không đẩy đè mã đang có.

## Giữ riêng

`.gitignore` chặn `.env`, khóa ký, credential JSON, SDK path, file nhạc, dependency, file EXE/APK và thư mục build. Nó không xóa dữ liệu khỏi lịch sử đã commit. Bản nguồn này được tạo mới để không mang theo lịch sử trước đó.

Giữ khóa ký Android và mật khẩu ở nơi riêng để có thể phát hành bản cập nhật cùng chữ ký. Khi phát hành, upload **chỉ EXE/APK mong muốn** vào GitHub Releases; không upload thư mục chứa bản sao khóa ký hoặc toàn bộ dữ liệu làm việc.
