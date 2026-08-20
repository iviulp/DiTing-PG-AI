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

    // 2. 组装 Tauri Builder 并注册 State 服务与 IPC Commands
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(DbService::new())
        .manage(AiService::new())
        .invoke_handler(tauri::generate_handler![
            commands::connect_db,
            commands::execute_sql,
            commands::get_table_schema,
            commands::get_process_list,
            commands::kill_process,
            commands::get_db_users,
            commands::ai_chat,
            commands::update_ai_config,
            commands::get_ai_config,
            commands::open_downloads_folder,
            commands::open_file_dialog,
            commands::save_file_directly,
            commands::export_encrypted_bundle,
            commands::import_encrypted_bundle,
        ])




        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
