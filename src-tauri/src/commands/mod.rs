/// Tauri 2.0 IPC Command 控制器层
/// 接收 React GUI 提交的请求，负责参数校验并调用后端服务处理
use crate::error::AppError;
use crate::models::{ConnectionConfig, DbValue, QueryResult};
use crate::services::ai_service::{AiConfig, AiConfigView, AiService, ChatMessage, StreamEvent};
use crate::services::db_service::DbService;
use crate::services::vault_service::{
    AiConfigVaultView, ConnectionView, MigrateOutcome, VaultService,
};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct SchemaItemDto {
    pub name: String,
    pub item_type: String,
    pub schema_name: String,
}

#[derive(Serialize)]
pub struct ProcessItemDto {
    pub pid: i64,
    pub user: String,
    pub db: String,
    pub client_ip: Option<String>,
    pub query: String,
    pub state: String,
    pub duration_seconds: i64,
}

/// 测试并建立新的数据库连接
#[tauri::command]
pub async fn connect_db(
    config: ConnectionConfig,
    db_service: State<'_, DbService>,
) -> Result<(), AppError> {
    tracing::info!(target: "IPC::CMD", db_name = %config.name, "Received connect_db IPC command");
    db_service.connect(config).await
}

// ============ WP6-S5/S6: Vault 命令组 (密码永不出 Rust 边界) ============

/// 列出脱敏连接视图 (前端唯一列表数据源; 不含明文密码)
#[tauri::command]
pub async fn vault_list_connections(
    vault: State<'_, VaultService>,
) -> Result<Vec<ConnectionView>, AppError> {
    vault
        .list_connections()
        .map_err(|e| AppError::Internal(e.to_string()))
}

/// 保存/更新连接 (密码随配置加密落盘; 留空密码 → 保留原值)
#[tauri::command]
pub async fn vault_upsert_connection(
    config: ConnectionConfig,
    vault: State<'_, VaultService>,
) -> Result<(), AppError> {
    vault
        .upsert_connection(config)
        .map_err(|e| AppError::Internal(e.to_string()))
}

/// 删除连接
#[tauri::command]
pub async fn vault_delete_connection(
    conn_id: String,
    vault: State<'_, VaultService>,
) -> Result<(), AppError> {
    vault
        .delete_connection(&conn_id)
        .map_err(|e| AppError::Internal(e.to_string()))
}

/// WP6-S6: 按 conn_id 连接 — 后端从 vault 取真实密码, 前端不接触
#[tauri::command]
pub async fn vault_connect_db(
    conn_id: String,
    vault: State<'_, VaultService>,
    db_service: State<'_, DbService>,
) -> Result<(), AppError> {
    let config = vault
        .get_connection_secret(&conn_id)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    db_service.connect(config).await
}

/// WP6-S6: 一次性测试通道 — 保存前测试新配置 (密码留空时从 vault 合并原密码)
#[tauri::command]
pub async fn vault_test_connection(
    mut config: ConnectionConfig,
    vault: State<'_, VaultService>,
    db_service: State<'_, DbService>,
) -> Result<(), AppError> {
    if config.password.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
        // 编辑场景留空密码: 从 vault 取原密码合并 (取不到则保持 None)
        if let Ok(stored) = vault.get_connection_secret(&config.id) {
            config.password = stored.password;
        }
    }
    db_service.connect(config).await
}

/// WP6-S5: localStorage 迁移 — 幂等 (enc 已有数据 → already_migrated); 脏条目跳过计数
#[tauri::command]
pub async fn vault_migrate_from_localstorage(
    connections_json: String,
    ai_config_json: Option<String>,
    vault: State<'_, VaultService>,
) -> Result<MigrateOutcome, AppError> {
    // 1. 解析连接 (容忍脏 JSON → 视为空列表)
    let configs: Vec<ConnectionConfig> =
        serde_json::from_str(&connections_json).unwrap_or_default();

    // 2. AI 配置迁移 (仅首次: vault 无配置且传入非空; 旧 localStorage 不含 api_key)
    if let Some(ai_json) = ai_config_json {
        if !ai_json.trim().is_empty() {
            if let Ok(parsed) =
                serde_json::from_str::<crate::services::vault_service::StoredAiConfig>(&ai_json)
            {
                let vault_empty = vault
                    .get_ai_config()
                    .map(|c| c.provider_name.is_empty() && c.base_url.is_empty())
                    .unwrap_or(true);
                if vault_empty {
                    let _ = vault.set_ai_config(parsed);
                }
            }
        }
    }

    // 3. 连接迁移 (幂等在 VaultService::migrate_connections 内保证)
    vault
        .migrate_connections(configs)
        .map_err(|e| AppError::Internal(e.to_string()))
}

/// WP6-S7: 后端组装导出 payload (含真实密码) → v2 主密码加密 → 保存
/// 明文密码只在 Rust 进程内存中出现, 不经 IPC 返回前端
#[tauri::command]
pub async fn vault_export_bundle(
    master_password: String,
    save_dir: Option<String>,
    vault: State<'_, VaultService>,
) -> Result<String, AppError> {
    use crate::services::vault::bundle::encrypt_bundle_v2;

    tracing::info!(target: "SECURITY::VAULT", "Exporting vault bundle (v2)...");
    let connections = vault
        .load_all_connections()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let ai = vault
        .get_ai_config()
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let payload = serde_json::json!({
        "version": "2.0",
        "created_at": chrono::Utc::now().to_rfc3339(),
        "app": "DiTing Desk (AIDB)",
        "connections": serde_json::to_value(&connections)
            .map_err(|e| AppError::Internal(e.to_string()))?,
        "ai_config": serde_json::to_value(&ai).map_err(|e| AppError::Internal(e.to_string()))?
    });

    let export_json = encrypt_bundle_v2(&payload, &master_password)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let file_name = format!(
        "diting_config_backup_{}.ditingvault",
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );
    save_file_directly(save_dir, file_name, export_json).await
}

/// WP6-S3: AI 配置走 vault (脱敏视图)
#[tauri::command]
pub async fn vault_get_ai_config(
    vault: State<'_, VaultService>,
) -> Result<AiConfigVaultView, AppError> {
    vault
        .get_ai_config_view()
        .map_err(|e| AppError::Internal(e.to_string()))
}

/// WP3: 查询指定连接的 SSH 隧道状态 (前端角标/诊断)
#[tauri::command]
pub async fn get_tunnel_state(
    conn_id: String,
    db_service: State<'_, DbService>,
) -> Result<crate::services::tunnel_service::TunnelState, AppError> {
    Ok(db_service.tunnel_state(&conn_id).await)
}

/// WP3: 手动关闭指定连接的 SSH 隧道
#[tauri::command]
pub async fn close_tunnel(
    conn_id: String,
    db_service: State<'_, DbService>,
) -> Result<(), AppError> {
    db_service.tunnels.close(&conn_id).await;
    Ok(())
}

/// 执行 SQL 查询并返回强类型数据集
/// WP1: force=true 表示用户已确认 Critical 风险 (二次确认后重发), 仅豁免确认策略, 不豁免 read_only
#[tauri::command]
pub async fn execute_sql(
    conn_id: String,
    sql: String,
    force: Option<bool>,
    db_service: State<'_, DbService>,
) -> Result<QueryResult, AppError> {
    tracing::info!(target: "IPC::CMD", conn_id = %conn_id, force = force.unwrap_or(false), "Received execute_sql IPC command");
    db_service
        .execute_query(&conn_id, &sql, force.unwrap_or(false))
        .await
}

/// 获取指定连接的表与视图 Schema 结构
#[tauri::command]
pub async fn get_table_schema(
    conn_id: String,
    db_service: State<'_, DbService>,
) -> Result<Vec<SchemaItemDto>, AppError> {
    tracing::info!(target: "IPC::CMD", conn_id = %conn_id, "Fetching table schema tree");
    let sql = "SELECT table_name, table_type, table_schema FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_name;";
    // 内部生成的可信只读 SQL, force=true 跳过确认策略
    let query_res = db_service.execute_query(&conn_id, sql, true).await?;

    let mut items = Vec::new();
    for r in query_res.rows {
        let name = if let Some(DbValue::Text(v)) = r.get(0) {
            v.clone()
        } else {
            continue;
        };
        let t_type = if let Some(DbValue::Text(v)) = r.get(1) {
            v.clone()
        } else {
            "BASE TABLE".into()
        };
        let schema_name = if let Some(DbValue::Text(v)) = r.get(2) {
            v.clone()
        } else {
            "public".into()
        };
        items.push(SchemaItemDto {
            name,
            item_type: if t_type.contains("VIEW") {
                "view".into()
            } else {
                "table".into()
            },
            schema_name,
        });
    }
    Ok(items)
}

/// 获取活跃活动进程列表
#[tauri::command]
pub async fn get_process_list(
    conn_id: String,
    db_service: State<'_, DbService>,
) -> Result<Vec<ProcessItemDto>, AppError> {
    tracing::info!(target: "IPC::CMD", conn_id = %conn_id, "Fetching active process list");
    let sql = "SELECT pid, usename, datname, client_addr, query, state, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)))::INT8 FROM pg_stat_activity WHERE state != 'idle' AND pid != pg_backend_pid();";
    let res = db_service.execute_query(&conn_id, sql, true).await;

    match res {
        Ok(query_res) => {
            let mut procs = Vec::new();
            for r in query_res.rows {
                let pid_str = if let Some(DbValue::Text(v)) = r.get(0) {
                    v.clone()
                } else {
                    "0".into()
                };
                let user = if let Some(DbValue::Text(v)) = r.get(1) {
                    v.clone()
                } else {
                    "postgres".into()
                };
                let db = if let Some(DbValue::Text(v)) = r.get(2) {
                    v.clone()
                } else {
                    "postgres".into()
                };
                let client_ip = if let Some(DbValue::Text(v)) = r.get(3) {
                    Some(v.clone())
                } else {
                    None
                };
                let query = if let Some(DbValue::Text(v)) = r.get(4) {
                    v.clone()
                } else {
                    "SELECT 1".into()
                };
                let state = if let Some(DbValue::Text(v)) = r.get(5) {
                    v.clone()
                } else {
                    "active".into()
                };
                let duration = if let Some(DbValue::Text(v)) = r.get(6) {
                    v.parse::<i64>().unwrap_or(1)
                } else {
                    1
                };

                procs.push(ProcessItemDto {
                    pid: pid_str.parse::<i64>().unwrap_or(1001),
                    user,
                    db,
                    client_ip,
                    query,
                    state,
                    duration_seconds: duration,
                });
            }
            Ok(procs)
        }
        Err(_) => Ok(vec![]),
    }
}

#[derive(Serialize)]
pub struct DbUserDto {
    pub username: String,
    pub is_superuser: bool,
    pub can_create_db: bool,
    pub can_create_role: bool,
    pub can_login: bool,
    pub connection_limit: i64,
    pub valid_until: Option<String>,
    pub is_current_user: bool,
    pub is_granted_manager: bool,
}

/// 动态查询并返回当前数据库实例真实存在的所有用户与当前登录用户身份
#[tauri::command]
pub async fn get_db_users(
    conn_id: String,
    db_service: State<'_, DbService>,
) -> Result<Vec<DbUserDto>, AppError> {
    tracing::info!(target: "IPC::CMD", conn_id = %conn_id, "Fetching real database users dynamically");

    // 1. 尝试执行 PostgreSQL 系统的 pg_roles / pg_user / pg_authid
    let pg_sql = "SELECT r.rolname::text AS usename, CASE WHEN r.rolsuper THEN 'true' ELSE 'false' END AS usesuper, CASE WHEN r.rolcreatedb THEN 'true' ELSE 'false' END AS usecreatedb, r.rolvaliduntil::text, CASE WHEN r.rolname = current_user THEN 'true' ELSE 'false' END AS is_curr, CASE WHEN r.rolcreaterole OR r.rolsuper THEN 'true' ELSE 'false' END AS is_mgr FROM pg_roles r ORDER BY is_curr DESC, r.rolname ASC;";
    let res = db_service.execute_query(&conn_id, pg_sql, true).await;

    if let Ok(query_res) = res {
        if !query_res.rows.is_empty() {
            let mut users = Vec::new();
            for r in query_res.rows {
                let username = match r.get(0) {
                    Some(DbValue::Text(v)) | Some(DbValue::StringDecimal(v)) => v.clone(),
                    _ => continue,
                };
                let is_super = match r.get(1) {
                    Some(DbValue::Bool(b)) => b.clone(),
                    Some(DbValue::Text(v)) => v == "t" || v == "true",
                    _ => false,
                };
                let can_createdb = match r.get(2) {
                    Some(DbValue::Bool(b)) => b.clone(),
                    Some(DbValue::Text(v)) => v == "t" || v == "true",
                    _ => false,
                };
                let valid_until = match r.get(3) {
                    Some(DbValue::Text(v)) | Some(DbValue::Timestamp(v)) => Some(v.clone()),
                    _ => None,
                };
                let is_curr = match r.get(4) {
                    Some(DbValue::Bool(b)) => b.clone(),
                    Some(DbValue::Text(v)) => v == "t" || v == "true",
                    _ => false,
                };
                let is_mgr = match r.get(5) {
                    Some(DbValue::Bool(b)) => b.clone(),
                    Some(DbValue::Text(v)) => v == "t" || v == "true",
                    _ => false,
                };

                users.push(DbUserDto {
                    username,
                    is_superuser: is_super,
                    can_create_db: can_createdb,
                    can_create_role: is_super || is_mgr,
                    can_login: true,
                    connection_limit: -1,
                    valid_until,
                    is_current_user: is_curr,
                    is_granted_manager: is_mgr,
                });
            }
            if !users.is_empty() {
                return Ok(users);
            }
        }
    }

    // 2. 尝试执行 MySQL 系统的 mysql.user
    let mysql_sql = "SELECT User, Super_priv = 'Y', Create_priv = 'Y', NULL, (User = SUBSTRING_INDEX(CURRENT_USER(), '@', 1)) AS is_curr, (Grant_priv = 'Y' OR Super_priv = 'Y') AS is_mgr FROM mysql.user GROUP BY User ORDER BY is_curr DESC, User ASC;";
    if let Ok(mysql_res) = db_service.execute_query(&conn_id, mysql_sql, true).await {
        if !mysql_res.rows.is_empty() {
            let mut users = Vec::new();
            for r in mysql_res.rows {
                let username = if let Some(DbValue::Text(v)) = r.get(0) {
                    v.clone()
                } else {
                    "root".into()
                };
                let is_super = match r.get(1) {
                    Some(DbValue::Bool(b)) => b.clone(),
                    Some(DbValue::Text(v)) => v == "t" || v == "1" || v == "true",
                    _ => false,
                };
                let can_createdb = match r.get(2) {
                    Some(DbValue::Bool(b)) => b.clone(),
                    Some(DbValue::Text(v)) => v == "t" || v == "1" || v == "true",
                    _ => false,
                };
                let is_curr = match r.get(4) {
                    Some(DbValue::Bool(b)) => b.clone(),
                    Some(DbValue::Text(v)) => v == "1" || v == "t" || v == "true",
                    _ => false,
                };
                let is_mgr = match r.get(5) {
                    Some(DbValue::Bool(b)) => b.clone(),
                    Some(DbValue::Text(v)) => v == "1" || v == "t" || v == "true",
                    _ => false,
                };

                users.push(DbUserDto {
                    username,
                    is_superuser: is_super,
                    can_create_db: can_createdb,
                    can_create_role: is_super || is_mgr,
                    can_login: true,
                    connection_limit: -1,
                    valid_until: None,
                    is_current_user: is_curr,
                    is_granted_manager: is_mgr,
                });
            }
            return Ok(users);
        }
    }

    // 3. 普通受限账户或特定权限视角：查询 pg_user 视图
    let pg_user_sql = "SELECT usename::text, usesuper, usecreatedb, valuntil::text, (usename = current_user()) AS is_curr FROM pg_user ORDER BY is_curr DESC, usename ASC;";
    if let Ok(pu_res) = db_service.execute_query(&conn_id, pg_user_sql, true).await {
        if !pu_res.rows.is_empty() {
            let mut users = Vec::new();
            for r in pu_res.rows {
                let username = match r.get(0) {
                    Some(DbValue::Text(v)) | Some(DbValue::StringDecimal(v)) => v.clone(),
                    _ => continue,
                };
                let is_super = match r.get(1) {
                    Some(DbValue::Bool(v)) => v.clone(),
                    Some(DbValue::Text(v)) => v == "t" || v == "true",
                    _ => false,
                };
                let can_createdb = match r.get(2) {
                    Some(DbValue::Bool(v)) => v.clone(),
                    Some(DbValue::Text(v)) => v == "t" || v == "true",
                    _ => false,
                };
                let is_curr = match r.get(4) {
                    Some(DbValue::Bool(v)) => v.clone(),
                    Some(DbValue::Text(v)) => v == "t" || v == "true",
                    _ => false,
                };

                users.push(DbUserDto {
                    username,
                    is_superuser: is_super,
                    can_create_db: can_createdb,
                    can_create_role: is_super,
                    can_login: true,
                    connection_limit: -1,
                    valid_until: None,
                    is_current_user: is_curr,
                    is_granted_manager: is_super,
                });
            }
            if !users.is_empty() {
                return Ok(users);
            }
        }
    }
    // 4. 普通受限账户（未开全局读系统表，但被 GRANT 特权）
    let curr_sql = "SELECT current_user, pg_has_role(current_user, 'pg_read_all_stats', 'member') AS is_granted;";
    if let Ok(curr_res) = db_service.execute_query(&conn_id, curr_sql, true).await {
        if let Some(r) = curr_res.rows.get(0) {
            let username = if let Some(DbValue::Text(v)) = r.get(0) {
                v.clone()
            } else {
                "current_user".into()
            };
            let is_granted = match r.get(1) {
                Some(DbValue::Bool(v)) => v.clone(),
                Some(DbValue::Text(v)) => v == "t" || v == "true",
                _ => false,
            };

            return Ok(vec![DbUserDto {
                username,
                is_superuser: false,
                can_create_db: false,
                can_create_role: is_granted,
                can_login: true,
                connection_limit: -1,
                valid_until: None,
                is_current_user: true,
                is_granted_manager: is_granted,
            }]);
        }
    }

    Ok(vec![])
}

/// 强制终断 Session PID
#[tauri::command]
pub async fn kill_process(
    conn_id: String,
    pid: i64,
    db_service: State<'_, DbService>,
) -> Result<(), AppError> {
    tracing::info!(target: "IPC::CMD", conn_id = %conn_id, pid = %pid, "Killing active process session");
    // WP4 步骤6: pid 范围断言 — 拒绝负数/越界 (拼接保持 i64 类型安全, 但防御异常输入)
    if pid <= 0 || pid > i32::MAX as i64 {
        return Err(AppError::Internal(format!(
            "非法 pid {pid}: 超出 PostgreSQL backend pid 有效范围 (1..={})",
            i32::MAX
        )));
    }
    let sql = format!("SELECT pg_terminate_backend({});", pid);
    let _ = db_service.execute_query(&conn_id, &sql, true).await;
    Ok(())
}

/// AI 自然语言生成 SQL / 问答交互 (WP2: 支持多轮 history; 保留为流式失败时的 fallback)
#[tauri::command]
pub async fn ai_chat(
    prompt: String,
    schema_context: Option<String>,
    history: Option<Vec<ChatMessage>>,
    ai_service: State<'_, AiService>,
) -> Result<String, AppError> {
    tracing::info!(target: "IPC::CMD", "Received ai_chat IPC command");
    ai_service
        .prompt(
            history.as_deref().unwrap_or(&[]),
            &prompt,
            schema_context.as_deref(),
        )
        .await
}

/// WP2: AI 流式对话 — SSE delta 经 Tauri Channel 推送前端 (Delta/Done/Error 三态)
#[tauri::command]
pub async fn ai_chat_stream(
    prompt: String,
    schema_context: Option<String>,
    history: Option<Vec<ChatMessage>>,
    channel: tauri::ipc::Channel<StreamEvent>,
    ai_service: State<'_, AiService>,
) -> Result<(), AppError> {
    tracing::info!(target: "IPC::CMD", "Received ai_chat_stream IPC command");
    ai_service
        .prompt_stream(
            history.as_deref().unwrap_or(&[]),
            &prompt,
            schema_context.as_deref(),
            move |event| {
                // Channel send 失败 (前端已卸载) 时静默丢弃
                let _ = channel.send(event);
            },
        )
        .await
}

/// 更新自定义 AI Provider (BaseURL / Key) 配置
/// WP2: api_key 传占位符 "__KEEP__" 或留空 (且原有 key) 时保留原 key; 落盘为加密格式
#[tauri::command]
pub async fn update_ai_config(
    config: AiConfig,
    ai_service: State<'_, AiService>,
) -> Result<(), AppError> {
    tracing::info!(target: "IPC::CMD", base_url = %config.base_url, "Updating AI Provider configuration");
    ai_service.update_config(config).await
}

/// 获取当前 AI Provider 配置 (WP2: 脱敏视图 — has_key + 尾4位, 绝不返回完整 key)
#[tauri::command]
pub async fn get_ai_config(ai_service: State<'_, AiService>) -> Result<AiConfigView, AppError> {
    Ok(ai_service.get_config_view().await)
}

/// 自动打开并跳转到用户指定的文件夹 (或系统 Downloads 目录) (macOS Finder / Windows Explorer)
#[tauri::command]
pub async fn open_downloads_folder(dir_path: Option<String>) -> Result<(), AppError> {
    tracing::info!(target: "IPC::CMD", dir_path = ?dir_path, "Opening specified folder in Finder / Explorer");

    #[cfg(target_os = "macos")]
    {
        let target = if let Some(ref d) = dir_path {
            d.clone()
        } else if let Ok(home) = std::env::var("HOME") {
            format!("{}/Downloads", home)
        } else {
            "~/Downloads".to_string()
        };

        let _ = std::process::Command::new("open").arg(&target).spawn();
    }

    #[cfg(target_os = "windows")]
    {
        let target = if let Some(ref d) = dir_path {
            d.clone()
        } else {
            "shell:Downloads".to_string()
        };

        let _ = std::process::Command::new("explorer").arg(&target).spawn();
    }

    #[cfg(target_os = "linux")]
    {
        let target = if let Some(ref d) = dir_path {
            d.clone()
        } else {
            "~/Downloads".to_string()
        };

        let _ = std::process::Command::new("xdg-open").arg(&target).spawn();
    }

    Ok(())
}

/// 弹出系统级文件夹选择框 (Save / Directory Picker)，允许用户修改自定义导出位置

#[tauri::command]
pub async fn open_file_dialog() -> Result<Option<String>, AppError> {
    tracing::info!(target: "IPC::CMD", "Opening folder picker dialog");

    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg("POSIX path of (choose folder with prompt \"选择自定义导出保存目录\")")
            .output();

        if let Ok(out) = output {
            let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path_str.is_empty() {
                return Ok(Some(path_str));
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let script = "[System.Reflection.Assembly]::LoadWithPartialName('System.windows.forms') | Out-Null; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }";
        let output = std::process::Command::new("powershell")
            .arg("-Command")
            .arg(script)
            .output();

        if let Ok(out) = output {
            let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path_str.is_empty() {
                return Ok(Some(path_str));
            }
        }
    }

    Ok(None)
}

/// 直接将导出的文件内容写入用户指定的物理文件目录路径

#[tauri::command]
pub async fn save_file_directly(
    dir_path: Option<String>,
    file_name: String,
    content: String,
) -> Result<String, AppError> {
    tracing::info!(target: "IPC::CMD", file_name = %file_name, "Saving exported file directly to file system");

    let target_dir = if let Some(dir) = dir_path {
        std::path::PathBuf::from(dir)
    } else {
        #[cfg(target_os = "macos")]
        {
            if let Ok(home) = std::env::var("HOME") {
                std::path::PathBuf::from(format!("{}/Downloads", home))
            } else {
                std::path::PathBuf::from("~/Downloads")
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            std::env::temp_dir()
        }
    };

    let full_path = target_dir.join(&file_name);
    tokio::fs::write(&full_path, content.as_bytes())
        .await
        .map_err(|e| {
            AppError::Io(format!(
                "Failed to write file to {}: {}",
                full_path.display(),
                e
            ))
        })?;

    Ok(full_path.to_string_lossy().to_string())
}

/// WP6-S4: 导出 v2 加密备份 bundle (用户主密码; 委托 vault::bundle 纯函数)
#[tauri::command]
pub async fn export_encrypted_bundle(
    connections_json: String,
    ai_config_json: String,
    master_password: String,
    save_dir: Option<String>,
) -> Result<String, AppError> {
    use crate::services::vault::bundle::{encrypt_bundle_v2, BundleError};

    tracing::info!(target: "SECURITY::VAULT", "Exporting encrypted configuration bundle (v2)...");

    let payload = serde_json::json!({
        "version": "2.0",
        "created_at": chrono::Utc::now().to_rfc3339(),
        "app": "DiTing Desk (AIDB)",
        "connections": serde_json::from_str::<serde_json::Value>(&connections_json).unwrap_or(serde_json::Value::Array(vec![])),
        "ai_config": serde_json::from_str::<serde_json::Value>(&ai_config_json).unwrap_or(serde_json::Value::Null)
    });

    let export_json = encrypt_bundle_v2(&payload, &master_password).map_err(|e| match e {
        BundleError::WeakPassword => AppError::Internal(e.to_string()),
        other => AppError::Internal(other.to_string()),
    })?;

    let file_name = format!(
        "diting_config_backup_{}.ditingvault",
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );
    save_file_directly(save_dir, file_name, export_json).await
}

/// 导入失败限速 (WP6 T14: 5 次失败/30s 窗口 → 拒绝, 防暴力破解)
mod import_rate_limit {
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    pub static FAIL_COUNT: AtomicU32 = AtomicU32::new(0);
    pub static WINDOW_START: AtomicU64 = AtomicU64::new(0);
    pub const LIMIT: u32 = 5;
    pub const WINDOW_SECS: u64 = 30;

    pub fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
    pub fn bump() {
        FAIL_COUNT.fetch_add(1, Ordering::SeqCst);
    }
    pub fn check() -> Option<u64> {
        // 返回 Some(剩余秒) 表示被限速
        let now = now_secs();
        let start = WINDOW_START.load(Ordering::SeqCst);
        if now.saturating_sub(start) > WINDOW_SECS {
            FAIL_COUNT.store(0, Ordering::SeqCst);
            WINDOW_START.store(now, Ordering::SeqCst);
            return None;
        }
        if FAIL_COUNT.load(Ordering::SeqCst) >= LIMIT {
            return Some(WINDOW_SECS.saturating_sub(now.saturating_sub(start)));
        }
        None
    }
    #[cfg(test)]
    pub fn reset() {
        FAIL_COUNT.store(0, Ordering::SeqCst);
        WINDOW_START.store(0, Ordering::SeqCst);
    }
}

/// WP6-S4: 导入备份 bundle — v2 主密码 / legacy v1 旧密钥分支 (委托 vault::bundle)
/// 返回解密 JSON; legacy 时 payload 内含 "legacy_import": true 供前端引导升级
#[tauri::command]
pub async fn import_encrypted_bundle(
    file_content: String,
    master_password: Option<String>,
) -> Result<serde_json::Value, AppError> {
    use crate::services::vault::bundle::{decrypt_bundle, BundleError};

    tracing::info!(target: "SECURITY::VAULT", "Importing configuration bundle...");

    if let Some(wait) = import_rate_limit::check() {
        return Err(AppError::Internal(format!(
            "密码错误次数过多, 请 {wait} 秒后再试 (防暴力破解限速)"
        )));
    }

    let result = decrypt_bundle(&file_content, master_password.as_deref());
    match result {
        Ok((json, is_legacy)) => {
            if is_legacy {
                tracing::warn!(target: "SECURITY::VAULT", "Legacy v1 bundle imported — 建议立即用主密码重新导出为 v2");
            }
            Ok(json)
        }
        Err(e) => {
            // 仅密码/篡改类失败计入限速 (格式错误不消耗配额)
            if matches!(e, BundleError::DecryptFailed) {
                import_rate_limit::bump();
            }
            Err(AppError::Internal(e.to_string()))
        }
    }
}

// ============ WP6 T14: 限速单测 ============
#[cfg(test)]
mod tests_import_rate_limit {
    use super::import_rate_limit;

    #[test]
    fn t14_rate_limit_after_5_fails() {
        import_rate_limit::reset();
        assert!(import_rate_limit::check().is_none(), "初始不限速");
        for _ in 0..5 {
            import_rate_limit::bump();
        }
        let r = import_rate_limit::check();
        assert!(r.is_some(), "5 次失败后必须限速");
        assert!(r.unwrap() > 0 && r.unwrap() <= 30, "剩余等待秒数在窗口内");
        import_rate_limit::reset();
        assert!(import_rate_limit::check().is_none(), "reset 后恢复");
    }

    #[test]
    fn t14_under_limit_not_blocked() {
        import_rate_limit::reset();
        for _ in 0..4 {
            import_rate_limit::bump();
        }
        assert!(import_rate_limit::check().is_none(), "4 次失败仍未达阈值");
        import_rate_limit::reset();
    }
}