use crate::common::*;
use serde_json::Value;
use std::{
    fs,
    io::{Cursor, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

pub fn ensure(root: &Path) -> Result<PathBuf> {
    let manifest_text =
        include_str!("../resources/tools.sha256.json").trim_start_matches('\u{feff}');
    let manifest: Value = serde_json::from_str(manifest_text).map_err(err)?;
    let expected = manifest
        .as_object()
        .ok_or("Manifest công cụ không hợp lệ")?;
    let fingerprint = sha(manifest_text.as_bytes());
    let directory = root.join(format!("native-tools-{}", &fingerprint[..12]));
    checked_dir(&directory)?;
    if !directory.join(".complete").exists() {
        // A verified ZIP overlay is appended after linking. It avoids compiling a
        // 136 MB constant into LLVM and leaves the app a native Rust executable.
        let mut executable = fs::File::open(std::env::current_exe().map_err(err)?).map_err(err)?;
        let length = executable.metadata().map_err(err)?.len();
        if length < 48 {
            return Err("Gói công cụ không đầy đủ.".into());
        }
        executable.seek(SeekFrom::End(-48)).map_err(err)?;
        let mut footer = [0u8; 48];
        executable.read_exact(&mut footer).map_err(err)?;
        if &footer[..8] != b"LUMARST1" {
            return Err(
                "Hãy chạy file Luma-Rust.exe đã đóng gói, không chạy binary Cargo trung gian."
                    .into(),
            );
        }
        let size = u64::from_le_bytes(footer[8..16].try_into().unwrap());
        if size > 512 * 1024 * 1024 || size > length - 48 {
            return Err("Kích thước gói công cụ không hợp lệ.".into());
        }
        executable
            .seek(SeekFrom::Start(length - 48 - size))
            .map_err(err)?;
        let mut bytes = vec![0u8; size as usize];
        executable.read_exact(&mut bytes).map_err(err)?;
        use sha2::{Digest, Sha256};
        if Sha256::digest(&bytes).as_slice() != &footer[16..] {
            return Err("Checksum gói công cụ không khớp.".into());
        }
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(err)?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(err)?;
            let relative = entry
                .enclosed_name()
                .ok_or("Đường dẫn công cụ không hợp lệ")?;
            let dest = directory.join(relative);
            if !dest.starts_with(&directory) {
                return Err("Công cụ vượt ra ngoài thư mục riêng.".into());
            }
            no_links(&dest)?;
            if entry.is_dir() {
                fs::create_dir_all(&dest).map_err(err)?
            } else {
                fs::create_dir_all(dest.parent().unwrap()).map_err(err)?;
                let mut file = fs::File::create(&dest).map_err(err)?;
                std::io::copy(&mut entry, &mut file).map_err(err)?;
                file.sync_all().map_err(err)?;
            }
        }
    }
    for (name, hash) in expected {
        if Path::new(name).components().count() != 1
            || sha_file(&directory.join(name))?
                != hash.as_str().ok_or("Hash công cụ không hợp lệ")?
        {
            return Err(format!("Công cụ {name} không vượt kiểm tra toàn vẹn. Hãy dùng đường dẫn công cụ riêng hoặc khôi phục cache công cụ."));
        }
    }
    for required in ["ffmpeg.exe", "ffprobe.exe", "yt-dlp.exe", "deno.exe"] {
        if !expected.contains_key(required) {
            return Err(format!("Thiếu công cụ {required}"));
        }
    }
    fs::write(directory.join(".complete"), fingerprint).map_err(err)?;
    Ok(directory)
}
