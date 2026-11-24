use crate::{common::*, library::metadata};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

pub fn byte_range(header: Option<&str>, size: u64) -> Result<Option<(u64, u64)>> {
    let Some(header) = header else {
        return Ok(None);
    };
    if size == 0 {
        return Err("Empty file".into());
    }
    let value = header.strip_prefix("bytes=").ok_or("Invalid range")?;
    let (a, b) = value.split_once('-').ok_or("Invalid range")?;
    if value.contains(',') {
        return Err("Multiple ranges are unsupported".into());
    }
    let (start, end) = if a.is_empty() {
        let count = b.parse::<u64>().map_err(err)?;
        if count == 0 {
            return Err("Invalid suffix".into());
        }
        (size.saturating_sub(count), size - 1)
    } else {
        let start = a.parse::<u64>().map_err(err)?;
        let end = if b.is_empty() {
            size - 1
        } else {
            b.parse::<u64>().map_err(err)?.min(size - 1)
        };
        (start, end)
    };
    if start >= size || end < start {
        return Err("Unsatisfiable range".into());
    }
    Ok(Some((start, end)))
}
fn cache_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
pub fn compatible(app: &App, track: &serde_json::Value) -> Result<PathBuf> {
    let source = Path::new(s(track, "path"));
    let stat = fs::metadata(source).map_err(err)?;
    let modified = stat
        .modified()
        .map_err(err)?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(err)?
        .as_nanos();
    let key = sha(format!("{}:{}:{modified}", path_string(source), stat.len()).as_bytes());
    let root = app.root.join("compat-cache");
    checked_dir(&root)?;
    let target = root.join(format!("{key}.flac"));
    let _guard = cache_lock().lock().unwrap();
    if target.exists() {
        return Ok(target);
    }
    let sample_bits = if s(track, "codec") == "ALAC" {
        n(track, "bitsPerSample") as u32
    } else {
        24
    };
    let bits = if sample_bits <= 16 {
        16
    } else if sample_bits <= 24 {
        24
    } else {
        32
    };
    let mut total = 0u64;
    let mut existing = Vec::new();
    for entry in fs::read_dir(&root).map_err(err)? {
        let entry = entry.map_err(err)?;
        if entry.file_type().map_err(err)?.is_file() {
            let m = entry.metadata().map_err(err)?;
            total += m.len();
            existing.push((m.modified().ok(), entry.path(), m.len()))
        }
    }
    existing.sort_by_key(|x| x.0);
    for (_, p, size) in existing {
        if total <= 256 * 1024 * 1024 {
            break;
        }
        if fs::remove_file(p).is_ok() {
            total = total.saturating_sub(size)
        }
    }
    if total > 256 * 1024 * 1024 {
        return Err("Cache M4A đang bận; hãy thử lại sau.".into());
    }
    let temporary = root.join(format!("preparing-{}.flac", id()));
    let args = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-n".into(),
        "-i".into(),
        path_string(source),
        "-map".into(),
        "0:a:0".into(),
        "-vn".into(),
        "-c:a".into(),
        "flac".into(),
        "-sample_fmt".into(),
        if bits <= 16 {
            "s16".into()
        } else {
            "s32".into()
        },
        "-bits_per_raw_sample".into(),
        bits.to_string(),
        "-fs".into(),
        "268435456".into(),
        path_string(&temporary),
    ];
    let result = (|| {
        run(
            &app.tool("ffmpeg"),
            &args,
            Some(&app.closing),
            Duration::from_secs(120),
            |_| {},
        )?;
        let converted = metadata(app, &temporary, "local")?;
        if (n(&converted, "duration") - n(track, "duration")).abs() > 0.15
            || n(&converted, "sampleRate") != n(track, "sampleRate")
            || n(&converted, "channels") != n(track, "channels")
            || n(&converted, "bitsPerSample") != bits as f64
        {
            return Err("Bản tương thích không giữ đúng thời lượng/rate/channels/precision hoặc vượt giới hạn 256 MB.".into());
        }
        fs::rename(&temporary, &target).map_err(err)?;
        Ok(target.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
pub fn start(app: Arc<App>) -> Result<String> {
    let server = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    server.set_nonblocking(true).map_err(err)?;
    let base = format!(
        "http://127.0.0.1:{}/{}{}",
        server.local_addr().map_err(err)?.port(),
        id().replace('-', ""),
        id().replace('-', "")
    );
    let secret = base.rsplit('/').next().unwrap_or_default().to_owned();
    let active = Arc::new(AtomicUsize::new(0));
    std::thread::spawn(move || {
        while !app.closing.load(Ordering::Relaxed) {
            match server.accept() {
                Ok((mut socket, _)) => {
                    if active.load(Ordering::Relaxed) >= 32 {
                        continue;
                    }
                    active.fetch_add(1, Ordering::Relaxed);
                    let app = app.clone();
                    let active = active.clone();
                    let secret = secret.clone();
                    std::thread::spawn(move || {
                        let _ = serve(&app, &mut socket, &secret);
                        active.fetch_sub(1, Ordering::Relaxed);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Err(_) => break,
            }
        }
    });
    Ok(base)
}
fn serve(app: &App, socket: &mut TcpStream, secret: &str) -> Result<()> {
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(err)?;
    socket
        .set_write_timeout(Some(Duration::from_secs(20)))
        .map_err(err)?;
    let mut bytes = Vec::new();
    let mut buf = [0u8; 4096];
    while bytes.len() < 16384 {
        let count = socket.read(&mut buf).map_err(err)?;
        if count == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&buf[..count]);
        if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let headers = String::from_utf8(bytes).map_err(err)?;
    let mut lines = headers.lines();
    let first = lines.next().unwrap_or("");
    let fields = first.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 3 {
        return Ok(());
    }
    let method = fields[0];
    let target = fields[1];
    let mut range = None;
    let mut origin = String::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_owned())
            }
            if name.eq_ignore_ascii_case("origin") {
                origin = value.trim().to_owned()
            }
        }
    }
    let allowed = [
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ];
    if !origin.is_empty() && !allowed.contains(&origin.as_str()) {
        socket
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .map_err(err)?;
        return Ok(());
    }
    let cors = if origin.is_empty() {
        "http://tauri.localhost"
    } else {
        &origin
    };
    let base_headers=format!("Access-Control-Allow-Origin: {cors}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\nCache-Control: no-store\r\nConnection: close\r\n");
    if method == "OPTIONS" {
        write!(
            socket,
            "HTTP/1.1 204 No Content\r\n{base_headers}Content-Length: 0\r\n\r\n"
        )
        .map_err(err)?;
        return Ok(());
    }
    if method != "GET" && method != "HEAD" {
        return Ok(());
    }
    let prefix = format!("/{secret}/track/");
    let Some(rest) = target.strip_prefix(&prefix) else {
        return Ok(());
    };
    let (key, query) = rest.split_once('?').unwrap_or((rest, ""));
    if valid_id(key).is_err() {
        return Ok(());
    }
    let Some(track) = app.track(key) else {
        write!(
            socket,
            "HTTP/1.1 404 Not Found\r\n{base_headers}Content-Length: 0\r\n\r\n"
        )
        .map_err(err)?;
        return Ok(());
    };
    let compatibility = s(&track, "codec") == "ALAC" || query == "compat=1";
    let filename = if compatibility {
        match compatible(app, &track) {
            Ok(p) => p,
            Err(_) => {
                write!(
                    socket,
                    "HTTP/1.1 422 Unprocessable Content\r\n{base_headers}Content-Length: 0\r\n\r\n"
                )
                .map_err(err)?;
                return Ok(());
            }
        }
    } else {
        PathBuf::from(s(&track, "path"))
    };
    let mut file = match File::open(&filename) {
        Ok(f) => f,
        Err(_) => {
            write!(
                socket,
                "HTTP/1.1 404 Not Found\r\n{base_headers}Content-Length: 0\r\n\r\n"
            )
            .map_err(err)?;
            return Ok(());
        }
    };
    let size = file.metadata().map_err(err)?.len();
    if size == 0 {
        return Ok(());
    }
    let selection = match byte_range(range.as_deref(), size) {
        Ok(v) => v,
        Err(_) => {
            write!(socket,"HTTP/1.1 416 Range Not Satisfiable\r\n{base_headers}Content-Range: bytes */{size}\r\nContent-Length: 0\r\n\r\n").map_err(err)?;
            return Ok(());
        }
    };
    let (start, end) = selection.unwrap_or((0, size - 1));
    let length = end - start + 1;
    let content_type = if filename
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("m4a"))
    {
        "audio/mp4"
    } else {
        "audio/flac"
    };
    let code = if selection.is_some() {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    let content_range = if selection.is_some() {
        format!("Content-Range: bytes {start}-{end}/{size}\r\n")
    } else {
        String::new()
    };
    write!(socket,"HTTP/1.1 {code}\r\n{base_headers}Content-Type: {content_type}\r\nAccept-Ranges: bytes\r\nContent-Length: {length}\r\n{content_range}\r\n").map_err(err)?;
    if method == "GET" {
        file.seek(SeekFrom::Start(start)).map_err(err)?;
        std::io::copy(&mut file.take(length), socket).map_err(err)?;
    }
    Ok(())
}
