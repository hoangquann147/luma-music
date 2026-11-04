# Luma

Ứng dụng nghe nhạc desktop bằng **Electron, React, TypeScript và Tailwind CSS**. Giao diện sáng, tối giản với sidebar điều hướng, vùng nội dung ở giữa và thanh phát nhạc cố định phía dưới.

Luma phát file FLAC và M4A (AAC / Apple Lossless) local, tổ chức album trong một thư mục thư viện chung, có Equalizer 10 dải, nhập playlist Spotify và tải nguồn âm thanh YouTube để chuyển sang FLAC. Nhãn định dạng phân biệt FLAC, M4A AAC và M4A ALAC; metadata, ảnh bìa và file nguồn được giữ.

## Sử dụng trên Windows

Repository chứa mã nguồn; EXE, APK và các công cụ nhị phân không được commit. Để chạy ứng dụng, làm theo phần **Chạy từ mã nguồn** bên dưới hoặc tự tạo bản phân phối Windows bằng `npm run dist:win`. Khi đã chuẩn bị công cụ bằng `npm run tools:fetch`, cấu hình đóng gói sẽ đưa yt-dlp, FFmpeg / ffprobe và Deno vào bản phân phối; người dùng cuối không cần cài riêng các công cụ này hay Node.js.

Electron Builder hỗ trợ portable và bộ cài NSIS. Một trình mở portable tùy chọn nằm ở `build/PortableLauncher.cs`, cùng script biên dịch `scripts/build-portable.ps1`; cách này cần .NET Framework 4.x, payload ứng dụng và executable 7-Zip kèm giấy phép. Trình mở xác minh SHA-256, giải nén vào thư mục tạm rồi dọn thư mục của nó khi thoát. Dữ liệu người dùng nằm riêng trong hồ sơ Luma.

Vào **Library → Import File** để chọn nhiều file **.flac / .m4a** trên máy, hoặc mở **Downloader** và dán liên kết YouTube. Thư mục tải mặc định là `Luma` trong thư mục Music; có thể đổi trong Settings.

### M4A và Equalizer

- M4A hỗ trợ AAC và ALAC. AAC được phát trực tiếp nếu decoder hỗ trợ; nếu không, Luma thử giải mã tương thích một lần bằng FFmpeg đi kèm. ALAC luôn dùng bản FLAC tạm để phát được trên Windows Chromium. File M4A gốc không bị chuyển đổi hoặc ghi đè.
- Bản tương thích giữ sample rate, số kênh và độ sâu bit ALAC; cache tối đa 512 MB, tối đa 256 MB/bản giải mã, thời gian chuẩn bị tối đa 120 giây. Bản tạm được dọn khi ứng dụng đóng. File quá lớn cần chia nhỏ bên ngoài hoặc dùng bản FLAC có sẵn. AAC vẫn có chất lượng theo nguồn nén mất dữ liệu.
- Chọn **biểu tượng Equalizer ở thanh phát** hoặc **Settings → Equalizer**. Có 10 dải 31 Hz–16 kHz, gain ±12 dB, preamp −24–0 dB, preset Flat / Bass nhẹ / Giọng hát / Ấm dịu / Sáng rõ, tự tạo headroom, nút bật/tắt và đặt lại.
- Các thay đổi áp dụng ngay trong Luma cho FLAC và M4A, được lưu trong hồ sơ Chromium của ứng dụng. EQ tắt mặc định; bật rồi tắt sẽ giữ các thông số để nghe so sánh. Đồ thị tham chiếu 48 kHz, còn xử lý dùng sample rate của AudioContext thực tế; thông tin Web Audio không phải phép đo sample rate DAC. Headroom là ước tính đáp tuyến, không phải limiter.
- Khi EQ chưa được bật, luồng phát native được giữ. Khi dùng EQ, Web Audio xử lý tín hiệu đã giải mã; bộ trộn hệ điều hành vẫn có thể resample. Bản PC chưa có USB exclusive/WASAPI exclusive.
- Đồng bộ Google Drive sang Android hiện chỉ quét **FLAC**. M4A và EQ 10 dải nói trên thuộc bản desktop; Android có bộ PEQ riêng.

Nhập playlist trực tiếp qua Spotify cần Client ID và đăng nhập Spotify. Nhập file CSV/JSON đã có metadata không cần đăng nhập Spotify; phát file local và tải nguồn YouTube cũng không cần tài khoản Spotify. Cần Internet cho tác vụ tải và metadata Spotify; nhận diện album từ tag và tổ chức thư viện hoạt động offline.

## Albums và thư mục nhạc chung

1. Vào **Settings → Thư viện local**, chọn **Thư mục thư viện** rồi lưu. Mặc định là **Music\\Luma\\Library**. Đây là thư mục nhạc lâu dài, không nằm trong thư mục giải nén EXE.
2. Với nhạc đã có từ bản cũ, bấm **Gom thư viện**. Luma sao chép file vào từng thư mục album, kiểm tra SHA-256 và báo riêng các bài lỗi. File nguồn bên ngoài được giữ. Thay đổi thư mục gốc cũng cần bước này để gom các file đang ở vị trí cũ.
3. Khi **Import File** mới hoặc tải nhạc xong, bài được tự xếp theo tag **album + album artist**. Với nhạc cũ, Gom thư viện đọc lại tag album khi có thể; album tổng hợp có cùng album artist được gộp. Bài thiếu tag vào **Chưa phân album**. Không dùng nhận diện âm thanh trực tuyến.
4. Mở tab **Albums** để xem bìa, nghệ sĩ và danh sách bài. Chọn **Tạo album**, nhập tên/nghệ sĩ rồi **Thêm bài vào album** để gán nhạc có trong Library. Gán album cập nhật thư viện và thư mục bản sao; không ghi lại tag hoặc sửa file nguồn.
5. **Phát album** tạo hàng đợi riêng của album; Next/Previous và Queue đi theo danh sách này. Phát trực tiếp từ Library quay về hàng đợi toàn thư viện. Hết album sẽ dừng.

Mỗi thư mục con có tên album và mã riêng để không trùng tên; bên trong chứa FLAC/M4A đã được xác minh. Các file được sao chép nên cần thêm dung lượng cho thư viện. Đặt thư viện nhạc ngoài thư mục repository, cache hoặc kết quả build để tránh đưa nhạc vào Git và tránh mất file khi dọn build.

Album thủ công được lưu trong `library.json` của hồ sơ Luma trên Windows; giữ hồ sơ này nếu muốn sao lưu cả cách gán album. Gỡ bài khỏi Luma vẫn giữ file trên đĩa. Bản sao quản lý cũ khi chuyển album chỉ được dọn sau khi bản mới đã ghi an toàn và marker/checksum khớp; file đang bị khóa có thể được dọn sau khi thoát.

Drive chỉ đồng bộ FLAC. Nên chọn đúng thư mục thư viện làm nguồn Drive, tránh chọn thư mục cha chứa cả bản tải gốc lẫn bản sao thư viện. Cấu hình Drive cũ được giữ; đổi vị trí/tên đường dẫn có thể để lại bản cloud cũ vì chức năng đồng bộ không sao chép thao tác xóa.

## Settings

Danh mục và ô tìm kiếm nằm bên trái, nội dung nằm bên phải; thanh phát nhạc luôn ở dưới. Tìm kiếm hỗ trợ từ khóa tiếng Việt không dấu.

- **Hồ sơ:** đổi tên hiển thị và chọn ảnh PNG/JPG/WebP tối đa 5 MB. Ảnh được thu nhỏ tối đa 256 px; tên và ảnh lưu trong `profile.json` ở hồ sơ Luma của Windows, không cần tài khoản trực tuyến.
- **Thư viện local:** chọn thư mục thư viện chung, gom nhạc đã có vào album và chọn thư mục tải.
- **Tải & chuyển đổi:** xem, đổi và kiểm tra yt-dlp/FFmpeg.
- **Spotify & metadata:** cấu hình Client ID/Secret và kết nối Spotify.
- **Phát nhạc:** chỉnh âm lượng hiện tại, đồng bộ với thanh phát.
- **Equalizer:** chỉnh 10 dải tần, preamp, preset, headroom và bật/tắt xử lý âm thanh.
- **Đồng bộ Google Drive:** lưu Desktop OAuth Client ID/Secret, chọn thư mục nguồn, kết nối Google và upload FLAC cho Android. Tự quét mỗi 2 phút khi ứng dụng đang mở và bật tự động; có hủy, retry/resume và kiểm tra xung đột.
- **Liên kết:** tập trung các website và tài liệu Spotify, yt-dlp, FFmpeg, Deno và các dịch vụ liên quan.

## Đồng bộ với Android

[Bản Android](../android/README.md) hỗ trợ Android 8.0+, nhập FLAC qua trình chọn file, nghe offline, phát nền, PEQ và điều khiển màn hình khóa. Google Drive cần Google Play services và hai OAuth clients (Desktop + Android) trong cùng dự án Google Cloud đã bật Drive API. Không cần Google Drive for Desktop hoặc public link. Hướng dẫn chi tiết nằm trong [GOOGLE-DRIVE-SETUP.md](GOOGLE-DRIVE-SETUP.md).

Trong Settings → Đồng bộ Google Drive, lưu Client ID loại Desktop app và Client Secret nếu Google yêu cầu, chọn thư mục FLAC nguồn và tự cấp quyền trong trình duyệt. Luma tạo thư mục `Luma Music` với scope `drive.file`, chỉ quản lý file do ứng dụng tạo. Android đăng nhập cùng tài khoản, tải file theo SHA-256/MD5 và lưu offline. Xóa không được tự sao chép giữa các thiết bị; giới hạn 2 GiB/file, 10.000 file nguồn. Chu kỳ Android là lịch nền định kỳ 15 phút, phụ thuộc mạng/pin/giới hạn hệ điều hành. Không cam kết cập nhật tức thì.

Client Secret và refresh token Desktop được mã hóa bằng Electron.safeStorage. Android dùng Google AuthorizationClient native, không nhúng Desktop client/secret và không lưu token vào preferences. Mã nguồn không chứa thông tin OAuth riêng; người triển khai tự cấu hình trong ứng dụng. Âm thanh local không yêu cầu đăng nhập.

## Chạy từ mã nguồn

Cần **Node.js ≥ 22.12** và npm. Từ thư mục gốc repository:

```powershell
cd desktop
npm ci
npm run tools:fetch
npm run dev
```

Nếu terminal đã ở `desktop/`, bỏ qua lệnh `cd desktop`. `tools:fetch` tải công cụ Windows theo `resources/tools/manifest.json` và kiểm tra SHA-256 trước khi cài vào thư mục công cụ. Manifest FFmpeg dùng URL upstream `latest` với checksum cố định; nếu upstream thay archive, script sẽ dừng. Chỉ cập nhật manifest sau khi xác minh nguồn và checksum mới, không bỏ kiểm tra hash. Có thể cấu hình executable riêng trong Settings theo phần dưới.

FLAC local không cần tài khoản trực tuyến. M4A cần FFmpeg / ffprobe để đọc thông tin và chuẩn bị ALAC tương thích; tải và chuyển đổi cũng cần các công cụ đã cấu hình.

Các lệnh khác:

| Lệnh | Kết quả |
| --- | --- |
| `npm run typecheck` | Kiểm tra TypeScript |
| `npm test` | Chạy kiểm thử tự động bằng Vitest |
| `npm run tools:fetch` | Tải bộ công cụ Windows từ manifest, kiểm tra SHA-256 và chuẩn bị đóng gói |
| `npm run build` | Kiểm tra kiểu và tạo renderer / main / preload đã biên dịch |
| `npm run preview` | Mở Electron từ bản đã build |
| `npm run dev:web` | Xem riêng giao diện bằng trình duyệt tại địa chỉ terminal in ra |
| `npm run pack` | Tạo ứng dụng chưa đóng gói installer trong `release/` |
| `npm run dist:win` | Build và đóng gói bản phân phối Windows trong `release/` |
| `npm run dist:setup` | Tạo bộ cài Windows NSIS nếu cần |

Chế độ `dev:web` chỉ xem được giao diện; nhập file, phát nguồn `luma-media:` và downloader cần chạy trong Electron. `npm ci` / bước đóng gói cần Internet để tải các dependency và công cụ build. Bản Windows chưa kèm chứng thư ký mã; cấu hình ký mã theo môi trường phát hành của bạn.

## Công cụ downloader

**Bản Windows dùng ngay:** không cần thao tác cài đặt bên dưới. Luma tự dùng yt-dlp, FFmpeg / ffprobe và Deno đã đóng kèm. Trong Settings, hai đường dẫn công cụ được điền tự động; chỉ thay đổi nếu muốn dùng executable riêng. Nhấn **Kiểm tra** để xem trạng thái.

**Khi phát triển hoặc thay công cụ thủ công:**

1. Tải **`yt-dlp.exe` chính thức** từ [yt-dlp Releases](https://github.com/yt-dlp/yt-dlp/releases). Khuyến nghị bản executable chính thức để có sẵn EJS challenge solver.
2. Cài **FFmpeg và ffprobe** từ bản build được dẫn tại [FFmpeg Downloads](https://ffmpeg.org/download.html). Giữ `ffmpeg.exe` và `ffprobe.exe` trong cùng một thư mục.
3. Cài **Deno ≥ 2.3.0**, thêm `deno.exe` vào `PATH`, hoặc đặt cùng thư mục với `yt-dlp.exe`. Deno được yt-dlp bật mặc định; YouTube hiện có thể yêu cầu runtime JavaScript và EJS để giải challenge. Bản yt-dlp chính thức đã kèm EJS; những cách cài khác cần đối chiếu [hướng dẫn EJS của yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/EJS).
4. Trong **Settings**, điền tên lệnh có trên `PATH` hoặc đường dẫn đầy đủ, chẳng hạn:

```text
yt-dlp: C:\Tools\yt-dlp\yt-dlp.exe
FFmpeg: C:\Tools\ffmpeg\bin\ffmpeg.exe
```

5. Chọn và lưu thư mục trong **Settings → Thư viện local**. Lưu đường dẫn công cụ trong **Tải & chuyển đổi**, rồi nhấn **Kiểm tra**. Luma kiểm tra cả `ffprobe` đi kèm FFmpeg. Các bước trên dành cho thiết lập thủ công; bản Windows đã có đủ executable.

Cập nhật yt-dlp khi YouTube thay đổi cách phân phối nội dung. Ứng dụng gọi yt-dlp với `--ignore-config`, vì vậy cấu hình yt-dlp bên ngoài không tự động áp dụng. Nếu cần chỉ định runtime khác, đặt biến môi trường `YTDLP_JS_RUNTIME`, ví dụ `node` hoặc `deno:C:\Tools\deno\deno.exe`, trước khi mở ứng dụng. Node làm runtime cho yt-dlp cần có executable độc lập trên máy; Node nhúng trong Electron không tự được dùng làm công cụ dòng lệnh.

## Thiết lập Spotify

Để nhập playlist trực tiếp:

1. Tạo ứng dụng trong [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Đăng ký Redirect URI chính xác: **`http://127.0.0.1:43827/callback`**.
3. Điền **Client ID** trong **Settings → Spotify & metadata** rồi lưu; không cần Client Secret cho đăng nhập playlist.
4. Nhấn **Connect Spotify**, tự đăng nhập và cấp quyền đọc playlist trong trình duyệt. Luma không nhận mật khẩu Spotify.
5. Mở **Playlists**, dán link playlist rồi nhập danh sách.

Luma dùng [Authorization Code với PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow), kiểm tra state, mã hóa token bằng kho khóa của hệ điều hành, tự refresh và cho ngắt kết nối. API hiện chỉ cho đọc nội dung playlist mà người dùng sở hữu hoặc là cộng tác viên; xem [Get Playlist Items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items). Với playlist khác, có thể nhập file CSV/JSON đã xuất hợp lệ. Development Mode còn phụ thuộc điều kiện tài khoản và quyền ứng dụng Spotify.

Tính năng lấy một track khi chưa đăng nhập vẫn có thể dùng Client ID / Client Secret và [Client Credentials Flow](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow). Token và Secret chỉ được sử dụng trong tiến trình chính, không trả về renderer. Secret lưu qua Settings được mã hóa bằng `Electron.safeStorage`.

Khi phát triển, có thể sao chép `.env.example` thành `.env` ở gốc dự án:

```dotenv
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_MARKET=VN
```

`.env` được đọc ở chế độ phát triển; với bản cài đặt, dùng Settings hoặc biến môi trường của tiến trình. Biến môi trường Spotify ưu tiên hơn giá trị đã lưu. Không đặt tiền tố `VITE_` cho Secret và không commit `.env`, token hay dữ liệu hồ sơ người dùng. Có thể đặt `YT_DLP_PATH` và `FFMPEG_PATH` để cung cấp đường dẫn mặc định khi khởi tạo thư viện mới.

Quyền truy cập thực tế phụ thuộc ứng dụng Spotify và tài khoản của bạn. Spotify đã thay đổi điều kiện và phạm vi **Development Mode** trong năm 2026; kiểm tra [tài liệu thay đổi API](https://developer.spotify.com/documentation/web-api/references/changes/february-2026) trước khi triển khai. Lỗi `403` cần được xử lý ở quyền ứng dụng / Dashboard; `429` là giới hạn tần suất. API không cung cấp luồng nhạc Spotify để tải trong ứng dụng này.

## Sử dụng

**Library:** nhấn **Import File**, chọn một hoặc nhiều file `.flac` / `.m4a`. Metadata, ảnh bìa, thời lượng, sample rate và bit depth được đọc từ file. Có thể tìm theo tên bài / nghệ sĩ / album, phát bài, mở vị trí file hoặc gỡ khỏi thư viện. Gỡ bài hát giữ nguyên file gốc. Nếu file bị di chuyển, nhập lại từ vị trí mới.

**Player:** dùng Previous, Play/Pause, Next, thanh tua và âm lượng. Nút Queue mở hàng đợi đang dùng: album được chọn hoặc toàn thư viện. Phím Space phát / tạm dừng khi con trỏ không ở ô nhập hoặc nút; các phím media và Media Session cũng được hỗ trợ. Hết một bài sẽ chuyển đến bài tiếp theo; hết hàng đợi sẽ dừng.

**Playlists:** nhập link Spotify hoặc nhấn **Import CSV / JSON**. Ứng dụng đọc đủ các trang, lưu playlist, bỏ mục trùng/không khả dụng và liên kết các bài đã có trong Library. Chọn tất cả hoặc từng bài rồi xác nhận tải và tự ghép nguồn. Hàng đợi xử lý tối đa hai tác vụ đồng thời, tiếp tục các bài còn lại khi một bài lỗi, và có thể hủy. Nguồn chưa khớp tên/nghệ sĩ/thời lượng sẽ hiện **Cần chọn nguồn** để duyệt thủ công. Bảng chia 100 bài/trang; Select All áp dụng toàn playlist.

**File playlist:** CSV hỗ trợ các cột `Track URI`, `Track Name`, `Artist Name(s)`, `Album Name`, `Duration (ms)`; có xử lý dấu phẩy và xuống dòng trong ô được đặt trong ngoặc kép. JSON nhận mảng track hoặc `tracks` / `items` có metadata Spotify. Mỗi bài cần Spotify Track URI/URL, tên và nghệ sĩ; thời lượng giúp tự ghép nguồn an toàn. Giới hạn 5 MB / 10.000 bài. File này chứa danh sách bài, không phải file âm thanh hay bộ nhớ đệm Spotify.



**Downloader:** dán liên kết HTTPS của một video YouTube hoặc một track Spotify, xác nhận quyền sử dụng nguồn rồi nhấn **Download as FLAC**. Với Spotify, lượt đầu lấy metadata và đề xuất tối đa ba nguồn YouTube. Mở nguồn để kiểm tra, chọn đúng bản thu, sau đó nhấn **Tải nguồn đã chọn**. Tên giống nhau không đảm bảo đó là cùng bản thu, bản phối hoặc master.

Tiến trình tải / chuyển đổi và lỗi hiện ngay trong tab. Có thể hủy tác vụ; ứng dụng dừng tiến trình con và dọn thư mục tạm. Tối đa hai tác vụ chạy đồng thời. File hoàn tất tự thêm vào Library; tên trùng được đánh số, không ghi đè bản có sẵn. Danh sách hoạt động tải chỉ giữ trong phiên hiện tại; thư viện và cài đặt được lưu lâu dài.

Hỗ trợ video đơn lẻ và danh sách track từ playlist Spotify. Chưa hỗ trợ tải playlist YouTube, album, livestream, âm thanh cần đăng nhập hoặc vượt DRM. Âm thanh vẫn đến từ nguồn YouTube được chọn; chỉ sử dụng nguồn bạn có quyền tải và chuyển đổi.

## Chất lượng âm thanh và metadata

- **FLAC là định dạng nén không mất dữ liệu**, không phải PCM thô không nén. Với file local, ứng dụng đọc và truyền dữ liệu FLAC nguyên bản tới bộ giải mã native của Chromium, không chuyển mã file trước khi phát.
- Đầu ra vẫn đi qua hệ thống âm thanh của Chromium / Electron và hệ điều hành. Mixer, thiết bị hoặc driver có thể thay đổi sample rate; ứng dụng không tuyên bố bit-perfect, WASAPI Exclusive hay ASIO.
- Downloader chọn `bestaudio/best` từ yt-dlp, rồi FFmpeg mã hóa thành FLAC. Nguồn YouTube thường đã nén mất dữ liệu: đổi sang FLAC **không khôi phục chi tiết đã mất**, không biến nguồn đó thành bản Hi-Res gốc. Mã chuyển đổi không ép nâng sample rate hoặc số kênh để tạo thông số giả.
- Spotify cung cấp tên bài, nghệ sĩ, album, ngày phát hành, số track và ảnh bìa khi có. Âm thanh được lấy từ **nguồn YouTube người dùng chọn**, không phải từ luồng Spotify.
- File FLAC dùng **Vorbis comments** cho tags và **PICTURE block** cho ảnh bìa; đây là cấu trúc metadata phù hợp với FLAC, không phải ID3. Tham khảo [FLAC FAQ của Xiph](https://www.xiph.org/flac/faq.html).

## Cấu trúc dự án

```text
desktop/
├── electron/
│   ├── main/
│   │   ├── index.ts          # Electron lifecycle, cửa sổ, IPC và dialog
│   │   ├── store.ts          # Thư viện FLAC, metadata, cài đặt, safeStorage
│   │   ├── media.ts          # Protocol stream FLAC, Range và HEAD
│   │   ├── downloader.ts     # yt-dlp, FFmpeg, tiến trình tải, hủy và cleanup
│   │   ├── spotify.ts        # Client Credentials, token cache, Get Track
│   │   ├── spotify-auth.ts   # OAuth PKCE, callback loopback, token mã hóa
│   │   ├── playlists.ts      # Lưu playlist, liên kết Library, batch queue
│   │   ├── playlist-files.ts # Nhập CSV / JSON
│   │   └── validation.ts     # URL, IPC inputs, byte range, tên file
│   └── preload/
│       └── index.ts          # contextBridge: API giới hạn cho renderer
├── src/
│   ├── App.tsx              # Sidebar, Home, Library, Downloader, Settings
│   ├── components/Player.tsx # Bottom Player, artwork và Queue
│   ├── components/PlaylistsView.tsx # Nhập và tải nhiều bài
│   ├── hooks/usePlayer.ts   # Audio lifecycle, seek, volume, Media Session
│   ├── styles.css           # Tailwind v4 và thiết kế giao diện
│   ├── main.tsx             # Điểm vào React
│   └── window.d.ts          # Kiểu window.music
├── shared/types.ts          # Hợp đồng IPC và kiểu dữ liệu dùng chung
├── tests/                   # Vitest: validation, Spotify, process lifecycle
├── electron.vite.config.ts  # Build main / preload / renderer
├── vite.web.config.ts       # Chế độ xem giao diện riêng
├── dev-csp.ts               # Điều chỉnh CSP chỉ cho Vite development
├── index.html               # CSP của renderer production
├── .env.example
├── package.json
└── package-lock.json
```

Kết quả build nằm ở `dist/` và `dist-electron/`; bản phân phối Windows nằm ở `release/`. Các thư mục này và binary công cụ được bỏ qua trong Git. Khi phát hành bản Windows đã chuẩn bị đủ công cụ, giữ các giấy phép và thông tin nguồn trong `THIRD-PARTY-NOTICES.md` cùng bộ công cụ.

## Các module chính

**`store.ts`** dùng `node:fs` kiểm tra chữ ký FLAC/container M4A, xác định đường dẫn thật, loại trùng theo đường dẫn và đọc tags/ảnh bằng `music-metadata`. **`m4a-probe.ts`** dùng ffprobe đi kèm xác định codec/rate/độ sâu bit M4A thực; trường sample entry MP4 có thể chứa sample rate cũ không phản ánh Hi-Res ALAC. Thư viện / cài đặt được ghi tuần tự qua file tạm rồi đổi tên tại `app.getPath('userData')/library.json`. Nếu JSON cũ hỏng, một bản sao được giữ trước khi khởi tạo lại.

**`media.ts`** phục vụ URL `luma-media://track/<id>` từ ID đã có trong thư viện, không nhận đường dẫn bất kỳ do renderer truyền vào. Backend dùng stream file và hỗ trợ HTTP-style byte ranges / HEAD để Chromium tua nhạc mà không nạp toàn bộ file vào RAM. Cách đăng ký custom protocol theo [Electron protocol API](https://www.electronjs.org/docs/latest/api/protocol).

**`m4a-cache.ts`** tạo FLAC tương thích cho ALAC và AAC khi cần. Tác vụ được tuần tự hóa, dùng lease/cancel, timeout và cache giới hạn; bản giải mã được kiểm tra metadata/độ dài trước commit. File nguồn thay đổi sẽ có cache key mới. Cache nằm trong thư mục tạm riêng và được dọn khi thoát.

**`usePlayer.ts` / `Player.tsx`** dùng `HTMLAudioElement`, thử AAC native và retry tương thích khi cần. **`src/audio/equalizer.ts`** thêm Web Audio graph 10 BiquadFilterNode, preamp, dry/wet bypass và master volume; tạo tối đa một MediaElementAudioSource cho mỗi element, chỉ mở context khi cần EQ. Hook đồng bộ trạng thái phát, vị trí, âm lượng, chuyển bài và Media Session; component hiển thị ảnh bìa, định dạng đúng và các điều khiển. Khi gỡ bài đang phát, nguồn phát được dừng và xóa khỏi player.

**`downloader.ts`** chứa `runProcess()` và `Downloader`. `runProcess()` gọi executable bằng `spawn` với `shell: false`, tham số tách biệt, timeout, streaming progress và `AbortSignal`. Mỗi tác vụ dùng thư mục tạm riêng; tải nguồn tốt nhất, gắn metadata / ảnh bìa qua `fluent-ffmpeg`, xuất FLAC, lưu không ghi đè rồi import. Trên Windows, hủy yt-dlp cũng kết thúc cây tiến trình runtime JavaScript đi kèm.

**`spotify.ts`** lấy / cache access token, refresh sau lỗi `401`, lấy metadata theo market và báo rõ lỗi quyền / rate limit. Kết quả chọn nguồn được cache ở backend trong 15 phút, liên kết với URL và danh sách ứng viên; renderer gửi ID lựa chọn, không tự quyết định metadata hay đường dẫn tải.

**`preload/index.ts`** chỉ công bố các method định nghĩa trong `MusicAPI` bằng `contextBridge`. Renderer không có quyền Node trực tiếp. Cửa sổ bật `contextIsolation`, sandbox và web security, chặn navigation / popup; mỗi IPC kiểm tra sender và input. Production giữ CSP giới hạn nguồn script, artwork và media.

`fluent-ffmpeg` được dùng theo yêu cầu dự án. Kho upstream đã [được archive và thông báo ngừng phát triển](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324); khi duy trì lâu dài, có thể thay riêng hàm chuyển đổi bằng lời gọi FFmpeg trực tiếp mà giữ nguyên UI và IPC.

## Kiểm tra và giới hạn xác minh

```powershell
npm run typecheck
npm test
npm run build
```

Bộ kiểm thử bao gồm URL hợp lệ / URL không an toàn, streaming và byte ranges phục vụ tua, tên file Windows, xác nhận tải, cài đặt, Spotify response / token với HTTP mock, ghi thư viện đồng thời, cùng việc truyền tham số / lỗi / timeout / hủy tiến trình con. Kiểm thử tự động không tải bài hát thật và không cần Spotify Secret.

Đặt biến `FFMPEG_TEST_PATH` tới executable FFmpeg (có ffprobe cùng thư mục) để chạy thêm kiểm thử chuyển đổi thật: giữ 96 kHz / 24-bit / stereo, kiểm tra tags và ảnh bìa, so khớp SHA-256 của PCM giải mã. Xem kết quả và giới hạn xác minh tại [VERIFICATION.md](VERIFICATION.md).

Tích hợp trực tiếp với YouTube, Spotify và Google Drive cần Internet, cấu hình dịch vụ hợp lệ và quyền sử dụng nguồn. Các kiểm thử mock không xác minh đăng nhập hoặc tải nhạc qua dịch vụ thật. Kiểm tra tích hợp và phát âm thanh trong Electron trên máy đích trước khi phân phối; xem các giới hạn đã ghi nhận trong [VERIFICATION.md](VERIFICATION.md).
