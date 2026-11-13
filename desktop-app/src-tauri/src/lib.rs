mod sidecar;

use std::sync::Arc;

use serde::Serialize;
use sidecar::SidecarManager;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppRuntimeInfo {
    version: String,
    config_dir: String,
    resource_dir: String,
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[tauri::command]
fn app_runtime_info(app: tauri::AppHandle) -> Result<AppRuntimeInfo, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("读取 app_config_dir 失败: {error}"))?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("读取 resource_dir 失败: {error}"))?;
    Ok(AppRuntimeInfo {
        version: app_version(),
        config_dir: config_dir.display().to_string(),
        resource_dir: resource_dir.display().to_string(),
    })
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_owned())?;
    window
        .show()
        .map_err(|error| format!("显示主窗口失败: {error}"))?;
    let _ = window.unminimize();
    window
        .set_focus()
        .map_err(|error| format!("聚焦主窗口失败: {error}"))
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_owned())?;
    window
        .hide()
        .map_err(|error| format!("隐藏主窗口失败: {error}"))
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    let _ = app.emit("app-quit-requested", ());
    app.exit(0);
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "显示 MeshAudio", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 MeshAudio", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    let tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("MeshAudio")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let _ = show_main_window(app.clone());
            }
            "hide" => {
                let _ = hide_main_window(app.clone());
            }
            "quit" => {
                quit_app(app.clone());
            }
            _ => {}
        })
        .icon(tauri::image::Image::from_app_icon_resource(32)?);

    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar = Arc::new(SidecarManager::new());
    let sidecar_for_setup = Arc::clone(&sidecar);
    tauri::Builder::default()
        .manage(Arc::clone(&sidecar))
        // Best-effort single-instance enforcement. If this plugin is not present in
        // a downstream lockfile, remove this call and keep the callback behavior as
        // the documented fallback until the dependency is available.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_main_window(app.clone());
            let _ = app.emit("second-instance", ());
        }))
        .setup(move |app| {
            let _ = app.emit("tauri-ready", ());
            // Bring the backend up with the process rather than on webview
            // mount: the audio path must not depend on the UI loading, and a
            // packaged build has no way to report an early JS failure.
            {
                let manager = Arc::clone(&sidecar_for_setup);
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let _ = manager.start(&handle, sidecar::SidecarConfig::default());
                });
            }
            if let Err(error) = setup_tray(app) {
                eprintln!("创建 MeshAudio 托盘失败: {error}");
                let _ = app.emit(
                    "tray-error",
                    serde_json::json!({ "message": error.to_string() }),
                );
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            app_runtime_info,
            show_main_window,
            hide_main_window,
            quit_app,
            sidecar::frontend_log,
            sidecar::start_sidecar,
            sidecar::stop_sidecar,
            sidecar::force_stop_sidecar,
            sidecar::sidecar_status,
            sidecar::sidecar_health,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                let _ = window.emit("window-hidden-to-tray", ());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running MeshAudio Tauri application")
        .run(move |app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = sidecar.stop(app);
            }
        });
}
