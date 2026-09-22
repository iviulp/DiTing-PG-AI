//! WP5: 类型映射与 SSL 模式纯函数层
//! - TypePlan: 列类型 → 读取策略 (A2-A4 映射表, 计划会议三/四)
//! - plan_pg / plan_mysql / plan_sqlite: 类型名归一化后匹配
//! - pg_ssl_mode / mysql_ssl_mode / default_ssl_mode: B1 SSL 纯函数
//!
//! 全部为无 IO 纯函数, L1 单测全覆盖 (D1)

use sqlx::mysql::MySqlSslMode;
use sqlx::postgres::PgSslMode;

/// 列读取策略
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypePlan {
    Int64,
    Int32,
    Int16,
    /// MySQL BIGINT UNSIGNED (超 i64 上界) → StringDecimal 无损
    UInt64Decimal,
    UInt32,
    Float64,
    Float32,
    Bool,
    /// 高精度 decimal → 字符串无损 (DECIMAL(65,30) 等)
    DecimalStr,
    Timestamp,
    Date,
    Time,
    Uuid,
    Json,
    BytesHex,
    Text,
    /// 未知类型 → 动态降级链 (目标类型→String→hex→decode error Text)
    Fallback,
}

/// 类型名归一化: 大写、剥 `(n)` 长度/精度与 unsigned/zerofill 等修饰词
fn normalize(type_name: &str) -> String {
    let upper = type_name.to_uppercase();
    // 剥括号段: VARCHAR(255) → VARCHAR, DECIMAL(65,30) → DECIMAL
    let base = match upper.find('(') {
        Some(idx) => upper[..idx].to_string(),
        None => upper.clone(),
    };
    // 取第一个词 (剥 UNSIGNED/ZEROFILL 等尾缀修饰)
    base.split_whitespace()
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

/// PostgreSQL 类型映射 (A4: 保留既有 + 补全)
pub fn plan_pg(type_name: &str) -> TypePlan {
    match normalize(type_name).as_str() {
        "INT8" | "BIGINT" => TypePlan::Int64,
        "INT4" | "INT" | "INTEGER" => TypePlan::Int32,
        "INT2" | "SMALLINT" => TypePlan::Int16,
        "BOOL" | "BOOLEAN" => TypePlan::Bool,
        "FLOAT4" | "REAL" => TypePlan::Float32,
        "FLOAT8" | "DOUBLE" => TypePlan::Float64,
        "NUMERIC" | "DECIMAL" => TypePlan::DecimalStr,
        "TIMESTAMPTZ" | "TIMESTAMP" => TypePlan::Timestamp,
        "DATE" => TypePlan::Date,
        "TIME" | "TIMETZ" => TypePlan::Time,
        "UUID" => TypePlan::Uuid,
        "JSON" | "JSONB" => TypePlan::Json,
        "BYTEA" => TypePlan::BytesHex,
        // 文本类与网络/区间类 → Text
        "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" | "CITEXT" | "UUID_TEXT" => TypePlan::Text,
        "INTERVAL" | "INET" | "CIDR" | "MACADDR" => TypePlan::Text,
        _ => TypePlan::Fallback,
    }
}

/// MySQL 类型映射 (A2: 会议三映射表; unsigned 组合独立判定)
pub fn plan_mysql(type_name: &str, is_unsigned: bool) -> TypePlan {
    let base = normalize(type_name);
    // sqlx MySQL type_info().name() 可能已带 UNSIGNED 尾缀
    let unsigned = is_unsigned || type_name.to_uppercase().contains("UNSIGNED");
    match base.as_str() {
        "BIGINT" => {
            if unsigned {
                TypePlan::UInt64Decimal
            } else {
                TypePlan::Int64
            }
        }
        "INT" | "INTEGER" | "MEDIUMINT" => {
            if unsigned {
                TypePlan::UInt32
            } else {
                TypePlan::Int32
            }
        }
        "SMALLINT" | "TINYINT" | "YEAR" => {
            if unsigned {
                TypePlan::UInt32
            } else {
                TypePlan::Int16
            }
        }
        "FLOAT" => TypePlan::Float32,
        "DOUBLE" => TypePlan::Float64,
        "DECIMAL" | "NUMERIC" => TypePlan::DecimalStr,
        "BIT" => TypePlan::Bool,
        "BOOL" | "BOOLEAN" => TypePlan::Bool,
        "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            TypePlan::Text
        }
        "JSON" => TypePlan::Json,
        "DATE" => TypePlan::Date,
        "DATETIME" | "TIMESTAMP" => TypePlan::Timestamp,
        "TIME" => TypePlan::Time,
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            TypePlan::BytesHex
        }
        _ => TypePlan::Fallback,
    }
}

/// SQLite 声明类型映射 (A3: 会议四; 动态类型由降级链兜底)
pub fn plan_sqlite(type_name: &str) -> TypePlan {
    match normalize(type_name).as_str() {
        "INT" | "INTEGER" | "BIGINT" | "SMALLINT" | "TINYINT" | "MEDIUMINT" => TypePlan::Int64,
        "REAL" | "DOUBLE" | "FLOAT" => TypePlan::Float64,
        "NUMERIC" | "DECIMAL" => TypePlan::DecimalStr,
        "BOOL" | "BOOLEAN" => TypePlan::Bool,
        "DATE" | "DATETIME" | "TIMESTAMP" => TypePlan::Timestamp,
        "TIME" => TypePlan::Time,
        "BLOB" => TypePlan::BytesHex,
        "JSON" => TypePlan::Json,
        // TEXT/CHAR/VARCHAR/CLOB/空/未知 → Text
        "TEXT" | "CHAR" | "VARCHAR" | "CLOB" | "NCHAR" | "NVARCHAR" => TypePlan::Text,
        "" => TypePlan::Text,
        _ => TypePlan::Fallback,
    }
}

// ============ B1: SSL 纯函数 ============

/// PG ssl_mode 映射; 非法值回退 default 策略并 warn
pub fn pg_ssl_mode(mode: &str, host: &str) -> PgSslMode {
    match mode.trim().to_lowercase().as_str() {
        "disable" | "disabled" | "off" => PgSslMode::Disable,
        "prefer" => PgSslMode::Prefer,
        "require" | "on" => PgSslMode::Require,
        "verify-ca" => PgSslMode::VerifyCa,
        "verify-full" => PgSslMode::VerifyFull,
        "" => pg_ssl_mode(default_ssl_mode(host, false), host),
        other => {
            tracing::warn!(target: "DB::SSL", "非法 PG ssl_mode '{other}', 回退默认策略");
            pg_ssl_mode(default_ssl_mode(host, false), host)
        }
    }
}

/// MySQL ssl_mode 映射; verify-full → VerifyIdentity (会议六)
pub fn mysql_ssl_mode(mode: &str, host: &str) -> MySqlSslMode {
    match mode.trim().to_lowercase().as_str() {
        "disable" | "disabled" | "off" => MySqlSslMode::Disabled,
        "prefer" => MySqlSslMode::Preferred,
        "require" | "on" => MySqlSslMode::Required,
        "verify-ca" => MySqlSslMode::VerifyCa,
        "verify-full" => MySqlSslMode::VerifyIdentity,
        "" => mysql_ssl_mode(default_ssl_mode(host, false), host),
        other => {
            tracing::warn!(target: "DB::SSL", "非法 MySQL ssl_mode '{other}', 回退默认策略");
            mysql_ssl_mode(default_ssl_mode(host, false), host)
        }
    }
}

/// 默认 SSL 策略: localhost/回环 → disable (向后兼容), 其余 → require
/// is_sqlite=true 恒为 disable (SQLite 无网络)
pub fn default_ssl_mode(host: &str, is_sqlite: bool) -> &'static str {
    if is_sqlite {
        return "disable";
    }
    let h = host.trim().to_lowercase();
    if h == "localhost" || h == "127.0.0.1" || h == "::1" || h == "[::1]" {
        "disable"
    } else {
        "require"
    }
}

/// 判断 host 是否回环地址 (供连接错误提示文案)
pub fn is_loopback(host: &str) -> bool {
    let h = host.trim().to_lowercase();
    h == "localhost" || h == "127.0.0.1" || h == "::1" || h == "[::1]"
}

/// 字节 → hex 字符串 (胶水层共享 helper, A5)
pub fn bytes_to_hex(v: &[u8]) -> String {
    let mut s = String::with_capacity(v.len() * 2);
    for b in v {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

// ============ D1: L1 单元测试 (≥40 用例) ============

#[cfg(test)]
mod tests {
    use super::*;

    // ---- plan_pg ----

    #[test]
    fn pg_integer_family() {
        assert_eq!(plan_pg("INT8"), TypePlan::Int64);
        assert_eq!(plan_pg("BIGINT"), TypePlan::Int64);
        assert_eq!(plan_pg("int8"), TypePlan::Int64, "大小写不敏感");
        assert_eq!(plan_pg("INT4"), TypePlan::Int32);
        assert_eq!(plan_pg("INTEGER"), TypePlan::Int32);
        assert_eq!(plan_pg("INT2"), TypePlan::Int16);
        assert_eq!(plan_pg("SMALLINT"), TypePlan::Int16);
    }

    #[test]
    fn pg_float_decimal() {
        assert_eq!(plan_pg("FLOAT4"), TypePlan::Float32);
        assert_eq!(plan_pg("REAL"), TypePlan::Float32);
        assert_eq!(plan_pg("FLOAT8"), TypePlan::Float64);
        assert_eq!(plan_pg("DOUBLE PRECISION"), TypePlan::Float64, "剥修饰词");
        assert_eq!(plan_pg("NUMERIC"), TypePlan::DecimalStr);
        assert_eq!(plan_pg("DECIMAL"), TypePlan::DecimalStr);
    }

    #[test]
    fn pg_temporal_uuid_json_bytes() {
        assert_eq!(plan_pg("TIMESTAMPTZ"), TypePlan::Timestamp);
        assert_eq!(plan_pg("TIMESTAMP"), TypePlan::Timestamp);
        assert_eq!(plan_pg("DATE"), TypePlan::Date);
        assert_eq!(plan_pg("TIME"), TypePlan::Time);
        assert_eq!(plan_pg("TIMETZ"), TypePlan::Time);
        assert_eq!(plan_pg("UUID"), TypePlan::Uuid);
        assert_eq!(plan_pg("JSON"), TypePlan::Json);
        assert_eq!(plan_pg("JSONB"), TypePlan::Json);
        assert_eq!(plan_pg("BYTEA"), TypePlan::BytesHex);
        assert_eq!(plan_pg("BOOL"), TypePlan::Bool);
    }

    #[test]
    fn pg_text_network_and_unknown() {
        assert_eq!(plan_pg("TEXT"), TypePlan::Text);
        assert_eq!(plan_pg("VARCHAR"), TypePlan::Text);
        assert_eq!(plan_pg("VARCHAR(255)"), TypePlan::Text, "剥长度");
        assert_eq!(plan_pg("INTERVAL"), TypePlan::Text);
        assert_eq!(plan_pg("INET"), TypePlan::Text);
        assert_eq!(plan_pg("CIDR"), TypePlan::Text);
        assert_eq!(plan_pg("MACADDR"), TypePlan::Text);
        assert_eq!(plan_pg("SOME_FUTURE_TYPE"), TypePlan::Fallback);
    }

    // ---- plan_mysql ----

    #[test]
    fn mysql_unsigned_combinations() {
        assert_eq!(plan_mysql("BIGINT", true), TypePlan::UInt64Decimal);
        assert_eq!(plan_mysql("BIGINT", false), TypePlan::Int64);
        assert_eq!(plan_mysql("BIGINT UNSIGNED", false), TypePlan::UInt64Decimal, "尾缀 UNSIGNED 也识别");
        assert_eq!(plan_mysql("INT", true), TypePlan::UInt32);
        assert_eq!(plan_mysql("INT", false), TypePlan::Int32);
        assert_eq!(plan_mysql("SMALLINT", true), TypePlan::UInt32);
        assert_eq!(plan_mysql("TINYINT", false), TypePlan::Int16);
        assert_eq!(plan_mysql("YEAR", false), TypePlan::Int16);
    }

    #[test]
    fn mysql_numeric_types() {
        assert_eq!(plan_mysql("FLOAT", false), TypePlan::Float32);
        assert_eq!(plan_mysql("DOUBLE", false), TypePlan::Float64);
        assert_eq!(plan_mysql("DECIMAL(65,30)", false), TypePlan::DecimalStr, "剥精度");
        assert_eq!(plan_mysql("NUMERIC", false), TypePlan::DecimalStr);
        assert_eq!(plan_mysql("BIT", false), TypePlan::Bool);
    }

    #[test]
    fn mysql_string_temporal_binary() {
        assert_eq!(plan_mysql("CHAR", false), TypePlan::Text);
        assert_eq!(plan_mysql("VARCHAR(255)", false), TypePlan::Text);
        assert_eq!(plan_mysql("LONGTEXT", false), TypePlan::Text);
        assert_eq!(plan_mysql("ENUM", false), TypePlan::Text);
        assert_eq!(plan_mysql("SET", false), TypePlan::Text);
        assert_eq!(plan_mysql("JSON", false), TypePlan::Json);
        assert_eq!(plan_mysql("DATE", false), TypePlan::Date);
        assert_eq!(plan_mysql("DATETIME", false), TypePlan::Timestamp);
        assert_eq!(plan_mysql("TIMESTAMP", false), TypePlan::Timestamp);
        assert_eq!(plan_mysql("TIME", false), TypePlan::Time);
        assert_eq!(plan_mysql("BLOB", false), TypePlan::BytesHex);
        assert_eq!(plan_mysql("VARBINARY(16)", false), TypePlan::BytesHex);
        assert_eq!(plan_mysql("GEOMETRY", false), TypePlan::Fallback);
    }

    // ---- plan_sqlite ----

    #[test]
    fn sqlite_type_affinity() {
        assert_eq!(plan_sqlite("INTEGER"), TypePlan::Int64);
        assert_eq!(plan_sqlite("INT"), TypePlan::Int64);
        assert_eq!(plan_sqlite("BIGINT"), TypePlan::Int64);
        assert_eq!(plan_sqlite("REAL"), TypePlan::Float64);
        assert_eq!(plan_sqlite("DOUBLE"), TypePlan::Float64);
        assert_eq!(plan_sqlite("NUMERIC"), TypePlan::DecimalStr);
        assert_eq!(plan_sqlite("DECIMAL(10,5)"), TypePlan::DecimalStr);
        assert_eq!(plan_sqlite("BOOLEAN"), TypePlan::Bool);
        assert_eq!(plan_sqlite("DATE"), TypePlan::Timestamp);
        assert_eq!(plan_sqlite("DATETIME"), TypePlan::Timestamp);
        assert_eq!(plan_sqlite("BLOB"), TypePlan::BytesHex);
        assert_eq!(plan_sqlite("JSON"), TypePlan::Json);
        assert_eq!(plan_sqlite("TEXT"), TypePlan::Text);
        assert_eq!(plan_sqlite("VARCHAR(64)"), TypePlan::Text);
        assert_eq!(plan_sqlite("CLOB"), TypePlan::Text);
        assert_eq!(plan_sqlite(""), TypePlan::Text, "空声明类型 → Text");
        assert_eq!(plan_sqlite("WEIRD_TYPE"), TypePlan::Fallback);
    }

    // ---- normalize ----

    #[test]
    fn normalize_strips_length_and_modifiers() {
        assert_eq!(normalize("varchar(255)"), "VARCHAR");
        assert_eq!(normalize("decimal(65,30)"), "DECIMAL");
        assert_eq!(normalize("DOUBLE PRECISION"), "DOUBLE");
        assert_eq!(normalize("  int  "), "INT");
    }

    // ---- SSL 纯函数 ----

    // 注: sqlx SslMode 枚举未实现 PartialEq, 用 Debug 字符串比较 (同时锁定变体名)
    fn pg_dbg(m: PgSslMode) -> String {
        format!("{m:?}")
    }
    fn my_dbg(m: MySqlSslMode) -> String {
        format!("{m:?}")
    }

    #[test]
    fn pg_ssl_mode_four_levels() {
        assert_eq!(pg_dbg(pg_ssl_mode("disable", "h")), "Disable");
        assert_eq!(pg_dbg(pg_ssl_mode("require", "h")), "Require");
        assert_eq!(pg_dbg(pg_ssl_mode("verify-ca", "h")), "VerifyCa");
        assert_eq!(pg_dbg(pg_ssl_mode("verify-full", "h")), "VerifyFull");
        assert_eq!(pg_dbg(pg_ssl_mode("REQUIRE", "h")), "Require", "大小写不敏感");
        assert_eq!(pg_dbg(pg_ssl_mode("prefer", "h")), "Prefer");
    }

    #[test]
    fn pg_ssl_mode_invalid_falls_back_to_default() {
        // 远程 host 非法值 → 默认 require
        assert_eq!(pg_dbg(pg_ssl_mode("garbage", "db.example.com")), "Require");
        // localhost 非法值 → 默认 disable
        assert_eq!(pg_dbg(pg_ssl_mode("garbage", "localhost")), "Disable");
    }

    #[test]
    fn mysql_ssl_mode_four_levels() {
        assert_eq!(my_dbg(mysql_ssl_mode("disable", "h")), "Disabled");
        assert_eq!(my_dbg(mysql_ssl_mode("require", "h")), "Required");
        assert_eq!(my_dbg(mysql_ssl_mode("verify-ca", "h")), "VerifyCa");
        assert_eq!(
            my_dbg(mysql_ssl_mode("verify-full", "h")),
            "VerifyIdentity",
            "verify-full → VerifyIdentity"
        );
    }

    #[test]
    fn mysql_ssl_mode_invalid_falls_back() {
        assert_eq!(my_dbg(mysql_ssl_mode("nope", "remote.db")), "Required");
        assert_eq!(my_dbg(mysql_ssl_mode("nope", "127.0.0.1")), "Disabled");
    }

    #[test]
    fn default_ssl_mode_policy() {
        assert_eq!(default_ssl_mode("localhost", false), "disable");
        assert_eq!(default_ssl_mode("127.0.0.1", false), "disable");
        assert_eq!(default_ssl_mode("::1", false), "disable");
        assert_eq!(default_ssl_mode("db.prod.internal", false), "require");
        assert_eq!(default_ssl_mode("8.8.8.8", false), "require");
        assert_eq!(default_ssl_mode("anything", true), "disable", "SQLite 恒 disable");
    }

    #[test]
    fn ssl_mode_empty_uses_default() {
        // 空串 → 走默认策略 (远程 require)
        assert_eq!(pg_dbg(pg_ssl_mode("", "db.example.com")), "Require");
        assert_eq!(my_dbg(mysql_ssl_mode("", "127.0.0.1")), "Disabled");
    }

    // ---- bytes_to_hex ----

    #[test]
    fn bytes_hex_roundtrip() {
        assert_eq!(bytes_to_hex(&[0x00, 0xff, 0x10]), "00ff10");
        assert_eq!(bytes_to_hex(&[]), "");
        // 可还原性: 每两位 hex 解析回原字节
        let original: Vec<u8> = (0..=255).collect();
        let hex = bytes_to_hex(&original);
        let back: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        assert_eq!(back, original);
    }
}