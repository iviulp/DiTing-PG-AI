// Prevents additional console window on Windows in release, do not remove!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod error;
mod models;
mod services;

use services::ai_service::AiService;
use services::db_service::DbService;
use tracing_subscriber::fmt;
use tracing_subscriber::EnvFilter;

fn main() {
    // 1. 初始化结构化日志输出引擎 (tracing)
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,aidb_desk=debug"));

    fmt()
        .with_env_filter(filter)
        .with_target(true)
        .init();

    tracing::info!("Initializing AIDB Desk Tauri Backend Engine...");

    let db_service = DbService::new();
    // WP3: 隧道被动断开 → emit tunnel-disconnected 事件 (前端显示断开角标)
    let mut disconnect_rx = db_service.subscribe_tunnel_disconnects();

    // 2. 组装 Tauri Builder 并注册 State 服务与 IPC Commands
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(db_service)
        .manage(AiService::new())
        .invoke_handler(tauri::generate_handler![
            commands::connect_db,
            commands::get_tunnel_state,
            commands::close_tunnel,
            commands::execute_sql,
            commands::get_table_schema,
            commands::get_process_list,
            commands::kill_process,
            commands::get_db_users,
            commands::ai_chat,
            commands::ai_chat_stream,
            commands::update_ai_config,
            commands::get_ai_config,
            commands::open_downloads_folder,
            commands::open_file_dialog,
            commands::save_file_directly,
            commands::export_encrypted_bundle,
            commands::import_encrypted_bundle,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match disconnect_rx.recv().await {
                        Ok(conn_id) => {
                            use tauri::Emitter;
                            let _ = handle.emit("tunnel-disconnected", conn_id);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // WP3: 应用退出前关闭全部 SSH 隧道, 避免残留监听端口
            if let tauri::RunEvent::Exit = event {
                tracing::info!("App exiting — closing all SSH tunnels");
                use tauri::Manager;
                let db = app_handle.state::<DbService>();
                let tunnels = db.tunnels.clone();
                // 退出路径同步等待: block_on 在 Exit 事件中是安全的 (窗口已关闭)
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                if let Ok(rt) = rt {
                    rt.block_on(tunnels.close_all());
                }
            }
        });
}
