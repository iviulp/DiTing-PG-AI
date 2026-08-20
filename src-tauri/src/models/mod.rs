/// 通用强类型数据模型与 JSON 映射层
/// 解决大整数、Decimal、JSONB、Timestamp 与 Hex 二进制格式在 Rust 与 JS 之间的序列化问题

use serde::{Deserialize, Serialize};

/// 支持的数据库类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseType {
    Postgres,
    Mysql,
    Sqlite,
}

/// 通用单元格数据类型枚举
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "val")]
pub enum DbValue {
    Null,
    Int(i64),
    Float(f64),
    StringDecimal(String),
    Bool(bool),
    Text(String),
    Json(String),
    BytesHex(String),
    Timestamp(String),
}

/// 单列结构元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMetadata {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
}

/// 单张表元数据定义
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSchema {

    pub table_name: String,
    pub schema_name: Option<String>,
    pub comment: Option<String>,
    pub columns: Vec<ColumnMetadata>,
}

/// 执行 SQL 查询后返回的数据集结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnMetadata>,
    pub rows: Vec<Vec<DbValue>>,
    pub rows_affected: u64,
    pub elapsed_ms: f64,
    pub is_read_only: bool,
}

/// 数据库连接配置载荷
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: DatabaseType,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: String,
    pub schema: Option<String>,
    pub env_tag: Option<String>, // 'PROD' | 'DEV' | 'TEST'
    pub ssl_mode: Option<String>,
    pub read_only: bool,
}
