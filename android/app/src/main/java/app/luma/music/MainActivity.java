package app.luma.music;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native Android UI; file access, playback and Drive jobs are handled by services. */
@SuppressWarnings("deprecation")
public final class MainActivity extends Activity {
    private static final int IMPORT_REQUEST = 4101;
    private static final int NOTIFICATION_REQUEST = 4102;
    private static final int PAPER = Color.rgb(248, 248, 252);
    private static final int LAVENDER = Color.rgb(238, 237, 245);
    private static final int BLUE = Color.rgb(77, 111, 161);
    private static final int INK = Color.rgb(48, 55, 70);
    private static final int MUTED = Color.rgb(137, 145, 160);
    private static final int LINE = Color.rgb(228, 231, 239);
    private static final int WHITE = Color.WHITE;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Map<String, View> trackRows = new LinkedHashMap<>();
    private LinearLayout root;
    private FrameLayout content;
    private TextView pageTitle, pageSubtitle, libraryCount, importButtonText;
    private TextView playerTitle, playerArtist, currentTime, totalTime;
    private TextView drivePhase, driveMessage, driveLastSync, driveConnection;
    private TextView driveConnectText, driveSyncText, driveStatusPill;
    private LinearLayout libraryTracks, driveConnectButton, driveSyncButton;
    private ProgressBar driveProgress;
    private SeekBar seekBar;
    private GlyphView playGlyph;
    private AudioSettingsView audioSettingsView;
    private View playButton, previousButton, nextButton;
    private final List<LinearLayout> tabButtons = new ArrayList<>();
    private List<LibraryRepository.Track> tracks = Collections.emptyList();
    private SharedPreferences preferences;
    private String selectedTab = "library";
    private String activeTrackId = "";
    private String librarySignature = "";
    private String previousError = "";
    private boolean isResumed;
    private boolean importing;
    private boolean seeking;
    private long playbackDuration;
    private int pollCount;

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            if (!isResumed) return;
            updatePlayer();
            if (pollCount++ % 4 == 0) { refreshLibrary(); updateDrive(); }
            handler.postDelayed(this, 500);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("luma_settings", MODE_PRIVATE);
        if (state != null) selectedTab = state.getString("tab", "library");
        getWindow().setStatusBarColor(PAPER);
        getWindow().setNavigationBarColor(PAPER);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        buildShell();
        showTab(selectedTab);
    }

    @Override protected void onResume() {
        super.onResume();
        isResumed = true; pollCount = 0;
        handler.removeCallbacks(poll); handler.post(poll);
    }

    @Override protected void onPause() {
        isResumed = false; handler.removeCallbacks(poll);
        super.onPause();
    }

    @Override protected void onDestroy() {
        handler.removeCallbacks(poll); io.shutdown();
        super.onDestroy();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("tab", selectedTab); super.onSaveInstanceState(state);
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        buildShell(); showTab(selectedTab);
    }

    private void buildShell() {
        tabButtons.clear();
        boolean compact = getResources().getConfiguration().screenHeightDp < 500;
        root = column(); root.setBackgroundColor(PAPER);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        setContentView(root);
        root.requestApplyInsets();

        LinearLayout header = row(); header.setPadding(dp(23), dp(compact ? 8 : 18), dp(23), dp(compact ? 9 : 16));
        LinearLayout heading = column();
        TextView brand = text("LUMA  /  YOUR PERSONAL SOUNDSPACE", 8, MUTED, true); brand.setLetterSpacing(.13f);
        if (compact) brand.setVisibility(View.GONE);
        heading.addView(brand);
        pageTitle = text("Thư viện", 28, INK, true); pageTitle.setPadding(0, dp(7), 0, 0); heading.addView(pageTitle);
        pageSubtitle = text("Âm nhạc, theo cách của bạn.", 11, MUTED, false); pageSubtitle.setPadding(0, dp(5), 0, 0); heading.addView(pageSubtitle);
        if (compact) pageSubtitle.setVisibility(View.GONE);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        FrameLayout mark = new FrameLayout(this); mark.setBackground(background(Color.rgb(229, 235, 246), 15, 0));
        GlyphView wave = new GlyphView("wave", BLUE); FrameLayout.LayoutParams waveParams = new FrameLayout.LayoutParams(dp(23), dp(23), Gravity.CENTER); mark.addView(wave, waveParams);
        header.addView(mark, new LinearLayout.LayoutParams(dp(43), dp(43)));
        root.addView(header, new LinearLayout.LayoutParams(-1, -2));

        content = new FrameLayout(this); root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        root.addView(buildPlayer(), new LinearLayout.LayoutParams(-1, -2));
        root.addView(buildNavigation(), new LinearLayout.LayoutParams(-1, dp(68)));
    }

    private View buildNavigation() {
        LinearLayout nav = row(); nav.setPadding(dp(12), dp(5), dp(12), dp(3)); nav.setBackgroundColor(PAPER);
        String[] ids = {"library", "sound", "drive", "settings"}; String[] labels = {"Thư viện", "Âm thanh", "Drive", "Cài đặt"}; String[] icons = {"library", "wave", "cloud", "settings"};
        for (int i = 0; i < ids.length; i++) {
            final String id = ids[i];
            LinearLayout item = column(); item.setGravity(Gravity.CENTER); item.setContentDescription(labels[i]);
            FrameLayout iconFrame = new FrameLayout(this); iconFrame.setTag("pill");
            GlyphView icon = new GlyphView(icons[i], MUTED); iconFrame.addView(icon, new FrameLayout.LayoutParams(dp(21), dp(21), Gravity.CENTER));
            item.addView(iconFrame, new LinearLayout.LayoutParams(dp(59), dp(31)));
            TextView label = text(labels[i], 10, MUTED, false); label.setPadding(0, dp(3), 0, 0); item.addView(label);
            item.setOnClickListener(view -> showTab(id)); item.setFocusable(true);
            nav.addView(item, new LinearLayout.LayoutParams(0, -1, 1)); tabButtons.add(item);
        }
        return nav;
    }

    private View buildPlayer() {
        LinearLayout player = column(); player.setPadding(dp(19), dp(12), dp(17), dp(4)); player.setBackgroundColor(LAVENDER);
        LinearLayout top = row();
        FrameLayout artwork = new FrameLayout(this); artwork.setBackground(background(Color.rgb(222, 225, 237), 11, 0));
        artwork.addView(new GlyphView("music", Color.rgb(127, 141, 166)), new FrameLayout.LayoutParams(dp(23), dp(23), Gravity.CENTER));
        top.addView(artwork, new LinearLayout.LayoutParams(dp(45), dp(45)));
        LinearLayout info = column(); info.setPadding(dp(12), 0, dp(8), 0);
        playerTitle = text("Chưa phát nhạc", 12, INK, true); oneLine(playerTitle); info.addView(playerTitle);
        playerArtist = text("Thêm một bài FLAC để bắt đầu", 10, MUTED, false); oneLine(playerArtist); playerArtist.setPadding(0, dp(5), 0, 0); info.addView(playerArtist);
        top.addView(info, new LinearLayout.LayoutParams(0, -2, 1));
        previousButton = iconButton("previous", "Bài trước", MUTED, () -> safeAction(() -> PlaybackService.previous(this)));
        top.addView(previousButton, new LinearLayout.LayoutParams(dp(34), dp(44)));
        FrameLayout play = new FrameLayout(this); play.setBackground(ripple(BLUE, 50)); play.setContentDescription("Phát nhạc");
        playGlyph = new GlyphView("play", WHITE); play.addView(playGlyph, new FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER));
        play.setOnClickListener(view -> { if (tracks.isEmpty()) { toast("Thêm file FLAC trong Thư viện để bắt đầu."); return; } notificationPermission(); safeAction(() -> PlaybackService.toggle(this)); });
        play.setFocusable(true); playButton = play; top.addView(play, new LinearLayout.LayoutParams(dp(40), dp(40)));
        nextButton = iconButton("next", "Bài tiếp theo", MUTED, () -> safeAction(() -> PlaybackService.next(this)));
        top.addView(nextButton, new LinearLayout.LayoutParams(dp(34), dp(44)));
        player.addView(top);

        LinearLayout seek = row(); currentTime = text("0:00", 9, MUTED, false); totalTime = text("0:00", 9, MUTED, false);
        seek.addView(currentTime, new LinearLayout.LayoutParams(dp(31), -2));
        seekBar = new SeekBar(this); seekBar.setMax(1000); seekBar.setProgressTintList(ColorStateList.valueOf(BLUE));
        seekBar.setThumbTintList(ColorStateList.valueOf(BLUE)); seekBar.setProgressBackgroundTintList(ColorStateList.valueOf(Color.rgb(208, 213, 226)));
        seekBar.setContentDescription("Vị trí phát nhạc"); seekBar.setPadding(dp(6), 0, dp(6), 0);
        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) { if (fromUser) currentTime.setText(formatTime(playbackDuration * progress / 1000)); }
            @Override public void onStartTrackingTouch(SeekBar bar) { seeking = true; }
            @Override public void onStopTrackingTouch(SeekBar bar) { safeAction(() -> PlaybackService.seekTo(MainActivity.this, playbackDuration * bar.getProgress() / 1000)); seeking = false; }
        });
        seek.addView(seekBar, new LinearLayout.LayoutParams(0, dp(34), 1)); totalTime.setGravity(Gravity.END); seek.addView(totalTime, new LinearLayout.LayoutParams(dp(33), -2));
        player.addView(seek); return player;
    }

    private void showTab(String tab) {
        selectedTab = tab; content.removeAllViews();
        audioSettingsView = null;
        libraryTracks = null; libraryCount = null; importButtonText = null;
        drivePhase = null; driveMessage = null; driveLastSync = null; driveConnection = null; driveProgress = null; driveStatusPill = null;
        driveConnectText = null; driveSyncText = null; driveConnectButton = null; driveSyncButton = null;
        int selected = "sound".equals(tab) ? 1 : "drive".equals(tab) ? 2 : "settings".equals(tab) ? 3 : 0;
        for (int i = 0; i < tabButtons.size(); i++) {
            LinearLayout item = tabButtons.get(i); FrameLayout pill = (FrameLayout) item.getChildAt(0);
            pill.setBackground(i == selected ? background(Color.rgb(222, 231, 248), 20, 0) : null);
            ((GlyphView) pill.getChildAt(0)).setColor(i == selected ? BLUE : MUTED);
            ((TextView) item.getChildAt(1)).setTextColor(i == selected ? BLUE : MUTED);
        }
        if (selected == 1) { pageTitle.setText("Âm thanh"); pageSubtitle.setText("Tinh chỉnh từng chi tiết."); buildSoundPage(); }
        else if (selected == 2) { pageTitle.setText("Google Drive"); pageSubtitle.setText("Đưa bộ sưu tập đến gần bạn hơn."); buildDrivePage(); }
        else if (selected == 3) { pageTitle.setText("Cài đặt"); pageSubtitle.setText("Những điều nhỏ, theo ý bạn."); buildSettingsPage(); }
        else { pageTitle.setText("Thư viện"); pageSubtitle.setText("Âm nhạc, theo cách của bạn."); buildLibraryPage(); }
        refreshLibrary(); updatePlayer(); updateDrive();
    }

    private void buildSoundPage() {
        audioSettingsView = new AudioSettingsView(this, () -> safeAction(() -> PlaybackService.applyAudioSettings(this)));
        content.addView(audioSettingsView, new FrameLayout.LayoutParams(-1, -1));
    }

    private LinearLayout scrollingPage() {
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setClipToPadding(false);
        LinearLayout page = column(); page.setPadding(dp(21), dp(2), dp(21), dp(21)); scroll.addView(page, new ScrollView.LayoutParams(-1, -2));
        content.addView(scroll, new FrameLayout.LayoutParams(-1, -1)); return page;
    }

    private void buildLibraryPage() {
        LinearLayout page = scrollingPage();
        LinearLayout hero = column(); hero.setPadding(dp(22), dp(23), dp(22), dp(21));
        GradientDrawable gradient = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{Color.rgb(234, 238, 248), Color.rgb(225, 232, 245)}); gradient.setCornerRadius(dp(18)); hero.setBackground(gradient);
        hero.addView(eyebrow("LESS NOISE. MORE MUSIC."));
        TextView title = text("Âm nhạc\nở bên bạn.", 28, Color.rgb(57, 73, 99), true); title.setLineSpacing(dp(1), 1); title.setPadding(0, dp(11), 0, dp(11)); hero.addView(title);
        hero.addView(paragraph("Mang những bản FLAC yêu thích vào Luma.\nLưu trên máy. Nghe cả khi không có mạng.", 11));
        LinearLayout importButton = actionButton("plus", "Thêm file FLAC", true, this::pickFiles); importButtonText = (TextView) importButton.getChildAt(1);
        LinearLayout.LayoutParams importParams = new LinearLayout.LayoutParams(-2, dp(43)); importParams.topMargin = dp(20); hero.addView(importButton, importParams);
        LinearLayout caption = row(); caption.setPadding(0, dp(15), 0, 0); caption.addView(new GlyphView("check", Color.rgb(139, 158, 180)), new LinearLayout.LayoutParams(dp(13), dp(13)));
        TextView captionText = text("  FLAC local · Không quảng cáo", 9, Color.rgb(142, 154, 176), false); caption.addView(captionText); hero.addView(caption);
        page.addView(hero);

        LinearLayout heading = row(); heading.setPadding(dp(1), dp(27), 0, dp(14));
        heading.addView(text("Bộ sưu tập của bạn", 16, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        libraryCount = pill("0 bài", Color.rgb(239, 241, 247), MUTED); heading.addView(libraryCount);
        heading.addView(iconButton("plus", "Thêm file FLAC", BLUE, this::pickFiles), new LinearLayout.LayoutParams(dp(35), dp(35)));
        page.addView(heading);
        libraryTracks = column(); page.addView(libraryTracks);
        TextView note = paragraph("File bạn chọn được sao chép vào vùng lưu trữ của Luma. File gốc vẫn được giữ nguyên.", 10); note.setPadding(dp(2), dp(17), dp(2), 0); page.addView(note);
        renderTracks();
    }

    private void renderTracks() {
        if (libraryTracks == null) return;
        libraryTracks.removeAllViews(); trackRows.clear();
        if (libraryCount != null) libraryCount.setText(tracks.size() + " bài");
        if (tracks.isEmpty()) {
            LinearLayout empty = column(); empty.setGravity(Gravity.CENTER); empty.setPadding(dp(23), dp(28), dp(23), dp(28)); empty.setBackground(background(WHITE, 14, LINE));
            GlyphView icon = new GlyphView("library", Color.rgb(154, 167, 190)); empty.addView(icon, new LinearLayout.LayoutParams(dp(34), dp(34)));
            TextView title = text("Bắt đầu từ một bài hát.", 13, Color.rgb(113, 125, 144), true); title.setPadding(0, dp(14), 0, dp(7)); empty.addView(title);
            TextView detail = paragraph("Nhấn Thêm file FLAC để tạo\nbộ sưu tập đầu tiên của bạn.", 11); detail.setGravity(Gravity.CENTER); empty.addView(detail);
            libraryTracks.addView(empty); return;
        }
        for (LibraryRepository.Track track : tracks) {
            LinearLayout item = row(); item.setPadding(dp(11), dp(11), dp(3), dp(11)); item.setBackground(background(track.id.equals(activeTrackId) ? Color.rgb(235, 240, 250) : WHITE, 12, track.id.equals(activeTrackId) ? Color.rgb(214, 225, 244) : LINE));
            FrameLayout art = new FrameLayout(this); art.setBackground(background(Color.rgb(232, 235, 244), 9, 0));
            art.addView(new GlyphView(track.id.equals(activeTrackId) ? "wave" : "music", Color.rgb(137, 154, 181)), new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER)); item.addView(art, new LinearLayout.LayoutParams(dp(43), dp(43)));
            LinearLayout info = column(); info.setPadding(dp(12), 0, dp(3), 0);
            TextView name = text(value(track.title, "Bài hát chưa có tên"), 12, track.id.equals(activeTrackId) ? BLUE : INK, true); oneLine(name); info.addView(name);
            TextView artist = text(value(track.artist, "Nghệ sĩ chưa rõ"), 10, MUTED, false); artist.setPadding(0, dp(5), 0, 0); oneLine(artist); info.addView(artist);
            LinearLayout meta = row(); meta.setPadding(0, dp(5), 0, 0); meta.addView(text("FLAC", 8, Color.rgb(130, 151, 181), true)); meta.addView(text("  ·  " + formatTime(track.durationMs), 8, Color.rgb(164, 172, 185), false)); info.addView(meta);
            item.addView(info, new LinearLayout.LayoutParams(0, -2, 1));
            View play = iconButton("play", "Phát " + name.getText(), BLUE, () -> play(track.id)); item.addView(play, new LinearLayout.LayoutParams(dp(35), dp(45)));
            View more = iconButton("more", "Tùy chọn " + name.getText(), MUTED, () -> trackOptions(track)); item.addView(more, new LinearLayout.LayoutParams(dp(28), dp(45)));
            item.setOnClickListener(view -> play(track.id)); item.setFocusable(true); item.setContentDescription("Phát " + name.getText() + ", " + artist.getText());
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(8); libraryTracks.addView(item, params); trackRows.put(track.id, item);
        }
    }

    private void pickFiles() {
        if (importing) { toast("Luma đang sao chép các file đã chọn…"); return; }
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT); picker.addCategory(Intent.CATEGORY_OPENABLE); picker.setType("audio/*");
        picker.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"audio/flac", "audio/x-flac"}); picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try { startActivityForResult(picker, IMPORT_REQUEST); } catch (Exception error) { showError("Không mở được trình chọn file", error); }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (GoogleDriveAuth.onActivityResult(this, requestCode, resultCode, data)) { updateDrive(); return; }
        if (requestCode != IMPORT_REQUEST || resultCode != RESULT_OK || data == null) return;
        List<Uri> uris = new ArrayList<>(); ClipData multiple = data.getClipData();
        if (multiple != null) for (int i = 0; i < multiple.getItemCount(); i++) { Uri uri = multiple.getItemAt(i).getUri(); if (!uris.contains(uri)) uris.add(uri); }
        else if (data.getData() != null) uris.add(data.getData());
        if (uris.isEmpty()) return;
        for (Uri uri : uris) try { getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { /* Immediate offline copying also works with a temporary grant. */ }
        importing = true; updateImportButton(); toast("Đang sao chép " + uris.size() + " file vào Luma…");
        io.execute(() -> {
            int succeeded = 0; List<String> errors = new ArrayList<>();
            for (Uri uri : uris) try { LibraryRepository.get(this).importUri(uri); succeeded++; } catch (Exception error) { errors.add(value(error.getMessage(), "Không đọc được một file FLAC.")); }
            final int count = succeeded;
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                importing = false; updateImportButton(); refreshLibrary();
                if (errors.isEmpty()) toast("Đã thêm " + count + " file. Sẵn sàng nghe offline.");
                else new AlertDialog.Builder(this).setTitle("Đã thêm " + count + "/" + uris.size() + " file").setMessage(String.join("\n\n", errors)).setPositiveButton("Đã hiểu", null).show();
            });
        });
    }

    private void updateImportButton() { if (importButtonText != null) importButtonText.setText(importing ? "Đang sao chép…" : "Thêm file FLAC"); }

    private void trackOptions(LibraryRepository.Track track) {
        new AlertDialog.Builder(this).setTitle(value(track.title, "Bài hát")).setItems(new String[]{"Phát bài hát", "Gỡ khỏi Luma"}, (dialog, which) -> {
            if (which == 0) play(track.id);
            else new AlertDialog.Builder(this).setTitle("Gỡ bài hát khỏi Luma?").setMessage("Xóa bản sao trong Luma. File gốc bạn đã chọn vẫn được giữ nguyên.").setNegativeButton("Giữ lại", null).setPositiveButton("Gỡ bài hát", (confirm, button) -> io.execute(() -> {
                try { PlaybackService.stopTrack(this,track.id); LibraryRepository.get(this).remove(track.id); runOnUiThread(() -> { if (!isDestroyed()) { refreshLibrary(); updatePlayer(); toast("Đã gỡ bài hát khỏi Luma."); } }); }
                catch (Exception error) { runOnUiThread(() -> { if (!isDestroyed()) showError("Không gỡ được bài hát", error); }); }
            })).show();
        }).show();
    }

    private void play(String id) { notificationPermission(); safeAction(() -> PlaybackService.play(this, id)); }

    private void refreshLibrary() {
        try {
            List<LibraryRepository.Track> latest = LibraryRepository.get(this).list();
            StringBuilder signature = new StringBuilder(); for (LibraryRepository.Track track : latest) signature.append(track.id).append('|').append(track.title).append('|').append(track.durationMs).append(';');
            tracks = latest;
            if (!librarySignature.contentEquals(signature)) { librarySignature = signature.toString(); renderTracks(); }
            updateImportButton();
        } catch (Exception error) { /* Keep the last rendered library during transient background updates. */ }
    }

    private void updatePlayer() {
        try {
            PlaybackService.State state = PlaybackService.getState(this); if (state == null) return;
            if (audioSettingsView != null) audioSettingsView.updateOutputInfo(state.outputInfo);
            String id = value(state.trackId, ""); boolean changed = !activeTrackId.equals(id); activeTrackId = id;
            playerTitle.setText(value(state.title, "Chưa phát nhạc")); playerArtist.setText(value(state.artist, id.isEmpty() ? "Thêm một bài FLAC để bắt đầu" : "FLAC · Lưu trên thiết bị"));
            playGlyph.setGlyph(state.playing ? "pause" : "play"); playButton.setContentDescription(state.playing ? "Tạm dừng" : "Phát nhạc");
            playbackDuration = Math.max(0, state.durationMs); totalTime.setText(formatTime(playbackDuration));
            if (!seeking) { currentTime.setText(formatTime(state.positionMs)); seekBar.setProgress(playbackDuration > 0 ? (int) Math.min(1000, state.positionMs * 1000 / playbackDuration) : 0); }
            seekBar.setEnabled(playbackDuration > 0 && !id.isEmpty());
            previousButton.setAlpha(tracks.isEmpty() ? .4f : 1); nextButton.setAlpha(tracks.isEmpty() ? .4f : 1);
            previousButton.setEnabled(!tracks.isEmpty()); nextButton.setEnabled(!tracks.isEmpty());
            if (changed) renderTracks();
            String error = value(state.error, ""); if (!error.isEmpty() && !error.equals(previousError)) toast(error); previousError = error;
        } catch (Exception ignored) { /* Service can be absent before first playback. */ }
    }

    private void buildDrivePage() {
        LinearLayout page = scrollingPage();
        LinearLayout intro = card(); intro.setPadding(dp(21), dp(22), dp(21), dp(21));
        FrameLayout cloud = new FrameLayout(this); cloud.setBackground(background(Color.rgb(233, 239, 249), 16, 0)); cloud.addView(new GlyphView("cloud", Color.rgb(113, 143, 183)), new FrameLayout.LayoutParams(dp(31), dp(31), Gravity.CENTER)); intro.addView(cloud, new LinearLayout.LayoutParams(dp(59), dp(59)));
        TextView title = text("Một bộ sưu tập.\nĐi cùng mọi nơi.", 25, Color.rgb(64, 80, 105), true); title.setPadding(0, dp(18), 0, dp(12)); intro.addView(title);
        intro.addView(paragraph("Kết nối Google Drive để tải nhạc FLAC về điện thoại. File đã tải nghe được khi không có mạng.", 12));
        driveConnection = text("Chưa kết nối tài khoản Google", 10, MUTED, false); driveConnection.setPadding(0, dp(19), 0, dp(11)); intro.addView(driveConnection);
        driveConnectButton = actionButton("google", "Kết nối Google Drive", true, () -> safeAction(() -> GoogleDriveAuth.connect(this))); driveConnectText = (TextView) driveConnectButton.getChildAt(1); intro.addView(driveConnectButton, new LinearLayout.LayoutParams(-1, dp(46)));
        TextView authNote = paragraph("Kết nối cần OAuth Android được cấu hình cho bản ứng dụng này. Hướng dẫn Google Cloud nằm trong Cài đặt.", 10); authNote.setPadding(0, dp(13), 0, 0); intro.addView(authNote);
        page.addView(intro);

        LinearLayout syncCard = card(); LinearLayout.LayoutParams syncParams = new LinearLayout.LayoutParams(-1, -2); syncParams.topMargin = dp(17); page.addView(syncCard, syncParams);
        LinearLayout syncTitle = row(); syncTitle.addView(text("Đồng bộ thư viện", 15, INK, true), new LinearLayout.LayoutParams(0, -2, 1)); driveStatusPill = pill("SẴN SÀNG", Color.rgb(239, 242, 248), MUTED); syncTitle.addView(driveStatusPill); syncCard.addView(syncTitle);
        drivePhase = text("Sẵn sàng khi bạn kết nối", 12, Color.rgb(111, 127, 150), true); drivePhase.setPadding(0, dp(18), 0, dp(7)); syncCard.addView(drivePhase);
        driveMessage = paragraph("Nhấn Đồng bộ ngay để cập nhật nhạc từ Google Drive.", 11); syncCard.addView(driveMessage);
        driveProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); driveProgress.setProgressTintList(ColorStateList.valueOf(BLUE)); driveProgress.setProgressBackgroundTintList(ColorStateList.valueOf(LINE)); driveProgress.setMax(100); driveProgress.setVisibility(View.GONE);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(-1, dp(5)); progressParams.topMargin = dp(15); syncCard.addView(driveProgress, progressParams);
        driveLastSync = text("Chưa có lần đồng bộ nào", 9, MUTED, false); driveLastSync.setPadding(0, dp(13), 0, dp(17)); syncCard.addView(driveLastSync);
        driveSyncButton = actionButton("sync", "Đồng bộ ngay", false, () -> {
            if (!GoogleDriveAuth.isConnected(this)) { toast("Kết nối tài khoản Google Drive trước khi đồng bộ."); return; }
            safeAction(() -> DriveSyncWorker.enqueueNow(this)); updateDrive();
        }); driveSyncText = (TextView) driveSyncButton.getChildAt(1); syncCard.addView(driveSyncButton, new LinearLayout.LayoutParams(-1, dp(43)));
        TextView note = paragraph("Đồng bộ tự động chạy theo lịch Android và điều kiện mạng. Bạn luôn có thể yêu cầu cập nhật thủ công.", 10); note.setPadding(dp(2), dp(17), dp(2), 0); page.addView(note);
    }

    private void updateDrive() {
        if (drivePhase == null) return;
        try {
            boolean connected = GoogleDriveAuth.isConnected(this); DriveSyncWorker.SyncStatus status = DriveSyncWorker.status(this);
            driveConnection.setText(connected ? "Đã kết nối Google Drive" : "Chưa kết nối tài khoản Google"); driveConnection.setTextColor(connected ? Color.rgb(116, 152, 131) : MUTED);
            driveConnectText.setText(connected ? "Đổi tài khoản Google" : "Kết nối Google Drive");
            driveSyncButton.setAlpha(connected ? 1 : .5f);
            if (status == null) return;
            String phase = value(status.phase, "idle"); boolean running = phase.equals("running") || phase.equals("syncing") || phase.equals("downloading") || phase.equals("scanning") || phase.equals("uploading");
            String label = phase.equals("error") || phase.equals("failed") ? "CẦN KIỂM TRA" : phase.equals("authorizing") ? "ĐANG KẾT NỐI" : phase.equals("queued") ? "ĐANG CHỜ" : phase.equals("waiting") ? "CHỜ MÁY TÍNH" : phase.equals("needs_login") ? "CHƯA CẤP QUYỀN" : running ? "ĐANG ĐỒNG BỘ" : connected ? "ĐÃ KẾT NỐI" : "CHƯA KẾT NỐI";
            driveStatusPill.setText(label); drivePhase.setText(running ? "Đang cập nhật bộ sưu tập…" : connected ? "Thư viện luôn ở bên bạn" : "Sẵn sàng khi bạn kết nối");
            driveMessage.setText(value(status.message, connected ? "Nhấn Đồng bộ ngay để cập nhật nhạc FLAC." : "Kết nối tài khoản để bắt đầu tải nhạc từ Drive."));
            driveProgress.setVisibility(running ? View.VISIBLE : View.GONE); driveProgress.setIndeterminate(status.total <= 0);
            if (status.total > 0) { driveProgress.setProgress(Math.min(100, status.done * 100 / status.total)); if (running) drivePhase.setText("Đang đồng bộ " + status.done + " / " + status.total + " file"); }
            driveLastSync.setText(status.lastSyncAt > 0 ? "Cập nhật gần nhất: " + android.text.format.DateFormat.format("dd/MM/yyyy · HH:mm", status.lastSyncAt) : "Chưa có lần đồng bộ hoàn tất");
            driveSyncText.setText(running ? "Đang đồng bộ…" : "Đồng bộ ngay"); driveSyncButton.setEnabled(!running);
        } catch (Exception ignored) { /* WorkManager may not yet have a status on the first frame. */ }
    }

    private void buildSettingsPage() {
        LinearLayout page = scrollingPage();
        LinearLayout sound = card(); sound.addView(sectionTitle("wave", "PCM, USB & Parametric EQ"));
        TextView soundDescription = paragraph("Chọn đầu ra, kiểm tra đường âm thanh và chỉnh PEQ 10 dải trong một nơi.", 11); soundDescription.setPadding(0, dp(13), 0, dp(15)); sound.addView(soundDescription);
        sound.addView(actionButton("wave", "Mở cài đặt âm thanh", false, () -> showTab("sound")), new LinearLayout.LayoutParams(-1, dp(43)));
        LinearLayout.LayoutParams soundParams = new LinearLayout.LayoutParams(-1, -2); soundParams.bottomMargin = dp(15); page.addView(sound, soundParams);
        LinearLayout sync = card(); sync.addView(sectionTitle("cloud", "Đồng bộ Google Drive"));
        addSwitch(sync, "Tự động đồng bộ", "Android cập nhật thư viện định kỳ khi điều kiện cho phép.", "auto_sync", true);
        divider(sync); addSwitch(sync, "Chỉ dùng Wi-Fi", "Ưu tiên tải nhạc khi có kết nối không tính phí.", "wifi_only", true); page.addView(sync);

        LinearLayout account = card(); LinearLayout.LayoutParams accountParams = new LinearLayout.LayoutParams(-1, -2); accountParams.topMargin = dp(15); page.addView(account, accountParams);
        account.addView(sectionTitle("google", "Tài khoản Google"));
        TextView authDescription = paragraph("Đăng nhập dùng OAuth Android của Google. Bản ứng dụng cần được đăng ký đúng package và SHA-1; không cần nhập Client ID vào Luma.", 11); authDescription.setPadding(0, dp(13), 0, dp(16)); account.addView(authDescription);
        account.addView(actionButton("cloud", GoogleDriveAuth.isConnected(this) ? "Mở trang Google Drive" : "Thiết lập kết nối", false, () -> showTab("drive")), new LinearLayout.LayoutParams(-1, dp(43)));
        if (GoogleDriveAuth.isConnected(this)) {
            TextView disconnect = text("Ngắt kết nối Google Drive", 11, Color.rgb(166, 126, 128), false); disconnect.setGravity(Gravity.CENTER); disconnect.setPadding(0, dp(16), 0, dp(5)); disconnect.setOnClickListener(view -> new AlertDialog.Builder(this).setTitle("Ngắt kết nối Google Drive?").setMessage("Nhạc đã tải trên máy vẫn được giữ. Đồng bộ sẽ dừng cho đến khi bạn kết nối lại.").setNegativeButton("Giữ kết nối", null).setPositiveButton("Ngắt kết nối", (dialog, which) -> { safeAction(() -> { DriveSyncWorker.cancel(this); GoogleDriveAuth.disconnect(this); }); showTab("settings"); }).show()); account.addView(disconnect);
        }

        LinearLayout help = card(); LinearLayout.LayoutParams helpParams = new LinearLayout.LayoutParams(-1, -2); helpParams.topMargin = dp(15); page.addView(help, helpParams);
        help.addView(sectionTitle("link", "Hướng dẫn Google & OAuth"));
        TextView helpDescription = paragraph("Dành cho thiết lập ứng dụng trên Google Cloud. Những liên kết dưới đây mở trang web chính thức của Google.", 10); helpDescription.setPadding(0, dp(12), 0, dp(9)); help.addView(helpDescription);
        help.addView(helpLink("Google Cloud Console", "Tạo dự án và bật Google Drive API", "https://console.cloud.google.com/")); divider(help);
        help.addView(helpLink("OAuth cho Android", "Package name và dấu vân tay chứng thư", "https://developers.google.com/identity/protocols/oauth2/native-app")); divider(help);
        help.addView(helpLink("Quyền truy cập Google Drive", "Tài liệu xác thực và phạm vi quyền", "https://developers.google.com/workspace/drive/api/guides/api-specific-auth"));

        LinearLayout about = card(); LinearLayout.LayoutParams aboutParams = new LinearLayout.LayoutParams(-1, -2); aboutParams.topMargin = dp(15); page.addView(about, aboutParams);
        about.addView(sectionTitle("wave", "Luma · Android 1.4.0")); TextView quality = paragraph("FLAC được giải mã thành PCM trên thiết bị. PEQ xử lý trực tiếp mẫu âm thanh. USB bit-perfect cần Android 14 trở lên và hỗ trợ từ điện thoại cùng DAC. Chất lượng Bluetooth còn phụ thuộc codec của kết nối.\n\nNhạc local không cần tài khoản Google. Dữ liệu nhập được sao chép để sử dụng offline.", 10); quality.setPadding(0, dp(13), 0, 0); about.addView(quality);
    }

    private void addSwitch(LinearLayout parent, String title, String description, String key, boolean defaultValue) {
        LinearLayout item = row(); item.setPadding(0, dp(15), 0, dp(14)); LinearLayout words = column(); words.addView(text(title, 12, INK, true));
        TextView detail = paragraph(description, 10); detail.setPadding(0, dp(6), dp(12), 0); words.addView(detail); item.addView(words, new LinearLayout.LayoutParams(0, -2, 1));
        Switch toggle = new Switch(this); toggle.setContentDescription(title); toggle.setChecked(preferences.getBoolean(key, defaultValue));
        toggle.setThumbTintList(new ColorStateList(new int[][]{new int[]{android.R.attr.state_checked}, new int[]{}}, new int[]{BLUE, Color.rgb(174, 182, 197)}));
        toggle.setTrackTintList(new ColorStateList(new int[][]{new int[]{android.R.attr.state_checked}, new int[]{}}, new int[]{Color.rgb(195, 211, 236), Color.rgb(224, 227, 235)}));
        toggle.setOnCheckedChangeListener((button, checked) -> { preferences.edit().putBoolean(key, checked).apply(); safeAction(() -> DriveSyncWorker.configurePeriodic(this)); }); item.addView(toggle); parent.addView(item);
    }

    private View helpLink(String title, String detail, String url) {
        LinearLayout link = row(); link.setPadding(0, dp(13), 0, dp(13)); link.setBackground(ripple(WHITE, 7));
        LinearLayout words = column(); words.addView(text(title, 11, BLUE, true)); TextView note = paragraph(detail, 9); note.setPadding(0, dp(5), 0, 0); words.addView(note); link.addView(words, new LinearLayout.LayoutParams(0, -2, 1));
        link.addView(new GlyphView("external", Color.rgb(153, 167, 187)), new LinearLayout.LayoutParams(dp(17), dp(17))); link.setFocusable(true); link.setContentDescription(title + ", mở trang web Google");
        link.setOnClickListener(view -> { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception error) { toast("Không tìm thấy trình duyệt để mở hướng dẫn."); } }); return link;
    }

    private void notificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && !preferences.getBoolean("asked_notifications", false)) {
            preferences.edit().putBoolean("asked_notifications", true).apply(); requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
        }
    }

    private void safeAction(Runnable action) { try { action.run(); updatePlayer(); } catch (Exception error) { showError("Chưa thực hiện được", error); } }
    private void showError(String title, Exception error) { new AlertDialog.Builder(this).setTitle(title).setMessage(value(error.getMessage(), "Vui lòng thử lại.")).setPositiveButton("Đã hiểu", null).show(); }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    private String value(String input, String fallback) { return input == null || input.trim().isEmpty() ? fallback : input; }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private static String formatTime(long milliseconds) { long seconds = Math.max(0, milliseconds) / 1000; return String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60); }
    private LinearLayout column() { LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); return layout; }
    private LinearLayout row() { LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.HORIZONTAL); layout.setGravity(Gravity.CENTER_VERTICAL); return layout; }
    private TextView text(String value, float size, int color, boolean medium) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); view.setIncludeFontPadding(false); view.setTypeface(Typeface.create(medium ? "sans-serif-medium" : "sans-serif", Typeface.NORMAL)); return view; }
    private TextView paragraph(String value, float size) { TextView view = text(value, size, MUTED, false); view.setLineSpacing(dp(3), 1.08f); return view; }
    private void oneLine(TextView view) { view.setSingleLine(true); view.setEllipsize(android.text.TextUtils.TruncateAt.END); }
    private TextView eyebrow(String value) { TextView label = text(value, 8, Color.rgb(132, 146, 169), true); label.setLetterSpacing(.14f); return label; }
    private TextView pill(String value, int color, int textColor) { TextView view = text(value, 8, textColor, true); view.setPadding(dp(9), dp(6), dp(9), dp(6)); view.setBackground(background(color, 8, 0)); return view; }
    private LinearLayout card() { LinearLayout layout = column(); layout.setPadding(dp(18), dp(19), dp(18), dp(18)); layout.setBackground(background(WHITE, 15, LINE)); return layout; }
    private View sectionTitle(String icon, String title) { LinearLayout row = row(); row.addView(new GlyphView(icon, Color.rgb(133, 153, 180)), new LinearLayout.LayoutParams(dp(21), dp(21))); TextView label = text(title, 13, INK, true); label.setPadding(dp(10), 0, 0, 0); row.addView(label); return row; }
    private void divider(LinearLayout parent) { View line = new View(this); line.setBackgroundColor(LINE); parent.addView(line, new LinearLayout.LayoutParams(-1, dp(1))); }
    private GradientDrawable background(int color, int radius, int stroke) { GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radius)); if (stroke != 0) drawable.setStroke(dp(1), stroke); return drawable; }
    private RippleDrawable ripple(int color, int radius) { return new RippleDrawable(ColorStateList.valueOf(Color.argb(28, 90, 119, 168)), background(color, radius, 0), null); }
    private LinearLayout actionButton(String icon, String title, boolean primary, Runnable action) {
        LinearLayout button = row(); button.setGravity(Gravity.CENTER); button.setPadding(dp(14), 0, dp(14), 0); button.setMinimumHeight(dp(43)); button.setBackground(ripple(primary ? BLUE : Color.rgb(240, 244, 250), 10)); button.setFocusable(true); button.setContentDescription(title);
        button.addView(new GlyphView(icon, primary ? WHITE : BLUE), new LinearLayout.LayoutParams(dp(17), dp(17))); TextView label = text(title, 11, primary ? WHITE : BLUE, true); label.setPadding(dp(9), 0, 0, 0); button.addView(label); button.setOnClickListener(view -> action.run()); return button;
    }
    private View iconButton(String icon, String description, int color, Runnable action) { FrameLayout button = new FrameLayout(this); button.setContentDescription(description); button.setFocusable(true); button.setBackground(ripple(Color.TRANSPARENT, 12)); button.addView(new GlyphView(icon, color), new FrameLayout.LayoutParams(dp(19), dp(19), Gravity.CENTER)); button.setOnClickListener(view -> action.run()); return button; }

    /** Small scalable line icons without fonts, bitmap assets or an icon dependency. */
    private final class GlyphView extends View {
        private String glyph; private int color; private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        GlyphView(String glyph, int color) { super(MainActivity.this); this.glyph = glyph; this.color = color; setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); }
        void setColor(int color) { this.color = color; invalidate(); }
        void setGlyph(String glyph) { if (!this.glyph.equals(glyph)) { this.glyph = glyph; invalidate(); } }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas); canvas.save(); float scale = Math.min(getWidth(), getHeight()) / 24f; canvas.translate((getWidth() - scale * 24) / 2, (getHeight() - scale * 24) / 2); canvas.scale(scale, scale);
            paint.setColor(color); paint.setStrokeWidth(1.7f); paint.setStyle(Paint.Style.STROKE); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND); Path path = new Path();
            switch (glyph) {
                case "play": paint.setStyle(Paint.Style.FILL); path.moveTo(8, 5); path.lineTo(19, 12); path.lineTo(8, 19); path.close(); canvas.drawPath(path, paint); break;
                case "pause": paint.setStyle(Paint.Style.FILL); canvas.drawRoundRect(new RectF(7, 5, 10, 19), 1, 1, paint); canvas.drawRoundRect(new RectF(14, 5, 17, 19), 1, 1, paint); break;
                case "previous": canvas.drawLine(6, 6, 6, 18, paint); paint.setStyle(Paint.Style.FILL); path.moveTo(18, 5); path.lineTo(9, 12); path.lineTo(18, 19); path.close(); canvas.drawPath(path, paint); break;
                case "next": canvas.drawLine(18, 6, 18, 18, paint); paint.setStyle(Paint.Style.FILL); path.moveTo(6, 5); path.lineTo(15, 12); path.lineTo(6, 19); path.close(); canvas.drawPath(path, paint); break;
                case "plus": canvas.drawLine(12, 5, 12, 19, paint); canvas.drawLine(5, 12, 19, 12, paint); break;
                case "music": path.moveTo(9, 17); path.lineTo(9, 6); path.lineTo(19, 4); path.lineTo(19, 15); canvas.drawPath(path, paint); canvas.drawOval(new RectF(3, 15, 9, 20), paint); canvas.drawOval(new RectF(13, 13, 19, 18), paint); break;
                case "library": canvas.drawRoundRect(new RectF(4, 5, 10, 20), 1, 1, paint); canvas.drawLine(14, 5, 14, 20, paint); canvas.drawLine(17, 4, 21, 19, paint); canvas.drawLine(6, 9, 8, 9, paint); break;
                case "cloud": path.moveTo(7, 18); path.cubicTo(1, 18, 1, 10, 6, 9); path.cubicTo(8, 1, 18, 3, 18, 10); path.cubicTo(24, 10, 24, 18, 18, 18); path.close(); canvas.drawPath(path, paint); break;
                case "settings": canvas.drawLine(4, 6, 20, 6, paint); canvas.drawLine(4, 12, 20, 12, paint); canvas.drawLine(4, 18, 20, 18, paint); paint.setStyle(Paint.Style.FILL); canvas.drawCircle(9, 6, 3, paint); canvas.drawCircle(16, 12, 3, paint); canvas.drawCircle(8, 18, 3, paint); break;
                case "wave": for (int i = 0; i < 5; i++) { float height = new float[]{5, 12, 17, 10, 5}[i]; canvas.drawLine(4 + i * 4, 12 - height / 2, 4 + i * 4, 12 + height / 2, paint); } break;
                case "check": path.moveTo(5, 12); path.lineTo(10, 17); path.lineTo(19, 7); canvas.drawPath(path, paint); break;
                case "sync": path.moveTo(19, 8); path.cubicTo(15, 1, 4, 4, 4, 12); path.moveTo(19, 4); path.lineTo(19, 8); path.lineTo(15, 8); path.moveTo(5, 16); path.cubicTo(9, 23, 20, 20, 20, 12); path.moveTo(5, 20); path.lineTo(5, 16); path.lineTo(9, 16); canvas.drawPath(path, paint); break;
                case "external": path.moveTo(14, 4); path.lineTo(20, 4); path.lineTo(20, 10); path.moveTo(20, 4); path.lineTo(11, 13); path.moveTo(10, 5); path.lineTo(5, 5); path.lineTo(5, 20); path.lineTo(19, 20); path.lineTo(19, 14); canvas.drawPath(path, paint); break;
                case "link": canvas.drawArc(new RectF(2, 9, 14, 21), 40, 270, false, paint); canvas.drawArc(new RectF(10, 3, 22, 15), 220, 270, false, paint); canvas.drawLine(8, 16, 16, 8, paint); break;
                case "google": paint.setStrokeWidth(2.2f); canvas.drawArc(new RectF(4, 4, 20, 20), 42, 277, false, paint); path.moveTo(20, 12); path.lineTo(13, 12); path.moveTo(20, 12); path.lineTo(20, 17); canvas.drawPath(path, paint); break;
                case "more": paint.setStyle(Paint.Style.FILL); canvas.drawCircle(12, 6, 1.3f, paint); canvas.drawCircle(12, 12, 1.3f, paint); canvas.drawCircle(12, 18, 1.3f, paint); break;
            }
            canvas.restore();
        }
    }
}
