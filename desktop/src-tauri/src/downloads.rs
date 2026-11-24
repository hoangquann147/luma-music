use crate::{
    common::*,
    oauth::{client, spotify_id},
};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

pub fn youtube_url(raw: &str) -> Result<String> {
    let u = url::Url::parse(raw).map_err(err)?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
    {
        return Err("Cần liên kết HTTPS YouTube công khai.".into());
    }
    let host = u.host_str().unwrap_or("");
    let key = if host == "youtu.be" {
        u.path()
            .trim_start_matches('/')
            .split('/')
            .next()
            .unwrap_or("")
            .to_owned()
    } else if [
        "youtube.com",
        "www.youtube.com",
        "music.youtube.com",
        "m.youtube.com",
    ]
    .contains(&host)
    {
        if u.path() == "/watch" {
            u.query_pairs()
                .find(|(k, _)| k == "v")
                .map(|(_, v)| v.to_string())
                .unwrap_or_default()
        } else {
            let p = u
                .path_segments()
                .map(|p| p.collect::<Vec<_>>())
                .unwrap_or_default();
            if p.len() == 2 && ["shorts", "embed", "live"].contains(&p[0]) {
                p[1].into()
            } else {
                String::new()
            }
        }
    } else {
        String::new()
    };
    if !regex::Regex::new(r"^[A-Za-z0-9_-]{11}$")
        .unwrap()
        .is_match(&key)
    {
        return Err("Chỉ hỗ trợ video YouTube đơn lẻ.".into());
    }
    Ok(format!("https://www.youtube.com/watch?v={key}"))
}
impl App {
    pub fn check_tools(&self) -> Value {
        let check = |name: &str, args: &[&str]| match run(
            &self.tool(name),
            &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            None,
            Duration::from_secs(10),
            |_| {},
        ) {
            Ok(out) => json!({"available":true,"version":out.lines().next().unwrap_or(name)}),
            Err(e) => json!({"available":false,"error":e}),
        };
        let yt = check("yt-dlp", &["--ignore-config", "--version"]);
        let mut ff = check("ffmpeg", &["-version"]);
        let probe = check("ffprobe", &["-version"]);
        if b(&ff, "available") && !b(&probe, "available") {
            ff = json!({"available":false,"error":"Thiếu ffprobe đi kèm FFmpeg."})
        }
        json!({"ytDlp":yt,"ffmpeg":ff})
    }
    pub fn search_audio(&self, meta: &Value) -> Result<Value> {
        let query = format!(
            "ytsearch5:{} - {} audio",
            s(meta, "artist"),
            s(meta, "title")
        );
        let args = [
            "--ignore-config",
            "--no-warnings",
            "--flat-playlist",
            "--dump-single-json",
            "--skip-download",
            &query,
        ]
        .map(String::from);
        let out = run(
            &self.tool("yt-dlp"),
            &args,
            None,
            Duration::from_secs(90),
            |_| {},
        )?;
        let data: Value = serde_json::from_str(&out).map_err(err)?;
        let mut candidates = Vec::new();
        for item in data["entries"]
            .as_array()
            .ok_or("Không có kết quả YouTube")?
        {
            let video = s(item, "id");
            if video.len() == 11
                && video
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                candidates.push(json!({"id":video,"title":item["title"],"channel":item.get("channel").or_else(||item.get("uploader")).cloned().unwrap_or(json!("")),"duration":n(item,"duration"),"url":format!("https://www.youtube.com/watch?v={video}")}))
            }
        }
        Ok(json!(candidates))
    }
    pub fn prepare_spotify(&self, url: &str) -> Result<Value> {
        let meta = self.spotify_track(url)?;
        self.prepare_metadata(meta)
    }
    pub fn prepare_metadata(&self, meta: Value) -> Result<Value> {
        let candidates = self.search_audio(&meta)?;
        let matched = json!({"id":id(),"metadata":meta,"candidates":candidates});
        self.matches
            .lock()
            .unwrap()
            .insert(s(&matched, "id").into(), matched.clone());
        Ok(matched)
    }
    pub fn start_download(self: &Arc<Self>, request: &Value) -> Result<Value> {
        if !b(request, "rightsConfirmed") {
            return Err("Hãy xác nhận quyền tải nội dung này.".into());
        }
        let url = text(&request["url"], 2048)?;
        let (url, meta) = if spotify_id(&url, "track").is_ok() {
            let matched = self
                .matches
                .lock()
                .unwrap()
                .get(s(request, "spotifyMatchId"))
                .cloned()
                .ok_or("Hãy chọn nguồn YouTube cho bài Spotify.")?;
            if s(&matched["metadata"], "spotifyUrl") != url {
                return Err("Nguồn không thuộc bài Spotify đã chọn.".into());
            }
            let candidate = matched["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| s(c, "id") == s(request, "candidateId"))
                .cloned()
                .ok_or("Chọn nguồn âm thanh hợp lệ.")?;
            (
                youtube_url(s(&candidate, "url"))?,
                Some(matched["metadata"].clone()),
            )
        } else {
            (youtube_url(&url)?, None)
        };
        let active = self
            .jobs
            .lock()
            .unwrap()
            .values()
            .filter(|j| !["completed", "cancelled", "error"].contains(&s(j, "stage")))
            .count();
        if active >= 3 {
            return Err("Đang có 3 tác vụ tải; chờ hoàn tất trước.".into());
        }
        let key = id();
        let job = json!({"id":key,"url":url,"title":meta.as_ref().map(|m|s(m,"title")).unwrap_or("YouTube audio"),"stage":"queued","progress":0,"createdAt":now()});
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancel
            .lock()
            .unwrap()
            .insert(key.clone(), cancel.clone());
        self.set_job(&job);
        let app = self.clone();
        let mut background = job.clone();
        std::thread::spawn(move || {
            let result = app.perform_download(&mut background, meta.as_ref(), &cancel);
            if let Err(e) = result {
                background["stage"] = json!(if cancel.load(Ordering::Relaxed) {
                    "cancelled"
                } else {
                    "error"
                });
                background["message"] = json!(e);
                app.set_job(&background)
            }
            app.cancel.lock().unwrap().remove(&key);
            let temp = app.root.join("download-cache").join(&key);
            if temp.parent() == Some(app.root.join("download-cache").as_path()) {
                let _ = fs::remove_dir_all(temp);
            }
        });
        Ok(job)
    }
    fn perform_download(
        &self,
        job: &mut Value,
        meta: Option<&Value>,
        cancel: &AtomicBool,
    ) -> Result<()> {
        let private = self.root.join("download-cache").join(s(job, "id"));
        checked_dir(&private)?;
        let template = private.join("source.%(ext)s");
        job["stage"] = json!("downloading");
        self.set_job(job);
        let tools_dir = self
            .tool("ffmpeg")
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.tools.clone());
        let mut args = vec![
            "--ignore-config".into(),
            "--no-playlist".into(),
            "--no-warnings".into(),
            "--newline".into(),
            "--progress".into(),
            "--progress-template".into(),
            "download:%(progress._percent_str)s".into(),
            "--print".into(),
            "before_dl:__LUMA_TITLE__%(title)s".into(),
            "--print".into(),
            "before_dl:__LUMA_ARTIST__%(artist,uploader)s".into(),
            "--no-simulate".into(),
            "-f".into(),
            "bestaudio/best".into(),
            "--ffmpeg-location".into(),
            path_string(&tools_dir),
            "-o".into(),
            path_string(&template),
        ];
        let deno = self.tool("deno");
        if deno.exists() {
            args.extend([
                "--js-runtimes".into(),
                format!("deno:{}", path_string(&deno)),
            ]);
        }
        args.extend(["--".into(), s(job, "url").to_owned()]);
        let mut previous = -1i32;
        run(
            &self.tool("yt-dlp"),
            &args,
            Some(cancel),
            Duration::from_secs(1800),
            |line| {
                if meta.is_none() {
                    if let Some(title) = line.strip_prefix("__LUMA_TITLE__") {
                        job["title"] = json!(title.chars().take(300).collect::<String>());
                    }
                    if let Some(artist) = line.strip_prefix("__LUMA_ARTIST__") {
                        job["artist"] = json!(artist.chars().take(300).collect::<String>());
                    }
                }
                if let Some(p) = line
                    .strip_prefix("download:")
                    .and_then(|v| v.trim().trim_end_matches('%').parse::<f64>().ok())
                {
                    let percent = (p * 0.7).floor() as i32;
                    if percent != previous {
                        previous = percent;
                        job["progress"] = json!(percent);
                        self.set_job(job);
                    }
                }
            },
        )?;
        let source = fs::read_dir(&private)
            .map_err(err)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("source."))
                    && p.extension().is_some_and(|e| {
                        !["part", "ytdl", "tmp"]
                            .iter()
                            .any(|x| e.eq_ignore_ascii_case(x))
                    })
            })
            .ok_or("yt-dlp chưa tạo file âm thanh.")?;
        if cancel.load(Ordering::Relaxed) {
            return Err("Đã hủy.".into());
        }
        job["stage"] = json!("converting");
        job["progress"] = json!(75);
        self.set_job(job);
        let output = private.join("converted.flac");
        let mut ff = vec![
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-nostdin".into(),
            "-n".into(),
            "-i".into(),
            path_string(&source),
        ];
        let mut cover = false;
        if let Some(meta) = meta {
            if let Ok(url) = url::Url::parse(s(meta, "coverUrl")) {
                if url.scheme() == "https" && url.host_str() == Some("i.scdn.co") {
                    if let Ok(response) = client()?.get(url).send() {
                        if response.status().is_success() {
                            let mut bytes = Vec::new();
                            if response
                                .take(5 * 1024 * 1024 + 1)
                                .read_to_end(&mut bytes)
                                .is_ok()
                                && bytes.len() <= 5 * 1024 * 1024
                            {
                                let picture = private.join("cover.jpg");
                                fs::write(&picture, bytes).map_err(err)?;
                                ff.extend(["-i".into(), path_string(&picture)]);
                                cover = true;
                            }
                        }
                    }
                }
            }
        }
        ff.extend([
            "-map".into(),
            "0:a:0".into(),
            "-c:a".into(),
            "flac".into(),
            "-compression_level".into(),
            "5".into(),
        ]);
        if cover {
            ff.extend([
                "-map".into(),
                "1:v:0".into(),
                "-c:v".into(),
                "copy".into(),
                "-disposition:v:0".into(),
                "attached_pic".into(),
            ]);
        } else {
            ff.push("-vn".into())
        }
        if let Some(meta) = meta {
            for name in ["title", "artist", "album"] {
                ff.extend(["-metadata".into(), format!("{name}={}", s(meta, name))]);
            }
        } else {
            ff.extend([
                "-metadata".into(),
                format!("title={}", s(job, "title")),
                "-metadata".into(),
                format!("artist={}", s(job, "artist")),
            ]);
        }
        ff.push(path_string(&output));
        run(
            &self.tool("ffmpeg"),
            &ff,
            Some(cancel),
            Duration::from_secs(600),
            |_| {},
        )?;
        if cancel.load(Ordering::Relaxed) {
            return Err("Đã hủy.".into());
        }
        job["stage"] = json!("tagging");
        job["progress"] = json!(95);
        self.set_job(job);
        let title = meta
            .map(|m| s(m, "title").to_owned())
            .unwrap_or_else(|| s(job, "title").to_owned());
        let settings = self.settings();
        let directory = PathBuf::from(s(&settings, "downloadDirectory"));
        checked_dir(&directory)?;
        let permanent = directory.join(format!("{}--{}.flac", stem(&title, 80), s(job, "id")));
        copy_verified(&output, &permanent)?;
        let mut track = self.add_file(
            &permanent,
            if meta.is_some() { "spotify" } else { "youtube" },
            meta,
        )?;
        track["sourceUrl"] = job["url"].clone();
        if let Some(meta) = meta {
            let mut locked = self.playlists.lock().unwrap();
            let mut next = locked.clone();
            let mut changed = Vec::new();
            for playlist in next.as_array_mut().unwrap() {
                let mut updated = false;
                for entry in playlist["tracks"].as_array_mut().unwrap() {
                    if s(&entry["metadata"], "spotifyUrl") == s(meta, "spotifyUrl") {
                        entry["localTrackId"] = track["id"].clone();
                        updated = true
                    }
                }
                if updated {
                    changed.push(playlist.clone())
                }
            }
            if !changed.is_empty() {
                atomic(&self.root.join("playlists.json"), &next)?;
                *locked = next;
                for p in changed {
                    self.emit("music:playlist-update", &p)
                }
            }
        }
        job["track"] = track;
        job["title"] = json!(title);
        job["progress"] = json!(100);
        job["stage"] = json!("completed");
        self.set_job(job);
        Ok(())
    }
    pub fn cancel_download(&self, key: &str) {
        if let Some(c) = self.cancel.lock().unwrap().get(key) {
            c.store(true, Ordering::Relaxed)
        }
    }
    pub fn start_batch(self: &Arc<Self>, request: &Value) -> Result<Value> {
        if !b(request, "rightsConfirmed") || !b(request, "autoMatchConfirmed") {
            return Err("Xác nhận quyền tải và cách ghép nguồn trước.".into());
        }
        let playlist = self
            .playlists
            .lock()
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|p| s(p, "id") == s(request, "playlistId"))
            .cloned()
            .ok_or("Không tìm thấy playlist.")?;
        let ids = request["entryIds"].as_array().ok_or("Chưa chọn bài")?;
        if ids.is_empty() || ids.len() > 10000 {
            return Err("Chọn 1 đến 10.000 bài.".into());
        }
        let entries = playlist["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| ids.contains(&t["id"]))
            .cloned()
            .collect::<Vec<_>>();
        if entries.len() != ids.len() {
            return Err("Có bài không thuộc playlist này.".into());
        }
        let key = id();
        let batch = json!({"id":key,"playlistId":playlist["id"],"stage":"running","total":entries.len(),"completed":0,"failed":0,"reviewRequired":0,"items":entries.iter().map(|e|json!({"entryId":e["id"],"stage":"queued"})).collect::<Vec<_>>()});
        let flag = Arc::new(AtomicBool::new(false));
        self.cancel
            .lock()
            .unwrap()
            .insert(key.clone(), flag.clone());
        self.batches
            .lock()
            .unwrap()
            .insert(key.clone(), batch.clone());
        self.emit("music:playlist-batch-update", &batch);
        let app = self.clone();
        let mut state = batch.clone();
        std::thread::spawn(move || {
            for (index, entry) in entries.iter().enumerate() {
                if flag.load(Ordering::Relaxed) {
                    for item in state["items"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .skip(index)
                    {
                        item["stage"] = json!("cancelled")
                    }
                    break;
                }
                let outcome = (|| -> Result<&str> {
                    if let Some(local) = entry.get("localTrackId").and_then(Value::as_str) {
                        if app.track(local).is_some() {
                            return Ok("completed");
                        }
                    }
                    state["items"][index]["stage"] = json!("resolving");
                    app.emit("music:playlist-batch-update", &state);
                    let matched = app.prepare_metadata(entry["metadata"].clone())?;
                    let candidate = matched["candidates"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|c| safe_candidate(&entry["metadata"], c));
                    let Some(candidate) = candidate else {
                        return Ok("needs-review");
                    };
                    if flag.load(Ordering::Relaxed) {
                        return Ok("cancelled");
                    }
                    let job=app.start_download(&json!({"url":entry["metadata"]["spotifyUrl"],"rightsConfirmed":true,"spotifyMatchId":matched["id"],"candidateId":candidate["id"]}))?;
                    let job_id = s(&job, "id").to_owned();
                    state["items"][index]["jobId"] = json!(job_id);
                    state["items"][index]["stage"] = json!("downloading");
                    app.emit("music:playlist-batch-update", &state);
                    loop {
                        if flag.load(Ordering::Relaxed) {
                            app.cancel_download(&job_id)
                        }
                        let stage = app
                            .jobs
                            .lock()
                            .unwrap()
                            .get(&job_id)
                            .map(|j| s(j, "stage").to_owned())
                            .unwrap_or_default();
                        if ["completed", "cancelled", "error"].contains(&stage.as_str()) {
                            return Ok(if stage == "completed" {
                                "completed"
                            } else if stage == "cancelled" {
                                "cancelled"
                            } else {
                                "error"
                            });
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                })();
                let stage = match outcome {
                    Ok(stage) => stage,
                    Err(e) => {
                        state["items"][index]["message"] = json!(e);
                        "error"
                    }
                };
                state["items"][index]["stage"] = json!(stage);
                let counter = match stage {
                    "completed" => "completed",
                    "needs-review" => "reviewRequired",
                    _ => "failed",
                };
                state[counter] = json!(n(&state, counter) + 1.0);
                app.batches
                    .lock()
                    .unwrap()
                    .insert(key.clone(), state.clone());
                app.emit("music:playlist-batch-update", &state);
            }
            state["stage"] = json!(if flag.load(Ordering::Relaxed) {
                "cancelled"
            } else {
                "completed"
            });
            app.batches
                .lock()
                .unwrap()
                .insert(key.clone(), state.clone());
            app.emit("music:playlist-batch-update", &state);
            app.cancel.lock().unwrap().remove(&key);
        });
        Ok(batch)
    }
}
fn normalize(value: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    value
        .nfkd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .map(|c| {
            if c == 'đ' {
                'd'
            } else if c.is_alphanumeric() {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn safe_candidate(meta: &Value, candidate: &Value) -> bool {
    let duration = n(meta, "duration");
    if duration <= 0.0
        || n(candidate, "duration") <= 0.0
        || (duration - n(candidate, "duration")).abs() > 8.0f64.min(3.0f64.max(duration * 0.02))
    {
        return false;
    }
    let title = normalize(s(meta, "title"));
    let artist = normalize(s(meta, "artist").split([',', ';']).next().unwrap_or(""));
    let candidate_title = normalize(s(candidate, "title"));
    let combined = normalize(&format!(
        "{} {}",
        s(candidate, "title"),
        s(candidate, "channel")
    ));
    let words = combined.split_whitespace().collect::<Vec<_>>();
    if artist.is_empty()
        || !artist.split_whitespace().all(|t| words.contains(&t))
        || !title
            .split_whitespace()
            .all(|t| candidate_title.split_whitespace().any(|w| w == t))
    {
        return false;
    }
    let versions = [
        "live",
        "remix",
        "cover",
        "karaoke",
        "instrumental",
        "slowed",
        "nightcore",
        "acoustic",
        "remaster",
    ];
    if versions.iter().any(|t| {
        candidate_title.split_whitespace().any(|w| w == *t)
            != title.split_whitespace().any(|w| w == *t)
    }) {
        return false;
    }
    let allowed = format!(
        "{title} {artist} official audio video music lyrics lyric hd hq 4k visualizer topic vevo"
    );
    candidate_title
        .split_whitespace()
        .all(|t| allowed.split_whitespace().any(|w| w == t))
}
