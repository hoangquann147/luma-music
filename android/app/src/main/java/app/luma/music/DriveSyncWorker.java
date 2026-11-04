package app.luma.music;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Incremental, download-only Drive sync. Complete verified files become available offline. */
public final class DriveSyncWorker extends Worker {
    private static final String TAG = "luma-drive-sync";
    private static final String MANUAL = "luma-drive-sync-now";
    private static final String PERIODIC = "luma-drive-sync-periodic";
    private static final String API = "https://www.googleapis.com/drive/v3/";
    private static final long JSON_LIMIT = 2L * 1024 * 1024;
    private static final long DISK_RESERVE = 8L * 1024 * 1024;
    private static final AtomicBoolean RUNNING = new AtomicBoolean();
    private volatile HttpURLConnection activeConnection;
    private long session, deadline;
    private int completed, total;
    private final Context context;

    public DriveSyncWorker(Context context, WorkerParameters parameters) { super(context, parameters); this.context = context.getApplicationContext(); }

    public static final class SyncStatus {
        public String phase, message;
        public int done, total;
        public long lastSyncAt;
        public boolean connected;
    }

    public static SyncStatus status(Context context) {
        SharedPreferences preferences = GoogleDriveAuth.prefs(context); SyncStatus status = new SyncStatus();
        status.phase = preferences.getString("drive_phase", "idle"); status.message = preferences.getString("drive_message", "Chưa kết nối Google Drive.");
        status.done = preferences.getInt("drive_done", 0); status.total = preferences.getInt("drive_total", 0); status.lastSyncAt = preferences.getLong("drive_last_sync", 0); status.connected = GoogleDriveAuth.isConnected(context); return status;
    }

    /** lastSyncAt < 0 preserves the previous successful completion timestamp. */
    public static void publishStatus(Context context, String phase, String message, int done, int total, long lastSyncAt) {
        SharedPreferences.Editor edit = GoogleDriveAuth.prefs(context).edit().putString("drive_phase", phase).putString("drive_message", message).putInt("drive_done", Math.max(0, done)).putInt("drive_total", Math.max(0, total));
        if (lastSyncAt >= 0) edit.putLong("drive_last_sync", lastSyncAt);
        edit.apply();
    }

    private static Constraints constraints(Context context) {
        boolean wifiOnly = GoogleDriveAuth.prefs(context).getBoolean("wifi_only", true);
        return new Constraints.Builder().setRequiredNetworkType(wifiOnly ? NetworkType.UNMETERED : NetworkType.CONNECTED).setRequiresBatteryNotLow(true).setRequiresStorageNotLow(true).build();
    }

    public static void enqueueNow(Context context) {
        if (!GoogleDriveAuth.isConnected(context)) { publishStatus(context, "needs_login", "Kết nối tài khoản Google Drive trước khi đồng bộ.", 0, 0, -1); return; }
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DriveSyncWorker.class).addTag(TAG).setConstraints(constraints(context)).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build();
        WorkManager.getInstance(context).enqueueUniqueWork(MANUAL, ExistingWorkPolicy.KEEP, request);
        synchronized (GoogleDriveAuth.SESSION_LOCK) {
            if (GoogleDriveAuth.isConnected(context) && !RUNNING.get()) publishStatus(context, "queued", GoogleDriveAuth.prefs(context).getBoolean("wifi_only", true) ? "Đang chờ Wi-Fi, pin và dung lượng phù hợp để đồng bộ." : "Đang chờ kết nối mạng, pin và dung lượng phù hợp.", 0, 0, -1);
        }
    }

    public static void configurePeriodic(Context context) {
        WorkManager manager = WorkManager.getInstance(context);
        if (!GoogleDriveAuth.isConnected(context) || !GoogleDriveAuth.prefs(context).getBoolean("auto_sync", true)) { manager.cancelUniqueWork(PERIODIC); return; }
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(DriveSyncWorker.class, 15, TimeUnit.MINUTES).addTag(TAG).setConstraints(constraints(context)).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build();
        manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, request);
    }

    public static void cancel(Context context) { WorkManager.getInstance(context).cancelAllWorkByTag(TAG); }

    @Override public Result doWork() {
        if (!GoogleDriveAuth.isConnected(context)) return Result.failure();
        if (!RUNNING.compareAndSet(false, true)) return Result.retry();
        session = GoogleDriveAuth.generation(context); deadline = SystemClock.elapsedRealtime() + TimeUnit.MINUTES.toMillis(7);
        completed = 0; total = 0;
        try {
            checkActive(); progress("scanning", "Đang tìm thư mục Luma Music trên Google Drive…");
            String folder = findRoot();
            if (folder == null) { progress("waiting", "Chưa tìm thấy thư mục nhạc do Luma Desktop tạo. Kết nối cùng tài khoản / dự án Google Cloud và đồng bộ từ máy tính trước."); return Result.success(); }
            List<JSONObject> remotes = listTracks(folder); total = remotes.size(); progress("syncing", "Đã tìm thấy " + total + " file FLAC từ Luma Desktop.");
            LibraryRepository repository = LibraryRepository.get(context); int downloaded = 0, skipped = 0, failed = 0; String latestError = "";
            for (JSONObject remote : remotes) {
                checkActive();
                try {
                    String id = remote.getString("id"); long size = validSize(remote); String md5 = remote.getString("md5Checksum");
                    LibraryRepository.Track existing = repository.findRemote(id);
                    if (existing != null && md5.equalsIgnoreCase(existing.md5) && new File(existing.path).isFile() && new File(existing.path).length() == size) skipped++;
                    else { download(remote, folder, repository); downloaded++; }
                } catch (GoogleDriveAuth.NeedsLoginException | Cancelled | BudgetExceeded error) { throw error; }
                catch (DrivePermissionError error) { throw error; }
                catch (Exception error) { failed++; latestError = friendly(error); }
                completed++; progress("syncing", "Đã xử lý " + completed + "/" + total + " file · " + downloaded + " tải về, " + skipped + " đã có" + (failed > 0 ? ", " + failed + " lỗi" : "."));
            }
            checkActive();
            if (failed > 0) { progress("error", "Đã giữ các file tải thành công; " + failed + " file cần thử lại. " + latestError); return Result.retry(); }
            synchronized (GoogleDriveAuth.SESSION_LOCK) {
                checkActive(); publishStatus(context, "idle", "Đồng bộ xong: " + downloaded + " file tải về, " + skipped + " file đã có. Sẵn sàng nghe offline.", completed, total, System.currentTimeMillis());
            }
            return Result.success();
        } catch (GoogleDriveAuth.NeedsLoginException error) {
            if (GoogleDriveAuth.active(context, session)) GoogleDriveAuth.needsLogin(context, session, error.getMessage()); return Result.failure();
        } catch (Cancelled error) { return Result.failure(); }
        catch (BudgetExceeded error) { progress("queued", "Đã lưu các file hoàn tất. Android sẽ tiếp tục đồng bộ ở lượt tiếp theo."); return Result.retry(); }
        catch (DrivePermissionError error) { progress("error", error.getMessage()); return Result.failure(); }
        catch (Exception error) { progress("error", "Chưa đồng bộ xong. Sẽ thử lại với thời gian chờ tăng dần. " + friendly(error)); return Result.retry(); }
        finally { HttpURLConnection connection = activeConnection; if (connection != null) connection.disconnect(); activeConnection = null; RUNNING.set(false); }
    }

    @Override public void onStopped() {
        HttpURLConnection connection = activeConnection; if (connection != null) connection.disconnect();
        synchronized (GoogleDriveAuth.SESSION_LOCK) {
            if (GoogleDriveAuth.active(context, session)) publishStatus(context, "queued", "Đồng bộ đã tạm dừng. Các file hoàn tất được giữ; Android sẽ tiếp tục khi điều kiện phù hợp.", completed, total, -1);
        }
        super.onStopped();
    }

    private void checkActive() throws Cancelled, BudgetExceeded {
        if (isStopped() || Thread.currentThread().isInterrupted() || !GoogleDriveAuth.active(context, session)) throw new Cancelled();
        if (SystemClock.elapsedRealtime() >= deadline) throw new BudgetExceeded();
    }

    private void progress(String phase, String message) {
        synchronized (GoogleDriveAuth.SESSION_LOCK) {
            if (!isStopped() && GoogleDriveAuth.active(context, session)) publishStatus(context, phase, message, completed, total, -1);
        }
    }

    private String findRoot() throws Exception {
        String query = "trashed=false and mimeType='application/vnd.google-apps.folder' and properties has { key='lumaSyncRoot' and value='v1' }";
        JSONObject page = json("files?q=" + encode(query) + "&spaces=drive&pageSize=1&orderBy=" + encode("createdTime asc") + "&fields=" + encode("files(id,name,createdTime,properties)"));
        JSONArray files = page.optJSONArray("files"); if (files == null) throw new IOException("Drive trả về danh sách thư mục không hợp lệ.");
        if (files.length() == 0) return null;
        String id = files.getJSONObject(0).optString("id"); if (!SyncRules.validDriveId(id)) throw new IOException("Mã thư mục Drive không hợp lệ."); return id;
    }

    private List<JSONObject> listTracks(String folder) throws Exception {
        List<JSONObject> tracks = new ArrayList<>(); Set<String> pages = new HashSet<>(), ids = new HashSet<>(); String token = "";
        do {
            checkActive(); if (!pages.add(token)) throw new IOException("Drive trả về phân trang lặp.");
            String query = "'" + folder + "' in parents and trashed=false and properties has { key='lumaSource' and value='desktop' }";
            JSONObject page = json("files?q=" + encode(query) + "&spaces=drive&pageSize=1000&orderBy=" + encode("createdTime asc") + "&fields=" + encode("nextPageToken,files(id,name,size,md5Checksum,properties,version,mimeType,parents,trashed)") + (token.isEmpty() ? "" : "&pageToken=" + encode(token)));
            JSONArray files = page.optJSONArray("files"); if (files == null) throw new IOException("Drive trả về danh sách file không hợp lệ.");
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.getJSONObject(i); if (!isDesktopTrack(file, folder)) continue;
                if (ids.add(file.getString("id"))) tracks.add(file);
                if (tracks.size() > 10000) throw new IOException("Bộ sưu tập vượt giới hạn 10.000 file cho một lượt đồng bộ điện thoại.");
            }
            token = page.optString("nextPageToken", ""); if (token.length() > 8192) throw new IOException("Mã phân trang Drive vượt giới hạn.");
        } while (!token.isEmpty());
        return tracks;
    }

    private boolean isDesktopTrack(JSONObject file, String folder) {
        JSONObject properties = file.optJSONObject("properties");
        return SyncRules.validDriveId(file.optString("id")) && !file.optBoolean("trashed", false) && file.optString("name").toLowerCase(java.util.Locale.ROOT).endsWith(".flac")
            && properties != null && "desktop".equals(properties.optString("lumaSource")) && properties.optString("lumaTrackId").matches("[a-fA-F0-9]{64}")
            && properties.optString("lumaContentSha256").matches("[a-fA-F0-9]{64}") && hasParent(file, folder)
            && file.optString("md5Checksum").matches("[a-fA-F0-9]{32}") && !file.optString("version").isEmpty();
    }

    private boolean hasParent(JSONObject file, String folder) { JSONArray parents = file.optJSONArray("parents"); if (parents == null) return false; for (int i = 0; i < parents.length(); i++) if (folder.equals(parents.optString(i))) return true; return false; }
    private long validSize(JSONObject remote) throws IOException { try { long size = Long.parseLong(remote.getString("size")); if (size < 4 || size > SyncRules.MAX_FILE_BYTES) throw new IOException("File phải là FLAC từ 4 byte đến 2 GB."); return size; } catch (org.json.JSONException | NumberFormatException error) { throw new IOException("Kích thước file Drive không hợp lệ."); } }

    private void download(JSONObject remote, String folder, LibraryRepository repository) throws Exception {
        checkActive(); long size = validSize(remote); String id = remote.getString("id"); File directory = repository.musicDirectory();
        if (directory.getUsableSpace() < size + DISK_RESERVE) throw new IOException("Điện thoại chưa đủ dung lượng để lưu bản nhạc này.");
        File temporary = File.createTempFile("drive-", ".part", directory);
        try {
            progress("downloading", "Đang tải: " + remote.optJSONObject("properties").optString("title", remote.optString("name")));
            HttpURLConnection connection = open("files/" + id + "?alt=media"); MessageDigest sha256 = MessageDigest.getInstance("SHA-256"); long written = 0;
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(temporary)) {
                long advertised = connection.getContentLengthLong(); if (advertised > SyncRules.MAX_FILE_BYTES || advertised >= 0 && advertised != size) throw new IOException("Kích thước luồng tải khác metadata Drive.");
                byte[] buffer = new byte[128 * 1024]; int count;
                while ((count = input.read(buffer)) != -1) {
                    checkActive(); written += count; if (written > size || written > SyncRules.MAX_FILE_BYTES) throw new IOException("Luồng âm thanh vượt kích thước đã công bố.");
                    if (directory.getUsableSpace() < DISK_RESERVE + count) throw new IOException("Điện thoại gần hết dung lượng. Bản tải chưa được lưu.");
                    output.write(buffer, 0, count); sha256.update(buffer, 0, count);
                }
                output.getFD().sync();
            } finally { connection.disconnect(); activeConnection = null; }
            checkActive(); if (written != size) throw new IOException("Bản tải chưa đủ dung lượng.");
            if (!SyncRules.hex(sha256.digest()).equalsIgnoreCase(remote.getJSONObject("properties").getString("lumaContentSha256"))) throw new IOException("SHA-256 không khớp bản gốc từ máy tính.");
            SyncRules.verifyFlac(temporary, remote.getString("md5Checksum"), size); checkActive();
            LibraryRepository.PreparedDownload prepared = repository.prepareVerifiedDownload(temporary, remote);
            JSONObject current = json("files/" + id + "?fields=" + encode("id,name,size,md5Checksum,properties,version,mimeType,parents,trashed"));
            if (!isDesktopTrack(current, folder) || !remote.getString("version").equals(current.optString("version")) || !remote.getString("md5Checksum").equalsIgnoreCase(current.optString("md5Checksum")) || validSize(current) != size
                || !remote.getJSONObject("properties").getString("lumaTrackId").equals(current.getJSONObject("properties").optString("lumaTrackId"))) throw new IOException("File Drive đã thay đổi trong lúc tải. Sẽ lấy lại bản mới ở lượt tiếp theo.");
            synchronized (GoogleDriveAuth.SESSION_LOCK) { checkActive(); repository.publishPreparedDownload(prepared); }
        } finally { temporary.delete(); }
    }

    private JSONObject json(String relative) throws Exception {
        checkActive(); HttpURLConnection connection = open(relative);
        try (InputStream input = connection.getInputStream()) {
            long length = connection.getContentLengthLong(); if (length > JSON_LIMIT) throw new IOException("Phản hồi Drive vượt giới hạn 2 MB.");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count; long total = 0;
            while ((count = input.read(buffer)) != -1) { checkActive(); total += count; if (total > JSON_LIMIT) throw new IOException("Phản hồi Drive vượt giới hạn 2 MB."); bytes.write(buffer, 0, count); }
            return new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
        } finally { connection.disconnect(); activeConnection = null; }
    }

    /** Fixed HTTPS origin, no redirect credential forwarding, one token refresh after HTTP 401. */
    private HttpURLConnection open(String relative) throws Exception {
        if (!relative.startsWith("files") || relative.startsWith("//") || relative.contains("\r") || relative.contains("\n")) throw new IOException("Đường dẫn Drive không hợp lệ.");
        for (int attempt = 0; attempt < 2; attempt++) {
            checkActive(); String bearer = GoogleDriveAuth.accessToken(context, session, attempt > 0);
            URL url = new URL(API + relative); if (!"https".equals(url.getProtocol()) || !"www.googleapis.com".equals(url.getHost()) || url.getPort() != -1 || url.getUserInfo() != null) throw new IOException("Nguồn Drive không hợp lệ.");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection(); activeConnection = connection;
            connection.setInstanceFollowRedirects(false); connection.setRequestMethod("GET"); connection.setConnectTimeout(20000); connection.setReadTimeout(30000); connection.setUseCaches(false);
            connection.setRequestProperty("Authorization", "Bearer " + bearer); connection.setRequestProperty("Accept", relative.contains("alt=media") ? "application/octet-stream" : "application/json"); connection.setRequestProperty("Accept-Encoding", "identity");
            int code;
            try { code = connection.getResponseCode(); } catch (Exception error) { connection.disconnect(); activeConnection = null; throw error; }
            if (code >= 200 && code < 300) return connection;
            String response = errorText(connection); connection.disconnect(); activeConnection = null; checkActive();
            if (code == 401 && attempt == 0) { GoogleDriveAuth.clearToken(context, bearer); continue; }
            if (code == 401) throw new GoogleDriveAuth.NeedsLoginException("Quyền Google Drive đã hết hiệu lực. Mở tab Drive và kết nối lại.");
            if (code == 403 && !response.contains("rateLimitExceeded") && !response.contains("userRateLimitExceeded")) throw new DrivePermissionError("Drive từ chối truy cập. Bật Google Drive API, cấp quyền drive.file và đăng ký cùng dự án Google Cloud với bản Desktop.");
            if (code >= 300 && code < 400) throw new IOException("Drive yêu cầu chuyển hướng; Luma không chuyển tiếp token sang máy chủ khác.");
            if (code == 404) throw new IOException("File hoặc thư mục Drive đã bị xóa / không còn quyền truy cập.");
            if (code == 429 || code >= 500 || code == 403) throw new IOException("Drive đang bận hoặc giới hạn yêu cầu (HTTP " + code + ").");
            throw new IOException("Google Drive trả về HTTP " + code + ".");
        }
        throw new IOException("Không lấy được phản hồi Google Drive.");
    }

    private String errorText(HttpURLConnection connection) {
        try (InputStream input = connection.getErrorStream()) {
            if (input == null) return ""; ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count; int read = 0;
            while ((count = input.read(buffer)) != -1) { read += count; if (read > 65536 || isStopped() || SystemClock.elapsedRealtime() >= deadline) break; bytes.write(buffer, 0, count); }
            return bytes.toString(StandardCharsets.UTF_8.name());
        } catch (Exception ignored) { return ""; }
    }

    private static String encode(String value) throws Exception { return URLEncoder.encode(value, StandardCharsets.UTF_8.name()); }
    private static String friendly(Exception error) { String message = error.getMessage(); return message == null || message.trim().isEmpty() ? "Kiểm tra kết nối mạng rồi thử lại." : message.substring(0, Math.min(500, message.length())); }
    private static final class Cancelled extends Exception {}
    private static final class BudgetExceeded extends Exception {}
    private static final class DrivePermissionError extends IOException { DrivePermissionError(String message) { super(message); } }
}
