/// AIDB Desk 统一错误处理模块
///
/// 封装后端 Rust Engine 所有的强类型错误分支，包含数据库驱动异常、
/// 安全 Vault 加解密失败、Rig AI Agent 工具调用故障及网络/IO 错误。

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 全局应用错误枚举
#[derive(Debug, Error)]
pub enum AppError {
    /// 数据库操作失败（SQL 语法错误、超时、连接断开）
    #[error("Database error: {0}")]
    Database(String),

    /// 多用户鉴权与秘钥 Vault 解密异常
    #[allow(dead_code)]
    #[error("Authentication/Vault error: {0}")]
    Auth(String),


    /// Rig AI Agent 执行或 Tool Calling 失败
    #[error("AI Agent error: {0}")]
    Ai(String),

    /// 语法解析或 AST 检查安全警告拦截
    #[error("SQL Safety Check Blocked: {0}")]
    SafetyBlocked(String),

    /// Critical 级高危 SQL 需用户二次确认 (WP1: 结构化风险信息随 DTO 下发前端)
    #[error("{message}")]
    SafetyCritical {
        message: String,
        risk_level: String,
        requires_confirmation: bool,
        reasons: Vec<String>,
    },

    /// IO、文件或配置解析错误
    #[error("IO/System error: {0}")]
    Io(String),

    /// 找不到指定的连接标识符
    #[error("Connection not found: {0}")]
    ConnectionNotFound(String),

    /// 内部通用错误或加解密异常
    #[error("Internal error: {0}")]
    Internal(String),
}

/// 导出给 Tauri IPC 前端的序列化错误 DTO
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppErrorDto {
    pub code: String,
    pub message: String,
    /// WP1: Critical 级风险信息 (仅 SAFETY_BLOCKED 且需确认时下发)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_confirmation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasons: Option<Vec<String>>,
}

impl AppError {
    /// 将内部 AppError 转为前端友好的 AppErrorDto，防盖敏感路径或机密
    pub fn to_dto(&self) -> AppErrorDto {
        match self {
            AppError::Database(msg) => AppErrorDto {
                code: "DATABASE_ERROR".into(),
                message: msg.clone(),
                risk_level: None,
                requires_confirmation: None,
                reasons: None,
            },
            AppError::Auth(msg) => AppErrorDto {
                code: "AUTH_ERROR".into(),
                message: msg.clone(),
                risk_level: None,
                requires_confirmation: None,
                reasons: None,
            },
            AppError::Ai(msg) => AppErrorDto {
                code: "AI_ERROR".into(),
                message: msg.clone(),
                risk_level: None,
                requires_confirmation: None,
                reasons: None,
            },
            AppError::SafetyBlocked(msg) => AppErrorDto {
                code: "SAFETY_BLOCKED".into(),
                message: msg.clone(),
                risk_level: None,
                requires_confirmation: None,
                reasons: None,
            },
            AppError::SafetyCritical {
                message,
                risk_level,
                requires_confirmation,
                reasons,
            } => AppErrorDto {
                code: "SAFETY_BLOCKED".into(),
                message: message.clone(),
                risk_level: Some(risk_level.clone()),
                requires_confirmation: Some(*requires_confirmation),
                reasons: Some(reasons.clone()),
            },
            AppError::Io(msg) => AppErrorDto {
                code: "IO_ERROR".into(),
                message: msg.clone(),
                risk_level: None,
                requires_confirmation: None,
                reasons: None,
            },
            AppError::ConnectionNotFound(msg) => AppErrorDto {
                code: "CONN_NOT_FOUND".into(),
                message: msg.clone(),
                risk_level: None,
                requires_confirmation: None,
                reasons: None,
            },
            AppError::Internal(msg) => AppErrorDto {
                code: "INTERNAL_ERROR".into(),
                message: msg.clone(),
                risk_level: None,
                requires_confirmation: None,
                reasons: None,
            },
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        AppError::Database(err.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Io(err.to_string())
    }
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.to_dto().serialize(serializer)
    }
}
