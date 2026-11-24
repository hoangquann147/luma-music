#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod audio;
mod commands;
mod common;
mod desktop_controls;
mod discord_presence;
mod downloads;
mod drive;
mod library;
mod media;
mod oauth;
#[cfg(test)]
mod tests;
mod tools;

use common::*;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};

#[tauri::command]
async fn music(
    action: String,
    args: Option<Vec<Value>>,
    state: tauri::State<'_, Arc<App>>,
) -> Result<Value> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        commands::dispatch(&app, &action, args.unwrap_or_default())
    })
    .await
    .map_err(err)?
}
fn main() {
    if let Err(e) = launch() {
        rfd::MessageDialog::new()
            .set_title("Luma không thể khởi động")
            .set_description(e)
            .show();
    }
}
fn launch() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if let Some(i) = args.iter().position(|a| a == "--verify-package") {
        let root = args
            .get(i + 1)
            .map(PathBuf::from)
            .ok_or("Cần thư mục kiểm tra riêng.")?;
        checked_dir(&root)?;
        let dir = tools::ensure(&root)?;
        let report = serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"engine":"Rust + Tauri","tools":dir.to_string_lossy(),"verified":true});
        atomic(&root.join("verification.json"), &report)?;
        return Ok(());
    }
    let test_profile = args
        .iter()
        .position(|a| a == "--self-test-profile")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from);
    let root = test_profile.clone().unwrap_or_else(|| {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Luma-Rust")
    });
    checked_dir(&root)?;
    let tools = tools::ensure(&root)?;
    let app = Arc::new(library::initialize(root, tools, test_profile.is_some())?);
    let smoke = app.test_mode;
    let smoke_hold=args.iter().any(|arg|arg=="--self-test-hold");
    let smoke_close=args.iter().any(|arg|arg=="--self-test-close-exits");
    let target = app.clone();
    let built = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![music])
        .manage(app.clone())
        .setup(move |tauri_app| {
            let result = (|| -> Result<()> {
                *target.handle.lock().unwrap() = Some(tauri_app.handle().clone());
                *target.media_base.lock().unwrap() = media::start(target.clone())?;
                *target.audio.lock().unwrap() = Some(audio::EngineHandle::start(target.clone())?);
                let mut window = tauri::WebviewWindowBuilder::new(tauri_app, "main", tauri::WebviewUrl::App("index.html".into()))
                    .title("Luma").inner_size(1320.0, 860.0).min_inner_size(1000.0, 680.0).visible(!smoke)
                    .on_navigation(|url| url.scheme() == "tauri" || url.host_str().is_some_and(|h| h == "tauri.localhost" || h == "localhost" || h == "127.0.0.1"));
                if smoke {
                    window = window.initialization_script(format!("window.__LUMA_NATIVE_SMOKE__=true;window.__LUMA_SMOKE_HOLD__={smoke_hold};window.__LUMA_SMOKE_CLOSE__={smoke_close};"))
                        .on_page_load(|view, payload| {
                            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                                let _ = view.eval(include_str!("smoke.js"));
                            }
                        });
                }
                window.build().map_err(err)?;
                desktop_controls::install(tauri_app.handle(), target.clone())?;
                if !smoke { commands::background(target.clone()); discord_presence::start(target.clone()); }
                Ok(())
            })();
            result.map_err(|e| std::io::Error::other(e).into())
        })
        .build(tauri::generate_context!()).map_err(err)?;
    built.run(move |handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            app.closing.store(true, Ordering::Relaxed);
            let engine = app.audio.lock().unwrap().take();
            if let Some(engine) = engine { engine.stop(); }
            for flag in app.cancel.lock().unwrap().values() {
                flag.store(true, Ordering::Relaxed)
            }
        }
        if let tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Destroyed,
            ..
        } = event
        {
            handle.exit(0)
        }
    });
    Ok(())
}
