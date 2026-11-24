use crate::common::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use lofty::{
    prelude::{Accessor, AudioFile, TaggedFileExt},
    probe::Probe,
    tag::ItemKey,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Mutex},
    time::Duration,
};

pub fn initialize(root: PathBuf, tools: PathBuf, test_mode: bool) -> Result<App> {
    fs::create_dir_all(&root).map_err(err)?;
    let music = if test_mode {
        root.join("Music")
    } else {
        dirs::audio_dir().unwrap_or_else(|| dirs::home_dir().unwrap().join("Music"))
    };
    let defaults = json!({"version":1,"tracks":[],"albums":[],"retiredCopies":[],"settings":{"downloadDirectory":path_string(&music.join("Luma")),"libraryDirectory":path_string(&music.join("Luma/Library")),"ytDlpPath":"bundled","ffmpegPath":"bundled","spotifyClientId":"","spotifyMarket":"VN","minimizeToTray":true,"crossfadeSeconds":0,"automix":false,"exclusiveMode":false,"discordEnabled":false,"discordApplicationId":"","discordShowQuality":true}});
    let library_path = root.join("library.json");
    let mut library = if library_path.exists() {
        read_json(&library_path)?
    } else {
        let old = dirs::config_dir()
            .unwrap_or_default()
            .join("Luma/library.json");
        if !test_mode && old.exists() {
            read_json(&old)?
        } else {
            defaults.clone()
        }
    };
    if library["version"] != 1 || !library["tracks"].is_array() || !library["settings"].is_object()
    {
        return Err("Thư viện không hợp lệ; file cũ được giữ nguyên. Không ghi đè dữ liệu.".into());
    }
    for (k, v) in defaults["settings"].as_object().unwrap() {
        if library["settings"].get(k).is_none() {
            library["settings"][k] = v.clone()
        }
    }
    if !library["albums"].is_array() {
        library["albums"] = json!([])
    }
    let mut tracks = library["tracks"].as_array().unwrap().clone();
    for track in &mut tracks {
        let known = library["albums"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| s(a, "id") == s(track, "albumId"));
        if !known {
            let name = if s(track, "album").is_empty() || s(track, "album") == "Local collection" {
                "Chưa phân album"
            } else {
                s(track, "album")
            };
            let album = ensure_album(
                &mut library,
                name,
                &if s(track, "albumArtist").is_empty() {
                    s(track, "artist").to_owned()
                } else {
                    s(track, "albumArtist").to_owned()
                },
                "metadata",
            );
            track["albumId"] = album["id"].clone();
        }
    }
    library["tracks"] = json!(tracks);
    let profile = load_or_default(&root.join("profile.json"), json!({"name":"Luma Listener"}))?;
    let playlists = load_or_default(&root.join("playlists.json"), json!([]))?;
    let settings = &library["settings"];
    let drive_config = load_or_default(
        &root.join("drive-config.json"),
        json!({"desktopClientId":"","secretConfigured":false,"sourceDirectory":settings["libraryDirectory"],"autoSync":true}),
    )?;
    let drive = json!({"config":drive_config,"connected":false,"connecting":false,"phase":"idle","filesTotal":0,"filesDone":0,"uploaded":0,"skipped":0,"failed":0,"bytesUploaded":0,"bytesTotal":0,"progress":0});
    Ok(App {
        root,
        tools,
        library: Mutex::new(library),
        profile: Mutex::new(profile),
        playlists: Mutex::new(if playlists.is_array() {
            playlists
        } else {
            playlists.get("playlists").cloned().unwrap_or(json!([]))
        }),
        jobs: Mutex::new(HashMap::new()),
        batches: Mutex::new(HashMap::new()),
        matches: Mutex::new(HashMap::new()),
        cancel: Mutex::new(HashMap::new()),
        oauth: Mutex::new(HashMap::new()),
        drive: Mutex::new(drive),
        handle: Mutex::new(None),
        media_base: Mutex::new(String::new()),
        audio: Mutex::new(None),
        closing: AtomicBool::new(false),
        test_mode,
    })
}
fn load_or_default(p: &Path, default: Value) -> Result<Value> {
    if p.exists() {
        read_json(p)
    } else {
        Ok(default)
    }
}
fn album_label(name: &str) -> String {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        "Chưa phân album".into()
    } else {
        name.chars().take(160).collect()
    }
}
fn ensure_album(lib: &mut Value, name: &str, artist: &str, kind: &str) -> Value {
    use unicode_normalization::UnicodeNormalization;
    let name = album_label(name);
    let artist = if name == "Chưa phân album" {
        "".into()
    } else {
        artist.chars().take(160).collect::<String>()
    };
    if let Some(a) = lib["albums"].as_array().unwrap().iter().find(|a| {
        s(a, "name").nfc().collect::<String>().to_lowercase()
            == name.nfc().collect::<String>().to_lowercase()
            && s(a, "artist").nfc().collect::<String>().to_lowercase()
                == artist.nfc().collect::<String>().to_lowercase()
    }) {
        return a.clone();
    }
    let key = id();
    let album = json!({"id":key,"name":name,"artist":artist,"folder":format!("{}--{key}",stem(&format!("{name} - {artist}"),42)),"kind":kind,"createdAt":now()});
    lib["albums"].as_array_mut().unwrap().push(album.clone());
    album
}
pub fn managed_album(root: &Path, album: &Value) -> Result<PathBuf> {
    checked_dir(root)?;
    let marker = root.join(".luma-library.json");
    let expected = json!({"app":"Luma","version":1,"layout":"albums"});
    if marker.exists() {
        if read_json(&marker)? != expected {
            return Err("Dấu thư viện hiện có không thuộc Luma.".into());
        }
    } else {
        atomic(&marker, &expected)?
    }
    let folder = s(album, "folder");
    if folder.is_empty()
        || Path::new(folder).components().count() != 1
        || folder == "."
        || folder == ".."
    {
        return Err("Thư mục album không hợp lệ.".into());
    }
    let directory = root.join(folder);
    no_links(&directory)?;
    let existed = directory.exists();
    fs::create_dir_all(&directory).map_err(err)?;
    let marker = directory.join(".luma-album.json");
    let expected = json!({"app":"Luma","version":1,"albumId":album["id"]});
    if existed {
        if !marker.exists() || read_json(&marker)? != expected {
            return Err("Thư mục trùng tên không thuộc album này; không ghi đè.".into());
        }
    } else {
        atomic(&marker, &expected)?
    }
    Ok(directory)
}
pub fn metadata(app: &App, p: &Path, source: &str) -> Result<Value> {
    let real = fs::canonicalize(p).map_err(err)?;
    let ext = real
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["flac", "m4a", "mp3"].contains(&ext.as_str()) {
        return Err("Chỉ hỗ trợ FLAC, MP3 hoặc M4A (AAC / ALAC).".into());
    }
    let tagged = Probe::open(&real).map_err(err)?.read().map_err(err)?;
    let properties = tagged.properties();
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let title = tag
        .and_then(|t| t.title())
        .map(|v| v.to_string())
        .unwrap_or_else(|| {
            real.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let artist = tag
        .and_then(|t| t.artist())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "Nghệ sĩ chưa xác định".into());
    let album = tag
        .and_then(|t| t.album())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "Chưa phân album".into());
    let album_artist = tag
        .and_then(|t| t.get_string(&ItemKey::AlbumArtist))
        .unwrap_or(&artist)
        .to_owned();
    let mut result = json!({"id":id(),"path":path_string(&real),"title":title,"artist":artist,"album":album_label(&album),"albumArtist":album_artist,"duration":properties.duration().as_secs_f64(),"sampleRate":properties.sample_rate().unwrap_or(0),"bitsPerSample":properties.bit_depth().unwrap_or(0),"channels":properties.channels().unwrap_or(0),"bitrate":properties.audio_bitrate().map(|n|n*1000),"container":ext.to_uppercase(),"codec":ext.to_uppercase(),"lossless":ext=="flac","addedAt":now(),"source":source});
    if ext == "m4a" {
        let output = run(
            &app.tool("ffprobe"),
            &[
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
            ]
            .map(String::from)
            .into_iter()
            .chain([path_string(&real)])
            .collect::<Vec<_>>(),
            None,
            Duration::from_secs(15),
            |_| {},
        )?;
        let probe: Value = serde_json::from_str(&output).map_err(err)?;
        let stream = &probe["streams"][0];
        let codec = s(stream, "codec_name");
        if !["aac", "alac"].contains(&codec) {
            return Err("M4A không có luồng AAC / ALAC hợp lệ.".into());
        }
        result["codec"] = json!(codec.to_uppercase());
        result["lossless"] = json!(codec == "alac");
        for (dest, key) in [
            ("sampleRate", "sample_rate"),
            ("bitsPerSample", "bits_per_raw_sample"),
            ("bitrate", "bit_rate"),
            ("duration", "duration"),
        ] {
            if let Some(value) = stream
                .get(key)
                .and_then(|x| x.as_f64().or_else(|| x.as_str()?.parse().ok()))
                .filter(|x| x.is_finite() && *x > 0.0)
            {
                result[dest] = json!(value)
            }
        }
        if let Some(channels) = stream.get("channels") {
            result["channels"] = channels.clone()
        }
        if codec == "aac" {
            result["bitsPerSample"] = json!(0)
        }
    }
    if let Some(pic) = tag.and_then(|t| {
        t.pictures()
            .iter()
            .find(|p| p.data().len() <= 5 * 1024 * 1024)
    }) {
        let mime = pic.mime_type().map(|m| m.to_string()).unwrap_or_default();
        if ["image/jpeg", "image/png", "image/webp"].contains(&mime.as_str()) {
            result["coverDataUrl"] = json!(format!(
                "data:{mime};base64,{}",
                STANDARD.encode(pic.data())
            ))
        }
    }
    if n(&result, "duration") <= 0.0 || n(&result, "sampleRate") <= 0.0 {
        return Err("File không có âm thanh hoặc metadata thời lượng hợp lệ.".into());
    }
    Ok(result)
}
impl App {
    pub fn track(&self, key: &str) -> Option<Value> {
        self.library.lock().unwrap()["tracks"]
            .as_array()?
            .iter()
            .find(|t| s(t, "id") == key)
            .cloned()
    }
    pub fn tracks(&self) -> Value {
        self.library.lock().unwrap()["tracks"].clone()
    }
    pub fn albums(&self) -> Value {
        let lib = self.library.lock().unwrap();
        list_albums(&lib)
    }
    pub fn settings(&self) -> Value {
        let lib = self.library.lock().unwrap();
        let raw = &lib["settings"];
        let secret = self.secret("spotify-client");
        json!({"libraryDirectory":raw["libraryDirectory"],"downloadDirectory":raw["downloadDirectory"],"ytDlpPath":raw["ytDlpPath"],"ffmpegPath":raw["ffmpegPath"],"spotifyClientId":raw["spotifyClientId"],"spotifyMarket":raw["spotifyMarket"],"spotifyConfigured":!s(raw,"spotifyClientId").is_empty()&&secret.is_some(),"minimizeToTray":raw["minimizeToTray"],"crossfadeSeconds":raw["crossfadeSeconds"],"automix":raw["automix"],"exclusiveMode":raw["exclusiveMode"],"discordEnabled":raw["discordEnabled"],"discordApplicationId":raw["discordApplicationId"],"discordShowQuality":raw["discordShowQuality"]})
    }
    pub fn add_file(
        &self,
        p: &Path,
        source: &str,
        metadata_override: Option<&Value>,
    ) -> Result<Value> {
        let real = fs::canonicalize(p).map_err(err)?;
        if let Some(t) = self.library.lock().unwrap()["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| {
                same(Path::new(s(t, "path")), &real) || same(Path::new(s(t, "originalPath")), &real)
            })
            .cloned()
        {
            return Ok(t);
        }
        let mut track = metadata(self, &real, source)?;
        if let Some(meta) = metadata_override {
            for k in ["title", "artist", "album", "spotifyUrl"] {
                if let Some(v) = meta.get(k) {
                    track[k] = v.clone()
                }
            }
        }
        let mut locked = self.library.lock().unwrap();
        let mut next = locked.clone();
        if let Some(t) = next["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| {
                same(Path::new(s(t, "path")), &real) || same(Path::new(s(t, "originalPath")), &real)
            })
            .cloned()
        {
            return Ok(t);
        }
        let album = ensure_album(
            &mut next,
            s(&track, "album"),
            s(&track, "albumArtist"),
            "metadata",
        );
        let root = PathBuf::from(s(&next["settings"], "libraryDirectory"));
        let dir = managed_album(&root, &album)?;
        let destination = dir.join(format!(
            "{}--{}.{}",
            stem(s(&track, "title"), 48),
            s(&track, "id"),
            real.extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase()
        ));
        let created = copy_verified(&real, &destination)?;
        track["path"] = json!(path_string(&destination));
        track["originalPath"] = json!(path_string(&real));
        track["managed"] = json!(true);
        track["albumId"] = album["id"].clone();
        track["album"] = album["name"].clone();
        next["tracks"].as_array_mut().unwrap().push(track.clone());
        if let Err(e) = atomic(&self.root.join("library.json"), &next) {
            if created {
                let _ = fs::remove_file(&destination);
            }
            return Err(e);
        }
        *locked = next;
        Ok(track)
    }
    pub fn save_settings(&self, patch: &Value) -> Result<Value> {
        let object = patch.as_object().ok_or("Cài đặt không hợp lệ")?;
        let mut lib = self.library.lock().unwrap();
        let mut next = lib.clone();
        for (k, v) in object {
            if ["minimizeToTray", "automix", "exclusiveMode", "discordEnabled", "discordShowQuality"].contains(&k.as_str()) {
                next["settings"][k] = json!(v.as_bool().ok_or("Tùy chọn âm thanh phải là bật/tắt.")?);
                continue;
            }
            if k == "crossfadeSeconds" {
                let seconds = v.as_f64().filter(|n| n.is_finite() && (0.0..=12.0).contains(n))
                    .ok_or("Crossfade phải từ 0 đến 12 giây.")?;
                next["settings"][k] = json!(seconds);
                continue;
            }
            if ![
                "libraryDirectory",
                "downloadDirectory",
                "ytDlpPath",
                "ffmpegPath",
                "spotifyClientId",
                "spotifyClientSecret",
                "spotifyMarket",
                "discordApplicationId",
            ]
            .contains(&k.as_str())
            {
                continue;
            }
            let value = text(v, 4096)?;
            if k == "spotifyClientSecret" {
                self.persist_secret("spotify-client", &json!({"secret":value}))?;
                continue;
            }
            if k == "libraryDirectory" || k == "downloadDirectory" {
                let p = Path::new(&value);
                if p.starts_with(&self.root) {
                    return Err("Chọn thư mục nhạc ngoài hồ sơ ứng dụng.".into());
                }
                checked_dir(p)?;
            }
            if k == "spotifyMarket"
                && (value.len() != 2 || !value.chars().all(|c| c.is_ascii_uppercase()))
            {
                return Err("Thị trường Spotify dùng 2 chữ cái viết hoa.".into());
            }
            if k == "discordApplicationId" && !value.is_empty() && !crate::discord_presence::valid_application_id(&value) {return Err("Discord Application ID phải là dãy 17–20 chữ số.".into());}
            next["settings"][k] = json!(value);
        }
        if b(&next["settings"],"discordEnabled") && !crate::discord_presence::valid_application_id(s(&next["settings"],"discordApplicationId")) {return Err("Nhập Discord Application ID trước khi bật Rich Presence.".into());}
        atomic(&self.root.join("library.json"), &next)?;
        *lib = next;
        drop(lib);
        Ok(self.settings())
    }
    pub fn create_album(&self, input: &Value) -> Result<Value> {
        let name = text(&input["name"], 640)?;
        if name.is_empty() {
            return Err("Nhập tên album.".into());
        }
        let artist = input
            .get("artist")
            .map(|v| text(v, 640))
            .transpose()?
            .unwrap_or_default();
        let mut lib = self.library.lock().unwrap();
        let mut next = lib.clone();
        let album = ensure_album(&mut next, &name, &artist, "manual");
        managed_album(Path::new(s(&next["settings"], "libraryDirectory")), &album)?;
        atomic(&self.root.join("library.json"), &next)?;
        *lib = next;
        let mut result = album;
        result["trackCount"] = json!(0);
        Ok(result)
    }
    pub fn remove_track(&self, key: &str) -> Result<Value> {
        valid_id(key)?;
        let mut lib = self.library.lock().unwrap();
        let mut next = lib.clone();
        next["tracks"]
            .as_array_mut()
            .unwrap()
            .retain(|t| s(t, "id") != key);
        atomic(&self.root.join("library.json"), &next)?;
        *lib = next;
        Ok(Value::Null)
    }
    pub fn organize(&self, input: Option<&Value>) -> Result<Value> {
        let target = if let Some(value) = input {
            valid_id(s(value, "albumId"))?;
            let ids = value["trackIds"].as_array().ok_or("Thiếu danh sách bài")?;
            if ids.is_empty() || ids.len() > 10000 {
                return Err("Chọn 1 đến 10.000 bài.".into());
            }
            Some((
                s(value, "albumId").to_owned(),
                ids.iter()
                    .map(|v| v.as_str().unwrap_or("").to_string())
                    .collect::<Vec<_>>(),
            ))
        } else {
            None
        };
        let snapshot = self.tracks();
        let mut copied = 0;
        let mut failed = Vec::new();
        for old in snapshot.as_array().unwrap() {
            if target
                .as_ref()
                .is_some_and(|(_, ids)| !ids.iter().any(|id| id == s(old, "id")))
            {
                continue;
            }
            let refreshed = if target.is_none() && !b(old, "managed") {
                metadata(self, Path::new(s(old, "path")), s(old, "source")).ok()
            } else {
                None
            };
            let outcome = (|| -> Result<()> {
                let mut lib = self.library.lock().unwrap();
                let mut next = lib.clone();
                let index = next["tracks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .position(|t| s(t, "id") == s(old, "id"))
                    .ok_or("Bài đã bị gỡ")?;
                let current = next["tracks"][index].clone();
                let album = if let Some((key, _)) = &target {
                    next["albums"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|a| s(a, "id") == key)
                        .cloned()
                        .ok_or("Không tìm thấy album")?
                } else {
                    let meta = refreshed.as_ref().unwrap_or(&current);
                    ensure_album(
                        &mut next,
                        s(meta, "album"),
                        s(meta, "albumArtist"),
                        "metadata",
                    )
                };
                let root = PathBuf::from(s(&next["settings"], "libraryDirectory"));
                let dir = managed_album(&root, &album)?;
                let source = Path::new(s(&current, "path"));
                let destination = dir.join(format!(
                    "{}--{}.{}",
                    stem(s(&current, "title"), 48),
                    s(&current, "id"),
                    source
                        .extension()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase()
                ));
                let created = if same(source, &destination) {
                    false
                } else {
                    copy_verified(source, &destination)?
                };
                next["tracks"][index]["path"] = json!(path_string(&destination));
                next["tracks"][index]["managed"] = json!(true);
                next["tracks"][index]["albumId"] = album["id"].clone();
                next["tracks"][index]["album"] = album["name"].clone();
                next["tracks"][index]["albumArtist"] = album["artist"].clone();
                if s(&current, "originalPath").is_empty() {
                    next["tracks"][index]["originalPath"] = current["path"].clone()
                }
                if let Err(e) = atomic(&self.root.join("library.json"), &next) {
                    if created {
                        let _ = fs::remove_file(&destination);
                    }
                    return Err(e);
                }
                *lib = next;
                if created {
                    copied += 1
                }
                Ok(())
            })();
            if let Err(error) = outcome {
                failed.push(json!({"trackId":old["id"],"title":old["title"],"error":error}))
            }
        }
        Ok(json!({"tracks":self.tracks(),"albums":self.albums(),"copied":copied,"failed":failed}))
    }
}
fn list_albums(lib: &Value) -> Value {
    let mut result = Vec::new();
    for a in lib["albums"].as_array().unwrap() {
        let mut album = a.clone();
        let tracks = lib["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["albumId"] == a["id"])
            .collect::<Vec<_>>();
        album["trackCount"] = json!(tracks.len());
        if let Some(cover) = tracks.iter().find_map(|t| t.get("coverDataUrl")) {
            album["coverDataUrl"] = cover.clone()
        }
        result.push(album)
    }
    result.sort_by_key(|v| s(v, "name").to_lowercase());
    json!(result)
}
