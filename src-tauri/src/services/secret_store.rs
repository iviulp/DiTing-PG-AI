//! WP2: 本地秘密加密存储 (方案 B+)
//! Argon2id(固定密码 + 每文件随机 salt) 派生 256 位密钥 + AES-256-GCM 加密
//! 威胁模型: 防配置文件被拷走/误备份/被其他进程读取; 不防本机 root 与内存 dump。
//! format_version 字段为后续升级 keyring (WP 计划备选) 预留迁移位。

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;

/// 固定 vault 密码 (与 .ditingvault 一致的方案 B+; WP6 计划升级为用户主密码)
const VAULT_PASSWORD: &[u8; 23] = b"diting-aidb-local-vault";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedBlob {
    pub format_version: u32,
    /// base64(salt 16B)
    pub salt: String,
    /// base64(nonce 12B)
    pub nonce: String,
    /// base64(ciphertext)
    pub ciphertext: String,
}

#[derive(Debug)]
pub enum SecretError {
    Crypto(String),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretError::Crypto(m) => write!(f, "Secret crypto error: {}", m),
        }
    }
}

fn derive_key(salt: &[u8]) -> Result<[u8; 32], SecretError> {
    let params = argon2::Params::new(19456, 2, 1, Some(32))
        .map_err(|e| SecretError::Crypto(e.to_string()))?;
    let argon2 = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(VAULT_PASSWORD, salt, &mut key)
        .map_err(|e| SecretError::Crypto(e.to_string()))?;
    Ok(key)
}

/// 加密任意秘密字符串 → 自描述 blob (salt/nonce 随机, 同明文两次加密结果必不同)
pub fn encrypt_secret(plaintext: &str) -> Result<EncryptedBlob, SecretError> {
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let key = derive_key(&salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| SecretError::Crypto(e.to_string()))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| SecretError::Crypto(e.to_string()))?;

    Ok(EncryptedBlob {
        format_version: 1,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce_bytes),
        ciphertext: B64.encode(ciphertext),
    })
}

/// 解密 blob → 原始秘密字符串; 篡改/密码不匹配返回 Err
pub fn decrypt_secret(blob: &EncryptedBlob) -> Result<String, SecretError> {
    let salt = B64
        .decode(&blob.salt)
        .map_err(|e| SecretError::Crypto(format!("bad salt: {}", e)))?;
    let nonce_bytes = B64
        .decode(&blob.nonce)
        .map_err(|e| SecretError::Crypto(format!("bad nonce: {}", e)))?;
    let ciphertext = B64
        .decode(&blob.ciphertext)
        .map_err(|e| SecretError::Crypto(format!("bad ciphertext: {}", e)))?;

    let key = derive_key(&salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| SecretError::Crypto(e.to_string()))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| SecretError::Crypto("decryption failed: tampered or wrong key".into()))?;

    String::from_utf8(plaintext).map_err(|e| SecretError::Crypto(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_ascii() {
        let blob = encrypt_secret("sk-test-1234567890").unwrap();
        assert_eq!(decrypt_secret(&blob).unwrap(), "sk-test-1234567890");
    }

    #[test]
    fn roundtrip_empty_string() {
        let blob = encrypt_secret("").unwrap();
        assert_eq!(decrypt_secret(&blob).unwrap(), "");
    }

    #[test]
    fn roundtrip_cjk_and_emoji() {
        let secret = "密钥-テスト-🔐-abc";
        let blob = encrypt_secret(secret).unwrap();
        assert_eq!(decrypt_secret(&blob).unwrap(), secret);
    }

    #[test]
    fn roundtrip_long_key() {
        let secret = "x".repeat(4096);
        let blob = encrypt_secret(&secret).unwrap();
        assert_eq!(decrypt_secret(&blob).unwrap(), secret);
    }

    #[test]
    fn tampered_ciphertext_rejected() {
        let mut blob = encrypt_secret("sk-secret").unwrap();
        // 篡改密文一个字节
        let mut ct = B64.decode(&blob.ciphertext).unwrap();
        ct[0] ^= 0xFF;
        blob.ciphertext = B64.encode(&ct);
        assert!(decrypt_secret(&blob).is_err());
    }

    #[test]
    fn same_plaintext_different_ciphertext() {
        let a = encrypt_secret("sk-same").unwrap();
        let b = encrypt_secret("sk-same").unwrap();
        assert_ne!(a.ciphertext, b.ciphertext); // 随机 salt/nonce
        assert_ne!(a.salt, b.salt);
    }

    #[test]
    fn blob_json_serializable() {
        let blob = encrypt_secret("sk-json").unwrap();
        let json = serde_json::to_string(&blob).unwrap();
        let parsed: EncryptedBlob = serde_json::from_str(&json).unwrap();
        assert_eq!(decrypt_secret(&parsed).unwrap(), "sk-json");
        assert_eq!(parsed.format_version, 1);
    }
}
