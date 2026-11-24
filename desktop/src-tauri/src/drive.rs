use crate::{
    common::*,
    library::metadata,
    oauth::{client, response_json},
};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
const CHUNK: usize = 8 * 1024 * 1024;
fn prop(value: &str, key: &str) -> String {
    let limit = 124 - key.len();
    let mut out = String::new();
    for c in value.chars().filter(|c| !c.is_control()) {
        if out.len() + c.len_utf8() > limit {
            break;
        }
        out.push(c)
    }
    out
}
fn walk(root: &Path, current: &Path, result: &mut Vec<PathBuf>) -> Result<()> {
    for e in fs::read_dir(current).map_err(err)? {
        let e = e.map_err(err)?;
        let p = e.path();
        let t = e.file_type().map_err(err)?;
        if t.is_symlink() {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if e.metadata().map_err(err)?.file_attributes() & 0x400 != 0 {
                continue;
            }
        }
        if t.is_dir() {
            walk(root, &p, result)?
        } else if t.is_file()
            && p.extension()
                .is_some_and(|e| ["flac", "mp3", "m4a"].iter().any(|ext| e.eq_ignore_ascii_case(ext)))
        {
            if !p.starts_with(root) {
                return Err("File nằm ngoài thư mục nguồn.".into());
            }
            result.push(p);
            if result.len() > 10000 {
                return Err("Nguồn Drive vượt 10.000 file.".into());
            }
        }
    }
    Ok(())
}
fn digest(p: &Path) -> Result<(String, String)> {
    let mut f = File::open(p).map_err(err)?;
    let mut md5 = md5::Context::new();
    let mut sha = sha2::Sha256::new();
    use sha2::Digest;
    let mut buf = [0u8; 65536];
    loop {
        let count = f.read(&mut buf).map_err(err)?;
        if count == 0 {
            break;
        }
        md5.consume(&buf[..count]);
        sha.update(&buf[..count]);
    }
    Ok((
        format!("{:x}", md5.compute()),
        format!("{:x}", sha.finalize()),
    ))
}
impl App {
    pub fn save_drive_config(&self, input: &Value) -> Result<Value> {
        let mut config = self.drive.lock().unwrap()["config"].clone();
        let old_id = s(&config, "desktopClientId").to_owned();
        let obj = input.as_object().ok_or("Cấu hình Drive không hợp lệ")?;
        for (k, v) in obj {
            match k.as_str() {
                "desktopClientId" => {
                    let key = text(v, 300)?;
                    if !key.is_empty()
                        && (!key.ends_with(".apps.googleusercontent.com")
                            || key.contains([' ', '\r', '\n']))
                    {
                        return Err("Google Client ID không hợp lệ.".into());
                    }
                    config[k] = json!(key)
                }
                "desktopClientSecret" => {
                    let secret = text(v, 1024)?;
                    if !secret.is_empty() {
                        self.persist_secret("google-client", &json!({"secret":secret}))?;
                        config["secretConfigured"] = json!(true)
                    }
                }
                "sourceDirectory" => {
                    let source = text(v, 4096)?;
                    if source.is_empty() || !Path::new(&source).is_absolute() {
                        return Err("Chọn thư mục nguồn tuyệt đối.".into());
                    }
                    no_links(Path::new(&source))?;
                    config[k] = json!(source)
                }
                "autoSync" => {
                    if !v.is_boolean() {
                        return Err("Công tắc Drive không hợp lệ".into());
                    }
                    config[k] = v.clone()
                }
                _ => return Err("Trường cấu hình Drive không được hỗ trợ.".into()),
            }
        }
        atomic(&self.root.join("drive-config.json"), &config)?;
        if s(&config, "desktopClientId") != old_id {
            self.cancel_drive();
            let _ = self.disconnect("google");
        }
        self.drive.lock().unwrap()["config"] = config;
        self.drive_emit(json!({"phase":"idle","message":"Đã lưu cấu hình Google Drive."}));
        Ok(self.drive_status())
    }
    pub fn cancel_drive(&self) {
        if let Some(c) = self.cancel.lock().unwrap().get("drive-sync") {
            c.store(true, Ordering::Relaxed)
        }
    }
    fn drive_get(&self, url: &str) -> Result<Value> {
        response_json(
            client()?
                .get(url)
                .bearer_auth(self.token("google", true)?)
                .send()
                .map_err(err)?,
        )
    }
    fn drive_list(&self, query: &str) -> Result<Vec<Value>> {
        let mut values = Vec::new();
        let mut next = String::new();
        let mut seen = std::collections::HashSet::new();
        loop {
            let mut url = url::Url::parse(&format!("{API}/files")).unwrap();
            url.query_pairs_mut()
                .append_pair("q", query)
                .append_pair(
                    "fields",
                    "nextPageToken,files(id,name,mimeType,md5Checksum,size,properties,version,createdTime)",
                )
                .append_pair("pageSize", "1000");
            if !next.is_empty() {
                url.query_pairs_mut().append_pair("pageToken", &next);
            }
            let page = self.drive_get(url.as_str())?;
            values.extend(
                page["files"]
                    .as_array()
                    .ok_or("Drive không có danh sách file")?
                    .iter()
                    .cloned(),
            );
            if values.len() > 15000 {
                return Err("Thư mục Drive vượt giới hạn.".into());
            }
            next = s(&page, "nextPageToken").into();
            if next.is_empty() {
                break;
            }
            if !seen.insert(next.clone()) {
                return Err("Drive phân trang bị lặp.".into());
            }
        }
        Ok(values)
    }
    pub fn sync_drive(self: &Arc<Self>) -> Result<Value> {
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut flags = self.cancel.lock().unwrap();
            if flags
                .get("drive-sync")
                .is_some_and(|f| !f.load(Ordering::Relaxed))
            {
                return Err("Đồng bộ đang chạy.".into());
            }
            flags.insert("drive-sync".into(), cancel.clone());
        }
        let result = (|| -> Result<Value> {
            let config = self.drive.lock().unwrap()["config"].clone();
            let root = fs::canonicalize(s(&config, "sourceDirectory")).map_err(err)?;
            no_links(&root)?;
            self.token("google", true)?;
            self.drive_emit(json!({"phase":"scanning","message":"Đang quét FLAC, MP3, M4A…","filesDone":0,"uploaded":0,"skipped":0,"failed":0,"bytesUploaded":0,"progress":0}));
            let mut folders=self.drive_list("trashed = false and mimeType = 'application/vnd.google-apps.folder' and properties has { key='lumaSyncRoot' and value='v1' }")?;
            folders.sort_by_key(|v| (s(v, "createdTime").to_owned(), s(v, "id").to_owned()));
            let folder = if let Some(folder) = folders.first() {
                s(folder, "id").to_owned()
            } else {
                let v=response_json(client()?.post(format!("{API}/files?fields=id")).bearer_auth(self.token("google",true)?).json(&json!({"name":"Luma Music","mimeType":"application/vnd.google-apps.folder","properties":{"lumaSyncRoot":"v1"}})).send().map_err(err)?)?;
                s(&v, "id").to_owned()
            };
            if !folder
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                || folder.is_empty()
            {
                return Err("Folder ID Drive không hợp lệ.".into());
            }
            let remote = self.drive_list(&format!("trashed = false and '{folder}' in parents"))?;
            let by_key = remote
                .iter()
                .filter_map(|v| {
                    v["properties"]["lumaTrackId"]
                        .as_str()
                        .map(|key| (key.to_owned(), v))
                })
                .collect::<std::collections::HashMap<_, _>>();
            let mut files = Vec::new();
            walk(&root, &root, &mut files)?;
            let total = files.len();
            let total_bytes = files
                .iter()
                .filter_map(|p| fs::metadata(p).ok())
                .map(|m| m.len())
                .sum::<u64>();
            self.drive_emit(json!({"folderId":folder,"filesTotal":total,"bytesTotal":total_bytes,"phase":"uploading"}));
            let index_path = self.root.join("drive-sync-index-rust.json");
            let mut index = if index_path.exists() {
                read_json(&index_path)?
            } else {
                json!({})
            };
            let mut uploaded = 0;
            let mut skipped = 0;
            let mut failed = 0;
            let mut done_bytes = 0u64;
            for (count, p) in files.iter().enumerate() {
                if cancel.load(Ordering::Relaxed) || self.closing.load(Ordering::Relaxed) {
                    return Err("Đã dừng đồng bộ Drive.".into());
                }
                let size = fs::metadata(p).map_err(err)?.len();
                let relative = p
                    .strip_prefix(&root)
                    .map_err(err)?
                    .to_string_lossy()
                    .replace('\\', "/");
                use unicode_normalization::UnicodeNormalization;
                let key = sha(relative.nfc().collect::<String>().to_lowercase().as_bytes());
                let attempt = (|| -> Result<bool> {
                    if size == 0 || size > 2 * 1024 * 1024 * 1024 {
                        return Err("File nhạc vượt giới hạn 2 GiB.".into());
                    }
                    let (md5, hash) = digest(p)?;
                    let previous = by_key.get(&key).copied();
                    if let Some(old) = previous {
                        if s(old, "md5Checksum") == md5
                            && s(&old["properties"], "lumaContentSha256") == hash
                        {
                            return Ok(false);
                        }
                        if !index[&key]["sha256"].is_null()
                            && s(&old["properties"], "lumaContentSha256")
                                != s(&index[&key], "sha256")
                        {
                            return Err("Bản trên Drive đã bị sửa; không ghi đè xung đột.".into());
                        }
                    }
                    let track = metadata(self, p, "local")?;
                    let properties = json!({"lumaSource":"desktop","lumaTrackId":key,"lumaContentSha256":hash,"title":prop(s(&track,"title"),"title"),"artist":prop(s(&track,"artist"),"artist"),"album":prop(s(&track,"album"),"album"),"duration":n(&track,"duration").to_string()});
                    let extension = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                    let mime = match extension.as_str() { "mp3" => "audio/mpeg", "m4a" => "audio/mp4", _ => "audio/flac" };
                    let mut meta = json!({"name":format!("{key}.{extension}"),"mimeType":mime,"properties":properties});
                    let (method, url) = if let Some(old) = previous {
                        (
                            reqwest::Method::PATCH,
                            format!(
                                "{UPLOAD}/{}?uploadType=resumable&fields=id,md5Checksum,properties",
                                s(old, "id")
                            ),
                        )
                    } else {
                        meta["parents"] = json!([folder]);
                        (
                            reqwest::Method::POST,
                            format!(
                                "{UPLOAD}?uploadType=resumable&fields=id,md5Checksum,properties"
                            ),
                        )
                    };
                    let response = client()?
                        .request(method, url)
                        .bearer_auth(self.token("google", true)?)
                        .header("X-Upload-Content-Type", mime)
                        .header("X-Upload-Content-Length", size)
                        .json(&meta)
                        .send()
                        .map_err(err)?;
                    if !response.status().is_success() {
                        return Err(format!(
                            "Không mở được upload Drive: HTTP {}",
                            response.status()
                        ));
                    }
                    let location = response
                        .headers()
                        .get("location")
                        .and_then(|v| v.to_str().ok())
                        .ok_or("Drive thiếu địa chỉ upload")?
                        .to_owned();
                    let url = url::Url::parse(&location).map_err(err)?;
                    if url.scheme() != "https"
                        || !url.host_str().unwrap_or("").ends_with(".googleapis.com")
                    {
                        return Err("Địa chỉ upload không thuộc Google.".into());
                    }
                    let mut file = File::open(p).map_err(err)?;
                    let mut offset = 0u64;
                    let mut remote_id = String::new();
                    while offset < size {
                        if cancel.load(Ordering::Relaxed) {
                            return Err("Đã hủy upload.".into());
                        }
                        let len = (size - offset).min(CHUNK as u64) as usize;
                        let mut buf = vec![0u8; len];
                        file.seek(SeekFrom::Start(offset)).map_err(err)?;
                        file.read_exact(&mut buf).map_err(err)?;
                        let response = client()?
                            .put(&location)
                            .bearer_auth(self.token("google", true)?)
                            .header("Content-Type", mime)
                            .header(
                                "Content-Range",
                                format!("bytes {}-{}/{size}", offset, offset + len as u64 - 1),
                            )
                            .body(buf)
                            .send()
                            .map_err(err)?;
                        if response.status().as_u16() == 308 {
                            let range = response
                                .headers()
                                .get("range")
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("");
                            let acknowledged = range
                                .strip_prefix("bytes=0-")
                                .and_then(|v| v.parse::<u64>().ok())
                                .ok_or("Drive trả offset không hợp lệ")?
                                + 1;
                            if acknowledged <= offset || acknowledged > offset + len as u64 {
                                return Err("Vị trí upload Drive ngoài giới hạn.".into());
                            }
                            offset = acknowledged;
                        } else {
                            let result = response_json(response)?;
                            if s(&result, "md5Checksum") != md5 {
                                return Err("Checksum file trên Drive không khớp.".into());
                            }
                            remote_id = s(&result, "id").into();
                            offset = size;
                        }
                        self.drive_emit(json!({"bytesUploaded":done_bytes+offset,"progress":if total_bytes==0{0.0}else{(done_bytes+offset)as f64*100.0/total_bytes as f64},"message":format!("Đang upload {}",s(&track,"title"))}));
                    }
                    if cancel.load(Ordering::Relaxed) {
                        return Err("Đã hủy đồng bộ.".into());
                    }
                    if digest(p)?.0 != md5 {
                        return Err("File nguồn thay đổi trong khi upload.".into());
                    }
                    index[&key] = json!({"sha256":hash,"md5":md5,"remoteId":remote_id});
                    atomic(&index_path, &index)?;
                    Ok(true)
                })();
                let message = match attempt {
                    Ok(true) => {
                        uploaded += 1;
                        "Đã upload".to_owned()
                    }
                    Ok(false) => {
                        skipped += 1;
                        "File đã đồng bộ".to_owned()
                    }
                    Err(e) => {
                        failed += 1;
                        e
                    }
                };
                done_bytes += size;
                self.drive_emit(json!({"filesDone":count+1,"uploaded":uploaded,"skipped":skipped,"failed":failed,"bytesUploaded":done_bytes,"progress":if total==0{100.0}else{(count+1)as f64*100.0/total as f64},"message":message}));
            }
            self.drive_emit(json!({"phase":"idle","lastSyncAt":now(),"message":format!("Đã xử lý {total} file: {uploaded} upload, {skipped} đã có, {failed} lỗi."),"progress":100}));
            Ok(self.drive_status())
        })();
        cancel.store(true, Ordering::Relaxed);
        self.cancel.lock().unwrap().remove("drive-sync");
        if let Err(e) = &result {
            self.drive_emit(json!({"phase":"error","message":e}))
        }
        result
    }
}

#[cfg(test)] mod sync_format_tests {
 use super::*;
 #[test] fn scans_supported_audio_recursively_but_excludes_wav() {
 let dir=tempfile::tempdir().unwrap(); let sub=dir.path().join("nested"); fs::create_dir(&sub).unwrap();
 for name in ["one.FLAC","two.mp3","three.M4A","four.wav","notes.txt"] {fs::write(sub.join(name),b"test").unwrap();}
 let mut files=Vec::new(); walk(dir.path(),dir.path(),&mut files).unwrap(); assert_eq!(files.len(),3);
 assert!(!files.iter().any(|p|p.extension().unwrap()=="wav"));
 }
}
