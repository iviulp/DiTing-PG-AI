/// WP6-S4: .ditingvault 备份 bundle 加解密核心 (纯函数, 可测)
/// - v2: 用户主密码 → Argon2id → HKDF(bundle) → AES-256-GCM, base64 编码
/// - legacy v1: 旧内置固定密钥 (urlencoding 编码) — 仅迁移期兼容, 带移除标记
/// commands 层只负责限速/文件 IO, 加解密与格式判定全在此, 便于 T4-T8 单测
use crate::services::vault::crypto::{
    aes_gcm_decrypt, aes_gcm_encrypt, b64_decode, b64_encode, derive_key_argon2id, hkdf_subkey,
    random_salt, zeroize_key, INFO_BUNDLE,
};

#[derive(Debug, PartialEq, Eq)]
pub enum BundleError {
    /// 文件格式非法/字段缺失
    Format(String),
    /// 需要主密码但未提供
    NeedPassword,
    /// 主密码太短
    WeakPassword,
    /// 解密失败 (密码错误或篡改) — 统一模糊文案
    DecryptFailed,
    /// 内部加密错误
    Crypto(String),
}

impl std::fmt::Display for BundleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BundleError::Format(e) => write!(f, "无效的备份文件格式: {e}"),
            BundleError::NeedPassword => write!(f, "此备份为 v2 格式，需要输入导出时设置的主密码。"),
            BundleError::WeakPassword => write!(
                f,
                "主密码至少 8 位 (导出备份必须设置用户主密码, 不再使用内置固定密钥)"
            ),
            BundleError::DecryptFailed => write!(f, "解密校验失败！主密码不匹配或备份数据已被非法篡改。"),
            BundleError::Crypto(e) => write!(f, "{e}"),
        }
    }
}

pub const BUNDLE_FORMAT: &str = "DITING_ENCRYPTED_VAULT";
pub const MIN_MASTER_PASSWORD_LEN: usize = 8;

/// 加密 payload 为 v2 bundle JSON 字符串 (用户主密码)
pub fn encrypt_bundle_v2(payload: &serde_json::Value, master_password: &str) -> Result<String, BundleError> {
    if master_password.len() < MIN_MASTER_PASSWORD_LEN {
        return Err(BundleError::WeakPassword);
    }
    let plaintext =
        serde_json::to_vec(payload).map_err(|e| BundleError::Crypto(format!("序列化失败: {e}")))?;

    let salt = random_salt();
    let mut kek = derive_key_argon2id(master_password.as_bytes(), &salt)
        .map_err(|e| BundleError::Crypto(e.to_string()))?;
    let dek = hkdf_subkey(&kek, INFO_BUNDLE).map_err(|e| BundleError::Crypto(e.to_string()))?;
    zeroize_key(&mut kek);

    let (nonce, ct) = aes_gcm_encrypt(&dek, &plaintext)
        .map_err(|e| BundleError::Crypto(e.to_string()))?;

    let bundle = serde_json::json!({
        "format": BUNDLE_FORMAT,
        "version": 2,
        "crypto": "AES-256-GCM + Argon2id(19MiB,t2,p1) + HKDF-SHA256",
        "kdf": { "algo": "argon2id", "m_kib": 19456, "t": 2, "p": 1 },
        "salt": b64_encode(&salt),
        "nonce": b64_encode(&nonce),
        "ciphertext": b64_encode(&ct)
    });
    serde_json::to_string_pretty(&bundle).map_err(|e| BundleError::Crypto(e.to_string()))
}

/// 解密 bundle: 返回 (payload, is_legacy)
/// - version>=2: 用 master_password 解密
/// - version==1 (或缺省): legacy 分支用旧固定密钥解密, is_legacy=true
pub fn decrypt_bundle(file_content: &str, master_password: Option<&str>) -> Result<(serde_json::Value, bool), BundleError> {
    let vault: serde_json::Value =
        serde_json::from_str(file_content).map_err(|_| BundleError::Format("非合法 JSON".into()))?;

    if vault.get("format").and_then(|v| v.as_str()) != Some(BUNDLE_FORMAT) {
        return Err(BundleError::Format("无法识别的安全签名".into()));
    }

    let version = vault.get("version").and_then(|v| v.as_i64()).unwrap_or(1);

    let get_field = |k: &str| -> Result<String, BundleError> {
        vault
            .get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| BundleError::Format(format!("Missing {k}")))
    };

    if version >= 2 {
        let password = master_password
            .filter(|p| !p.is_empty())
            .ok_or(BundleError::NeedPassword)?;
        let salt = b64_decode(&get_field("salt")?).map_err(|e| BundleError::Crypto(e.to_string()))?;
        let nonce = b64_decode(&get_field("nonce")?).map_err(|e| BundleError::Crypto(e.to_string()))?;
        let ct = b64_decode(&get_field("ciphertext")?).map_err(|e| BundleError::Crypto(e.to_string()))?;

        let mut kek = derive_key_argon2id(password.as_bytes(), &salt)
            .map_err(|e| BundleError::Crypto(e.to_string()))?;
        let dek = hkdf_subkey(&kek, INFO_BUNDLE).map_err(|e| BundleError::Crypto(e.to_string()))?;
        zeroize_key(&mut kek);

        let pt = aes_gcm_decrypt(&dek, &nonce, &ct).map_err(|_| BundleError::DecryptFailed)?;
        let mut json: serde_json::Value = serde_json::from_slice(&pt)
            .map_err(|e| BundleError::Crypto(format!("payload 解析失败: {e}")))?;
        if let Some(obj) = json.as_object_mut() {
            obj.insert("legacy_import".into(), serde_json::Value::Bool(false));
        }
        Ok((json, false))
    } else {
        decrypt_legacy_v1(&vault, &get_field).map(|j| (j, true))
    }
}

/// LEGACY v1 解密分支
/// ⚠️ SECURITY-LEGACY-REMOVAL-MARKER: 仅为存量 v1 备份迁移保留;
/// 固定密钥已视为公开泄露, 导入成功后前端应引导立即以 v2 主密码重新导出。
/// 计划移除: WP7 后首个 breaking release。
fn decrypt_legacy_v1(
    vault: &serde_json::Value,
    get_field: &dyn Fn(&str) -> Result<String, BundleError>,
) -> Result<serde_json::Value, BundleError> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    let _ = vault;
    let salt_str = get_field("salt")?;
    let nonce_str = get_field("nonce")?;
    let ct_str = get_field("ciphertext")?;
    let salt = urlencoding::decode_binary(salt_str.as_bytes());
    let nonce_bytes = urlencoding::decode_binary(nonce_str.as_bytes());
    let ciphertext = urlencoding::decode_binary(ct_str.as_bytes());

    // LEGACY-FIXED-KEY [REDACTED] — 仅 v1 解密; 勿在新格式使用
    let password = b"yuguosheng";
    let mut derived_key = [0u8; 32];
    let params = argon2::Params::new(19456, 2, 1, Some(32)).unwrap();
    let argon2_instance =
        argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    argon2_instance
        .hash_password_into(password, &salt, &mut derived_key)
        .map_err(|e| BundleError::Crypto(format!("Argon2 派生失败: {e}")))?;
    let cipher = Aes256Gcm::new_from_slice(&derived_key)
        .map_err(|e| BundleError::Crypto(format!("AES 初始化失败: {e}")))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let pt = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| BundleError::DecryptFailed)?;
    derived_key.iter_mut().for_each(|b| *b = 0);
    let mut json: serde_json::Value = serde_json::from_slice(&pt)
        .map_err(|e| BundleError::Crypto(format!("payload 解析失败: {e}")))?;
    if let Some(obj) = json.as_object_mut() {
        obj.insert("legacy_import".into(), serde_json::Value::Bool(true));
    }
    Ok(json)
}

/// 构造 legacy v1 bundle (仅测试用: 复刻旧格式以验证迁移分支)
#[cfg(test)]
pub fn make_legacy_v1_bundle(payload: &serde_json::Value) -> String {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use rand::RngCore;
    let plaintext = serde_json::to_vec(payload).unwrap();
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let password = b"yuguosheng";
    let mut derived_key = [0u8; 32];
    let params = argon2::Params::new(19456, 2, 1, Some(32)).unwrap();
    let argon2 = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    argon2
        .hash_password_into(password, &salt, &mut derived_key)
        .unwrap();
    let cipher = Aes256Gcm::new_from_slice(&derived_key).unwrap();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher.encrypt(nonce, plaintext.as_ref()).unwrap();
    serde_json::to_string_pretty(&serde_json::json!({
        "format": BUNDLE_FORMAT,
        "version": "1.0",
        "crypto": "AES-256-GCM + Argon2id",
        "salt": urlencoding::encode_binary(&salt).into_owned(),
        "nonce": urlencoding::encode_binary(&nonce_bytes).into_owned(),
        "ciphertext": urlencoding::encode_binary(&ct).into_owned()
    }))
    .unwrap()
}

// ============ S4 单测 (T4-T8, T14 核心) ============
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_payload() -> serde_json::Value {
        json!({
            "version": "2.0",
            "connections": [{"id":"a","password":"topsecret"}],
            "ai_config": {"api_key":"***"}
        })
    }

    #[test]
    fn t_v2_roundtrip() {
        let payload = sample_payload();
        let bundle = encrypt_bundle_v2(&payload, "correct-horse").unwrap();
        let (dec, is_legacy) = decrypt_bundle(&bundle, Some("correct-horse")).unwrap();
        assert!(!is_legacy);
        assert_eq!(dec.get("legacy_import"), Some(&json!(false)));
        assert_eq!(
            dec.get("connections").and_then(|c| c.get(0)).and_then(|x| x.get("password")),
            Some(&json!("topsecret"))
        );
    }

    #[test]
    fn t4_wrong_password_rejected_no_panic() {
        let bundle = encrypt_bundle_v2(&sample_payload(), "correct-horse").unwrap();
        let err = decrypt_bundle(&bundle, Some("wrong-password")).unwrap_err();
        assert_eq!(err, BundleError::DecryptFailed, "错误密码必须统一模糊错误");
    }

    #[test]
    fn t4_v2_missing_password_needs_password() {
        let bundle = encrypt_bundle_v2(&sample_payload(), "correct-horse").unwrap();
        assert_eq!(decrypt_bundle(&bundle, None).unwrap_err(), BundleError::NeedPassword);
        assert_eq!(decrypt_bundle(&bundle, Some("")).unwrap_err(), BundleError::NeedPassword);
    }

    #[test]
    fn weak_password_rejected_on_export() {
        assert_eq!(
            encrypt_bundle_v2(&sample_payload(), "short").unwrap_err(),
            BundleError::WeakPassword
        );
        // 边界: 恰好 8 位允许
        assert!(encrypt_bundle_v2(&sample_payload(), "12345678").is_ok());
    }

    #[test]
    fn t5_legacy_v1_detected_and_decrypted() {
        let payload = json!({"version":"1.0","connections":[{"id":"old"}]});
        let legacy = make_legacy_v1_bundle(&payload);
        let (dec, is_legacy) = decrypt_bundle(&legacy, None).unwrap();
        assert!(is_legacy, "v1 必须识别为 legacy");
        assert_eq!(dec.get("legacy_import"), Some(&json!(true)));
        assert_eq!(dec.get("connections").and_then(|c| c.get(0)).and_then(|x| x.get("id")), Some(&json!("old")));
    }

    #[test]
    fn t6_v2_ciphertext_tamper_rejected() {
        let bundle = encrypt_bundle_v2(&sample_payload(), "correct-horse").unwrap();
        // 篡改 ciphertext base64 内容 1 字符
        let mut v: serde_json::Value = serde_json::from_str(&bundle).unwrap();
        let ct = v.get("ciphertext").and_then(|c| c.as_str()).unwrap().to_string();
        let mut chars: Vec<char> = ct.chars().collect();
        chars[0] = if chars[0] == 'A' { 'B' } else { 'A' };
        let tampered: String = chars.into_iter().collect();
        v["ciphertext"] = json!(tampered);
        let bad = serde_json::to_string(&v).unwrap();
        assert_eq!(
            decrypt_bundle(&bad, Some("correct-horse")).unwrap_err(),
            BundleError::DecryptFailed,
            "篡改必须被 GCM 认证拒绝"
        );
    }

    #[test]
    fn t6_legacy_tamper_rejected() {
        let legacy = make_legacy_v1_bundle(&sample_payload());
        let mut v: serde_json::Value = serde_json::from_str(&legacy).unwrap();
        let ct = v.get("ciphertext").and_then(|c| c.as_str()).unwrap().to_string();
        let mut chars: Vec<char> = ct.chars().collect();
        chars[0] = if chars[0] == 'A' { 'B' } else { 'A' };
        v["ciphertext"] = json!(chars.into_iter().collect::<String>());
        assert!(decrypt_bundle(&serde_json::to_string(&v).unwrap(), None).is_err());
    }

    #[test]
    fn t7_invalid_format_rejected() {
        let bad = json!({"format":"BOGUS","version":2,"salt":"","nonce":"","ciphertext":""}).to_string();
        assert!(matches!(
            decrypt_bundle(&bad, Some("password123")).unwrap_err(),
            BundleError::Format(_)
        ));
        // 非 JSON
        assert!(matches!(
            decrypt_bundle("not json at all", Some("password123")).unwrap_err(),
            BundleError::Format(_)
        ));
    }

    #[test]
    fn t7_missing_field_rejected() {
        let no_ct = json!({"format":BUNDLE_FORMAT,"version":2,"salt":"AA==","nonce":"AA=="}).to_string();
        assert!(matches!(
            decrypt_bundle(&no_ct, Some("password123")).unwrap_err(),
            BundleError::Format(_)
        ));
    }

    #[test]
    fn t8_v1_to_v2_old_password_invalid_on_new() {
        // 场景: legacy v1 用固定密钥; 重新导出为 v2 后, 旧固定密钥无法解开新文件
        let payload = sample_payload();
        let legacy = make_legacy_v1_bundle(&payload);
        let (_, is_legacy) = decrypt_bundle(&legacy, None).unwrap();
        assert!(is_legacy);
        // 用户以主密码重新导出 v2
        let v2 = encrypt_bundle_v2(&payload, "new-master-pw").unwrap();
        // v2 文件不含 version:1 / 不是 legacy
        let (dec2, is_legacy2) = decrypt_bundle(&v2, Some("new-master-pw")).unwrap();
        assert!(!is_legacy2);
        assert_eq!(dec2.get("legacy_import"), Some(&json!(false)));
        // 旧固定密钥路径 (None password) 对 v2 文件 → NeedPassword, 无法用旧密钥解
        assert_eq!(decrypt_bundle(&v2, None).unwrap_err(), BundleError::NeedPassword);
    }

    #[test]
    fn v2_nonce_uniqueness_same_payload_password() {
        let payload = sample_payload();
        let b1 = encrypt_bundle_v2(&payload, "same-password").unwrap();
        let b2 = encrypt_bundle_v2(&payload, "same-password").unwrap();
        let v1: serde_json::Value = serde_json::from_str(&b1).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&b2).unwrap();
        assert_ne!(v1["ciphertext"], v2["ciphertext"], "随机 salt/nonce → 密文不同");
        assert_ne!(v1["salt"], v2["salt"]);
    }

    #[test]
    fn no_plaintext_secret_in_v2_bundle() {
        let bundle = encrypt_bundle_v2(&sample_payload(), "correct-horse").unwrap();
        assert!(!bundle.contains("topsecret"), "明文密码不得出现在 bundle");
        assert!(!bundle.contains("***"), "api_key 不得出现在 bundle");
    }
}
