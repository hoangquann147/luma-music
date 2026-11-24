//! Desktop lifetime and Windows media controls. Install on Tauri's main thread
//! after creating the main window; neither controls depend on the WebView running.
use crate::{commands, common::*};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Listener, Manager,
};

struct DesktopControls {
    tray: Option<TrayIcon>,
    #[cfg(windows)]
    media: Option<souvlaki::MediaControls>,
    metadata_key: String,
    errors: Vec<String>,
}
type SharedControls = Arc<Mutex<DesktopControls>>;

/// Errors in optional shell integrations are reported without making playback
/// unusable. In particular, a missing tray never strands an invisible window.
pub fn install(handle: &AppHandle, state: Arc<App>) -> Result<()> {
    if state.test_mode && !std::env::args().any(|arg| arg == "--self-test-desktop-controls") {
        return Ok(());
    }
    let window = handle
        .get_webview_window("main")
        .ok_or("Không tìm thấy cửa sổ Luma.")?;
    let mut errors = Vec::new();
    let tray = match create_tray(handle, state.clone()) {
        Ok(tray) => Some(tray),
        Err(error) => {
            errors.push(format!("Không tạo được khay hệ thống: {error}"));
            None
        }
    };
    let tray_ready = tray.is_some();
    #[cfg(windows)]
    let media = match create_media(handle, state.clone()) {
        Ok(media) => Some(media),
        Err(error) => {
            errors.push(format!("Windows SMTC chưa sẵn sàng: {error}"));
            None
        }
    };
    let controls = Arc::new(Mutex::new(DesktopControls {
        tray,
        #[cfg(windows)]
        media,
        metadata_key: "\0".to_owned(),
        errors,
    }));
    handle.manage(controls.clone());
    let close_window = window.clone();
    let close_state = state.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if should_hide_on_close(
                b(&close_state.settings(), "minimizeToTray"),
                tray_ready,
                close_state.closing.load(Ordering::Relaxed),
            ) {
                // Prevent closing only after a successful hide. If the shell
                // integration or hide fails, the normal Quit path remains usable.
                if close_window.hide().is_ok() {
                    api.prevent_close();
                }
            }
        }
    });
    let update_handle = handle.clone();
    let update_state = state.clone();
    handle.listen("music:playback-state", move |event| {
        let Ok(playback) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        let controls = controls.clone();
        let state = update_state.clone();
        // COM controls are initialized and updated on the UI thread. The audio
        // output worker only publishes its state and never waits for shell work.
        let _ = update_handle.run_on_main_thread(move || {
            if let Ok(mut controls) = controls.lock() {
                if let Err(error) = update_media(&mut controls, &state, &playback) {
                    remember_error(&mut controls, format!("Windows SMTC: {error}"));
                }
            }
        });
    });
    let current = commands::dispatch(&state, "audioState", vec![]).unwrap_or(Value::Null);
    if let Some(controls) = handle.try_state::<SharedControls>() {
        if let Ok(mut controls) = controls.lock() {
            if let Err(error) = update_media(&mut controls, &state, &current) {
                remember_error(&mut controls, format!("Windows SMTC: {error}"));
            }
        }
    }
    state.emit("music:desktop-status", &status(handle));
    Ok(())
}

fn should_hide_on_close(enabled: bool, tray_ready: bool, quitting: bool) -> bool {
    enabled && tray_ready && !quitting
}

fn show(handle: &AppHandle) -> Result<()> {
    let window = handle
        .get_webview_window("main")
        .ok_or("Không tìm thấy cửa sổ Luma.")?;
    window.show().map_err(err)?;
    window.unminimize().map_err(err)?;
    window.set_focus().map_err(err)
}

fn quit(handle: &AppHandle, state: &Arc<App>) {
    // Setting the flag first makes an explicit Quit bypass close-to-tray.
    // The application's ExitRequested path stops the output worker and releases
    // any exclusive device before process termination.
    state.closing.store(true, Ordering::Relaxed);
    handle.exit(0);
}

fn run_audio(state: Arc<App>, command: Value) {
    std::thread::spawn(move || {
        if let Err(error) = commands::dispatch(&state, "audioCommand", vec![command]) {
            let handle = { state.handle.lock().unwrap().as_ref().cloned() };
            if let Some(handle) = handle {
                if let Some(controls) = handle.try_state::<SharedControls>() {
                    if let Ok(mut controls) = controls.lock() {
                        remember_error(&mut controls, error);
                    }
                }
                state.emit("music:desktop-status", &status(&handle));
            }
        }
    });
}

fn create_tray(handle: &AppHandle, state: Arc<App>) -> Result<TrayIcon> {
    let play = MenuItem::with_id(handle, "luma-play-pause", "Play/Pause", true, None::<&str>)
        .map_err(err)?;
    let next =
        MenuItem::with_id(handle, "luma-next", "Next Track", true, None::<&str>).map_err(err)?;
    let show_app =
        MenuItem::with_id(handle, "luma-show", "Show App", true, None::<&str>).map_err(err)?;
    let quit_app =
        MenuItem::with_id(handle, "luma-quit", "Quit", true, None::<&str>).map_err(err)?;
    let menu = Menu::with_items(handle, &[&play, &next, &show_app, &quit_app]).map_err(err)?;
    let icon = handle
        .default_window_icon()
        .cloned()
        .ok_or("Thiếu biểu tượng khay hệ thống.")?;
    TrayIconBuilder::with_id("luma-system-tray")
        .icon(icon)
        .tooltip("Luma")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "luma-play-pause" => run_audio(state.clone(), json!({"op":"toggle"})),
            "luma-next" => run_audio(state.clone(), json!({"op":"next"})),
            "luma-show" => {
                let _ = show(app);
            }
            "luma-quit" => quit(app, &state),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                let _ = show(tray.app_handle());
            }
        })
        .build(handle)
        .map_err(err)
}

#[cfg(windows)]
fn create_media(handle: &AppHandle, state: Arc<App>) -> Result<souvlaki::MediaControls> {
    use souvlaki::{MediaControls, PlatformConfig};
    let window = handle
        .get_webview_window("main")
        .ok_or("Không tìm thấy cửa sổ Luma.")?;
    let hwnd = window.hwnd().map_err(err)?;
    let mut media = MediaControls::new(PlatformConfig {
        display_name: "Luma",
        dbus_name: "app.luma.rust",
        hwnd: Some(hwnd.0 as *mut std::ffi::c_void),
    })
    .map_err(err)?;
    let app = handle.clone();
    media
        .attach(move |event| transport_event(&app, state.clone(), event))
        .map_err(err)?;
    Ok(media)
}

#[cfg(windows)]
fn transport_event(handle: &AppHandle, state: Arc<App>, event: souvlaki::MediaControlEvent) {
    use souvlaki::MediaControlEvent;
    match event {
        MediaControlEvent::Raise => {
            let _ = show(handle);
        }
        MediaControlEvent::Quit => quit(handle, &state),
        event => {
            // SMTC callbacks may arrive while a COM update is in progress. Never
            // call the blocking playback command from inside that callback.
            std::thread::spawn(move || {
                let current =
                    commands::dispatch(&state, "audioState", vec![]).unwrap_or(Value::Null);
                let is_stop = matches!(event, MediaControlEvent::Stop);
                if let Some(command) = media_command(event, &current) {
                    let _ = commands::dispatch(&state, "audioCommand", vec![command]);
                    if is_stop {
                        let _ = commands::dispatch(
                            &state,
                            "audioCommand",
                            vec![json!({"op":"seek","position":0.0})],
                        );
                    }
                }
            });
        }
    }
}

#[cfg(windows)]
fn media_command(event: souvlaki::MediaControlEvent, state: &Value) -> Option<Value> {
    use souvlaki::{MediaControlEvent as Event, SeekDirection};
    let seek = |direction: SeekDirection, seconds: f64| {
        let delta = if direction == SeekDirection::Forward {
            seconds
        } else {
            -seconds
        };
        let duration = n(state, "duration");
        let position = (n(state, "position") + delta).max(0.0);
        let position = if duration > 0.0 {
            position.min(duration)
        } else {
            position
        };
        json!({"op":"seek","position":position})
    };
    Some(match event {
        Event::Play => json!({"op":"resume"}),
        Event::Pause | Event::Stop => json!({"op":"pause"}),
        Event::Toggle => json!({"op":"toggle"}),
        Event::Next => json!({"op":"next"}),
        Event::Previous => json!({"op":"previous"}),
        Event::SetPosition(position) => {
            json!({"op":"seek","position":position.0.as_secs_f64()})
        }
        Event::Seek(direction) => seek(direction, 5.0),
        Event::SeekBy(direction, amount) => seek(direction, amount.as_secs_f64()),
        Event::SetVolume(volume) if volume.is_finite() => {
            json!({"op":"volume","volume":volume.clamp(0.0,1.0)})
        }
        _ => return None,
    })
}

fn remember_error(controls: &mut DesktopControls, message: String) {
    if controls.errors.last() != Some(&message) {
        eprintln!("{message}");
        controls.errors.push(message);
        if controls.errors.len() > 8 {
            controls.errors.remove(0);
        }
    }
}

#[cfg(windows)]
fn update_media(controls: &mut DesktopControls, app: &App, playback: &Value) -> Result<()> {
    use souvlaki::{MediaMetadata, MediaPlayback, MediaPosition};
    if let Some(tray) = controls.tray.as_ref() {
        let title = app
            .track(s(playback, "trackId"))
            .map(|track| s(&track, "title").to_owned())
            .unwrap_or_default();
        let tooltip = if title.is_empty() {
            "Luma".to_owned()
        } else {
            format!("Luma — {title}").chars().take(120).collect()
        };
        let _ = tray.set_tooltip(Some(&tooltip));
    }
    let Some(media) = controls.media.as_mut() else {
        return Ok(());
    };
    let track_id = s(playback, "trackId");
    let track = app.track(track_id);
    if controls.metadata_key != track_id {
        let track = track.as_ref().unwrap_or(&Value::Null);
        let title = if track_id.is_empty() {
            "Luma"
        } else {
            s(track, "title")
        };
        let artwork = cover_file(app, s(track, "coverDataUrl"))?;
        media
            .set_metadata(MediaMetadata {
                title: Some(title),
                artist: Some(s(track, "artist")),
                album: Some(s(track, "album")),
                cover_url: Some(&artwork),
                duration: Some(safe_duration(n(playback, "duration"))),
            })
            .map_err(err)?;
        controls.metadata_key = track_id.to_owned();
    }
    let progress = Some(MediaPosition(safe_duration(n(playback, "position"))));
    let status = if track_id.is_empty() {
        MediaPlayback::Stopped
    } else if b(playback, "playing") {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    };
    media.set_playback(status).map_err(err)
}

#[cfg(not(windows))]
fn update_media(_controls: &mut DesktopControls, _app: &App, _playback: &Value) -> Result<()> {
    Ok(())
}

fn safe_duration(seconds: f64) -> Duration {
    if seconds.is_finite() && seconds > 0.0 {
        Duration::from_secs_f64(seconds.min(365.0 * 24.0 * 3600.0))
    } else {
        Duration::ZERO
    }
}

/// Souvlaki 0.8 on Windows strips `file://` and passes the remainder directly to
/// StorageFile. Use an absolute Windows path, preserving spaces and Unicode.
fn cover_file(app: &App, data_url: &str) -> Result<String> {
    let root = app.root.join("smtc-artwork");
    checked_dir(&root)?;
    let custom = data_url.split_once(',').and_then(|(header, payload)| {
        if payload.len() > 8 * 1024 * 1024 {
            return None;
        }
        let ext = match header {
            "data:image/png;base64" => "png",
            "data:image/jpeg;base64" | "data:image/jpg;base64" => "jpg",
            _ => return None,
        };
        let bytes = STANDARD.decode(payload).ok()?;
        if bytes.is_empty() || bytes.len() > 5 * 1024 * 1024 {
            return None;
        }
        // Reject malformed cover data before handing it to the Windows shell.
        image::load_from_memory(&bytes).ok()?;
        Some((bytes, ext))
    });
    let (bytes, extension) =
        custom.unwrap_or_else(|| (include_bytes!("../../build/icon.png").to_vec(), "png"));
    let filename = format!("{}.{}", sha(&bytes), extension);
    let path = root.join(filename);
    no_links(&path)?;
    if !path.exists() {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(err)?;
        file.write_all(&bytes).map_err(err)?;
        file.sync_all().map_err(err)?;
    }
    // Keep a small cache. Windows may retain an open stream; in that case a
    // failed removal is harmless and retried on a later metadata change.
    let mut cached = fs::read_dir(&root)
        .map_err(err)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .collect::<Vec<_>>();
    cached.sort_by_key(|entry| entry.metadata().ok().and_then(|m| m.modified().ok()));
    let excess = cached.len().saturating_sub(16);
    for entry in cached.into_iter().take(excess) {
        if entry.path() != path {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(format!("file://{}", path_string(&path)))
}

pub fn status(handle: &AppHandle) -> Value {
    let visible = handle
        .get_webview_window("main")
        .is_some_and(|window| window.is_visible().unwrap_or(false));
    let Some(controls) = handle.try_state::<SharedControls>() else {
        return json!({"trayReady":false,"smtcReady":false,"windowVisible":visible});
    };
    let controls = controls.lock().unwrap();
    #[cfg(windows)]
    let smtc = controls.media.is_some();
    #[cfg(not(windows))]
    let smtc = false;
    json!({"trayReady":controls.tray.is_some(),"smtcReady":smtc,"windowVisible":visible,"error":controls.errors.last()})
}

/// The UI smoke harness can exercise real window and transport behavior without
/// synthesizing global keyboard/mouse input or changing a user's active profile.
pub fn smoke_action(handle: &AppHandle, app: &Arc<App>, action: &str) -> Result<Value> {
    if !app.test_mode {
        return Err("Lệnh kiểm thử chỉ dùng với hồ sơ thử riêng.".into());
    }
    match action {
        "status" => {}
        "close" => handle
            .get_webview_window("main")
            .ok_or("Không tìm thấy cửa sổ Luma.")?
            .close()
            .map_err(err)?,
        "show" => show(handle)?,
        "quit" => quit(handle, app),
        "toggle" | "next" | "previous" | "pause" | "resume" => {
            commands::dispatch(app, "audioCommand", vec![json!({"op":action})])?;
        }
        #[cfg(windows)]
        "mediaToggle" | "mediaNext" | "mediaPrevious" => {
            use souvlaki::MediaControlEvent as Event;
            transport_event(handle,app.clone(),match action {"mediaNext"=>Event::Next,"mediaPrevious"=>Event::Previous,_=>Event::Toggle});
        }
        _ => return Err("Hành động kiểm thử desktop không hợp lệ.".into()),
    }
    Ok(status(handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_only_hides_when_a_tray_can_restore_the_window() {
        assert!(should_hide_on_close(true, true, false));
        assert!(!should_hide_on_close(true, false, false));
        assert!(!should_hide_on_close(false, true, false));
        assert!(!should_hide_on_close(true, true, true));
    }

    #[test]
    fn media_positions_never_panic_on_invalid_or_unbounded_values() {
        assert_eq!(safe_duration(f64::NAN), Duration::ZERO);
        assert_eq!(safe_duration(f64::INFINITY), Duration::ZERO);
        assert_eq!(safe_duration(-5.0), Duration::ZERO);
        assert_eq!(safe_duration(1.25), Duration::from_millis(1250));
    }

    #[cfg(windows)]
    #[test]
    fn hardware_transport_maps_and_bounds_relative_seek() {
        use souvlaki::{MediaControlEvent as Event, SeekDirection};
        let state = json!({"position":2.0,"duration":10.0});
        assert_eq!(media_command(Event::Play, &state).unwrap()["op"], "resume");
        assert_eq!(media_command(Event::Pause, &state).unwrap()["op"], "pause");
        assert_eq!(media_command(Event::Next, &state).unwrap()["op"], "next");
        assert_eq!(
            media_command(Event::Previous, &state).unwrap()["op"],
            "previous"
        );
        assert_eq!(
            media_command(Event::Seek(SeekDirection::Backward), &state).unwrap()["position"],
            0.0
        );
        assert_eq!(
            media_command(
                Event::SeekBy(SeekDirection::Forward, Duration::from_secs(60)),
                &state
            )
            .unwrap()["position"],
            10.0
        );
        assert!(media_command(Event::SetVolume(f64::NAN), &state).is_none());
    }
}
