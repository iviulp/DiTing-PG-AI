//! WP6-S3: VaultService 加密存储层
//! - ~/.aidb/connections.enc: 全量连接配置 (含密码), KEK→HKDF(connections)→AES-256-GCM
//! - ~/.aidb/ai_config.enc: AI 配置 (含 api_key), KEK→HKDF(aiconfig)→AES-256-GCM
//! - 文件格式: {"format":"AIDB_ENC_V1","salt":b64,"nonce":b64,"ciphertext":b64}
//! - 原子写 (临时文件 + rename + fsync + 0600)
//! - API: list(脱敏) / upsert / delete / get_secret / ai_config get(脱敏)/set(占位保留)
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::models::ConnectionConfig;
use crate::services::vault::crypto::{
    aes_gcm_decrypt, aes_gcm_encrypt, b64_decode, b64_encode, hkdf_subkey, random_salt,
    INFO_AICONFIG, INFO_CONNECTIONS, KEY_LEN,
};
use crate::services::vault::kek::atomic_write_secret;
#[cfg(not(test))]
use crate::services::vault::kek::resolve_kek;

pub const ENC_FORMAT_V1: &str = "AIDB_ENC_V1";

#[derive(Debug, Serialize, Deserialize)]
pub struct EncFile {
    pub format: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug)]
pub enum VaultError {
    Kek(String),
    Io(String),
    Crypto(String),
    Format(String),
    NotFound(String),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::Kek(e) => write!(f, "密钥管理失败: {e}"),
            VaultError::Io(e) => write!(f, "存储读写失败: {e}"),
            VaultError::Crypto(e) => write!(f, "{e}"),
            VaultError::Format(e) => write!(f, "文件格式非法: {e}"),
            VaultError::NotFound(e) => write!(f, "{e}"),
        }
    }
}

/// 脱敏连接视图 (list 返回, 绝不含明文密码)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionView {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub group_name: Option<String>,
    pub color_label: Option<String>,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub schema: Option<String>,
    pub env_tag: Option<String>,
    pub ssl_mode: Option<String>,
    pub read_only: bool,
    pub password_set: bool,
    pub ssh_tunnel: Option<crate::models::SshTunnelConfig>,
}

impl ConnectionView {
    pub fn from_config(c: &ConnectionConfig) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            db_type: format!("{:?}", c.db_type).to_lowercase(),
            group_name: c.group_name.clone(),
            color_label: c.color_label.clone(),
            host: c.host.clone(),
            port: c.port,
            user: c.user.clone(),
            database: c.database.clone(),
            schema: c.schema.clone(),
            env_tag: c.env_tag.clone(),
            ssl_mode: c.ssl_mode.clone(),
            read_only: c.read_only,
            password_set: c.password.as_ref().map(|p| !p.is_empty()).unwrap_or(false),
            // SSH 隧道视图: 脱敏敏感字段 (ssh_password/passphrase/otp_secret)
            ssh_tunnel: c.ssh_tunnel.as_ref().map(|t| {
                let mut v = t.clone();
                if v.ssh_password.is_some() {
                    v.ssh_password = Some("***".into());
                }
                if v.passphrase.is_some() {
                    v.passphrase = Some("***".into());
                }
                if v.otp_secret.is_some() {
                    v.otp_secret = Some("****".into());
                }
                v
            }),
        }
    }
}

/// AI 配置脱敏视图 (与 WP2 AiConfigView 类似, key 仅后 4 位)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfigVaultView {
    pub provider_name: String,
    pub base_url: String,
    pub model_name: String,
    pub temperature: f32,
    pub api_key_set: bool,
    pub key_tail4: String,
}

/// AI 配置存储结构 (含明文 api_key, 仅后端内部/加密落盘使用)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StoredAiConfig {
    pub provider_name: String,
    pub base_url: String,
    pub api_key: String,
    pub model_name: String,
    pub temperature: f32,
}

pub struct VaultService {
    dir: PathBuf,
    /// KEK 缓存 (进程内一次解析; Mutex 便于内部可变)
    kek: Mutex<Option<([u8; KEY_LEN], &'static str)>>,
}

impl VaultService {
    pub fn new() -> Self {
        let dir = crate::services::vault::kek::aidb_dir().unwrap_or_else(|_| PathBuf::from(".aidb"));
        Self { dir, kek: Mutex::new(None) }
    }

    /// 测试构造器: 指定目录 (KEK 走 FileKek 于该目录, 不触碰 keychain/真实 ~/.aidb)
    #[cfg(test)]
    pub fn with_dir(dir: PathBuf) -> Self {
        Self { dir, kek: Mutex::new(None) }
    }

    fn kek(&self) -> Result<[u8; KEY_LEN], VaultError> {
        let mut guard = self.kek.lock().map_err(|e| VaultError::Kek(e.to_string()))?;
        if let Some((k, _)) = *guard {
            return Ok(k);
        }
        // 测试目录: 用 FileKek 指向测试目录
        #[cfg(test)]
        {
            use crate::services::vault::kek::{FileKek, KekProvider};
            let fk = FileKek::with_dir(self.dir.clone());
            let k = fk.get_or_create().map_err(VaultError::Kek)?;
            *guard = Some((k, fk.name()));
            Ok(k)
        }
        #[cfg(not(test))]
        {
            let (k, provider) = resolve_kek().map_err(VaultError::Kek)?;
            tracing::info!(target: "VAULT", provider, "KEK resolved");
            *guard = Some((k, provider));
            Ok(k)
        }
    }

    fn connections_path(&self) -> PathBuf {
        self.dir.join("connections.enc")
    }
    fn ai_config_path(&self) -> PathBuf {
        self.dir.join("ai_config.enc")
    }

    // ---- 底层读写 ----

    fn read_json<T: for<'de> Deserialize<'de>>(&self, path: &Path, info: &[u8]) -> Result<Option<T>, VaultError> {
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(path).map_err(|e| VaultError::Io(e.to_string()))?;
        let enc: EncFile =
            serde_json::from_str(&raw).map_err(|e| VaultError::Format(format!("enc 文件解析失败: {e}")))?;
        if enc.format != ENC_FORMAT_V1 {
            return Err(VaultError::Format(format!("未知 format: {}", enc.format)));
        }
        let kek = self.kek()?;
        let dek = hkdf_subkey(&kek, info).map_err(|e| VaultError::Crypto(e.to_string()))?;
        let salt = b64_decode(&enc.salt).map_err(|e| VaultError::Crypto(e.to_string()))?;
        let nonce = b64_decode(&enc.nonce).map_err(|e| VaultError::Crypto(e.to_string()))?;
        let ct = b64_decode(&enc.ciphertext).map_err(|e| VaultError::Crypto(e.to_string()))?;
        if salt.is_empty() {
            return Err(VaultError::Format("salt 为空".into()));
        }
        let pt = aes_gcm_decrypt(&dek, &nonce, &ct).map_err(|e| VaultError::Crypto(e.to_string()))?;
        let val: T =
            serde_json::from_slice(&pt).map_err(|e| VaultError::Format(format!("payload 解析失败: {e}")))?;
        Ok(Some(val))
    }

    fn write_json<T: Serialize>(&self, path: &Path, info: &[u8], val: &T) -> Result<(), VaultError> {
        let kek = self.kek()?;
        let dek = hkdf_subkey(&kek, info).map_err(|e| VaultError::Crypto(e.to_string()))?;
        let salt = random_salt(); // 每次写入新 salt (文件自描述, 便于未来重派生)
        let pt = serde_json::to_vec(val).map_err(|e| VaultError::Io(e.to_string()))?;
        let (nonce, ct) = aes_gcm_encrypt(&dek, &pt).map_err(|e| VaultError::Crypto(e.to_string()))?;
        let enc = EncFile {
            format: ENC_FORMAT_V1.to_string(),
            salt: b64_encode(&salt),
            nonce: b64_encode(&nonce),
            ciphertext: b64_encode(&ct),
        };
        let raw = serde_json::to_string_pretty(&enc).map_err(|e| VaultError::Io(e.to_string()))?;
        std::fs::create_dir_all(&self.dir).map_err(|e| VaultError::Io(e.to_string()))?;
        atomic_write_secret(path, raw.as_bytes()).map_err(VaultError::Io)
    }

    // ---- 连接 API ----

    pub fn list_connections(&self) -> Result<Vec<ConnectionView>, VaultError> {
        let all: Vec<ConnectionConfig> = self
            .read_json(&self.connections_path(), INFO_CONNECTIONS)?
            .unwrap_or_default();
        Ok(all.iter().map(ConnectionView::from_config).collect())
    }

    pub fn load_all_connections(&self) -> Result<Vec<ConnectionConfig>, VaultError> {
        Ok(self
            .read_json(&self.connections_path(), INFO_CONNECTIONS)?
            .unwrap_or_default())
    }

    pub fn upsert_connection(&self, config: ConnectionConfig) -> Result<(), VaultError> {
        let mut all = self.load_all_connections()?;
        if let Some(slot) = all.iter_mut().find(|c| c.id == config.id) {
            // 编辑留空密码 → 保留原密码 (占位保留语义)
            if config.password.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
                let keep = slot.password.take();
                *slot = config;
                if slot.password.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
                    slot.password = keep;
                }
            } else {
                *slot = config;
            }
        } else {
            all.push(config);
        }
        self.write_json(&self.connections_path(), INFO_CONNECTIONS, &all)
    }

    pub fn delete_connection(&self, id: &str) -> Result<(), VaultError> {
        let mut all = self.load_all_connections()?;
        let before = all.len();
        all.retain(|c| c.id != id);
        if all.len() == before {
            return Err(VaultError::NotFound(format!("连接不存在: {id}")));
        }
        self.write_json(&self.connections_path(), INFO_CONNECTIONS, &all)
    }

    /// 取完整配置 (含明文密码; 调用方负责 zeroize/不外传)
    pub fn get_connection_secret(&self, id: &str) -> Result<ConnectionConfig, VaultError> {
        self.load_all_connections()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| VaultError::NotFound(format!("连接不存在: {id}")))
    }

    /// 批量保存 (迁移用): 幂等 — enc 已存在且非空 → already_migrated
    pub fn migrate_connections(&self, configs: Vec<ConnectionConfig>) -> Result<MigrateOutcome, VaultError> {
        let existing = self.load_all_connections()?;
        if !existing.is_empty() {
            return Ok(MigrateOutcome::AlreadyMigrated);
        }
        let mut dirty_skipped = 0usize;
        let clean: Vec<ConnectionConfig> = configs
            .into_iter()
            .filter(|c| {
                if c.id.is_empty() || c.host.is_empty() {
                    dirty_skipped += 1;
                    return false;
                }
                true
            })
            .collect();
        self.write_json(&self.connections_path(), INFO_CONNECTIONS, &clean)?;
        Ok(MigrateOutcome::Migrated { count: clean.len(), dirty_skipped })
    }

    // ---- AI 配置 API ----

    pub fn get_ai_config(&self) -> Result<StoredAiConfig, VaultError> {
        Ok(self
            .read_json(&self.ai_config_path(), INFO_AICONFIG)?
            .unwrap_or_default())
    }

    pub fn get_ai_config_view(&self) -> Result<AiConfigVaultView, VaultError> {
        let c = self.get_ai_config()?;
        let tail4: String = c.api_key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        Ok(AiConfigVaultView {
            provider_name: c.provider_name,
            base_url: c.base_url,
            model_name: c.model_name,
            temperature: c.temperature,
            api_key_set: !c.api_key.is_empty(),
            key_tail4: if c.api_key.is_empty() { String::new() } else { format!("****{tail4}") },
        })
    }

    /// set: api_key == "__KEEP__" 或空 → 保留原值
    pub fn set_ai_config(&self, mut cfg: StoredAiConfig) -> Result<(), VaultError> {
        if cfg.api_key == "__KEEP__" || cfg.api_key.is_empty() {
            let old = self.get_ai_config()?;
            cfg.api_key = old.api_key;
        }
        self.write_json(&self.ai_config_path(), INFO_AICONFIG, &cfg)
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MigrateOutcome {
    AlreadyMigrated,
    Migrated { count: usize, dirty_skipped: usize },
}

// ============ S3 单测 (T9/T10/T12/T13 + 基本读写) ============
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ConnectionConfig, DatabaseType};

    fn test_vault() -> (VaultService, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (VaultService::with_dir(dir.path().to_path_buf()), dir)
    }

    fn conn(id: &str, pw: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: format!("conn-{id}"),
            db_type: DatabaseType::Postgres,
            group_name: None,
            color_label: None,
            host: "127.0.0.1".into(),
            port: 5432,
            user: "u".into(),
            password: pw.map(|s| s.to_string()),
            database: "db".into(),
            schema: None,
            env_tag: None,
            ssl_mode: None,
            read_only: false,
            ssh_tunnel: None,
        }
    }

    #[test]
    fn connections_roundtrip() {
        let (v, _d) = test_vault();
        assert!(v.list_connections().unwrap().is_empty());
        v.upsert_connection(conn("a", Some("secret"))).unwrap();
        let all = v.load_all_connections().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].password.as_deref(), Some("secret"));
        // 文件为密文格式
        let raw = std::fs::read_to_string(v.connections_path()).unwrap();
        assert!(raw.contains(ENC_FORMAT_V1));
        assert!(!raw.contains("secret"), "明文密码不得出现在文件中");
    }

    #[test]
    fn upsert_replaces_and_keeps_password_on_empty() {
        let (v, _d) = test_vault();
        v.upsert_connection(conn("a", Some("pw1"))).unwrap();
        // 编辑: 留空密码 → 保留原密码
        v.upsert_connection(conn("a", Some(""))).unwrap();
        assert_eq!(v.get_connection_secret("a").unwrap().password.as_deref(), Some("pw1"));
        // 编辑: 新密码 → 覆盖
        v.upsert_connection(conn("a", Some("pw2"))).unwrap();
        assert_eq!(v.get_connection_secret("a").unwrap().password.as_deref(), Some("pw2"));
    }

    #[test]
    fn delete_connection_not_found_error() {
        let (v, _d) = test_vault();
        v.upsert_connection(conn("a", None)).unwrap();
        v.delete_connection("a").unwrap();
        assert!(v.delete_connection("a").is_err());
        assert!(v.list_connections().unwrap().is_empty());
    }

    #[test]
    fn t12_list_view_masked() {
        let (v, _d) = test_vault();
        v.upsert_connection(conn("a", Some("supersecret"))).unwrap();
        let views = v.list_connections().unwrap();
        assert_eq!(views.len(), 1);
        assert!(views[0].password_set);
        let json = serde_json::to_string(&views).unwrap();
        assert!(!json.contains("supersecret"), "脱敏视图不得含明文密码");
        // password 字段本身不存在于视图
        assert!(!json.contains("\"password\""));
    }

    #[test]
    fn t9_migrate_idempotent() {
        let (v, _d) = test_vault();
        let out1 = v.migrate_connections(vec![conn("a", Some("p"))]).unwrap();
        assert_eq!(out1, MigrateOutcome::Migrated { count: 1, dirty_skipped: 0 });
        let file1 = std::fs::read(v.connections_path()).unwrap();
        let out2 = v.migrate_connections(vec![conn("b", None)]).unwrap();
        assert_eq!(out2, MigrateOutcome::AlreadyMigrated);
        let file2 = std::fs::read(v.connections_path()).unwrap();
        assert_eq!(file1, file2, "幂等: 二次迁移文件不变");
        assert_eq!(v.load_all_connections().unwrap().len(), 1, "b 不得写入");
    }

    #[test]
    fn t10_migrate_dirty_skipped_counted() {
        let (v, _d) = test_vault();
        let mut dirty = conn("", Some("p")); // id 空 → 脏
        dirty.host = "h".into();
        let mut dirty2 = conn("ok-id", None);
        dirty2.host = "".into(); // host 空 → 脏
        let out = v.migrate_connections(vec![conn("a", None), dirty, dirty2]).unwrap();
        assert_eq!(out, MigrateOutcome::Migrated { count: 1, dirty_skipped: 2 });
    }

    #[test]
    fn ai_config_roundtrip_and_view() {
        let (v, _d) = test_vault();
        v.set_ai_config(StoredAiConfig {
            provider_name: "p".into(),
            base_url: "https://x".into(),
            api_key: "sk-abcdef123456".into(),
            model_name: "m".into(),
            temperature: 0.3,
        })
        .unwrap();
        let view = v.get_ai_config_view().unwrap();
        assert!(view.api_key_set);
        assert_eq!(view.key_tail4, "****3456");
        let raw = std::fs::read_to_string(v.ai_config_path()).unwrap();
        assert!(!raw.contains("sk-abcdef123456"), "api_key 不得明文落盘");
        // 全量读回 (后端内部使用)
        assert_eq!(v.get_ai_config().unwrap().api_key, "sk-abcdef123456");
    }

    #[test]
    fn t13_ai_config_keep_placeholder() {
        let (v, _d) = test_vault();
        v.set_ai_config(StoredAiConfig {
            api_key: "original-key".into(),
            ..Default::default()
        })
        .unwrap();
        // __KEEP__ → 保留
        v.set_ai_config(StoredAiConfig {
            api_key: "__KEEP__".into(),
            model_name: "new-model".into(),
            ..Default::default()
        })
        .unwrap();
        let c = v.get_ai_config().unwrap();
        assert_eq!(c.api_key, "original-key");
        assert_eq!(c.model_name, "new-model");
        // 空 → 保留
        v.set_ai_config(StoredAiConfig {
            api_key: "".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(v.get_ai_config().unwrap().api_key, "original-key");
    }

    #[test]
    fn t7_invalid_format_rejected() {
        let (v, dir) = test_vault();
        std::fs::write(
            dir.path().join("connections.enc"),
            r#"{"format":"BOGUS","salt":"AA==","nonce":"AA==","ciphertext":"AA=="}"#,
        )
        .unwrap();
        let err = v.list_connections().unwrap_err();
        assert!(matches!(err, VaultError::Format(_)));
    }

    #[test]
    fn enc_file_permission_0600() {
        let (v, _d) = test_vault();
        v.upsert_connection(conn("a", None)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(v.connections_path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn cross_kek_isolation_via_hkdf_info() {
        // connections 与 ai_config 使用不同 HKDF info → 互相不可解
        let (v, dir) = test_vault();
        v.upsert_connection(conn("a", Some("p"))).unwrap();
        // 把 connections.enc 复制为 ai_config.enc → 解析必须失败 (密文相同但 dek 不同, GCM 认证失败)
        std::fs::copy(dir.path().join("connections.enc"), dir.path().join("ai_config.enc")).unwrap();
        let r = v.get_ai_config();
        assert!(r.is_err(), "跨用途密文必须解密失败");
    }
}
