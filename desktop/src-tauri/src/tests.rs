use crate::{common::*, downloads, library, media};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

fn tools() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../.build-tools/native/resources/tools")
}
fn app() -> (tempfile::TempDir, Arc<App>) {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(library::initialize(temp.path().join("profile"), tools(), true).unwrap());
    (temp, app)
}
fn fixture(directory: &Path, ext: &str, title: &str, album: &str) -> PathBuf {
    fs::create_dir_all(directory).unwrap();
    let target = directory.join(format!("{title}.{ext}"));
    let codec = match ext {
        "m4a" => "alac",
        _ => "flac",
    };
    let args = vec![
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-n",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=997:sample_rate=96000:duration=4",
        "-ac",
        "2",
        "-c:a",
        codec,
        "-sample_fmt",
        if codec == "alac" { "s32p" } else { "s32" },
        "-metadata",
        &format!("title={title}"),
        "-metadata",
        "artist=Nghệ sĩ thử nghiệm",
        "-metadata",
        &format!("album={album}"),
        "-metadata",
        "album_artist=Various Artists",
    ]
    .into_iter()
    .map(str::to_string)
    .chain(if codec == "flac" {
        vec!["-bits_per_raw_sample".into(), "24".into()]
    } else {
        vec![]
    })
    .chain([path_string(&target)])
    .collect::<Vec<_>>();
    run(
        &tools().join("ffmpeg.exe"),
        &args,
        None,
        Duration::from_secs(20),
        |_| {},
    )
    .unwrap();
    target
}
#[test]
fn validates_youtube_without_arbitrary_hosts_or_playlist_injection() {
    assert_eq!(
        downloads::youtube_url("https://youtu.be/abcdefghijk?t=2").unwrap(),
        "https://www.youtube.com/watch?v=abcdefghijk"
    );
    assert!(downloads::youtube_url("https://evil.example/watch?v=abcdefghijk").is_err());
    assert!(downloads::youtube_url("https://www.youtube.com/playlist?list=123").is_err());
    assert!(
        downloads::youtube_url("[REDACTED]youtube.com/watch?v=abcdefghijk").is_err()
    );
    assert!(downloads::youtube_url("http://youtube.com/watch?v=abcdefghijk").is_err());
}
#[test]
fn validates_spotify_canonical_ids() {
    use crate::oauth::spotify_id;
    let id = "0123456789ABCDEFGHIJKL";
    assert_eq!(
        spotify_id(&format!("spotify:track:{id}"), "track").unwrap(),
        id
    );
    assert_eq!(
        spotify_id(
            &format!("https://open.spotify.com/intl-vn/track/{id}?si=test"),
            "track"
        )
        .unwrap(),
        id
    );
    assert!(spotify_id("https://evil.example/track/0123456789ABCDEFGHIJKL", "track").is_err());
    assert!(spotify_id(
        "https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL",
        "track"
    )
    .is_err());
}
#[test]
fn validates_range_boundaries() {
    assert_eq!(
        media::byte_range(Some("bytes=3-7"), 10).unwrap(),
        Some((3, 7))
    );
    assert_eq!(
        media::byte_range(Some("bytes=-3"), 10).unwrap(),
        Some((7, 9))
    );
    assert_eq!(
        media::byte_range(Some("bytes=7-"), 10).unwrap(),
        Some((7, 9))
    );
    assert!(media::byte_range(Some("bytes=10-"), 10).is_err());
    assert!(media::byte_range(Some("bytes=0-2,5-7"), 10).is_err());
    assert!(media::byte_range(Some("bytes=-0"), 10).is_err());
    assert!(media::byte_range(Some("bytes=0-1"), 0).is_err());
}
#[test]
fn keeps_original_bytes_deduplicates_and_reads_real_flac() {
    let (temp, app) = app();
    let p = fixture(
        &temp.path().join("originals"),
        "flac",
        "Bình minh",
        "Album A",
    );
    let before = sha_file(&p).unwrap();
    let track = app.add_file(&p, "local", None).unwrap();
    assert_eq!(n(&track, "sampleRate"), 96000.0);
    assert_eq!(n(&track, "bitsPerSample"), 24.0);
    assert_eq!(s(&track, "title"), "Bình minh");
    assert_eq!(s(&track, "albumArtist"), "Various Artists");
    assert!(b(&track, "managed"));
    assert_ne!(s(&track, "path"), path_string(&p));
    assert_eq!(sha_file(Path::new(s(&track, "path"))).unwrap(), before);
    assert_eq!(sha_file(&p).unwrap(), before);
    assert_eq!(app.add_file(&p, "local", None).unwrap()["id"], track["id"]);
    assert_eq!(app.tracks().as_array().unwrap().len(), 1);
}
#[test]
fn manually_assigns_album_without_writing_source_tags() {
    let (temp, app) = app();
    let p = fixture(
        &temp.path().join("originals"),
        "flac",
        "Bài một",
        "Metadata Album",
    );
    let track = app.add_file(&p, "local", None).unwrap();
    let original = sha_file(&p).unwrap();
    let album = app
        .create_album(&json!({"name":"../Album: của tôi","artist":"Custom"}))
        .unwrap();
    let result = app
        .organize(Some(
            &json!({"albumId":album["id"],"trackIds":[track["id"]]}),
        ))
        .unwrap();
    assert!(result["failed"].as_array().unwrap().is_empty());
    let current = app.track(s(&track, "id")).unwrap();
    assert_eq!(current["albumId"], album["id"]);
    assert!(Path::new(s(&current, "path"))
        .starts_with(Path::new(s(&app.settings(), "libraryDirectory"))));
    assert_eq!(sha_file(&p).unwrap(), original);
    assert_eq!(sha_file(Path::new(s(&current, "path"))).unwrap(), original);
}
#[test]
fn rejects_foreign_album_directories_and_keeps_user_files() {
    let (temp, app) = app();
    let p = fixture(&temp.path().join("originals"), "flac", "One", "User album");
    let album = app
        .create_album(&json!({"name":"User album","artist":"Various Artists"}))
        .unwrap();
    let dir = PathBuf::from(s(&app.settings(), "libraryDirectory")).join(s(&album, "folder"));
    fs::remove_file(dir.join(".luma-album.json")).unwrap();
    fs::write(dir.join("user.txt"), "untouched").unwrap();
    assert!(app.add_file(&p, "local", None).is_err());
    assert_eq!(
        fs::read_to_string(dir.join("user.txt")).unwrap(),
        "untouched"
    );
    assert!(p.exists());
}
#[test]
fn failed_index_commit_does_not_mutate_memory_or_original() {
    let (temp, app) = app();
    let p = fixture(&temp.path().join("originals"), "flac", "Rollback", "Album");
    let before = sha_file(&p).unwrap();
    fs::create_dir(app.root.join("library.json")).unwrap();
    assert!(app.add_file(&p, "local", None).is_err());
    assert!(app.tracks().as_array().unwrap().is_empty());
    assert_eq!(sha_file(&p).unwrap(), before);
}
#[test]
fn relocating_root_requires_explicit_consolidation() {
    let (temp, app) = app();
    let p = fixture(&temp.path().join("originals"), "flac", "Move", "Album");
    let old = app.add_file(&p, "local", None).unwrap();
    let target = temp.path().join("NewLibrary");
    app.save_settings(&json!({"libraryDirectory":path_string(&target)}))
        .unwrap();
    assert_eq!(app.track(s(&old, "id")).unwrap()["path"], old["path"]);
    let result = app.organize(None).unwrap();
    assert!(result["failed"].as_array().unwrap().is_empty());
    let t = app.track(s(&old, "id")).unwrap();
    assert!(Path::new(s(&t, "path")).starts_with(target));
    assert!(p.exists());
}
#[test]
fn duplicate_imports_from_threads_commit_once() {
    let (temp, app) = app();
    let p = fixture(&temp.path().join("originals"), "flac", "Parallel", "Album");
    let handles = (0..3)
        .map(|_| {
            let app = app.clone();
            let p = p.clone();
            std::thread::spawn(move || app.add_file(&p, "local", None).unwrap()["id"].clone())
        })
        .collect::<Vec<_>>();
    let ids = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert!(ids.iter().all(|id| id == &ids[0]));
    assert_eq!(app.tracks().as_array().unwrap().len(), 1);
}
#[test]
fn alac_compatibility_keeps_exact_pcm_and_original_file() {
    let (temp, app) = app();
    let p = fixture(&temp.path().join("originals"), "m4a", "ALAC nguồn", "Album");
    let before = sha_file(&p).unwrap();
    let track = app.add_file(&p, "local", None).unwrap();
    assert_eq!(s(&track, "codec"), "ALAC");
    assert_eq!(n(&track, "sampleRate"), 96000.0);
    assert_eq!(n(&track, "bitsPerSample"), 24.0);
    let proxy = media::compatible(&app, &track).unwrap();
    let mut hashes = Vec::new();
    for (input, label) in [(&p, "source"), (&proxy, "proxy")] {
        let raw = temp.path().join(format!("{label}.s24le"));
        run(
            &app.tool("ffmpeg"),
            &vec![
                "-v".into(),
                "error".into(),
                "-i".into(),
                path_string(input),
                "-map".into(),
                "0:a:0".into(),
                "-f".into(),
                "s24le".into(),
                path_string(&raw),
            ],
            None,
            Duration::from_secs(20),
            |_| {},
        )
        .unwrap();
        hashes.push(sha_file(&raw).unwrap());
    }
    assert_eq!(hashes[0], hashes[1]);
    assert_eq!(sha_file(&p).unwrap(), before);
}
#[test]
fn actual_http_media_range_head_and_origin_are_guarded() {
    let (temp, app) = app();
    let p = fixture(&temp.path().join("originals"), "flac", "Stream", "Album");
    let t = app.add_file(&p, "local", None).unwrap();
    let base = media::start(app.clone()).unwrap();
    let url = format!("{base}/track/{}", s(&t, "id"));
    let client = crate::oauth::client().unwrap();
    let r = client
        .get(&url)
        .header("Origin", "http://tauri.localhost")
        .header("Range", "bytes=0-3")
        .send()
        .unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(r.bytes().unwrap().as_ref(), b"fLaC");
    let head = client.head(&url).send().unwrap();
    assert_eq!(head.status(), 200);
    assert_eq!(
        head.headers()["content-length"]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap(),
        fs::metadata(s(&t, "path")).unwrap().len()
    );
    assert_eq!(
        client
            .get(&url)
            .header("Origin", "https://evil.example")
            .send()
            .unwrap()
            .status(),
        403
    );
    app.closing
        .store(true, std::sync::atomic::Ordering::Relaxed);
}
#[test]
fn quoted_csv_import_and_duplicate_entries_work() {
    let (temp, app) = app();
    let p = temp.path().join("playlist.csv");
    fs::write(&p,"Track URI,Track Name,Artist Name(s),Album Name,Duration (ms)\nspotify:track:0123456789ABCDEFGHIJKL,\"Hello, world\",Artist,Album,123000\nspotify:track:0123456789ABCDEFGHIJKL,Duplicate,Artist,Album,123000\n").unwrap();
    let list = app.import_playlist_file(&p).unwrap();
    assert_eq!(list["tracks"].as_array().unwrap().len(), 1);
    assert_eq!(s(&list["tracks"][0]["metadata"], "title"), "Hello, world");
    assert_eq!(n(&list["tracks"][0]["metadata"], "duration"), 123.0);
    assert_eq!(n(&list, "skipped"), 1.0);
}
#[test]
fn safe_matching_rejects_wrong_edits_and_duration() {
    let meta = json!({"title":"Hello","artist":"Singer","duration":200});
    let mut candidate =
        json!({"title":"Singer Hello Official Audio","channel":"Singer","duration":201});
    assert!(downloads::safe_candidate(&meta, &candidate));
    candidate["title"] = json!("Singer Hello Remix");
    assert!(!downloads::safe_candidate(&meta, &candidate));
    candidate["title"] = json!("Singer Hello Official Audio");
    candidate["duration"] = json!(220);
    assert!(!downloads::safe_candidate(&meta, &candidate));
}
#[test]
fn settings_reject_relative_paths_and_profile_as_library() {
    let (_, app) = app();
    assert!(app
        .save_settings(&json!({"libraryDirectory":"relative"}))
        .is_err());
    assert!(app
        .save_settings(&json!({"libraryDirectory":path_string(&app.root.join("music"))}))
        .is_err());
}
#[test]
fn credentials_are_protected_by_windows_not_plaintext() {
    let (_, app) = app();
    let secret = json!({"refresh_token":"[REDACTED]"});
    app.persist_secret("test", &secret).unwrap();
    let stored = fs::read_to_string(app.root.join("test.protected.json")).unwrap();
    assert!(!stored.contains("synthetic-unit-test-secret"));
    assert_eq!(app.secret("test").unwrap(), secret);
    assert!(unprotect(b"not a DPAPI blob").is_err());
}

#[test]
fn audio_preferences_validate_atomically_and_survive_restart() {
    let (_temp, app) = app();
    assert_eq!(app.settings()["minimizeToTray"], true);
    assert_eq!(n(&app.settings(), "crossfadeSeconds"), 0.0);
    let changed = app.save_settings(&json!({"minimizeToTray":false,"crossfadeSeconds":12,"automix":true,"exclusiveMode":true})).unwrap();
    assert_eq!(changed["exclusiveMode"], true);
    assert_eq!(changed["automix"], true);
    assert_eq!(changed["minimizeToTray"], false);
    assert_eq!(n(&changed, "crossfadeSeconds"), 12.0);
    for bad in [json!({"crossfadeSeconds":12.1}), json!({"crossfadeSeconds":-1}), json!({"crossfadeSeconds":"4"}), json!({"exclusiveMode":"true"}), json!({"automix":1}), json!({"minimizeToTray":null})] {
        assert!(app.save_settings(&bad).is_err());
        assert_eq!(app.settings(), changed);
    }
    let restored = library::initialize(app.root.clone(), tools(), true).unwrap();
    assert_eq!(restored.settings(), changed);
}

#[test]
fn native_decoder_matches_ffmpeg_pcm_and_seeks_exactly() {
    let (temp, app) = app();
    for ext in ["flac", "m4a"] {
        let source = fixture(&temp.path().join(ext), ext, "Exact PCM", "Decoder");
        let before = sha_file(&source).unwrap();
        let raw = temp.path().join(format!("decoded-{ext}.s32le"));
        run(&app.tool("ffmpeg"), &vec!["-v".into(), "error".into(), "-i".into(), path_string(&source), "-map".into(), "0:a:0".into(), "-f".into(), "s32le".into(), path_string(&raw)], None, Duration::from_secs(20), |_| {}).unwrap();
        let reference = fs::read(&raw).unwrap().chunks_exact(4).map(|b| i32::from_le_bytes(b.try_into().unwrap())).collect::<Vec<_>>();
        let mut reader = crate::audio::decode::Reader::open(&source, 0.0).unwrap();
        assert_eq!(reader.rate, 96000);
        assert_eq!(reader.bits, 24);
        let mut actual = Vec::new();
        while let Some(chunk) = reader.chunk().unwrap() {
            actual.extend(chunk.into_iter().map(|x| (x * 2147483648.0).round() as i32));
        }
        assert_eq!(actual, reference, "native PCM differs: {ext}");
        let mut seek = crate::audio::decode::Reader::open(&source, 1.125).unwrap();
        let first = seek.chunk().unwrap().unwrap();
        let offset = (1.125 * reader.rate as f64) as usize * reader.channels;
        let expected = &reference[offset..offset + first.len()];
        assert!(first.iter().zip(expected).all(|(sample, expected)| (*sample * 2147483648.0).round() as i32 == *expected), "inaccurate seek: {ext}");
        assert_eq!(sha_file(&source).unwrap(), before);
    }
}

#[test] fn mp3_and_aac_metadata_preserve_original_bytes() {
 let (temp,app)=app();
 for (ext,codec) in [("mp3","libmp3lame"),("m4a","aac")] {
 let path=temp.path().join(format!("original.{ext}"));
 let args=["-v","error","-f","lavfi","-i","sine=frequency=440:duration=1","-c:a",codec].map(String::from).into_iter().chain([path_string(&path)]).collect::<Vec<_>>();
 run(&tools().join("ffmpeg.exe"),&args,None,Duration::from_secs(20),|_|{}).unwrap();
 let original=fs::read(&path).unwrap();let track=library::metadata(&app,&path,"local").unwrap();
 assert_eq!(track["lossless"],false);assert!(track["duration"].as_f64().unwrap()>0.);
 assert_eq!(original,fs::read(path).unwrap());
 }
}
#[test]
fn discord_settings_validate_atomically_and_persist() {
    let (temp,app)=app();
    assert_eq!(app.settings()["discordEnabled"],false);
    assert_eq!(app.settings()["discordShowQuality"],true);
    assert!(app.save_settings(&json!({"discordEnabled":true,"discordApplicationId":"invalid"})).is_err());
    assert_eq!(app.settings()["discordEnabled"],false);
    app.save_settings(&json!({"discordEnabled":true,"discordApplicationId":"123456789012345678","discordShowQuality":false})).unwrap();
    drop(app);
    let app=library::initialize(temp.path().join("profile"),tools(),true).unwrap();
    assert_eq!(app.settings()["discordEnabled"],true);
    assert_eq!(app.settings()["discordApplicationId"],"123456789012345678");
    assert_eq!(app.settings()["discordShowQuality"],false);
    app.save_settings(&json!({"discordEnabled":false})).unwrap();
    assert_eq!(app.settings()["discordEnabled"],false);
}
