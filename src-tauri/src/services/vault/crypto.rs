/// WP6-S1: 加密原语层 (纯函数, 无 IO)
/// - derive_key_argon2id: 主密码 → KEK/DEK (19MiB / t2 / p1, 输出 32B)
/// - hkdf_subkey: 从 KEK 按用途 info 派生子密钥 (用途隔离)
/// - aes_gcm_encrypt/decrypt: 每次随机 12B nonce, AES-256-GCM
/// - base64 工具
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use zeroize::Zeroize;

pub const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;
pub const SALT_LEN: usize = 16;

/// 用途隔离 info 常量 (HKDF domain separation)
pub const INFO_CONNECTIONS: &[u8] = b"diting/connections/v1";
pub const INFO_AICONFIG: &[u8] = b"diting/aiconfig/v1";
pub const INFO_BUNDLE: &[u8] = b"diting/bundle/v1";

#[derive(Debug)]
pub enum CryptoError {
    Kdf(String),
    Encrypt(String),
    Decrypt(String),
    Decode(String),
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::Kdf(e) => write!(f, "密钥派生失败: {e}"),
            CryptoError::Encrypt(e) => write!(f, "加密失败: {e}"),
            CryptoError::Decrypt(e) => write!(f, "解密失败: {e}"),
            CryptoError::Decode(e) => write!(f, "编码解析失败: {e}"),
        }
    }
}

/// Argon2id 派生 256 位密钥 (19MiB/t2/p1, 与 WP2 secret_store 一致)
pub fn derive_key_argon2id(password: &[u8], salt: &[u8]) -> Result<[u8; KEY_LEN], CryptoError> {
    let mut out = [0u8; KEY_LEN];
    let params = argon2::Params::new(19456, 2, 1, Some(KEY_LEN))
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    let argon2 = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    argon2
        .hash_password_into(password, salt, &mut out)
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    Ok(out)
}

/// HKDF-SHA256 子密钥派生 (用途隔离)
pub fn hkdf_subkey(kek: &[u8; KEY_LEN], info: &[u8]) -> Result<[u8; KEY_LEN], CryptoError> {
    use hkdf::Hkdf;
    use sha2::Sha256;
    // 主密钥无需 salt (KEK 已是高熵随机), 用空 salt
    let hk = Hkdf::<Sha256>::new(None, kek);
    let mut okm = [0u8; KEY_LEN];
    hk.expand(info, &mut okm)
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    Ok(okm)
}

/// AES-256-GCM 加密; 返回 (nonce, ciphertext); 每次新随机 nonce
pub fn aes_gcm_encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), CryptoError> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| CryptoError::Encrypt(e.to_string()))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| CryptoError::Encrypt(e.to_string()))?;
    Ok((nonce_bytes.to_vec(), ct))
}

/// AES-256-GCM 解密; 认证失败 → Decrypt 错误 (不 panic)
pub fn aes_gcm_decrypt(key: &[u8; KEY_LEN], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if nonce.len() != NONCE_LEN {
        return Err(CryptoError::Decrypt(format!("nonce 长度非法: {}", nonce.len())));
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| CryptoError::Decrypt(e.to_string()))?;
    let n = Nonce::from_slice(nonce);
    cipher
        .decrypt(n, ciphertext)
        .map_err(|e| CryptoError::Decrypt(e.to_string()))
}

pub fn b64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, CryptoError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| CryptoError::Decode(e.to_string()))
}

/// 生成随机 salt
pub fn random_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

/// 清零密钥材料
pub fn zeroize_key(k: &mut [u8; KEY_LEN]) {
    k.zeroize();
}

// ============ S1 单测 (T1/T2/T3) ============
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t1_roundtrip_small_and_large() {
        let mut kek = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut kek);
        let dek = hkdf_subkey(&kek, INFO_CONNECTIONS).unwrap();

        // 小 payload
        let msg = b"hello diting";
        let (n, ct) = aes_gcm_encrypt(&dek, msg).unwrap();
        let pt = aes_gcm_decrypt(&dek, &n, &ct).unwrap();
        assert_eq!(pt, msg);

        // 1MB payload
        let big = vec![0xABu8; 1024 * 1024];
        let (n2, ct2) = aes_gcm_encrypt(&dek, &big).unwrap();
        let pt2 = aes_gcm_decrypt(&dek, &n2, &ct2).unwrap();
        assert_eq!(pt2, big);
    }

    #[test]
    fn t2_nonce_uniqueness_same_plaintext() {
        let mut kek = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut kek);
        let dek = hkdf_subkey(&kek, INFO_AICONFIG).unwrap();
        let msg = b"same plaintext";
        let (n1, ct1) = aes_gcm_encrypt(&dek, msg).unwrap();
        let (n2, ct2) = aes_gcm_encrypt(&dek, msg).unwrap();
        assert_ne!(n1, n2, "nonce 必须每次不同");
        assert_ne!(ct1, ct2, "密文必须不同");
    }

    #[test]
    fn t3_hkdf_domain_separation() {
        let mut kek = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut kek);
        let k1 = hkdf_subkey(&kek, INFO_CONNECTIONS).unwrap();
        let k2 = hkdf_subkey(&kek, INFO_AICONFIG).unwrap();
        let k3 = hkdf_subkey(&kek, INFO_BUNDLE).unwrap();
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
        assert_ne!(k2, k3);
        // 同 info 确定性
        let k1b = hkdf_subkey(&kek, INFO_CONNECTIONS).unwrap();
        assert_eq!(k1, k1b);
    }

    #[test]
    fn argon2id_deterministic_per_salt() {
        let salt = random_salt();
        let k1 = derive_key_argon2id(b"pw", &salt).unwrap();
        let k2 = derive_key_argon2id(b"pw", &salt).unwrap();
        assert_eq!(k1, k2, "同密码同 salt 确定");
        let k3 = derive_key_argon2id(b"pw2", &salt).unwrap();
        assert_ne!(k1, k3, "不同密码不同密钥");
    }

    #[test]
    fn decrypt_wrong_key_fails_no_panic() {
        let mut k1 = [0u8; KEY_LEN];
        let mut k2 = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut k1);
        rand::thread_rng().fill_bytes(&mut k2);
        let (n, ct) = aes_gcm_encrypt(&k1, b"secret").unwrap();
        let r = aes_gcm_decrypt(&k2, &n, &ct);
        assert!(r.is_err(), "错误密钥必须解密失败");
    }

    #[test]
    fn ciphertext_tamper_rejected() {
        let mut k = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut k);
        let (n, mut ct) = aes_gcm_encrypt(&k, b"important").unwrap();
        ct[0] ^= 0xFF; // 篡改 1 字节
        assert!(aes_gcm_decrypt(&k, &n, &ct).is_err(), "篡改必须被 GCM 认证拒绝");
    }

    #[test]
    fn base64_roundtrip() {
        let data: Vec<u8> = (0..=255).collect();
        let enc = b64_encode(&data);
        let dec = b64_decode(&enc).unwrap();
        assert_eq!(dec, data);
    }

    #[test]
    fn invalid_nonce_len_rejected() {
        let mut k = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut k);
        assert!(aes_gcm_decrypt(&k, &[0u8; 5], b"x").is_err());
    }
}
