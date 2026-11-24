use crate::common::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(40))
        .connect_timeout(Duration::from_secs(15))
        .user_agent("Luma-Rust/2.0")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(err)
}
pub fn response_json(response: reqwest::blocking::Response) -> Result<Value> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16(){401=>"Phiên đăng nhập hết hạn; kết nối lại tài khoản.".into(),403=>"Dịch vụ từ chối quyền truy cập (403). Kiểm tra OAuth client, tài khoản thử nghiệm và quyền ứng dụng.".into(),429=>"Dịch vụ đang giới hạn yêu cầu. Hãy thử lại sau.".into(),_=>format!("Dịch vụ trả về HTTP {}.",status.as_u16())});
    }
    response.json().map_err(err)
}
pub fn external(url: &str) -> Result<Value> {
    let parsed = url::Url::parse(url).map_err(err)?;
    let allowed = [
        "open.spotify.com",
        "developer.spotify.com",
        "github.com",
        "www.youtube.com",
        "youtube.com",
        "youtu.be",
        "ffmpeg.org",
        "www.ffmpeg.org",
        "deno.com",
        "console.cloud.google.com",
        "developers.google.com",
        "accounts.spotify.com",
        "accounts.google.com",
        "discord.com",
        "docs.discord.com",
    ];
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || !allowed.contains(&parsed.host_str().unwrap_or(""))
    {
        return Err("Không được mở liên kết bên ngoài này.".into());
    }
    #[cfg(windows)]
    {
        command(Path::new("C:\\Windows\\System32\\rundll32.exe"))
            .arg("url.dll,FileProtocolHandler")
            .arg(parsed.as_str())
            .spawn()
            .map_err(err)?;
    }
    Ok(Value::Null)
}
impl App {
    fn oauth_client(&self, provider: &str) -> Result<(String, String)> {
        if provider == "spotify" {
            let settings = self.settings();
            let key = s(&settings, "spotifyClientId").to_owned();
            if !regex::Regex::new(r"^[A-Za-z0-9]{32}$")
                .unwrap()
                .is_match(&key)
            {
                return Err("Nhập Spotify Client ID hợp lệ trong Settings trước.".into());
            }
            let secret = self
                .secret("spotify-client")
                .map(|v| s(&v, "secret").to_owned())
                .unwrap_or_default();
            Ok((key, secret))
        } else {
            let v = self.drive.lock().unwrap();
            let key = s(&v["config"], "desktopClientId").to_owned();
            if !key.ends_with(".apps.googleusercontent.com")
                || key.len() > 300
                || key.contains([' ', '\r', '\n'])
            {
                return Err("Nhập Google OAuth Client ID loại Desktop app trước.".into());
            }
            Ok((
                key,
                self.secret("google-client")
                    .map(|v| s(&v, "secret").to_owned())
                    .unwrap_or_default(),
            ))
        }
    }
    pub fn spotify_status(&self) -> Value {
        let session = self.secret("spotify-session");
        json!({"connected":session.is_some(),"redirectUri":"http://127.0.0.1:43827/callback","displayName":session.and_then(|v|v.get("displayName").cloned())})
    }
    pub fn connect_oauth(self: &Arc<Self>, provider: &str) -> Result<Value> {
        let (key, secret) = self.oauth_client(provider)?;
        let listener = TcpListener::bind(if provider == "spotify" {
            "127.0.0.1:43827"
        } else {
            "127.0.0.1:0"
        })
        .map_err(|e| format!("Không mở được cổng callback OAuth: {e}"))?;
        listener.set_nonblocking(true).map_err(err)?;
        let redirect = format!(
            "http://127.0.0.1:{}/callback",
            listener.local_addr().map_err(err)?.port()
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let flag_key = format!("oauth-{provider}");
        {
            let mut flags = self.cancel.lock().unwrap();
            if flags
                .get(&flag_key)
                .is_some_and(|c| !c.load(Ordering::Relaxed))
            {
                return Err("Đang có phiên đăng nhập. Hãy hủy trước.".into());
            }
            flags.insert(flag_key.clone(), cancel.clone());
        }
        let verifier = URL_SAFE_NO_PAD.encode(
            [
                uuid::Uuid::new_v4().as_bytes().as_slice(),
                uuid::Uuid::new_v4().as_bytes().as_slice(),
            ]
            .concat(),
        );
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = id();
        let mut auth = url::Url::parse(if provider == "spotify" {
            "https://accounts.spotify.com/authorize"
        } else {
            "https://accounts.google.com/o/oauth2/v2/auth"
        })
        .unwrap();
        auth.query_pairs_mut()
            .append_pair("client_id", &key)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect)
            .append_pair("state", &state)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &challenge)
            .append_pair(
                "scope",
                if provider == "spotify" {
                    "playlist-read-private playlist-read-collaborative user-read-private"
                } else {
                    "https://www.googleapis.com/auth/drive.file"
                },
            );
        if provider == "google" {
            auth.query_pairs_mut()
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent");
            self.drive_emit(json!({"connecting":true,"phase":"connecting","message":"Hoàn tất đăng nhập Google trong trình duyệt."}));
        }
        let result = (|| -> Result<Value> {
            external(auth.as_str())?;
            let started = Instant::now();
            let code = loop {
                if cancel.load(Ordering::Relaxed) || self.closing.load(Ordering::Relaxed) {
                    return Err("Đã hủy kết nối tài khoản.".into());
                }
                if started.elapsed() > Duration::from_secs(180) {
                    return Err("Đăng nhập quá thời gian; hãy thử lại.".into());
                }
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
                        let mut bytes = [0u8; 8192];
                        let count = socket.read(&mut bytes).map_err(err)?;
                        let request = String::from_utf8_lossy(&bytes[..count]);
                        let target = request
                            .lines()
                            .next()
                            .and_then(|l| l.strip_prefix("GET "))
                            .and_then(|x| x.split_whitespace().next())
                            .unwrap_or("");
                        let parsed = url::Url::parse(&redirect).and_then(|u| u.join(target));
                        let query = parsed
                            .as_ref()
                            .ok()
                            .map(|u| u.query_pairs().into_owned().collect::<HashMap<_, _>>())
                            .unwrap_or_default();
                        let valid =
                            target.starts_with("/callback?") && query.get("state") == Some(&state);
                        let html = if valid {
                            "Luma: You can close this tab and return to the application."
                        } else {
                            "Invalid Luma OAuth callback."
                        };
                        let status = if valid { "200 OK" } else { "400 Bad Request" };
                        let _=write!(socket,"HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",html.len());
                        if !valid {
                            continue;
                        }
                        if query.contains_key("error") {
                            return Err("Bạn đã từ chối kết nối tài khoản.".into());
                        }
                        if let Some(code) = query.get("code") {
                            break code.clone();
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(80))
                    }
                    Err(e) => return Err(err(e)),
                }
            };
            let mut form = vec![
                ("grant_type".to_string(), "authorization_code".into()),
                ("client_id".into(), key.clone()),
                ("code".into(), code),
                ("redirect_uri".into(), redirect),
                ("code_verifier".into(), verifier),
            ];
            if provider == "google" && !secret.is_empty() {
                form.push(("client_secret".into(), secret))
            }
            let endpoint = if provider == "spotify" {
                "https://accounts.spotify.com/api/token"
            } else {
                "https://oauth2.googleapis.com/token"
            };
            let mut token = response_json(client()?.post(endpoint).form(&form).send().map_err(err)?)?;
            if cancel.load(Ordering::Relaxed) {
                return Err("Đã hủy kết nối.".into());
            }
            token["expiresAt"] =
                json!(chrono::Utc::now().timestamp() + n(&token, "expires_in") as i64 - 30);
            if provider == "spotify" {
                if let Ok(response) = client()?
                    .get("https://api.spotify.com/v1/me")
                    .bearer_auth(s(&token, "access_token"))
                    .send()
                {
                    if let Ok(user) = response_json(response) {
                        token["displayName"] = user
                            .get("display_name")
                            .cloned()
                            .unwrap_or(user["id"].clone())
                    }
                }
            }
            self.persist_secret(&format!("{provider}-session"), &token)?;
            Ok(if provider == "spotify" {
                self.spotify_status()
            } else {
                self.drive_status()
            })
        })();
        cancel.store(true, Ordering::Relaxed);
        self.cancel.lock().unwrap().remove(&flag_key);
        if provider == "google" {
            self.drive_emit(json!({"connecting":false,"phase":if result.is_ok(){"idle"}else{"error"},"message":if result.is_ok(){"Đã kết nối Google Drive.".to_string()}else{result.as_ref().err().unwrap().clone()}}));
            if result.is_ok() {
                return Ok(self.drive_status());
            }
        }
        result
    }
    pub fn cancel_oauth(&self, provider: &str) {
        if let Some(flag) = self
            .cancel
            .lock()
            .unwrap()
            .get(&format!("oauth-{provider}"))
        {
            flag.store(true, Ordering::Relaxed)
        }
    }
    pub fn disconnect(&self, provider: &str) -> Result<Value> {
        self.cancel_oauth(provider);
        let path = self.root.join(format!("{provider}-session.protected.json"));
        if path.exists() {
            fs_remove(&path)?
        }
        Ok(if provider == "spotify" {
            self.spotify_status()
        } else {
            self.drive_status()
        })
    }
    pub fn token(&self, provider: &str, user_only: bool) -> Result<String> {
        let (key, secret) = self.oauth_client(provider)?;
        if let Some(mut token) = self.secret(&format!("{provider}-session")) {
            if n(&token, "expiresAt") > chrono::Utc::now().timestamp() as f64 {
                return Ok(s(&token, "access_token").to_owned());
            }
            let refresh = s(&token, "refresh_token").to_owned();
            if refresh.is_empty() {
                return Err("Phiên cần đăng nhập lại.".into());
            }
            let mut form = vec![
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
                ("client_id", key.as_str()),
            ];
            if provider == "google" && !secret.is_empty() {
                form.push(("client_secret", secret.as_str()))
            }
            let endpoint = if provider == "spotify" {
                "https://accounts.spotify.com/api/token"
            } else {
                "https://oauth2.googleapis.com/token"
            };
            let updated = response_json(client()?.post(endpoint).form(&form).send().map_err(err)?)?;
            for (k, v) in updated.as_object().unwrap() {
                token[k] = v.clone()
            }
            token["expiresAt"] =
                json!(chrono::Utc::now().timestamp() + n(&token, "expires_in") as i64 - 30);
            self.persist_secret(&format!("{provider}-session"), &token)?;
            return Ok(s(&token, "access_token").to_owned());
        }
        if user_only || provider == "google" {
            return Err("Hãy kết nối tài khoản trong Settings trước.".into());
        }
        if secret.is_empty() {
            return Err("Kết nối Spotify hoặc lưu Client Secret để lấy metadata.".into());
        }
        if let Some(cached) = self.oauth.lock().unwrap().get("spotify-app").cloned() {
            if n(&cached, "expiresAt") > chrono::Utc::now().timestamp() as f64
                && s(&cached, "clientId") == key
            {
                return Ok(s(&cached, "access_token").into());
            }
        }
        let mut token = response_json(
            client()?
                .post("https://accounts.spotify.com/api/token")
                .basic_auth(&key, Some(&secret))
                .form(&[("grant_type", "client_credentials")])
                .send()
                .map_err(err)?,
        )?;
        token["expiresAt"] =
            json!(chrono::Utc::now().timestamp() + n(&token, "expires_in") as i64 - 30);
        token["clientId"] = json!(key);
        self.oauth
            .lock()
            .unwrap()
            .insert("spotify-app".into(), token.clone());
        Ok(s(&token, "access_token").into())
    }
    pub fn spotify_get(&self, url: &str, user_only: bool) -> Result<Value> {
        let u = url::Url::parse(url).map_err(err)?;
        if u.scheme() != "https"
            || u.host_str() != Some("api.spotify.com")
            || !u.path().starts_with("/v1/")
        {
            return Err("Endpoint Spotify không hợp lệ.".into());
        }
        response_json(
            client()?
                .get(url)
                .bearer_auth(self.token("spotify", user_only)?)
                .send()
                .map_err(err)?,
        )
    }
    pub fn spotify_track(&self, url: &str) -> Result<Value> {
        let key = spotify_id(url, "track")?;
        let market = s(&self.settings(), "spotifyMarket").to_owned();
        let v = self.spotify_get(
            &format!("https://api.spotify.com/v1/tracks/{key}?market={market}"),
            false,
        )?;
        track_metadata(&v).ok_or("Bài Spotify không khả dụng hoặc thiếu metadata.".into())
    }
    pub fn import_spotify_playlist(&self, url: &str) -> Result<Value> {
        let key = spotify_id(url, "playlist")?;
        let details =
            self.spotify_get(&format!("https://api.spotify.com/v1/playlists/{key}"), true)?;
        let mut next = format!("https://api.spotify.com/v1/playlists/{key}/items?limit=50");
        let mut tracks = Vec::new();
        let mut seen = HashSet::new();
        let mut pages = HashSet::new();
        let mut total = 0;
        let mut skipped = 0;
        while !next.is_empty() {
            if !pages.insert(next.clone())
                || !next.starts_with(&format!("https://api.spotify.com/v1/playlists/{key}/items"))
            {
                return Err("Phân trang Spotify không hợp lệ.".into());
            }
            let page = self.spotify_get(&next, true)?;
            total = n(&page, "total") as usize;
            let items = page["items"].as_array().ok_or("Playlist thiếu items")?;
            for row in items {
                let t = row.get("item").or_else(|| row.get("track")).unwrap_or(row);
                if let Some(meta) = track_metadata(t) {
                    if seen.insert(s(&meta, "spotifyUrl").to_owned()) {
                        tracks.push(json!({"id":id(),"metadata":meta}))
                    } else {
                        skipped += 1
                    }
                } else {
                    skipped += 1
                }
                if tracks.len() + skipped > 10000 {
                    return Err("Playlist vượt 10.000 mục.".into());
                }
            }
            next = s(&page, "next").into();
        }
        let p = json!({"id":id(),"name":details["name"],"url":format!("https://open.spotify.com/playlist/{key}"),"owner":details["owner"]["display_name"],"coverUrl":details["images"][0]["url"],"tracks":tracks,"total":total,"skipped":skipped,"importedAt":now(),"source":"spotify"});
        self.save_playlist(&p)?;
        Ok(p)
    }
    pub fn save_playlist(&self, p: &Value) -> Result<()> {
        let mut locked = self.playlists.lock().unwrap();
        let mut next = locked.clone();
        next.as_array_mut()
            .ok_or("Playlist index không hợp lệ")?
            .push(p.clone());
        atomic(&self.root.join("playlists.json"), &next)?;
        *locked = next;
        self.emit("music:playlist-update", p);
        Ok(())
    }
    pub fn import_playlist_file(&self, p: &Path) -> Result<Value> {
        if std::fs::metadata(p).map_err(err)?.len() > 16 * 1024 * 1024 {
            return Err("File playlist vượt 16 MB.".into());
        }
        let mut name = p
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let data = std::fs::read(p).map_err(err)?;
        let rows: Vec<Value> = if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("csv")) {
            let mut reader = csv::ReaderBuilder::new()
                .flexible(true)
                .from_reader(data.as_slice());
            let headers = reader.headers().map_err(err)?.clone();
            let mut rows = Vec::new();
            for record in reader.records() {
                let row = record.map_err(err)?;
                let mut value = json!({});
                for (k, v) in headers.iter().zip(row.iter()) {
                    value[k] = json!(v)
                }
                rows.push(value);
                if rows.len() > 10000 {
                    return Err("Playlist vượt 10.000 bài.".into());
                }
            }
            rows
        } else {
            let v: Value = serde_json::from_slice(&data).map_err(err)?;
            if !s(&v, "name").is_empty() {
                name = s(&v, "name").into()
            }
            v.as_array()
                .or_else(|| v["tracks"].as_array())
                .or_else(|| v["tracks"]["items"].as_array())
                .or_else(|| v["items"].as_array())
                .cloned()
                .ok_or("JSON chưa có tracks/items")?
        };
        if rows.is_empty() || rows.len() > 10000 {
            return Err("Playlist cần từ 1 đến 10.000 mục.".into());
        }
        let mut tracks = Vec::new();
        let mut seen = HashSet::new();
        let mut skipped = 0;
        for row in &rows {
            let raw = row
                .get("item")
                .or_else(|| row.get("track"))
                .or_else(|| row.get("metadata"))
                .unwrap_or(row);
            let meta = track_metadata(raw).or_else(|| export_metadata(raw));
            if let Some(meta) = meta {
                if seen.insert(s(&meta, "spotifyUrl").to_owned()) {
                    tracks.push(json!({"id":id(),"metadata":meta}))
                } else {
                    skipped += 1
                }
            } else {
                skipped += 1
            }
        }
        if tracks.is_empty() {
            return Err("Không tìm thấy bài hợp lệ có Spotify URL, tên và nghệ sĩ.".into());
        }
        let playlist = json!({"id":id(),"name":name,"tracks":tracks,"total":rows.len(),"skipped":skipped,"source":"file","importedAt":now()});
        self.save_playlist(&playlist)?;
        Ok(playlist)
    }
}
fn fs_remove(path: &Path) -> Result<()> {
    std::fs::remove_file(path).map_err(err)
}
pub fn spotify_id(url: &str, kind: &str) -> Result<String> {
    let uri = format!("spotify:{kind}:");
    let key = if let Some(key) = url.strip_prefix(&uri) {
        key.to_string()
    } else {
        let u = url::Url::parse(url).map_err(err)?;
        if u.scheme() != "https"
            || u.host_str() != Some("open.spotify.com")
            || !u.username().is_empty()
            || u.password().is_some()
            || u.port().is_some()
        {
            return Err("Liên kết Spotify không hợp lệ.".into());
        }
        let parts = u
            .path_segments()
            .ok_or("Link Spotify không hợp lệ")?
            .collect::<Vec<_>>();
        parts
            .windows(2)
            .find(|w| w[0] == kind)
            .map(|w| w[1].to_owned())
            .ok_or("Sai loại liên kết Spotify")?
    };
    if key.len() != 22 || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Mã Spotify không hợp lệ.".into());
    }
    Ok(key)
}
pub fn track_metadata(v: &Value) -> Option<Value> {
    if b(v, "is_local")
        || v.get("is_playable") == Some(&Value::Bool(false))
        || (!s(v, "type").is_empty() && s(v, "type") != "track")
    {
        return None;
    }
    let key = s(v, "id");
    if key.len() != 22 || s(v, "name").is_empty() {
        return None;
    }
    let artists = v["artists"]
        .as_array()?
        .iter()
        .map(|a| s(a, "name"))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    if artists.is_empty() {
        return None;
    }
    Some(
        json!({"title":v["name"],"artist":artists,"album":v["album"]["name"],"duration":n(v,"duration_ms")/1000.0,"coverUrl":v["album"]["images"][0]["url"],"releaseDate":v["album"]["release_date"],"trackNumber":v["track_number"],"spotifyUrl":format!("https://open.spotify.com/track/{key}")}),
    )
}
fn export_metadata(v: &Value) -> Option<Value> {
    let obj = v.as_object()?;
    let fields: HashMap<String, &Value> = obj
        .iter()
        .map(|(k, v)| {
            (
                k.chars()
                    .filter(|c| c.is_alphanumeric())
                    .flat_map(char::to_lowercase)
                    .collect(),
                v,
            )
        })
        .collect();
    let pick = |names: &[&str]| -> String {
        names
            .iter()
            .find_map(|k| {
                fields
                    .get(*k)
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
            })
            .unwrap_or("")
            .to_owned()
    };
    let url = pick(&[
        "spotifyurl",
        "trackuri",
        "spotifyuri",
        "trackurl",
        "uri",
        "url",
        "spotifytrackid",
        "trackid",
        "id",
    ]);
    let key = spotify_id(&url, "track").ok().or_else(|| {
        if url.len() == 22 && url.chars().all(|c| c.is_ascii_alphanumeric()) {
            Some(url)
        } else {
            None
        }
    })?;
    let title = pick(&["title", "trackname", "name"]);
    let artist = pick(&["artist", "artistnames", "artistname", "artists"]);
    if title.is_empty() || artist.is_empty() {
        return None;
    }
    let duration = pick(&["durationms", "durationmilliseconds"])
        .parse::<f64>()
        .ok()
        .map(|n| n / 1000.0)
        .or_else(|| pick(&["duration", "durationseconds"]).parse().ok())
        .unwrap_or(0.0);
    Some(
        json!({"title":title,"artist":artist,"album":pick(&["album","albumname"]),"duration":duration,"spotifyUrl":format!("https://open.spotify.com/track/{key}")}),
    )
}
