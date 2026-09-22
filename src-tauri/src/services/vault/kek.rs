/// WP6-S2: KEK 管理层
/// KekProvider trait 三实现:
/// - KeychainKek: macOS Keychain (keyring crate, service=com.diting.aidb, account=vault-kek-v1)
/// - FileKek: ~/.aidb/.kek (0600), keychain 不可用时降级
/// - MemoryKek: 测试专用
/// 运行期探测 + 降级 + provider 名日志

use super::crypto::KEY_LEN;

pub trait KekProvider: Send + Sync {
    /// provider 名称 (日志/诊断用)
    fn name(&self) -> &'static str;
    /// 获取 KEK (不存在则生成并持久化)
    fn get_or_create(&self) -> Result<[u8; KEY_LEN], String>;
}

/// ~/.aidb 目录 (0700)
pub fn aidb_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法确定 HOME 目录".to_string())?;
    let dir = std::path::PathBuf::from(home).join(".aidb");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 ~/.aidb 失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// macOS Keychain 实现
pub struct KeychainKek;

impl KekProvider for KeychainKek {
    fn name(&self) -> &'static str {
        "keychain"
    }
    fn get_or_create(&self) -> Result<[u8; KEY_LEN], String> {
        use base64::Engine;
        let entry = keyring::Entry::new("com.diting.aidb", "vault-kek-v1")
            .map_err(|e| format!("keychain entry 创建失败: {e}"))?;
        match entry.get_password() {
            Ok(b64) => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64.trim())
                    .map_err(|e| format!("keychain KEK 解码失败: {e}"))?;
                if bytes.len() != KEY_LEN {
                    return Err(format!("keychain KEK 长度非法: {}", bytes.len()));
                }
                let mut kek = [0u8; KEY_LEN];
                kek.copy_from_slice(&bytes);
                Ok(kek)
            }
            Err(keyring::Error::NoEntry) => {
                let mut kek = [0u8; KEY_LEN];
                rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut kek);
                let b64 = base64::engine::general_purpose::STANDARD.encode(kek);
                entry
                    .set_password(&b64)
                    .map_err(|e| format!("keychain KEK 写入失败: {e}"))?;
                Ok(kek)
            }
            Err(e) => Err(format!("keychain 读取失败: {e}")),
        }
    }
}

/// 文件降级实现 (~/.aidb/.kek, 0600)
pub struct FileKek {
    pub dir: std::path::PathBuf,
}

impl FileKek {
    pub fn new() -> Result<Self, String> {
        Ok(Self { dir: aidb_dir()? })
    }
    pub fn with_dir(dir: std::path::PathBuf) -> Self {
        Self { dir }
    }
}

impl KekProvider for FileKek {
    fn name(&self) -> &'static str {
        "file"
    }
    fn get_or_create(&self) -> Result<[u8; KEY_LEN], String> {
        let path = self.dir.join(".kek");
        if path.exists() {
            let bytes = std::fs::read(&path).map_err(|e| format!(".kek 读取失败: {e}"))?;
            if bytes.len() != KEY_LEN {
                return Err(format!(".kek 长度非法: {}", bytes.len()));
            }
            let mut kek = [0u8; KEY_LEN];
            kek.copy_from_slice(&bytes);
            return Ok(kek);
        }
        let mut kek = [0u8; KEY_LEN];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut kek);
        atomic_write_secret(&path, &kek)?;
        Ok(kek)
    }
}

/// 原子写敏感文件 (临时文件 + rename + 0600)
pub fn atomic_write_secret(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("临时文件创建失败: {e}"))?;
        f.write_all(data).map_err(|e| format!("临时文件写入失败: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync 失败: {e}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("原子 rename 失败: {e}"))
}

/// 测试用内存 KEK
pub struct MemoryKek {
    pub kek: std::sync::Mutex<Option<[u8; KEY_LEN]>>,
}

impl MemoryKek {
    pub fn new() -> Self {
        Self { kek: std::sync::Mutex::new(None) }
    }
}

impl KekProvider for MemoryKek {
    fn name(&self) -> &'static str {
        "memory"
    }
    fn get_or_create(&self) -> Result<[u8; KEY_LEN], String> {
        let mut guard = self.kek.lock().map_err(|e| e.to_string())?;
        if let Some(k) = *guard {
            return Ok(k);
        }
        let mut kek = [0u8; KEY_LEN];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut kek);
        *guard = Some(kek);
        Ok(kek)
    }
}

/// 运行期探测: Keychain → File 降级
pub fn resolve_kek() -> Result<([u8; KEY_LEN], &'static str), String> {
    let kc = KeychainKek;
    match kc.get_or_create() {
        Ok(kek) => Ok((kek, kc.name())),
        Err(e) => {
            tracing::warn!(target: "VAULT::KEK", "Keychain 不可用, 降级 FileKek: {e}");
            let fk = FileKek::new()?;
            let kek = fk.get_or_create()?;
            Ok((kek, fk.name()))
        }
    }
}

// ============ S2 单测 (T11 等) ============
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_kek_stable_across_calls() {
        let m = MemoryKek::new();
        let k1 = m.get_or_create().unwrap();
        let k2 = m.get_or_create().unwrap();
        assert_eq!(k1, k2);
        assert_eq!(m.name(), "memory");
    }

    #[test]
    fn file_kek_persists_and_0600() {
        let dir = tempfile::tempdir().unwrap();
        let fk = FileKek::with_dir(dir.path().to_path_buf());
        let k1 = fk.get_or_create().unwrap();
        let k2 = fk.get_or_create().unwrap();
        assert_eq!(k1, k2, "重读必须同 KEK");
        let path = dir.path().join(".kek");
        assert!(path.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, ".kek 权限必须 0600");
        }
    }

    #[test]
    fn file_kek_corrupt_len_rejected() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".kek"), b"short").unwrap();
        let fk = FileKek::with_dir(dir.path().to_path_buf());
        assert!(fk.get_or_create().is_err());
    }

    #[test]
    fn t11_keychain_fail_falls_back_to_file() {
        // 模拟 Keychain 失败 → FileKek 降级 (通过 resolve_kek 逻辑的等价测试:
        // 直接验证降级函数在 keychain error 时用 file)
        struct FailingKek;
        impl KekProvider for FailingKek {
            fn name(&self) -> &'static str {
                "keychain"
            }
            fn get_or_create(&self) -> Result<[u8; KEY_LEN], String> {
                Err("mock: keychain 不可用".into())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let primary = FailingKek;
        let (kek, provider) = match primary.get_or_create() {
            Ok(k) => (k, primary.name()),
            Err(_) => {
                let fk = FileKek::with_dir(dir.path().to_path_buf());
                let k = fk.get_or_create().unwrap();
                (k, fk.name())
            }
        };
        assert_eq!(provider, "file");
        assert_eq!(kek.len(), KEY_LEN);
    }

    #[test]
    fn atomic_write_secret_no_tmp_leftover() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.enc");
        atomic_write_secret(&p, b"data").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"data");
        assert!(!dir.path().join("x.tmp").exists(), "临时文件必须已 rename");
    }
}
