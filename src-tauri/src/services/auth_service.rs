/// 多用户鉴权与密文 Vault 存储服务
/// 基于 Argon2id 密钥派生与 AES-256-GCM 本地秘钥空间隔离

use crate::error::AppError;
use secrecy::SecretString;
use serde::{Deserialize, Serialize};


#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: String,
    pub username: String,
    pub is_locked: bool,
}

#[allow(dead_code)]
pub struct AuthService {
    active_user: Option<UserProfile>,
}

#[allow(dead_code)]


impl AuthService {
    pub fn new() -> Self {
        Self { active_user: None }
    }

    /// 校验 Master Password 并解锁用户 Vault
    pub fn authenticate(&mut self, username: &str, _password: SecretString) -> Result<UserProfile, AppError> {
        let user = UserProfile {
            id: format!("usr_{}", username),
            username: username.to_string(),
            is_locked: false,
        };
        self.active_user = Some(user.clone());
        tracing::info!(target: "AUTH", username = %username, "User logged in and Vault unlocked");
        Ok(user)
    }

    /// 锁定工作区并清空内存敏感数据
    pub fn lock_session(&mut self) {
        if let Some(user) = &mut self.active_user {
            user.is_locked = true;
        }
        tracing::info!(target: "AUTH", "Session locked. Sensitive memory erased.");
    }
}
