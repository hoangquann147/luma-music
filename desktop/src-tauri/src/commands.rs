use crate::{common::*, oauth::external};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

pub fn dispatch(app: &Arc<App>, action: &str, args: Vec<Value>) -> Result<Value> {
    let first = args.first().cloned().unwrap_or(Value::Null);
    match action {
        "bootstrap" => Ok(
            json!({"tracks":app.tracks(),"albums":app.albums(),"settings":app.settings(),"tools":app.check_tools(),"jobs":app.jobs.lock().unwrap().values().cloned().collect::<Vec<_>>(),"spotifyAuth":app.spotify_status(),"playlists":app.playlists.lock().unwrap().clone(),"playlistBatches":app.batches.lock().unwrap().values().cloned().collect::<Vec<_>>(),"profile":app.profile.lock().unwrap().clone(),"mediaBase":app.media_base.lock().unwrap().clone()}),
        ),
        "importFiles" => {
            let files = if app.test_mode {
                let path = app.root.join("test-import.json");
                if path.exists() {
                    read_json(&path)?
                        .as_array()
                        .ok_or("Test import is not an array")?
                        .iter()
                        .filter_map(|v| v.as_str().map(PathBuf::from))
                        .collect()
                } else {
                    Vec::new()
                }
            } else {
                rfd::FileDialog::new()
                    .set_title("Import FLAC / M4A files")
                    .add_filter("FLAC / M4A", &["flac", "m4a"])
                    .pick_files()
                    .unwrap_or_default()
            };
            if files.len() > 10000 {
                return Err("Chỉ nhập tối đa 10.000 file một lần.".into());
            }
            let mut tracks = Vec::new();
            let mut errors = Vec::new();
            for file in files {
                match app.add_file(&file, "local", None) {
                    Ok(t) => tracks.push(t),
                    Err(e) => errors.push(format!(
                        "{}: {e}",
                        file.file_name().unwrap_or_default().to_string_lossy()
                    )),
                }
            }
            if tracks.is_empty() && !errors.is_empty() {
                return Err(errors.join("\n"));
            }
            if !errors.is_empty() && !app.test_mode {
                rfd::MessageDialog::new()
                    .set_title("Một số file chưa được nhập")
                    .set_description(errors.join("\n").chars().take(4000).collect::<String>())
                    .show();
            }
            Ok(json!(tracks))
        }
        "getAlbums" => Ok(app.albums()),
        "createAlbum" => app.create_album(&first),
        "assignAlbum" => app.organize(Some(&first)),
        "consolidateLibrary" => app.organize(None),
        "removeTrack" => app.remove_track(&text(&first, 80)?),
        "saveSettings" => {
            let settings = app.save_settings(&first)?;
            let engine = app.audio.lock().unwrap().clone();
            if let Some(engine) = engine { engine.command(json!({"op":"configure"}))?; }
            Ok(settings)
        }
        "audioCommand" => {
            let engine = app.audio.lock().unwrap().clone().ok_or("Bộ phát Rust chưa sẵn sàng.")?;
            engine.command(first)
        }
        "audioState" => {
            let engine = app.audio.lock().unwrap().clone().ok_or("Bộ phát Rust chưa sẵn sàng.")?;
            Ok(engine.snapshot())
        }
        "checkTools" => Ok(app.check_tools()),
        "chooseLibraryDirectory" | "selectDownloadDirectory" | "chooseDriveDirectory" => {
            Ok(rfd::FileDialog::new()
                .set_title("Chọn thư mục Luma")
                .pick_folder()
                .map(|p| json!(path_string(&p)))
                .unwrap_or(Value::Null))
        }
        "openLibraryDirectory" => {
            let settings = app.settings();
            let p = Path::new(s(&settings, "libraryDirectory"));
            checked_dir(p)?;
            open_folder(p, false)
        }
        "revealTrack" => {
            let key = text(&first, 80)?;
            valid_id(&key)?;
            let track = app.track(&key).ok_or("Không tìm thấy bài hát")?;
            open_folder(Path::new(s(&track, "path")), true)
        }
        "openExternal" => external(&text(&first, 2048)?),
        "spotifyStatus" => Ok(app.spotify_status()),
        "connectSpotify" => app.connect_oauth("spotify"),
        "cancelSpotifyConnect" => {
            app.cancel_oauth("spotify");
            Ok(Value::Null)
        }
        "disconnectSpotify" => app.disconnect("spotify"),
        "prepareSpotify" => app.prepare_spotify(&text(&first, 2048)?),
        "startDownload" => app.start_download(&first),
        "cancelDownload" => {
            let key = text(&first, 80)?;
            valid_id(&key)?;
            app.cancel_download(&key);
            Ok(Value::Null)
        }
        "importSpotifyPlaylist" => app.import_spotify_playlist(&text(&first, 2048)?),
        "importPlaylistFile" => {
            let file = rfd::FileDialog::new()
                .set_title("Import playlist CSV / JSON")
                .add_filter("Playlist", &["csv", "json"])
                .pick_file();
            if let Some(p) = file {
                app.import_playlist_file(&p)
            } else {
                Ok(Value::Null)
            }
        }
        "startPlaylistDownload" => app.start_batch(&first),
        "cancelPlaylistDownload" => {
            let key = text(&first, 80)?;
            valid_id(&key)?;
            app.cancel_download(&key);
            Ok(Value::Null)
        }
        "saveProfile" => {
            let name = text(&first["name"], 640)?;
            if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
                return Err("Tên hồ sơ cần 1–80 ký tự, không có ký tự điều khiển.".into());
            }
            let mut profile = app.profile.lock().unwrap();
            let mut next = profile.clone();
            next["name"] = json!(name);
            atomic(&app.root.join("profile.json"), &next)?;
            *profile = next.clone();
            Ok(next)
        }
        "chooseProfilePhoto" => {
            let Some(p) = rfd::FileDialog::new()
                .set_title("Chọn ảnh hồ sơ")
                .add_filter("Ảnh", &["png", "jpg", "jpeg", "webp"])
                .pick_file()
            else {
                return Ok(Value::Null);
            };
            if fs::metadata(&p).map_err(err)?.len() > 5 * 1024 * 1024 {
                return Err("Ảnh tối đa 5 MB.".into());
            }
            let image = image::ImageReader::open(&p)
                .map_err(err)?
                .with_guessed_format()
                .map_err(err)?
                .decode()
                .map_err(err)?
                .thumbnail(256, 256);
            let mut encoded = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut encoded, image::ImageFormat::Png)
                .map_err(err)?;
            if encoded.get_ref().len() > 512 * 1024 {
                return Err("Ảnh hồ sơ quá lớn sau khi thu nhỏ.".into());
            }
            let mut profile = app.profile.lock().unwrap();
            let mut next = profile.clone();
            next["avatarDataUrl"] = json!(format!(
                "data:image/png;base64,{}",
                STANDARD.encode(encoded.into_inner())
            ));
            atomic(&app.root.join("profile.json"), &next)?;
            *profile = next.clone();
            Ok(next)
        }
        "driveStatus" => Ok(app.drive_status()),
        "saveDriveConfig" => app.save_drive_config(&first),
        "connectDrive" => app.connect_oauth("google"),
        "cancelDriveConnect" => {
            app.cancel_oauth("google");
            Ok(Value::Null)
        }
        "disconnectDrive" => {
            app.cancel_drive();
            app.disconnect("google")
        }
        "syncDriveNow" => app.sync_drive(),
        "cancelDriveSync" => {
            app.cancel_drive();
            Ok(app.drive_status())
        }
        "discordStatus" => Ok(crate::discord_presence::status()),
        "smokeReport" if app.test_mode => {
            atomic(&app.root.join("ui-smoke-report.json"), &first)?;
            Ok(Value::Null)
        }
        "desktopTest" if app.test_mode => {
            let handle = app.handle.lock().unwrap().clone().ok_or("Cửa sổ chưa sẵn sàng.")?;
            crate::desktop_controls::smoke_action(&handle, app, first.as_str().unwrap_or("status"))
        }
        _ => Err("Lệnh ứng dụng không được hỗ trợ.".into()),
    }
}
fn open_folder(path: &Path, reveal: bool) -> Result<Value> {
    if !path.exists() {
        return Err("File/thư mục không còn tồn tại.".into());
    }
    #[cfg(windows)]
    {
        let mut explorer = command(Path::new("C:\\Windows\\explorer.exe"));
        if reveal {
            explorer.arg("/select,");
        }
        explorer.arg(path).spawn().map_err(err)?;
    }
    Ok(Value::Null)
}

pub fn background(app: Arc<App>) {
    std::thread::spawn(move || {
        let mut waited = 0;
        while !app.closing.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_secs(1));
            waited += 1;
            if waited < 120 {
                continue;
            }
            waited = 0;
            let enabled = {
                let drive = app.drive.lock().unwrap();
                b(&drive["config"], "autoSync")
            };
            if enabled && app.secret("google-session").is_some() {
                let _ = app.sync_drive();
            }
        }
    });
}
