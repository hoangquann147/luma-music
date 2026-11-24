use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;

pub type Result<T> = std::result::Result<T, String>;
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
pub fn n(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}
pub fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn text(v: &Value, max: usize) -> Result<String> {
    let t = v.as_str().ok_or("Dữ liệu văn bản không hợp lệ.")?;
    if t.len() > max || t.contains('\0') {
        return Err("Văn bản vượt giới hạn hoặc không hợp lệ.".into());
    }
    Ok(t.trim().into())
}
pub fn valid_id(t: &str) -> Result<()> {
    uuid::Uuid::parse_str(t)
        .map(|_| ())
        .map_err(|_| "Mã mục không hợp lệ.".into())
}
pub fn path_string(p: &Path) -> String {
    p.to_string_lossy()
        .strip_prefix("\\\\?\\")
        .unwrap_or(&p.to_string_lossy())
        .to_string()
}
pub fn same(a: &Path, b: &Path) -> bool {
    path_string(a).eq_ignore_ascii_case(&path_string(b))
}
pub fn read_json(p: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(p).map_err(err)?).map_err(err)
}
pub fn atomic(p: &Path, v: &Value) -> Result<()> {
    fs::create_dir_all(p.parent().ok_or("Thiếu thư mục lưu")?).map_err(err)?;
    let tmp = p.with_extension(format!("tmp-{}", id()));
    let result = (|| {
        let mut f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)
            .map_err(err)?;
        f.write_all(&serde_json::to_vec_pretty(v).map_err(err)?)
            .map_err(err)?;
        f.sync_all().map_err(err)?;
        fs::rename(&tmp, p).map_err(err)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
pub fn sha_file(p: &Path) -> Result<String> {
    let mut f = File::open(p).map_err(err)?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let count = f.read(&mut buf).map_err(err)?;
        if count == 0 {
            break;
        }
        h.update(&buf[..count]);
    }
    Ok(format!("{:x}", h.finalize()))
}
pub fn sha(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
pub fn stem(t: &str, limit: usize) -> String {
    use unicode_normalization::UnicodeNormalization;
    let cleaned = t
        .nfc()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect::<String>()
        .trim_end_matches(['.', ' '])
        .to_string();
    let reserved = regex::Regex::new(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)").unwrap();
    if cleaned.is_empty() || reserved.is_match(&cleaned) {
        "Untitled".into()
    } else {
        cleaned
    }
}
pub fn no_links(p: &Path) -> Result<()> {
    let mut current = Some(p);
    while let Some(path) = current {
        if let Ok(meta) = fs::symlink_metadata(path) {
            if meta.file_type().is_symlink() {
                return Err("Không sử dụng thư mục liên kết cho file quản lý.".into());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("Không sử dụng junction/reparse point.".into());
                }
            }
        }
        current = path.parent();
    }
    Ok(())
}
pub fn checked_dir(p: &Path) -> Result<()> {
    if !p.is_absolute()
        || p.parent().is_none()
        || p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Chọn thư mục tuyệt đối riêng cho nhạc.".into());
    }
    no_links(p)?;
    fs::create_dir_all(p).map_err(err)
}
pub fn copy_verified(source: &Path, destination: &Path) -> Result<bool> {
    no_links(destination)?;
    let hash = sha_file(source)?;
    if destination.exists() {
        if sha_file(destination)? == hash {
            return Ok(false);
        }
        return Err("File đích đã tồn tại với nội dung khác; không ghi đè.".into());
    }
    let result = (|| {
        let mut src = File::open(source).map_err(err)?;
        let mut dst = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .map_err(err)?;
        std::io::copy(&mut src, &mut dst).map_err(err)?;
        dst.sync_all().map_err(err)?;
        if sha_file(destination)? != hash {
            return Err("Checksum bản sao không khớp.".into());
        }
        Ok(true)
    })();
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}
pub fn command(binary: &Path) -> Command {
    let mut c = Command::new(binary);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c
}
pub fn run(
    binary: &Path,
    args: &[String],
    cancel: Option<&AtomicBool>,
    timeout: Duration,
    mut on_line: impl FnMut(&str),
) -> Result<String> {
    let mut child = command(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "Không chạy được {}: {e}",
                binary.file_name().unwrap_or_default().to_string_lossy()
            )
        })?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(t) => {
                    if tx.send(t).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let errors = std::thread::spawn(move || {
        let mut input = stderr;
        let mut result = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(count) = input.read(&mut buf) {
            if count == 0 {
                break;
            }
            result.extend_from_slice(&buf[..count]);
            if result.len() > 65536 {
                result.drain(..result.len() - 65536);
            }
        }
        String::from_utf8_lossy(&result).into_owned()
    });
    let started = Instant::now();
    let mut output = String::new();
    let mut aborted = false;
    let status = loop {
        while let Ok(line) = rx.try_recv() {
            on_line(&line);
            if output.len() + line.len() > 8_000_000 {
                aborted = true;
                break;
            }
            output.push_str(&line);
            output.push('\n');
        }
        if aborted
            || cancel.is_some_and(|c| c.load(Ordering::Relaxed))
            || started.elapsed() > timeout
        {
            #[cfg(windows)]
            {
                let _ = command(Path::new("C:\\Windows\\System32\\taskkill.exe"))
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(if started.elapsed() > timeout {
                "Tác vụ vượt thời gian cho phép."
            } else {
                "Đã hủy tác vụ."
            }
            .into());
        }
        if let Some(status) = child.try_wait().map_err(err)? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    let _ = reader.join();
    for line in rx.try_iter() {
        on_line(&line);
        if output.len() + line.len() < 8_000_000 {
            output.push_str(&line);
            output.push('\n')
        }
    }
    let error = errors.join().unwrap_or_default();
    if !status.success() {
        return Err(format!(
            "{}: {}",
            binary.file_name().unwrap_or_default().to_string_lossy(),
            error
                .chars()
                .rev()
                .take(1600)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    Ok(output)
}

pub struct App {
    pub root: PathBuf,
    pub tools: PathBuf,
    pub library: Mutex<Value>,
    pub profile: Mutex<Value>,
    pub playlists: Mutex<Value>,
    pub jobs: Mutex<HashMap<String, Value>>,
    pub batches: Mutex<HashMap<String, Value>>,
    pub matches: Mutex<HashMap<String, Value>>,
    pub cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub oauth: Mutex<HashMap<String, Value>>,
    pub drive: Mutex<Value>,
    pub handle: Mutex<Option<tauri::AppHandle>>,
    pub media_base: Mutex<String>,
    pub audio: Mutex<Option<crate::audio::EngineHandle>>,
    pub closing: AtomicBool,
    pub test_mode: bool,
}
impl App {
    pub fn emit(&self, event: &str, value: &Value) {
        if let Some(app) = self.handle.lock().unwrap().as_ref() {
            let _ = app.emit(event, value);
        }
    }
    pub fn persist_secret(&self, key: &str, value: &Value) -> Result<()> {
        let encoded = protect(&serde_json::to_vec(value).map_err(err)?)?;
        atomic(
            &self.root.join(format!("{key}.protected.json")),
            &json!({"data":STANDARD.encode(encoded)}),
        )
    }
    pub fn secret(&self, key: &str) -> Option<Value> {
        let v = read_json(&self.root.join(format!("{key}.protected.json"))).ok()?;
        let bytes = STANDARD.decode(s(&v, "data")).ok()?;
        serde_json::from_slice(&unprotect(&bytes).ok()?).ok()
    }
    pub fn tool(&self, name: &str) -> PathBuf {
        let settings = self.library.lock().unwrap();
        let key = match name {
            "yt-dlp" => "ytDlpPath",
            "ffmpeg" => "ffmpegPath",
            _ => "",
        };
        let configured = s(&settings["settings"], key);
        if !configured.is_empty()
            && configured != "bundled"
            && configured != name
            && configured != format!("{name}.exe")
        {
            return PathBuf::from(configured);
        }
        if name == "ffprobe" {
            let ff = s(&settings["settings"], "ffmpegPath");
            if Path::new(ff).is_absolute() {
                return Path::new(ff).parent().unwrap().join("ffprobe.exe");
            }
        }
        let bundled = self.tools.join(format!("{name}.exe"));
        if bundled.exists() {
            bundled
        } else {
            PathBuf::from(name)
        }
    }
    pub fn set_job(&self, job: &Value) {
        self.jobs
            .lock()
            .unwrap()
            .insert(s(job, "id").into(), job.clone());
        self.emit("music:download-update", job);
    }
    pub fn drive_status(&self) -> Value {
        let mut v = self.drive.lock().unwrap().clone();
        v["connected"] = json!(self.secret("google-session").is_some());
        v
    }
    pub fn drive_emit(&self, patch: Value) {
        let mut v = {
            let mut state = self.drive.lock().unwrap();
            for (k, v) in patch.as_object().unwrap() {
                state[k] = v.clone()
            }
            state.clone()
        };
        v["connected"] = json!(self.secret("google-session").is_some());
        self.emit("music:drive-status", &v);
    }
}
#[cfg(windows)]
fn crypt(data: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .map_err(err)?;
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as _)));
        Ok(result)
    }
}
#[cfg(windows)]
pub fn protect(v: &[u8]) -> Result<Vec<u8>> {
    crypt(v, true)
}
#[cfg(windows)]
pub fn unprotect(v: &[u8]) -> Result<Vec<u8>> {
    crypt(v, false)
}
#[cfg(not(windows))]
pub fn protect(_: &[u8]) -> Result<Vec<u8>> {
    Err("Kho khóa hệ điều hành chưa được hỗ trợ trên nền tảng này.".into())
}
#[cfg(not(windows))]
pub fn unprotect(_: &[u8]) -> Result<Vec<u8>> {
    Err("Kho khóa hệ điều hành chưa được hỗ trợ trên nền tảng này.".into())
}
