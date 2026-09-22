/// SQL 抽象执行服务与连接池管理器
/// 支持 PostgreSQL, MySQL, SQLite 的动态连接调度与异步 Execute/Query 操作

use crate::error::AppError;
use crate::models::{ColumnMetadata, ConnectionConfig, DatabaseType, DbValue, QueryResult};
use crate::services::safety_checker::{RiskLevel, SqlSafetyChecker};
use crate::services::tunnel_service::{TunnelManager, TunnelState};

use sqlx::{Column, Row, TypeInfo};
use sqlx::postgres::PgPoolOptions;
use sqlx::mysql::MySqlPoolOptions;
use sqlx::sqlite::SqlitePoolOptions;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 内部统一 Pool 枚举包装
pub enum AnyPool {
    Postgres(sqlx::PgPool),
    MySql(sqlx::MySqlPool),
    Sqlite(sqlx::SqlitePool),
}

/// WP4 步骤2: 转义失败时返回的常量 Error SQL (不含用户原始输入, 避免反射注入/回显)
const SELECT_ESCAPE_ERROR: &str =
    "SELECT 'Invalid input: contains control characters' AS \"Error\";";

// ============ WP5 A5: 类型保真读取器 (宏生成三栈实现, 后端特化 unsigned/i8) ============

use crate::services::value_mapping::TypePlan;

/// 后端特化 try_get: u64/u32/i8 仅 MySQL 支持, 其余后端返回 Decode 错误走降级链
macro_rules! try_typed {
    (mysql, u64, $r:expr, $i:expr) => { $r.try_get::<u64, _>($i) };
    (pg, decimal, $r:expr, $i:expr) => { $r.try_get::<bigdecimal::BigDecimal, _>($i) };
    (mysql, decimal, $r:expr, $i:expr) => { $r.try_get::<bigdecimal::BigDecimal, _>($i) };
    (sqlite, decimal, $r:expr, $i:expr) => {
        Err::<bigdecimal::BigDecimal, sqlx::Error>(sqlx::Error::Decode("BigDecimal not supported on sqlite".into()))
    };
    (mysql, u32, $r:expr, $i:expr) => { $r.try_get::<u32, _>($i) };
    (mysql, i8, $r:expr, $i:expr) => { $r.try_get::<i8, _>($i) };
    ($b:ident, u64, $r:expr, $i:expr) => {
        Err::<u64, sqlx::Error>(sqlx::Error::Decode("u64 not supported on this backend".into()))
    };
    ($b:ident, u32, $r:expr, $i:expr) => {
        Err::<u32, sqlx::Error>(sqlx::Error::Decode("u32 not supported on this backend".into()))
    };
    ($b:ident, i8, $r:expr, $i:expr) => {
        Err::<i8, sqlx::Error>(sqlx::Error::Decode("i8 not supported on this backend".into()))
    };
}

macro_rules! impl_read_db_value {
    ($fn:ident, $row:ty, $backend:ident) => {
        /// 按 TypePlan 读取单元格; NULL 类型无关先行判定; 失败走降级链,
        /// 最终失败产出 Text("<decode error: …>") + warn (禁止静默变 Null)
        fn $fn(r: &$row, i: usize, col_name: &str, plan: TypePlan) -> DbValue {
            use sqlx::Row as _;
            if let Ok(vr) = <$row as sqlx::Row>::try_get_raw(r, i) {
                use sqlx::ValueRef as _;
                if vr.is_null() {
                    return DbValue::Null;
                }
            }
            let decode_error = |e: sqlx::Error, expect: &str| -> DbValue {
                tracing::warn!(target: "DB::TYPE", column = %col_name, plan = ?plan, "类型读取降级 ({expect}): {e}");
                // 动态降级链: i64 → f64 → bool → String → bytes hex → 显式错误文本
                r.try_get::<i64, _>(i)
                    .map(DbValue::Int)
                    .or_else(|_| r.try_get::<f64, _>(i).map(DbValue::Float))
                    .or_else(|_| r.try_get::<bool, _>(i).map(DbValue::Bool))
                    .or_else(|_| r.try_get::<String, _>(i).map(DbValue::Text))
                    .or_else(|_| {
                        r.try_get::<Vec<u8>, _>(i)
                            .map(|b| DbValue::BytesHex(crate::services::value_mapping::bytes_to_hex(&b)))
                    })
                    .unwrap_or_else(|_| DbValue::Text(format!("<decode error: {e}>")))
            };
            match plan {
                TypePlan::Int64 => r
                    .try_get::<i64, _>(i)
                    .map(DbValue::Int)
                    .unwrap_or_else(|e| decode_error(e, "i64")),
                TypePlan::Int32 => r
                    .try_get::<i32, _>(i)
                    .map(|v| DbValue::Int(v as i64))
                    .or_else(|_| r.try_get::<i64, _>(i).map(DbValue::Int))
                    .unwrap_or_else(|e| decode_error(e, "i32")),
                TypePlan::Int16 => r
                    .try_get::<i16, _>(i)
                    .map(|v| DbValue::Int(v as i64))
                    .or_else(|_| r.try_get::<i32, _>(i).map(|v| DbValue::Int(v as i64)))
                    .or_else(|_| r.try_get::<i64, _>(i).map(DbValue::Int))
                    .unwrap_or_else(|e| decode_error(e, "i16")),
                TypePlan::UInt64Decimal => try_typed!($backend, u64, r, i)
                    .map(|v| DbValue::StringDecimal(v.to_string()))
                    .or_else(|_| {
                        try_typed!($backend, decimal, r, i)
                            .map(|v| DbValue::StringDecimal(v.to_string()))
                    })
                    .or_else(|_| r.try_get::<String, _>(i).map(DbValue::StringDecimal))
                    .unwrap_or_else(|e| decode_error(e, "u64/decimal")),
                TypePlan::UInt32 => try_typed!($backend, u32, r, i)
                    .map(|v| DbValue::Int(v as i64))
                    .or_else(|_| r.try_get::<i64, _>(i).map(DbValue::Int))
                    .unwrap_or_else(|e| decode_error(e, "u32")),
                TypePlan::Float64 => r
                    .try_get::<f64, _>(i)
                    .map(DbValue::Float)
                    .unwrap_or_else(|e| decode_error(e, "f64")),
                TypePlan::Float32 => r
                    .try_get::<f32, _>(i)
                    .map(|v| DbValue::Float(v as f64))
                    .or_else(|_| r.try_get::<f64, _>(i).map(DbValue::Float))
                    .unwrap_or_else(|e| decode_error(e, "f32")),
                TypePlan::Bool => r
                    .try_get::<bool, _>(i)
                    .map(DbValue::Bool)
                    .or_else(|_| try_typed!($backend, i8, r, i).map(|v| DbValue::Bool(v != 0)))
                    .or_else(|_| r.try_get::<i64, _>(i).map(|v| DbValue::Bool(v != 0)))
                    .or_else(|_| {
                        r.try_get::<String, _>(i)
                            .map(|s| DbValue::Bool(s == "t" || s == "true" || s == "1"))
                    })
                    .unwrap_or_else(|e| decode_error(e, "bool")),
                TypePlan::DecimalStr => try_typed!($backend, decimal, r, i)
                    .map(|v| DbValue::StringDecimal(v.to_string()))
                    .or_else(|_| r.try_get::<String, _>(i).map(DbValue::StringDecimal))
                    .or_else(|_| r.try_get::<f64, _>(i).map(|v| DbValue::StringDecimal(v.to_string())))
                    .unwrap_or_else(|e| decode_error(e, "decimal")),
                TypePlan::Timestamp => r
                    .try_get::<chrono::DateTime<chrono::Utc>, _>(i)
                    .map(|dt| DbValue::Timestamp(dt.format("%Y-%m-%d %H:%M:%S%.3f%:z").to_string()))
                    .or_else(|_| {
                        r.try_get::<chrono::NaiveDateTime, _>(i)
                            .map(|n| DbValue::Timestamp(n.format("%Y-%m-%d %H:%M:%S%.3f").to_string()))
                    })
                    .or_else(|_| r.try_get::<String, _>(i).map(DbValue::Timestamp))
                    .unwrap_or_else(|e| decode_error(e, "timestamp")),
                TypePlan::Date => r
                    .try_get::<chrono::NaiveDate, _>(i)
                    .map(|d| DbValue::Timestamp(d.format("%Y-%m-%d").to_string()))
                    .or_else(|_| r.try_get::<String, _>(i).map(DbValue::Timestamp))
                    .unwrap_or_else(|e| decode_error(e, "date")),
                TypePlan::Time => r
                    .try_get::<chrono::NaiveTime, _>(i)
                    .map(|t| DbValue::Timestamp(t.format("%H:%M:%S").to_string()))
                    .or_else(|_| r.try_get::<String, _>(i).map(DbValue::Timestamp))
                    .unwrap_or_else(|e| decode_error(e, "time")),
                TypePlan::Uuid => r
                    .try_get::<uuid::Uuid, _>(i)
                    .map(|u| DbValue::Text(u.to_string()))
                    .or_else(|_| r.try_get::<String, _>(i).map(DbValue::Text))
                    .unwrap_or_else(|e| decode_error(e, "uuid")),
                TypePlan::Json => r
                    .try_get::<serde_json::Value, _>(i)
                    .map(|v| DbValue::Json(v.to_string()))
                    .or_else(|_| r.try_get::<String, _>(i).map(DbValue::Json))
                    .unwrap_or_else(|e| decode_error(e, "json")),
                TypePlan::BytesHex => r
                    .try_get::<Vec<u8>, _>(i)
                    .map(|b| DbValue::BytesHex(crate::services::value_mapping::bytes_to_hex(&b)))
                    .or_else(|_| r.try_get::<String, _>(i).map(DbValue::Text))
                    .unwrap_or_else(|e| decode_error(e, "bytes")),
                TypePlan::Text => r
                    .try_get::<String, _>(i)
                    .map(DbValue::Text)
                    .unwrap_or_else(|e| decode_error(e, "text")),
                TypePlan::Fallback => decode_error(
                    sqlx::Error::Decode("fallback".into()),
                    "unknown type → 动态降级链",
                ),
            }
        }
    };
}

impl_read_db_value!(read_pg_value, sqlx::postgres::PgRow, pg);
impl_read_db_value!(read_mysql_value, sqlx::mysql::MySqlRow, mysql);
impl_read_db_value!(read_sqlite_value, sqlx::sqlite::SqliteRow, sqlite);

/// 全局连接池调度服务
pub struct DbService {
    pools: Arc<RwLock<HashMap<String, (AnyPool, ConnectionConfig)>>>,
    /// WP3: SSH 隧道管理器 (conn_id → 隧道句柄); 断开事件总线在 TunnelManager 内
    pub tunnels: Arc<TunnelManager>,
}

impl DbService {
    pub fn new() -> Self {
        Self {
            pools: Arc::new(RwLock::new(HashMap::new())),
            tunnels: Arc::new(TunnelManager::new()),
        }
    }

    /// 订阅隧道被动断开事件 (返回 conn_id 流; main.rs 转发为 tauri event)
    pub fn subscribe_tunnel_disconnects(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.tunnels.subscribe_disconnects()
    }

    /// WP3: 查询隧道状态 (IPC 暴露给前端角标)
    pub async fn tunnel_state(&self, conn_id: &str) -> TunnelState {
        self.tunnels.state(conn_id).await
    }

    /// 将 psql 命令行专有的元命令 (\\l, \\dt, \\d <table>, \\dn, \\du, \\df, \\di, \\c 等) 转译为等效的 PostgreSQL 系统目录 SQL
    pub fn translate_psql_command(cmd: &str, _current_db: &str) -> String {
        let trimmed = cmd.trim().trim_end_matches(';');
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        let main_cmd = parts.get(0).copied().unwrap_or("");
        let arg = parts.get(1).copied().unwrap_or("");

        match main_cmd {
            "\\l" | "\\list" => {
                "SELECT datname AS \"Name\", pg_get_userbyid(datdba) AS \"Owner\", pg_encoding_to_char(encoding) AS \"Encoding\", datcollate AS \"Collate\", datctype AS \"Ctype\" FROM pg_database WHERE datistemplate = false ORDER BY datname;".into()
            }
            "\\c" | "\\connect" => {
                if !arg.is_empty() {
                    // WP4 步骤2: 目标库名过 escape_sql_literal; 失败返回常量 Error SQL (不回显输入)
                    match crate::services::sql_escape::escape_sql_literal(arg) {
                        Ok(safe) => format!(
                            "SELECT current_database() AS \"Current_DB\", '{}' AS \"Target_DB_Tip (请使用顶部下拉切换)\", current_user AS \"User\";",
                            safe
                        ),
                        Err(_) => SELECT_ESCAPE_ERROR.to_string(),
                    }
                } else {
                    "SELECT current_database() AS \"Current_DB\", current_user AS \"User\", inet_server_addr()::text AS \"Server_IP\", inet_server_port() AS \"Port\";".into()
                }
            }
            "\\dt" => {
                if !arg.is_empty() {
                    // WP4 步骤2: 模式串过 escape_sql_literal (保留 ILIKE %通配语义, psql 兼容)
                    match crate::services::sql_escape::escape_sql_literal(arg) {
                        Ok(safe) => format!(
                            "SELECT n.nspname as \"Schema\", c.relname as \"Name\", 'table' as \"Type\", pg_catalog.pg_get_userbyid(c.relowner) as \"Owner\" FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relname ILIKE '%{}%' ORDER BY 1,2;",
                            safe
                        ),
                        Err(_) => SELECT_ESCAPE_ERROR.to_string(),
                    }
                } else {
                    "SELECT n.nspname as \"Schema\", c.relname as \"Name\", 'table' as \"Type\", pg_catalog.pg_get_userbyid(c.relowner) as \"Owner\" FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1,2;".into()
                }
            }
            "\\dv" => {
                "SELECT n.nspname as \"Schema\", c.relname as \"Name\", 'view' as \"Type\", pg_catalog.pg_get_userbyid(c.relowner) as \"Owner\" FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'v' AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1,2;".into()
            }
            "\\di" => {
                "SELECT n.nspname as \"Schema\", c.relname as \"Name\", 'index' as \"Type\", c2.relname as \"Table\" FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid JOIN pg_catalog.pg_class c2 ON i.indrelid = c2.oid LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'i' AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1,2;".into()
            }
            "\\dn" => {
                "SELECT nspname AS \"Name\", pg_catalog.pg_get_userbyid(nspowner) AS \"Owner\" FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_%' ORDER BY 1;".into()
            }
            "\\du" | "\\dg" => {
                "SELECT r.rolname AS \"Role_Name\", ARRAY(SELECT b.rolname FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles b ON (m.roleid = b.oid) WHERE m.member = r.oid) as \"Member_Of\", CASE WHEN r.rolsuper THEN 'Superuser, ' ELSE '' END || CASE WHEN r.rolcreaterole THEN 'Create role, ' ELSE '' END || CASE WHEN r.rolcreatedb THEN 'Create DB, ' ELSE '' END || CASE WHEN r.rolcanlogin THEN 'Cannot login' ELSE '' END AS \"Attributes\" FROM pg_catalog.pg_roles r ORDER BY 1;".into()
            }
            "\\df" => {
                "SELECT n.nspname as \"Schema\", p.proname as \"Name\", pg_catalog.pg_get_function_result(p.oid) as \"Result data type\", pg_catalog.pg_get_function_arguments(p.oid) as \"Argument data types\" FROM pg_catalog.pg_proc p LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2;".into()
            }
            "\\d" => {
                if !arg.is_empty() {
                    // WP4 步骤2: 删除原 arg.replace('"', "") 伪清洗; 全量过 escape_sql_literal
                    // 支持 schema.table (按最后一个 '.' 切分, 双条件各自转义)
                    let (schema_part, table_part) = match arg.rfind('.') {
                        Some(idx) if idx > 0 && idx < arg.len() - 1 => {
                            (Some(&arg[..idx]), &arg[idx + 1..])
                        }
                        _ => (None, arg),
                    };
                    let esc = crate::services::sql_escape::escape_sql_literal;
                    match (
                        schema_part.map(esc).transpose(),
                        esc(table_part),
                    ) {
                        (Ok(schema), Ok(table)) => {
                            let schema_cond = match schema {
                                Some(s) => format!(" AND n.nspname = '{}'", s),
                                None => String::new(),
                            };
                            format!(
                                "SELECT \
                            a.attname AS \"Column\", \
                            format_type(a.atttypid, a.atttypmod) AS \"Type\", \
                            CASE WHEN a.attnotnull THEN 'not null' ELSE '' END AS \"Nullable\", \
                            (SELECT substring(pg_catalog.pg_get_expr(d.adbin, d.adrelid) for 128) FROM pg_catalog.pg_attrdef d WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.atthasdef) AS \"Default\", \
                            pg_catalog.col_description(a.attrelid, a.attnum) AS \"Comment\" \
                         FROM pg_catalog.pg_attribute a \
                         JOIN pg_catalog.pg_class c ON a.attrelid = c.oid \
                         JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid \
                         WHERE c.relname = '{}'{} AND a.attnum > 0 AND NOT a.attisdropped \
                         ORDER BY a.attnum;",
                                table, schema_cond
                            )
                        }
                        _ => SELECT_ESCAPE_ERROR.to_string(),
                    }
                } else {
                    "SELECT n.nspname as \"Schema\", c.relname as \"Name\", CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'i' THEN 'index' WHEN 'S' THEN 'sequence' WHEN 's' THEN 'special' WHEN 'f' THEN 'foreign table' END as \"Type\", pg_catalog.pg_get_userbyid(c.relowner) as \"Owner\" FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1,2;".into()
                }
            }
            _ => cmd.to_string(),
        }
    }

    /// 建立并注册新的数据库连接池
    pub async fn connect(&self, config: ConnectionConfig) -> Result<(), AppError> {
        let conn_id = config.id.clone();

        // WP3: SSH 隧道集成 — enabled && 非 Sqlite 时先开隧道, 连接指向 127.0.0.1:local_port
        // (重连时 TunnelManager::open 内部先关旧隧道, 不泄漏句柄)
        let use_tunnel = config
            .ssh_tunnel
            .as_ref()
            .map(|t| t.enabled)
            .unwrap_or(false);
        let (eff_host, eff_port) = if use_tunnel {
            if config.db_type == DatabaseType::Sqlite {
                return Err(AppError::tunnel(
                    crate::services::tunnel_service::tunnel_err::INVALID_CONFIG,
                    "SQLite 是本地文件数据库, 不支持 SSH 隧道",
                ));
            }
            let t = config.ssh_tunnel.clone().unwrap();
            let local_port = self
                .tunnels
                .open(&conn_id, t, config.host.clone(), config.port)
                .await?;
            tracing::info!(target: "DB::TUNNEL", conn_id = %conn_id, local_port, "SSH tunnel established");
            ("127.0.0.1".to_string(), local_port)
        } else {
            (config.host.clone(), config.port)
        };

        let pool = match config.db_type {
            DatabaseType::Postgres => {
                // WP5 B1: ssl_mode 接入 (原字段已存在但从未使用) + WP4 技术债: user/database 也过编码
                let encoded_user = urlencoding::encode(&config.user);
                let encoded_pass = urlencoding::encode(config.password.as_deref().unwrap_or(""));
                let encoded_db = urlencoding::encode(&config.database);
                let url = format!(
                    "postgres://{}:{}@{}:{}/{}",
                    encoded_user,
                    encoded_pass,
                    eff_host,
                    eff_port,
                    encoded_db
                );
                // 默认策略基于原始 host (隧道时 eff_host 是 127.0.0.1, 不代表真实目标)
                let ssl = crate::services::value_mapping::pg_ssl_mode(
                    config.ssl_mode.as_deref().unwrap_or(""),
                    &config.host,
                );
                let opts = url
                    .parse::<sqlx::postgres::PgConnectOptions>()
                    .map_err(|e| AppError::Database(format!("连接串解析失败: {e}")))?
                    .ssl_mode(ssl);
                let p = PgPoolOptions::new()
                    .max_connections(5)
                    .acquire_timeout(std::time::Duration::from_secs(10))
                    .connect_with(opts)
                    .await
                    .map_err(|e| {
                        // 隧道模式下 DB 连接失败: 关隧道避免悬挂资源
                        if use_tunnel {
                            let tunnels = self.tunnels.clone();
                            let cid = conn_id.clone();
                            tokio::spawn(async move { tunnels.close(&cid).await });
                        }
                        // B1 会议七: SSL 握手失败且默认策略 → 提示可显式 ssl_mode=disable 降级
                        let mut msg = e.to_string();
                        if config.ssl_mode.is_none()
                            && !crate::services::value_mapping::is_loopback(&config.host)
                        {
                            msg.push_str(" (提示: 默认 ssl_mode=require, 如服务器不支持 SSL 可在连接配置中显式设置 ssl_mode=disable)");
                        }
                        AppError::Database(msg)
                    })?;
                // WP4 步骤2: standard_conforming_strings 基线检查 (off 时反斜杠有转义语义, 告警)
                {
                    use sqlx::Row;
                    if let Ok(row) = sqlx::query("SHOW standard_conforming_strings")
                        .fetch_one(&p)
                        .await
                    {
                        let v: String = row.try_get(0).unwrap_or_default();
                        if v.eq_ignore_ascii_case("off") {
                            tracing::warn!(target: "DB::SECURITY", conn_id = %conn_id,
                                "standard_conforming_strings=off — 反斜杠在字面量中有转义语义, SQL 拼接安全假设被削弱!");
                        }
                    }
                }
                AnyPool::Postgres(p)
            }
            DatabaseType::Mysql => {
                // WP5 B1: MySQL ssl_mode 接入 (verify-full → VerifyIdentity)
                let encoded_user = urlencoding::encode(&config.user);
                let encoded_pass = urlencoding::encode(config.password.as_deref().unwrap_or(""));
                let encoded_db = urlencoding::encode(&config.database);
                let url = format!(
                    "mysql://{}:{}@{}:{}/{}",
                    encoded_user,
                    encoded_pass,
                    eff_host,
                    eff_port,
                    encoded_db
                );
                let ssl = crate::services::value_mapping::mysql_ssl_mode(
                    config.ssl_mode.as_deref().unwrap_or(""),
                    &config.host,
                );
                let opts = url
                    .parse::<sqlx::mysql::MySqlConnectOptions>()
                    .map_err(|e| AppError::Database(format!("连接串解析失败: {e}")))?
                    .ssl_mode(ssl);
                let p = MySqlPoolOptions::new()
                    .max_connections(5)
                    .acquire_timeout(std::time::Duration::from_secs(10))
                    .connect_with(opts)
                    .await
                    .map_err(|e| {
                        if use_tunnel {
                            let tunnels = self.tunnels.clone();
                            let cid = conn_id.clone();
                            tokio::spawn(async move { tunnels.close(&cid).await });
                        }
                        let mut msg = e.to_string();
                        if config.ssl_mode.is_none()
                            && !crate::services::value_mapping::is_loopback(&config.host)
                        {
                            msg.push_str(" (提示: 默认 ssl_mode=require, 如服务器不支持 SSL 可在连接配置中显式设置 ssl_mode=disable)");
                        }
                        AppError::Database(msg)
                    })?;
                AnyPool::MySql(p)
            }


            DatabaseType::Sqlite => {
                let p = SqlitePoolOptions::new()
                    .max_connections(5)
                    .connect(&config.database)
                    .await?;
                AnyPool::Sqlite(p)
            }
        };

        let mut lock = self.pools.write().await;
        // 允许重复调用以刷新已有的连接配置（例如关闭/开启 ReadOnly 模式）
        lock.insert(conn_id, (pool, config));
        Ok(())
    }


    /// 执行任意 SQL 语句并格式化返回 QueryResult
    /// WP1 安全管道: psql 元命令先转译 → read_only AST 白名单 → 风险分级 (Critical 需 force 确认) → 执行
    pub async fn execute_query(
        &self,
        conn_id: &str,
        sql: &str,
        force: bool,
    ) -> Result<QueryResult, AppError> {
        let start = std::time::Instant::now();
        let lock = self.pools.read().await;
        let (pool, config) = lock
            .get(conn_id)
            .ok_or_else(|| AppError::ConnectionNotFound(conn_id.to_string()))?;

        // psql 元命令 (Meta-Commands) 智能解析与转译 (先转译, 再对 effective_sql 做 AST 检查)
        let effective_sql = if sql.trim().starts_with('\\') {
            Self::translate_psql_command(sql.trim(), &config.database)
        } else {
            sql.to_string()
        };

        // L1: read_only 物理约束 — AST 白名单拦截 (force 也不可绕过)
        if config.read_only {
            SqlSafetyChecker::check_read_only(&effective_sql, &config.db_type)?;
        }

        // L2: 风险分级 — 解析失败时非 read_only 模式透传, 交由数据库本身报语法错
        match SqlSafetyChecker::inspect_safety(&effective_sql, &config.db_type) {
            Ok(verdict) => {
                if verdict.level == RiskLevel::Critical && !force {
                    return Err(AppError::SafetyCritical {
                        message: format!(
                            "高危 SQL 已被安全管道拦截: {}",
                            verdict.reasons.join("; ")
                        ),
                        risk_level: verdict.level.as_str().to_string(),
                        requires_confirmation: true,
                        reasons: verdict.reasons,
                    });
                }
                if verdict.level == RiskLevel::Critical && force {
                    // SEC 决议: force=true 执行 Critical 时打 WARN 安全日志 (SQL 截断 200 字符脱敏)
                    let truncated: String = effective_sql.chars().take(200).collect();
                    tracing::warn!(
                        target: "DB::SAFETY",
                        conn_id = %conn_id,
                        force = true,
                        sql_head = %truncated,
                        "Critical SQL force-executed after user confirmation"
                    );
                }
            }
            Err(_) if config.read_only => {
                // read_only 下解析失败已在 L1 拦截, 不会到达此处; 防御性兜底
                return Err(AppError::SafetyBlocked(
                    "Read-Only mode: SQL 解析失败, 已拦截".into(),
                ));
            }
            Err(_) => {
                // 非 read_only: 语法解析失败透传, 让数据库报原始错误
            }
        }

        match pool {
            AnyPool::Postgres(p) => {
                // 安全防护：防止千万级 SQL 结果一次性全量拉入 Rust 内存导致 OOM 溢出
                // 设置单条 SQL 最大拉取上限为 50,000 行
                const MAX_QUERY_ROWS_LIMIT: usize = 50_000;
                
                use futures_util::StreamExt;
                let mut stream = sqlx::query(&effective_sql).fetch(p);

                let mut rows_fetched = 0;
                let mut columns: Vec<ColumnMetadata> = Vec::new();
                let mut result_rows: Vec<Vec<DbValue>> = Vec::new();

                while let Some(row_result) = stream.next().await {
                    let r = row_result?;
                    if rows_fetched == 0 {
                        columns = r
                            .columns()
                            .iter()
                            .map(|c| ColumnMetadata {
                                name: c.name().to_string(),
                                data_type: c.type_info().name().to_string(),
                                nullable: true,
                                is_primary_key: false,
                            })
                            .collect();
                    }

                    let mut row_vals = Vec::new();
                    for (i, col) in r.columns().iter().enumerate() {
                        let type_name = col.type_info().name();
                        // WP5: TypePlan 驱动 + 类型保真读取 (替代原 unwrap_or(Null) 静默丢弃)
                        let plan = crate::services::value_mapping::plan_pg(type_name);
                        row_vals.push(read_pg_value(&r, i, col.name(), plan));
                    }
                    result_rows.push(row_vals);
                    rows_fetched += 1;

                    if rows_fetched >= MAX_QUERY_ROWS_LIMIT {
                        tracing::warn!(target: "DB::SAFETY", "Query row limit reached ({}), streaming stopped to protect memory.", MAX_QUERY_ROWS_LIMIT);
                        break;
                    }
                }

                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                Ok(QueryResult {
                    columns,
                    rows: result_rows,
                    rows_affected: rows_fetched as u64,
                    elapsed_ms: elapsed,
                    is_read_only: config.read_only,
                })
            }
            AnyPool::MySql(p) => {
                const MAX_QUERY_ROWS_LIMIT: usize = 50_000;
                use futures_util::StreamExt;
                let mut stream = sqlx::query(&effective_sql).fetch(p);

                let mut rows_fetched = 0;
                let mut columns: Vec<ColumnMetadata> = Vec::new();
                let mut result_rows: Vec<Vec<DbValue>> = Vec::new();

                while let Some(row_result) = stream.next().await {
                    let r = row_result?;
                    if rows_fetched == 0 {
                        columns = r
                            .columns()
                            .iter()
                            .map(|c| ColumnMetadata {
                                name: c.name().to_string(),
                                data_type: c.type_info().name().to_string(),
                                nullable: true,
                                is_primary_key: false,
                            })
                            .collect();
                    }

                    let mut row_vals = Vec::new();
                    for (i, col) in r.columns().iter().enumerate() {
                        // WP5: MySQL 原为全列 String 降级, 现按 TypePlan 类型保真读取
                        let type_name = col.type_info().name();
                        let plan = crate::services::value_mapping::plan_mysql(type_name, false);
                        row_vals.push(read_mysql_value(&r, i, col.name(), plan));
                    }
                    result_rows.push(row_vals);
                    rows_fetched += 1;

                    if rows_fetched >= MAX_QUERY_ROWS_LIMIT {
                        tracing::warn!(target: "DB::SAFETY", "MySql Query row limit reached ({}), streaming stopped.", MAX_QUERY_ROWS_LIMIT);
                        break;
                    }
                }

                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                Ok(QueryResult {
                    columns,
                    rows: result_rows,
                    rows_affected: rows_fetched as u64,
                    elapsed_ms: elapsed,
                    is_read_only: config.read_only,
                })
            }
            AnyPool::Sqlite(p) => {
                const MAX_QUERY_ROWS_LIMIT: usize = 50_000;
                use futures_util::StreamExt;
                let mut stream = sqlx::query(&effective_sql).fetch(p);

                let mut rows_fetched = 0;
                let mut columns: Vec<ColumnMetadata> = Vec::new();
                let mut result_rows: Vec<Vec<DbValue>> = Vec::new();

                while let Some(row_result) = stream.next().await {
                    let r = row_result?;
                    if rows_fetched == 0 {
                        columns = r
                            .columns()
                            .iter()
                            .map(|c| ColumnMetadata {
                                name: c.name().to_string(),
                                data_type: c.type_info().name().to_string(),
                                nullable: true,
                                is_primary_key: false,
                            })
                            .collect();
                    }

                    let mut row_vals = Vec::new();
                    for (i, col) in r.columns().iter().enumerate() {
                        // WP5: SQLite 原为全列 String 降级, 现按声明类型 TypePlan 读取 (动态类型走降级链)
                        let type_name = col.type_info().name();
                        let plan = crate::services::value_mapping::plan_sqlite(type_name);
                        row_vals.push(read_sqlite_value(&r, i, col.name(), plan));
                    }
                    result_rows.push(row_vals);
                    rows_fetched += 1;

                    if rows_fetched >= MAX_QUERY_ROWS_LIMIT {
                        tracing::warn!(target: "DB::SAFETY", "Sqlite Query row limit reached ({}), streaming stopped.", MAX_QUERY_ROWS_LIMIT);
                        break;
                    }
                }

                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                Ok(QueryResult {
                    columns,
                    rows: result_rows,
                    rows_affected: rows_fetched as u64,
                    elapsed_ms: elapsed,
                    is_read_only: config.read_only,
                })
            }
        }


    }
}

// ============ WP4 步骤2: translate_psql_command 注入加固集成测试 (T2) ============

#[cfg(test)]
mod tests_wp4_translate {
    use super::DbService;
    use sqlparser::dialect::PostgreSqlDialect;
    use sqlparser::parser::Parser;

    /// 断言 SQL 为单条语句且可被 sqlparser 解析 (无多语句注入)
    fn assert_single_select(sql: &str) {
        let dialect = PostgreSqlDialect {};
        let ast = Parser::parse_sql(&dialect, sql)
            .unwrap_or_else(|e| panic!("SQL 应可解析为合法语句, 实得错误 {e}; SQL={sql}"));
        assert_eq!(ast.len(), 1, "必须是单条语句, 防多语句注入; SQL={sql}");
        let s = ast[0].to_string().to_uppercase();
        assert!(s.starts_with("SELECT"), "必须是 SELECT; SQL={sql}");
    }

    #[test]
    fn t2_dt_pattern_escapes_single_quote() {
        // \dt it's → ILIKE '%it''s%'
        let sql = DbService::translate_psql_command("\\dt it's", "mydb");
        assert!(sql.contains("ILIKE '%it''s%'"), "单引号应翻倍: {sql}");
        assert_single_select(&sql);
    }

    #[test]
    fn t2_dt_wildcard_preserved() {
        // \dt user% → 通配符保留 (psql 兼容)
        let sql = DbService::translate_psql_command("\\dt user%", "mydb");
        assert!(sql.contains("ILIKE '%user%%'"), "通配符应保留: {sql}");
        assert_single_select(&sql);
    }

    #[test]
    fn t2_d_injection_attempt_neutralized() {
        // 注意: translate 按空白切分, arg 仅取第二个 token "evil';", 其余被丢弃 (天然限制注入面)
        // 关键保证: 该 token 的单引号被翻倍, 整条 SQL 是单条 SELECT
        let sql = DbService::translate_psql_command("\\d evil'; DROP TABLE t; --", "mydb");
        assert!(
            sql.contains("relname = 'evil'';'"),
            "注入 token 的单引号应翻倍: {sql}"
        );
        assert_single_select(&sql);
    }

    #[test]
    fn t2_d_injection_no_space_neutralized() {
        // 无空格注入 (整体作为单 token): \d x';DROPTABLEy;--
        let sql = DbService::translate_psql_command("\\d x';DROPTABLEy;--", "mydb");
        assert!(
            sql.contains("relname = 'x'';DROPTABLEy;--'"),
            "无空格注入也应被字面量化: {sql}"
        );
        assert_single_select(&sql);
    }

    #[test]
    fn t2_d_control_char_returns_constant_error() {
        // \d bad\0name → 常量 Error SQL, 不含原始输入
        let sql = DbService::translate_psql_command("\\d bad\u{0}name", "mydb");
        assert_eq!(sql, "SELECT 'Invalid input: contains control characters' AS \"Error\";");
        assert!(!sql.contains("bad"), "不得回显原始输入");
        assert_single_select(&sql);
    }

    #[test]
    fn t2_d_schema_table_split() {
        // \d myschema.mytable → 双条件 nspname/relname
        let sql = DbService::translate_psql_command("\\d myschema.mytable", "mydb");
        assert!(sql.contains("c.relname = 'mytable'"), "表名条件: {sql}");
        assert!(sql.contains("n.nspname = 'myschema'"), "schema 条件: {sql}");
        assert_single_select(&sql);
    }

    #[test]
    fn t2_d_schema_table_injection() {
        // schema.table 两段各自转义
        let sql = DbService::translate_psql_command("\\d sch'ema.tab'le", "mydb");
        assert!(sql.contains("n.nspname = 'sch''ema'"), "schema 段转义: {sql}");
        assert!(sql.contains("c.relname = 'tab''le'"), "表名段转义: {sql}");
        assert_single_select(&sql);
    }

    #[test]
    fn t2_c_database_escapes_quote() {
        // \c db'x → 'db''x'
        let sql = DbService::translate_psql_command("\\c db'x", "mydb");
        assert!(sql.contains("'db''x'"), "目标库名单引号应翻倍: {sql}");
        assert_single_select(&sql);
    }

    #[test]
    fn t2_no_arg_commands_unchanged() {
        // 无参常量路径零回归: \dt \d \l \dn \du \df \di \dv 均为合法单 SELECT
        for cmd in ["\\dt", "\\d", "\\l", "\\dn", "\\du", "\\df", "\\di", "\\dv"] {
            let sql = DbService::translate_psql_command(cmd, "mydb");
            assert_single_select(&sql);
        }
    }

    #[test]
    fn t2_d_no_arg_lists_all_relations() {
        // \d 无参 → 列出全部关系 (常量路径)
        let sql = DbService::translate_psql_command("\\d", "mydb");
        assert!(sql.contains("CASE c.relkind"), "无参 \\d 应走关系列举分支: {sql}");
        assert_single_select(&sql);
    }
}
