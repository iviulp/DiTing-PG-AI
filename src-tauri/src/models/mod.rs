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
    /// WP3: SSH 隧道配置 (前端 SshTunnelConfig 镜像; 旧 JSON 无此字段时默认 None)
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelConfig>,
}

/// WP3: SSH 隧道类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TunnelType {
    /// 单跳: 本机 → SSH 主机 → 目标 DB
    #[default]
    Direct,
    /// 双跳: 本机 → 堡垒机 → 目标内网机 → DB
    BastionJump,
}

/// WP3: SSH 认证方式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SshAuthType {
    #[default]
    Password,
    PrivateKey,
}

/// WP3: SSH 隧道配置 (镜像前端 src/types/index.ts SshTunnelConfig)
/// 敏感字段 (密码/私钥 passphrase/OTP) 在 Debug 输出中脱敏
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SshTunnelConfig {
    pub enabled: bool,
    #[serde(default)]
    pub tunnel_type: TunnelType,

    // 第一重: 堡垒机 / 跳板机 (direct 模式下即 SSH 主机)
    pub ssh_host: String,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    pub ssh_user: String,
    #[serde(default)]
    pub auth_type: SshAuthType,
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub ssh_private_key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub otp_secret: Option<String>,
    #[serde(default)]
    pub otp_code: Option<String>,

    // 第二重: 目标内网中转机 (仅 bastion_jump 模式)
    #[serde(default)]
    pub target_ssh_host: Option<String>,
    #[serde(default)]
    pub target_ssh_port: Option<u16>,
    #[serde(default)]
    pub target_ssh_user: Option<String>,
    #[serde(default)]
    pub target_auth_type: Option<SshAuthType>,
    #[serde(default)]
    pub target_ssh_password: Option<String>,
    #[serde(default)]
    pub target_ssh_private_key_path: Option<String>,
}

fn default_ssh_port() -> u16 {
    22
}

/// Debug 脱敏实现: 密码/passphrase/OTP 一律显示为 ***
impl std::fmt::Debug for SshTunnelConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshTunnelConfig")
            .field("enabled", &self.enabled)
            .field("tunnel_type", &self.tunnel_type)
            .field("ssh_host", &self.ssh_host)
            .field("ssh_port", &self.ssh_port)
            .field("ssh_user", &self.ssh_user)
            .field("auth_type", &self.auth_type)
            .field("ssh_password", &mask(self.ssh_password.is_some()))
            .field("ssh_private_key_path", &self.ssh_private_key_path)
            .field("passphrase", &mask(self.passphrase.is_some()))
            .field("otp_secret", &mask(self.otp_secret.is_some()))
            .field("otp_code", &mask(self.otp_code.is_some()))
            .field("target_ssh_host", &self.target_ssh_host)
            .field("target_ssh_port", &self.target_ssh_port)
            .field("target_ssh_user", &self.target_ssh_user)
            .finish()
    }
}

struct Masked(bool);
fn mask(present: bool) -> Masked {
    Masked(present)
}
impl std::fmt::Debug for Masked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.0 {
            write!(f, "***")
        } else {
            write!(f, "None")
        }
    }
}
