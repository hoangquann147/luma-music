package app.luma.music;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.SystemClock;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Tasks;
import java.io.IOException;
import java.util.Collections;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.TimeUnit;

/** Native Google authorization. Tokens remain in RAM; no web client secret or refresh token. */
public final class GoogleDriveAuth {
    public static final int REQUEST_AUTH = 8401;
    public static final String DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
    public static final Object SESSION_LOCK = new Object();
    private static final Object TOKEN_LOCK = new Object();
    private static volatile String token;
    private static volatile long tokenUntil;
    private static volatile long tokenGeneration = -1;
    private GoogleDriveAuth() {}

    static SharedPreferences prefs(Context context) { return context.getSharedPreferences("luma_settings", Context.MODE_PRIVATE); }
    public static boolean isConnected(Context context) { return prefs(context).getBoolean("drive_connected", false); }
    static long generation(Context context) { return prefs(context).getLong("drive_session_generation", 0); }
    static boolean active(Context context, long generation) { return isConnected(context) && generation(context) == generation; }

    private static AuthorizationRequest request(boolean chooseAccount) {
        AuthorizationRequest.Builder builder = AuthorizationRequest.builder().setRequestedScopes(Collections.singletonList(new Scope(DRIVE_SCOPE)));
        if (chooseAccount) builder.setPrompt(AuthorizationRequest.Prompt.SELECT_ACCOUNT);
        return builder.build();
    }

    public static void connect(Activity activity) {
        final long session;
        synchronized (SESSION_LOCK) {
            session = generation(activity) + 1;
            prefs(activity).edit().putBoolean("drive_connected", false).putLong("drive_session_generation", session).putLong("drive_pending_generation", session).apply();
            token = null; tokenUntil = 0; tokenGeneration = -1;
        }
        DriveSyncWorker.cancel(activity);
        DriveSyncWorker.publishStatus(activity, "authorizing", "Đang yêu cầu quyền Google Drive…", 0, 0, -1);
        try { Identity.getAuthorizationClient(activity).authorize(request(true))
            .addOnSuccessListener(result -> {
                if (activity.isDestroyed() || generation(activity) != session) return;
                try {
                    if (result.hasResolution()) {
                        if (result.getPendingIntent() == null) throw new NeedsLoginException("Google chưa cung cấp màn hình cấp quyền. Hãy thử kết nối lại.");
                        activity.startIntentSenderForResult(result.getPendingIntent().getIntentSender(), REQUEST_AUTH, null, 0, 0, 0);
                    } else accepted(activity, result, session);
                } catch (Exception error) { failed(activity, session, message(error)); }
            })
            .addOnFailureListener(error -> failed(activity, session, message(error))); }
        catch (Exception error) { failed(activity, session, message(error)); }
    }

    public static boolean onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_AUTH) return false;
        long session = prefs(activity).getLong("drive_pending_generation", -1);
        if (session < 0 || generation(activity) != session) return true;
        if (resultCode != Activity.RESULT_OK || data == null) {
            failed(activity, session, "Chưa cấp quyền Google Drive. Bạn vẫn có thể nghe nhạc local."); return true;
        }
        try { accepted(activity, Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(data), session); }
        catch (Exception error) { failed(activity, session, message(error)); }
        return true;
    }

    private static String validated(AuthorizationResult result) throws NeedsLoginException {
        if (result.hasResolution()) throw new NeedsLoginException("Google cần bạn cấp quyền. Mở Drive và kết nối lại.");
        if (result.getAccessToken() == null || result.getAccessToken().trim().isEmpty() || result.getGrantedScopes() == null || !result.getGrantedScopes().contains(DRIVE_SCOPE))
            throw new NeedsLoginException("Chưa được cấp quyền drive.file. Kết nối lại và cho phép Luma truy cập file do ứng dụng tạo.");
        return result.getAccessToken();
    }

    private static void accepted(Context context, AuthorizationResult result, long session) throws NeedsLoginException {
        String granted = validated(result);
        synchronized (SESSION_LOCK) {
            if (generation(context) != session) return;
            token = granted; tokenUntil = SystemClock.elapsedRealtime() + TimeUnit.MINUTES.toMillis(50); tokenGeneration = session;
            prefs(context).edit().putBoolean("drive_connected", true).remove("drive_pending_generation").apply();
        }
        DriveSyncWorker.publishStatus(context, "idle", "Đã cấp quyền Google Drive. Đang chờ đồng bộ…", 0, 0, -1);
        DriveSyncWorker.enqueueNow(context); DriveSyncWorker.configurePeriodic(context);
    }

    private static void failed(Context context, long session, String detail) {
        synchronized (SESSION_LOCK) {
            if (generation(context) != session) return;
            prefs(context).edit().putBoolean("drive_connected", false).remove("drive_pending_generation").apply();
            token = null; tokenUntil = 0; tokenGeneration = -1;
            DriveSyncWorker.publishStatus(context, "needs_login", detail, 0, 0, -1);
        }
    }

    /** Local disconnect only; deliberately does not revoke project-wide OAuth grants. */
    public static void disconnect(Context context) {
        synchronized (SESSION_LOCK) {
            prefs(context).edit().putBoolean("drive_connected", false).putLong("drive_session_generation", generation(context) + 1).remove("drive_pending_generation").apply();
            token = null; tokenUntil = 0; tokenGeneration = -1;
            DriveSyncWorker.publishStatus(context, "idle", "Đã ngắt kết nối trên điện thoại. Nhạc đã tải vẫn được giữ.", 0, 0, -1);
        }
        DriveSyncWorker.cancel(context);
    }

    /** Call only on a worker thread; silently refreshes grants and never launches UI. */
    static String accessToken(Context context, long session, boolean force) throws Exception {
        if (!active(context, session)) throw new NeedsLoginException("Chưa kết nối Google Drive. Mở tab Drive để cấp quyền.");
        synchronized (TOKEN_LOCK) {
            synchronized (SESSION_LOCK) {
                if (!active(context, session)) throw new NeedsLoginException("Phiên Google Drive đã thay đổi.");
                if (!force && token != null && tokenGeneration == session && tokenUntil > SystemClock.elapsedRealtime()) return token;
            }
            AuthorizationResult result;
            try { result = Tasks.await(Identity.getAuthorizationClient(context).authorize(request(false)), 20, TimeUnit.SECONDS); }
            catch (TimeoutException error) { throw new IOException("Google chưa phản hồi yêu cầu token. Sẽ thử lại sau.", error); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException("Đã dừng yêu cầu Google Drive.", error); }
            catch (ExecutionException error) {
                Throwable cause = error.getCause();
                if (cause instanceof ApiException) {
                    int code = ((ApiException) cause).getStatusCode();
                    if (code == 7 || code == 8 || code == 14 || code == 15 || code == 17 || code == 19 || code == 20 || code == 21 || code == 22)
                        throw new IOException("Google Play services chưa phản hồi hoặc kết nối mạng bị gián đoạn. Sẽ thử lại sau.", error);
                }
                throw new NeedsLoginException(message(error));
            }
            String granted = validated(result);
            synchronized (SESSION_LOCK) {
                if (!active(context, session)) throw new NeedsLoginException("Phiên Google Drive đã thay đổi.");
                token = granted; tokenGeneration = session; tokenUntil = SystemClock.elapsedRealtime() + TimeUnit.MINUTES.toMillis(50);
            }
            return granted;
        }
    }

    static void clearToken(Context context, String invalid) throws Exception {
        synchronized (SESSION_LOCK) {
            if (invalid != null && invalid.equals(token)) { token = null; tokenUntil = 0; tokenGeneration = -1; }
        }
        if (invalid != null && !invalid.isEmpty()) Tasks.await(Identity.getAuthorizationClient(context).clearToken(ClearTokenRequest.builder().setToken(invalid).build()), 15, TimeUnit.SECONDS);
    }

    static void needsLogin(Context context, long session, String detail) {
        synchronized (SESSION_LOCK) {
            if (generation(context) != session) return;
            prefs(context).edit().putBoolean("drive_connected", false).putLong("drive_session_generation", session + 1).apply();
            token = null; tokenUntil = 0; tokenGeneration = -1;
            DriveSyncWorker.publishStatus(context, "needs_login", detail, 0, 0, -1);
        }
        DriveSyncWorker.configurePeriodic(context);
    }

    private static String message(Throwable error) {
        Throwable cause = error; while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        if (cause instanceof ApiException) {
            int code = ((ApiException) cause).getStatusCode();
            if (code == 10 || code == 12500) return "OAuth Android chưa được cấu hình đúng. Đăng ký package app.luma.music và SHA-1 của bản APK trong cùng dự án Google Cloud với Luma Desktop; xem Cài đặt.";
            if (code == 12501 || code == 16) return "Bạn chưa hoàn tất cấp quyền Google Drive. Có thể kết nối lại bất cứ lúc nào.";
        }
        return "Google chưa cấp quyền Drive. Kiểm tra mạng, Google Play services và cấu hình OAuth Android trong Google Cloud. " + (cause.getMessage() == null ? "" : cause.getMessage());
    }

    public static final class NeedsLoginException extends Exception { NeedsLoginException(String message) { super(message); } }
}
