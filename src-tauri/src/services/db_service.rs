/// SQL 抽象执行服务与连接池管理器
/// 支持 PostgreSQL, MySQL, SQLite 的动态连接调度与异步 Execute/Query 操作

use crate::error::AppError;
use crate::models::{ColumnMetadata, ConnectionConfig, DatabaseType, DbValue, QueryResult};

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

/// 全局连接池调度服务
pub struct DbService {
    pools: Arc<RwLock<HashMap<String, (AnyPool, ConnectionConfig)>>>,
}

impl DbService {
    pub fn new() -> Self {
        Self {
            pools: Arc::new(RwLock::new(HashMap::new())),
        }
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
                    format!("SELECT current_database() AS \"Current_DB\", '{}' AS \"Target_DB_Tip (请使用顶部下拉切换)\", current_user AS \"User\";", arg)
                } else {
                    "SELECT current_database() AS \"Current_DB\", current_user AS \"User\", inet_server_addr()::text AS \"Server_IP\", inet_server_port() AS \"Port\";".into()
                }
            }
            "\\dt" => {
                if !arg.is_empty() {
                    format!("SELECT n.nspname as \"Schema\", c.relname as \"Name\", 'table' as \"Type\", pg_catalog.pg_get_userbyid(c.relowner) as \"Owner\" FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relname ILIKE '%{}%' ORDER BY 1,2;", arg)
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
                    let clean_tbl = arg.replace('"', "");
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
                         WHERE c.relname = '{}' AND a.attnum > 0 AND NOT a.attisdropped \
                         ORDER BY a.attnum;",
                        clean_tbl
                    )
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
        
        let pool = match config.db_type {
            DatabaseType::Postgres => {
                let encoded_pass = urlencoding::encode(config.password.as_deref().unwrap_or(""));
                let url = format!(
                    "postgres://{}:{}@{}:{}/{}",
                    config.user,
                    encoded_pass,
                    config.host,
                    config.port,
                    config.database
                );
                let p = PgPoolOptions::new()
                    .max_connections(5)
                    .acquire_timeout(std::time::Duration::from_secs(10))
                    .connect(&url)
                    .await?;
                AnyPool::Postgres(p)
            }
            DatabaseType::Mysql => {
                let encoded_pass = urlencoding::encode(config.password.as_deref().unwrap_or(""));
                let url = format!(
                    "mysql://{}:{}@{}:{}/{}",
                    config.user,
                    encoded_pass,
                    config.host,
                    config.port,
                    config.database
                );
                let p = MySqlPoolOptions::new()
                    .max_connections(5)
                    .acquire_timeout(std::time::Duration::from_secs(10))
                    .connect(&url)
                    .await?;
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
    pub async fn execute_query(&self, conn_id: &str, sql: &str) -> Result<QueryResult, AppError> {
        let start = std::time::Instant::now();
        let lock = self.pools.read().await;
        let (pool, config) = lock
            .get(conn_id)
            .ok_or_else(|| AppError::ConnectionNotFound(conn_id.to_string()))?;

        // 安全检核：若是物理只读模式，阻断写 SQL
        if config.read_only {
            let lower_sql = sql.trim().to_lowercase();
            if lower_sql.starts_with("insert") || lower_sql.starts_with("update") || lower_sql.starts_with("delete") || lower_sql.starts_with("drop") {
                return Err(AppError::SafetyBlocked("Database connection is in Read-Only mode.".into()));
            }
        }

        // psql 元命令 (Meta-Commands) 智能解析与转译
        let effective_sql = if sql.trim().starts_with('\\') {
            Self::translate_psql_command(sql.trim(), &config.database)
        } else {
            sql.to_string()
        };

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
                        let db_val = match type_name {
                            "INT8" | "BIGINT" => {
                                r.try_get::<i64, _>(i).map(DbValue::Int).unwrap_or(DbValue::Null)
                            }
                            "INT4" | "INT" | "INTEGER" => {
                                r.try_get::<i32, _>(i).map(|v| DbValue::Int(v as i64)).unwrap_or(DbValue::Null)
                            }
                            "INT2" | "SMALLINT" => {
                                r.try_get::<i16, _>(i).map(|v| DbValue::Int(v as i64)).unwrap_or(DbValue::Null)
                            }
                            "BOOL" | "BOOLEAN" => {
                                if let Ok(b) = r.try_get::<bool, _>(i) {
                                    DbValue::Bool(b)
                                } else if let Ok(s) = r.try_get::<String, _>(i) {
                                    DbValue::Bool(s == "t" || s == "true" || s == "1")
                                } else {
                                    DbValue::Null
                                }
                            }
                            "TIMESTAMPTZ" | "TIMESTAMP" => {
                                if let Ok(dt) = r.try_get::<chrono::DateTime<chrono::Utc>, _>(i) {
                                    DbValue::Timestamp(dt.format("%Y-%m-%d %H:%M:%S.%3f%z").to_string())
                                } else if let Ok(naive) = r.try_get::<chrono::NaiveDateTime, _>(i) {
                                    DbValue::Timestamp(naive.format("%Y-%m-%d %H:%M:%S").to_string())
                                } else {
                                    r.try_get::<String, _>(i).map(DbValue::Text).unwrap_or(DbValue::Null)
                                }
                            }
                            "UUID" => {
                                r.try_get::<uuid::Uuid, _>(i).map(|v| DbValue::Text(v.to_string())).unwrap_or(DbValue::Null)
                            }
                            _ => {
                                if let Ok(b) = r.try_get::<bool, _>(i) {
                                    DbValue::Bool(b)
                                } else {
                                    r.try_get::<String, _>(i).map(DbValue::Text).unwrap_or(DbValue::Null)
                                }
                            }
                        };
                        row_vals.push(db_val);
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
                let mut stream = sqlx::query(sql).fetch(p);

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
                    for (i, _) in r.columns().iter().enumerate() {
                        let val: String = r.try_get::<String, _>(i).unwrap_or_else(|_| "NULL".into());
                        row_vals.push(DbValue::Text(val));
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
                let mut stream = sqlx::query(sql).fetch(p);

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
                    for (i, _) in r.columns().iter().enumerate() {
                        let val: String = r.try_get::<String, _>(i).unwrap_or_else(|_| "NULL".into());
                        row_vals.push(DbValue::Text(val));
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
