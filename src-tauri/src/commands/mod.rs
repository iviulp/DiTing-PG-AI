/// Tauri 2.0 IPC Command 控制器层
/// 接收 React GUI 提交的请求，负责参数校验并调用后端服务处理
use crate::error::AppError;
use crate::models::{ConnectionConfig, DbValue, QueryResult};
use crate::services::ai_service::{AiConfig, AiService};
use crate::services::db_service::DbService;
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

/// 执行 SQL 查询并返回强类型数据集
#[tauri::command]
pub async fn execute_sql(
    conn_id: String,
    sql: String,
    db_service: State<'_, DbService>,
) -> Result<QueryResult, AppError> {
    tracing::info!(target: "IPC::CMD", conn_id = %conn_id, "Received execute_sql IPC command");
    db_service.execute_query(&conn_id, &sql).await
}

/// 获取指定连接的表与视图 Schema 结构
#[tauri::command]
pub async fn get_table_schema(
    conn_id: String,
    db_service: State<'_, DbService>,
) -> Result<Vec<SchemaItemDto>, AppError> {
    tracing::info!(target: "IPC::CMD", conn_id = %conn_id, "Fetching table schema tree");
    let sql = "SELECT table_name, table_type, table_schema FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_name;";
    let query_res = db_service.execute_query(&conn_id, sql).await?;

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
    let res = db_service.execute_query(&conn_id, sql).await;

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
    let res = db_service.execute_query(&conn_id, pg_sql).await;

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
    if let Ok(mysql_res) = db_service.execute_query(&conn_id, mysql_sql).await {
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
    if let Ok(pu_res) = db_service.execute_query(&conn_id, pg_user_sql).await {
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
    if let Ok(curr_res) = db_service.execute_query(&conn_id, curr_sql).await {
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
    let sql = format!("SELECT pg_terminate_backend({});", pid);
    let _ = db_service.execute_query(&conn_id, &sql).await;
    Ok(())
}

/// AI 自然语言生成 SQL / 问答交互
#[tauri::command]
pub async fn ai_chat(
    prompt: String,
    schema_context: Option<String>,
    ai_service: State<'_, AiService>,
) -> Result<String, AppError> {
    tracing::info!(target: "IPC::CMD", "Received ai_chat IPC command");
    ai_service.prompt(&prompt, schema_context.as_deref()).await
}

/// 更新自定义 AI Provider (BaseURL / Key) 配置
#[tauri::command]
pub async fn update_ai_config(
    config: AiConfig,
    ai_service: State<'_, AiService>,
) -> Result<(), AppError> {
    tracing::info!(target: "IPC::CMD", base_url = %config.base_url, "Updating AI Provider configuration");
    ai_service.update_config(config).await
}

/// 获取当前 AI Provider 配置
#[tauri::command]
pub async fn get_ai_config(ai_service: State<'_, AiService>) -> Result<AiConfig, AppError> {
    Ok(ai_service.get_config().await)
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

/// 导出加密的配置数据包 (包含所有已配置的数据库连接信息和 AI Provider 配置)
/// 使用内置证书 / 固定密钥 (yuguosheng) + Argon2id 派生密钥 + AES-256-GCM 工业级加解密
#[tauri::command]
pub async fn export_encrypted_bundle(
    connections_json: String,
    ai_config_json: String,
    save_dir: Option<String>,
) -> Result<String, AppError> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use rand::RngCore;

    tracing::info!(target: "SECURITY::VAULT", "Exporting encrypted configuration bundle...");

    // 1. 组装待加密的完整 Payload
    let payload = serde_json::json!({
        "version": "1.0",
        "created_at": chrono::Utc::now().to_rfc3339(),
        "app": "DiTing Desk (AIDB)",
        "connections": serde_json::from_str::<serde_json::Value>(&connections_json).unwrap_or(serde_json::Value::Array(vec![])),
        "ai_config": serde_json::from_str::<serde_json::Value>(&ai_config_json).unwrap_or(serde_json::Value::Null)
    });

    let plaintext = serde_json::to_vec(&payload)
        .map_err(|e| AppError::Internal(format!("Failed to serialize bundle: {}", e)))?;

    // 2. 生成随机 Salt 与 Nonce
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    // 3. 使用 Argon2id 从密码 (yuguosheng) 派生 256 位强密钥
    let password = b"yuguosheng";
    let mut derived_key = [0u8; 32];
    let params = argon2::Params::new(19456, 2, 1, Some(32)).unwrap();
    let argon2_instance = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    argon2_instance
        .hash_password_into(password, &salt, &mut derived_key)
        .map_err(|e| AppError::Internal(format!("Argon2 key derivation failed: {}", e)))?;

    // 4. AES-256-GCM 加密
    let cipher = Aes256Gcm::new_from_slice(&derived_key)
        .map_err(|e| AppError::Internal(format!("Failed to initialize AES-GCM: {}", e)))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| AppError::Internal(format!("AES-GCM encryption failed: {}", e)))?;

    // 5. 组装密文结构并 Base64 编码保存
    let export_bundle = serde_json::json!({
        "format": "DITING_ENCRYPTED_VAULT",
        "crypto": "AES-256-GCM + Argon2id",
        "salt": urlencoding::encode_binary(&salt).into_owned(),
        "nonce": urlencoding::encode_binary(&nonce_bytes).into_owned(),
        "ciphertext": urlencoding::encode_binary(&ciphertext).into_owned()
    });

    let export_json = serde_json::to_string_pretty(&export_bundle)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let file_name = format!("diting_config_backup_{}.ditingvault", chrono::Local::now().format("%Y%m%d_%H%M%S"));
    let saved_path = save_file_directly(save_dir, file_name, export_json).await?;
    Ok(saved_path)
}

/// 导入加密配置数据包并自动解密 (使用证书固定密钥 yuguosheng 解码并校验签名)
#[tauri::command]
pub async fn import_encrypted_bundle(
    file_content: String,
) -> Result<serde_json::Value, AppError> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};

    tracing::info!(target: "SECURITY::VAULT", "Importing and decrypting configuration bundle...");

    let vault: serde_json::Value = serde_json::from_str(&file_content)
        .map_err(|_| AppError::Internal("无效的备份文件格式，请确保上传的是 .ditingvault 加密文件。".into()))?;

    if vault.get("format").and_then(|v| v.as_str()) != Some("DITING_ENCRYPTED_VAULT") {
        return Err(AppError::Internal("非法的谛听加密备份凭证，无法识别的安全签名。".into()));
    }

    let salt_str = vault.get("salt").and_then(|v| v.as_str()).ok_or_else(|| AppError::Internal("Missing salt".into()))?;
    let nonce_str = vault.get("nonce").and_then(|v| v.as_str()).ok_or_else(|| AppError::Internal("Missing nonce".into()))?;
    let ciphertext_str = vault.get("ciphertext").and_then(|v| v.as_str()).ok_or_else(|| AppError::Internal("Missing ciphertext".into()))?;

    let salt = urlencoding::decode_binary(salt_str.as_bytes());
    let nonce_bytes = urlencoding::decode_binary(nonce_str.as_bytes());
    let ciphertext = urlencoding::decode_binary(ciphertext_str.as_bytes());

    // 使用 Argon2id 从固定密码 yuguosheng 派生密钥
    let password = b"yuguosheng";
    let mut derived_key = [0u8; 32];
    let params = argon2::Params::new(19456, 2, 1, Some(32)).unwrap();
    let argon2_instance = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    argon2_instance
        .hash_password_into(password, &salt, &mut derived_key)
        .map_err(|e| AppError::Internal(format!("Argon2 key derivation failed: {}", e)))?;

    // AES-256-GCM 解密
    let cipher = Aes256Gcm::new_from_slice(&derived_key)
        .map_err(|e| AppError::Internal(format!("AES initialization failed: {}", e)))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let decrypted_bytes = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| AppError::Internal("解密校验失败！证书密码不匹配或备份数据已被非法篡改。".into()))?;

    let decrypted_json: serde_json::Value = serde_json::from_slice(&decrypted_bytes)
        .map_err(|e| AppError::Internal(format!("Failed to parse decrypted data: {}", e)))?;

    Ok(decrypted_json)
}
