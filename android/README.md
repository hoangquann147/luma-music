# Luma Android 1.4.0

Native Java Android companion for Luma Desktop: local FLAC import/offline playback, MediaCodec → PCM → optional app DSP → AudioTrack foreground playback, MediaSession/notification controls, and incremental PC → Google Drive → Android sync. Light mobile UI uses Library / Sound / Drive / Settings.

Android 8.0+ (minSdk 26), compile SDK 36, target SDK 35, JDK 17, Gradle 8.13, AGP 8.13.2. Google Drive authorization uses Google Play services AuthorizationClient 22.0.0 and WorkManager 2.11.2. No broad storage permission: files are selected through Android's system picker and copied into app-private offline storage.

## Audio path

- Native FLAC STREAMINFO supplies original sample rate, channels and bit depth. Streaming decode supports mono/stereo. The actual decoder PCM representation is inspected; a requested 32-bit output never implies that the source or decoder has 32-bit precision.
- PCM 16-bit, float, packed 24-bit and integer 32-bit conversion. Integer 24/32 AudioTrack output requires API31+. The app retains the source sample rate; ordinary Android routing may still mix/resample it.
- Ten real RBJ/W3C parametric biquads: peak, low shelf, high shelf, frequency 20–20000Hz, gain ±12dB, damping Q 0.1–10. Independent stereo histories, 10ms crossfade on DSP changes, per-band bypass, overall bypass, named local presets and response graph labelled at 48kHz.
- Preamp -24–0dB and estimated automatic headroom follow EQ enable; left/right balance is independent. Final PCM conversion saturates overrange samples; headroom is not an arbitrary-transient limiter.
- USB bit-perfect uses **Android14+ preferred mixer APIs**, not a custom USB Host driver. It requires a supported advertised BIT_PERFECT format matching the source rate/channels and sufficient actual decoder/output precision. Unsupported combinations stop with a reason; there is no silent fallback or fake exclusive status.
- USB mode bypasses every DSP/volume operation. It monitors the platform preference and routed device; selected-device removal or preference/route changes request pause/flush and report an error. Hardware event delivery is asynchronous; this is not a zero-latency hardware interlock. Use the DAC's volume control.
- Source/decoder/output diagnostics stay visible alongside requested/confirmed routing status. The Sound page can copy device/Android/USB diagnostics, without secrets or music paths.
- DSD native/DoP, MQA and HiBy's proprietary USB driver/features are not included. API confirmation is not an external hardware measurement or a guarantee of support on a particular phone or DAC.

References: [Android USB mixer](https://developer.android.com/media/platform/improve-audio-playback), [AOSP preferred mixer attributes](https://source.android.com/docs/core/audio/preferred-mixer-attr), [W3C Audio EQ Cookbook](https://www.w3.org/TR/audio-eq-cookbook/).

## Build

Install JDK 17 and Android SDK platform 36 / build-tools 36.0.0. Set `ANDROID_HOME` or generate `local.properties` with the SDK path. Use the provided Gradle wrapper:

```powershell
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

Release builds use the same signing key for upgrade compatibility. Set environment variables `LUMA_KEYSTORE` (absolute PKCS12 path) and `LUMA_KEYSTORE_PASSWORD`; key alias is `luma`, then run:

```powershell
.\gradlew.bat :app:assembleRelease :app:testReleaseUnitTest :app:lintRelease
```

Use your own PKCS12 keystore with alias `luma`. Keep the same signing key for later updates. Never commit the keystore, its password or signing configuration containing credentials. A new signing key changes the SHA-1 used by Google OAuth and normally requires uninstalling the old APK before installing.

## Google setup

Enable Drive API and register an Android OAuth client in the SAME Google Cloud project as Luma Desktop. Use package `app.luma.music` and the certificate SHA-1 for the build you install. Inspect certificates with:

```powershell
.\gradlew.bat :app:signingReport
```

Debug and release certificates differ. Set the release signing environment variables before generating a report for that variant; register the corresponding Android OAuth client for each certificate you use.

No client secret or embedded Desktop OAuth client is used on Android. AuthorizationClient requests `https://www.googleapis.com/auth/drive.file`; tokens remain in memory and Google Play services renews authorized access. The APK plays imported local FLAC even before Google is configured. See [Google Drive setup](GOOGLE-DRIVE-SETUP.md).

## Sync protocol

The desktop creates a private folder with public custom file `properties: {lumaSyncRoot:'v1'}`; public properties do not make the file public. Both clients select the oldest accessible matching folder. Child FLAC files contain `properties.lumaSource='desktop'`, a stable SHA-256 path key `lumaTrackId`, content SHA-256 `lumaContentSha256`, and bounded title/artist/album/duration metadata.

Android pages the folder and streams changed files to private temporary files, checks size/FLAC marker/SHA-256/Drive MD5, rechecks the remote version, then commits the index under a session generation guard. An old offline version is retained until the new one commits. No remote deletion or cross-device deletion is mirrored. Worker scheduling is nominally 15 minutes, subject to Android constraints and power management; Wi-Fi/unmetered, storage and battery constraints default on.

The Android companion receives completed music from the PC. YouTube conversion and Spotify playlist download remain on the desktop. The companion supports native playback and cloud/offline library sync; it has no embedded Windows tools.

## Verification

The 1.4 audio update adds numerical DSP/PCM/FLAC-header tests and USB/settings precision rules. See VERIFICATION.md for final build, lint, tests, package and signature results. Tests cover measured sine-filter responses, independent channels, overlapping headroom, bit-exact integer conversion, float precision, malformed metadata, checksums and path-safe filenames.

Physical device/emulator playback, USB DAC output and live Google authorization/sync are not covered by the recorded verification. Hardware and account integration require separate testing after building and configuring your clients.
