//! WP3: SSH 隧道服务 — russh 0.63 纯 Rust 实现
//! - direct 单跳: 本机 → SSH 主机 → 目标 DB (channel_open_direct_tcpip)
//! - bastion_jump 双跳: 本机 → 堡垒机 →(direct-tcpip 隧道流)→ 目标内网机 → DB
//! - 认证链: password / privatekey(passphrase) / keyboard-interactive + TOTP(OTP 关键词注入, 手填 otp_code 优先)
//! - 主机密钥: TOFU 首次信任 + 指纹持久化 (~/.aidb/known_hosts), 变更硬失败
//! - 本地端口: bind("127.0.0.1:0") 动态分配 + accept loop + copy_bidirectional
//!
//! 计划: docs/plans/WP3-ssh-tunnel.md (会议2/3/4/6/7/8 决议)

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{client, Disconnect};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

use crate::error::AppError;
use crate::models::{SshAuthType, SshTunnelConfig, TunnelType};

// ============ 状态机 (会议2) ============

/// 隧道生命周期状态。合法转移:
/// Disconnected→Connecting→Authenticating→Forwarding→Closing→Disconnected
/// 任意中间态→Failed(带错误码); Failed/Closed→可重新 open
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TunnelState {
    Disconnected,
    Connecting,
    Authenticating,
    Forwarding,
    Closing,
    Failed { code: String, message: String },
}

impl TunnelState {
    /// 状态机转移校验 (会议2: 非法转移拒绝)
    #[allow(dead_code)] // 状态机转移校验: T 单测覆盖全部合法/非法转移
    pub fn can_transition_to(&self, next: &TunnelState) -> bool {
        use TunnelState::*;
        match (self, next) {
            (Disconnected, Connecting) => true,
            (Connecting, Authenticating) => true,
            (Authenticating, Forwarding) => true,
            (Forwarding, Closing) => true,
            (Closing, Disconnected) => true,
            // 任意活动态可直接进入 Failed
            (Connecting | Authenticating | Forwarding | Closing, Failed { .. }) => true,
            // Failed 后允许重新 open (Disconnected→Connecting 由 reset 完成)
            (Failed { .. }, Disconnected) => true,
            _ => false,
        }
    }

    #[allow(dead_code)] // 状态机访问器: 测试断言转移合法性; 前端经 get_tunnel_state 消费
    pub fn is_failed(&self) -> bool {
        matches!(self, TunnelState::Failed { .. })
    }

    #[allow(dead_code)] // 状态机访问器 (测试 + 诊断)
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            TunnelState::Connecting | TunnelState::Authenticating | TunnelState::Forwarding
        )
    }
}

/// 冻结错误码清单 (计划附录; 新增必须过评审)
pub mod tunnel_err {
    pub const AUTH_FAILED: &str = "TUNNEL_AUTH_FAILED";
    pub const HOST_KEY_MISMATCH: &str = "TUNNEL_HOST_KEY_MISMATCH";
    pub const CHANNEL_REFUSED: &str = "TUNNEL_CHANNEL_REFUSED";
    pub const TIMEOUT: &str = "TUNNEL_TIMEOUT";
    pub const PORT_EXHAUSTED: &str = "TUNNEL_PORT_EXHAUSTED";
    pub const OTP_FAILED: &str = "TUNNEL_OTP_FAILED";
    pub const KEY_FILE_ERROR: &str = "TUNNEL_KEY_FILE_ERROR";
    pub const INVALID_CONFIG: &str = "TUNNEL_INVALID_CONFIG";
    pub const DISCONNECTED: &str = "TUNNEL_DISCONNECTED";
}

// ============ TOTP (会议4) ============

/// 生成 6 位 TOTP 验证码 (SHA1/30s, RFC 6238)
/// secret_b32: base32 编码密钥 (authenticator app 中显示的 Secret)
pub fn generate_otp(secret_b32: &str) -> Result<String, AppError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| AppError::tunnel(tunnel_err::OTP_FAILED, format!("系统时钟异常: {e}")))?
        .as_secs();
    generate_otp_at(secret_b32, now)
}

/// 固定 unix 时间生成 TOTP (测试可注入 RFC 6238 向量时间点)
pub fn generate_otp_at(secret_b32: &str, unix_time: u64) -> Result<String, AppError> {
    use totp_rs::{Algorithm, Secret, TOTP};
    let secret = Secret::Encoded(secret_b32.to_string())
        .to_bytes()
        .map_err(|e| AppError::tunnel(tunnel_err::OTP_FAILED, format!("非法 base32 OTP secret: {e}")))?;
    let totp = TOTP::new_unchecked(
        Algorithm::SHA1,
        6,
        1,
        30,
        secret,
        Some("aidb".to_string()),
        "ssh".to_string(),
    );
    Ok(totp.generate(unix_time))
}

/// 判断 keyboard-interactive prompt 是否为 OTP 类 (会议4 关键词表)
fn is_otp_prompt(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    ["verification code", "otp", "token", "one-time", "mfa", "2fa", "totp", "验证码"]
        .iter()
        .any(|kw| lower.contains(kw))
}

// ============ 私钥加载 (Step 11) ============

/// 展开 ~ 前缀为 home 目录
pub fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

/// 加载私钥; 区分三类错误: 文件不存在 / 格式错误 / passphrase 错误 (Step 11)
fn load_private_key(path: &str, passphrase: Option<&str>) -> Result<PrivateKeyWithHashAlg, AppError> {
    let expanded = expand_tilde(path);
    if !expanded.exists() {
        return Err(AppError::tunnel(
            tunnel_err::KEY_FILE_ERROR,
            format!("私钥文件不存在: {}", expanded.display()),
        ));
    }
    let err_msg = |e: &russh::keys::Error| -> String {
        let s = e.to_string().to_lowercase();
        if s.contains("mac") || s.contains("decrypt") || s.contains("password") {
            "私钥 passphrase 错误或密钥已加密但未提供 passphrase".to_string()
        } else {
            "私钥格式无法解析 (非 OpenSSH/PEM 私钥或文件损坏)".to_string()
        }
    };
    let key = match load_secret_key(&expanded, passphrase) {
        Ok(k) => k,
        Err(e) => {
            // russh 0.63: 加密密钥需要 passphrase; None 时部分格式返回 NeedsPassphrase
            if passphrase.is_none() && format!("{e:?}").to_lowercase().contains("passphrase") {
                return Err(AppError::tunnel(
                    tunnel_err::KEY_FILE_ERROR,
                    "私钥已加密, 请提供 passphrase",
                ));
            }
            return Err(AppError::tunnel(tunnel_err::KEY_FILE_ERROR, err_msg(&e)));
        }
    };
    let hash_alg = if key.algorithm().is_rsa() {
        Some(HashAlg::Sha256)
    } else {
        None
    };
    Ok(PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg))
}

// ============ 主机密钥 TOFU 存储 (会议7) ============

/// known_hosts 指纹存储: ~/.aidb/known_hosts.json, 形如 { "host:port": "SHA256:..." }
#[derive(Debug, Default)]
pub struct HostKeyStore {
    path: PathBuf,
}

impl HostKeyStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn default_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".aidb")
            .join("known_hosts.json")
    }

    /// 读取已记录指纹 (文件缺失/损坏返回空 map — TOFU 重新信任)
    pub fn load(&self) -> HashMap<String, String> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// 校验: Ok(true)=首次(TOFU 记录), Ok(false)=已有且一致, Err=不一致硬失败
    pub fn verify_or_trust(&self, host_port: &str, fingerprint: &str) -> Result<bool, AppError> {
        let mut map = self.load();
        match map.get(host_port) {
            Some(recorded) if recorded != fingerprint => Err(AppError::tunnel(
                tunnel_err::HOST_KEY_MISMATCH,
                format!(
                    "SSH 主机密钥已变更! 记录指纹 {recorded}, 本次 {fingerprint}. \
                     可能存在中间人攻击; 若确认主机已重装, 请删除 {} 中的该条目后重连",
                    self.path.display()
                ),
            )),
            Some(_) => Ok(false),
            None => {
                map.insert(host_port.to_string(), fingerprint.to_string());
                self.save(&map);
                Ok(true)
            }
        }
    }

    fn save(&self, map: &HashMap<String, String>) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(map) {
            let _ = std::fs::write(&self.path, json);
        }
    }
}

/// 计算主机密钥 SHA256 指纹 (OpenSSH 风格字符串, 如 "SHA256:base64...")
fn fingerprint_sha256(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

// ============ russh Handler ============

#[derive(Debug)]
pub struct TunnelError(#[allow(dead_code)] pub russh::Error);
impl std::fmt::Display for TunnelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SSH error: {}", self.0)
    }
}
impl std::error::Error for TunnelError {}
impl From<russh::Error> for TunnelError {
    fn from(e: russh::Error) -> Self {
        TunnelError(e)
    }
}

/// 隧道专用 Handler: TOFU 主机密钥校验; 认证走 Handle 上的显式调用链
pub struct TunnelHandler {
    host_store: Arc<HostKeyStore>,
    host_port: String,
    /// check_server_key 的错误缓存 (失败后 connect 返回 Disconnected, 从此处取原因)
    host_key_error: Arc<RwLock<Option<String>>>,
}

impl client::Handler for TunnelHandler {
    type Error = TunnelError;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // russh 0.63: PublicKeyOrCertificate::public_key() 统一两个变体 (Certificate 内含 PublicKey)
        let pk: PublicKey = server_public_key.public_key();
        let fp = fingerprint_sha256(&pk);
        match self.host_store.verify_or_trust(&self.host_port, &fp) {
            Ok(_) => Ok(true),
            Err(e) => {
                // 记录错误供调用方读取; 返回 false 使 russh 中止连接
                let msg = e.to_string();
                if let Ok(mut guard) = self.host_key_error.try_write() {
                    *guard = Some(msg);
                }
                Ok(false)
            }
        }
    }
}

// ============ SSH 连接抽象 (会议2: SshConnector trait, 便于 mock) ============

/// russh 会话句柄封装 (Arc 共享: 转发协程与 TunnelHandle 各持一份)
pub struct SshSession {
    pub handle: Arc<client::Handle<TunnelHandler>>,
}

/// WP3: SSH 连接目标端点 (WP7: 打包为结构体, open_ssh_session 参数降至 clippy 阈值内)
struct SshTarget<'a> {
    user: &'a str,
    host: &'a str,
    port: u16,
    auth_type: SshAuthType,
    password: Option<&'a str>,
    key_path: Option<&'a str>,
}

/// 建立到单跳的认证会话。认证链 (会议4):
/// 1. privatekey 模式: publickey(passphrase 解密)
/// 2. password 模式: 有 otp_secret/otp_code → keyboard-interactive 优先, 失败降级 password(+OTP 拼接)
/// 3. 无 OTP: 直接 password
async fn open_ssh_session(
    cfg: &SshTunnelConfig,
    target: SshTarget<'_>,
    host_store: Arc<HostKeyStore>,
) -> Result<SshSession, AppError> {
    // 解构目标端点; 下方逻辑沿用原变量名 (零改动)
    let SshTarget { user, host, port, auth_type, password, key_path } = target;
    let host_port = format!("{host}:{port}");
    let host_key_error: Arc<RwLock<Option<String>>> = Arc::new(RwLock::new(None));
    let handler = TunnelHandler {
        host_store: host_store.clone(),
        host_port: host_port.clone(),
        host_key_error: host_key_error.clone(),
    };

    let ssh_config = client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(15)),
        keepalive_max: 3,
        inactivity_timeout: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    };

    let connect_timeout = std::time::Duration::from_secs(15);
    let mut handle = tokio::time::timeout(
        connect_timeout,
        client::connect(Arc::new(ssh_config), (host, port), handler),
    )
    .await
    .map_err(|_| {
        AppError::tunnel(
            tunnel_err::TIMEOUT,
            format!("SSH 连接超时 ({host_port}, {connect_timeout:?})"),
        )
    })?
    .map_err(|e| {
        // check_server_key 拒绝时 russh 返回 Disconnected; 取缓存的具体原因
        if let Ok(guard) = host_key_error.try_read() {
            if let Some(msg) = guard.as_ref() {
                return AppError::tunnel(tunnel_err::HOST_KEY_MISMATCH, msg.clone());
            }
        }
        AppError::tunnel(
            tunnel_err::TIMEOUT,
            format!("无法连接 SSH 主机 {host_port}: {e}"),
        )
    })?;

    // ---- 认证链 ----
    let auth_timeout = std::time::Duration::from_secs(15);
    let auth_result: Result<bool, AppError> = async {
        match auth_type {
            SshAuthType::PrivateKey => {
                let key_path = key_path.ok_or_else(|| {
                    AppError::tunnel(tunnel_err::INVALID_CONFIG, "私钥认证缺少 private_key_path")
                })?;
                let key = load_private_key(key_path, cfg.passphrase.as_deref())?;
                let r = handle
                    .authenticate_publickey(user, key)
                    .await
                    .map_err(|e| AppError::tunnel(tunnel_err::AUTH_FAILED, format!("publickey 认证通信失败: {e}")))?;
                if r.success() {
                    Ok(true)
                } else {
                    Err(AppError::tunnel(
                        tunnel_err::AUTH_FAILED,
                        format!("publickey 认证被拒绝 (user={user})"),
                    ))
                }
            }
            SshAuthType::Password => {
                let password = password.unwrap_or("");
                let has_otp = cfg.otp_secret.as_deref().map(|s| !s.is_empty()).unwrap_or(false)
                    || cfg.otp_code.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
                if has_otp {
                    // keyboard-interactive: OTP 关键词注入 (手填 otp_code 优先)
                    if let Ok(true) = try_keyboard_interactive(&mut handle, user, password, cfg).await {
                        return Ok(true);
                    }
                    // 降级: password + OTP 拼接 (部分 PAM 配置要求 "密码+验证码" 一体)
                    if let Ok(otp) = current_otp(cfg) {
                        let combined = format!("{password}{otp}");
                        let r = handle.authenticate_password(user, combined).await;
                        if r.map(|r| r.success()).unwrap_or(false) {
                            return Ok(true);
                        }
                    }
                    Err(AppError::tunnel(
                        tunnel_err::AUTH_FAILED,
                        "OTP 认证失败 (keyboard-interactive 与 password+OTP 均未通过; 验证码可能已过期)",
                    ))
                } else {
                    let r = handle
                        .authenticate_password(user, password)
                        .await
                        .map_err(|e| AppError::tunnel(tunnel_err::AUTH_FAILED, format!("password 认证通信失败: {e}")))?;
                    if r.success() {
                        Ok(true)
                    } else {
                        Err(AppError::tunnel(
                            tunnel_err::AUTH_FAILED,
                            format!("密码认证被拒绝 (user={user})"),
                        ))
                    }
                }
            }
        }
    }
    .await;

    tokio::time::timeout(auth_timeout, async { auth_result })
        .await
        .map_err(|_| {
            AppError::tunnel(tunnel_err::TIMEOUT, "SSH 认证超时 (15s)")
        })?
        .map(|_| SshSession { handle: Arc::new(handle) })
}

/// 当前有效 OTP 码: 手填 otp_code 优先, 否则由 otp_secret 生成
fn current_otp(cfg: &SshTunnelConfig) -> Result<String, AppError> {
    if let Some(code) = cfg.otp_code.as_deref().filter(|s| !s.is_empty()) {
        return Ok(code.to_string());
    }
    if let Some(secret) = cfg.otp_secret.as_deref().filter(|s| !s.is_empty()) {
        return generate_otp(secret);
    }
    Err(AppError::tunnel(tunnel_err::OTP_FAILED, "无 otp_code 且无 otp_secret"))
}

/// keyboard-interactive 多轮 prompt 应答: OTP 类 prompt 注入验证码, 密码类注入密码
async fn try_keyboard_interactive(
    handle: &mut client::Handle<TunnelHandler>,
    user: &str,
    password: &str,
    cfg: &SshTunnelConfig,
) -> Result<bool, AppError> {
    use client::KeyboardInteractiveAuthResponse::*;
    let mut resp = handle
        .authenticate_keyboard_interactive_start(user, None)
        .await
        .map_err(|e| AppError::tunnel(tunnel_err::AUTH_FAILED, format!("keyboard-interactive 启动失败: {e}")))?;
    // 防死循环: 最多 5 轮
    for _ in 0..5 {
        match resp {
            Success => return Ok(true),
            Failure { .. } => return Ok(false),
            InfoRequest { prompts, .. } => {
                if prompts.is_empty() {
                    resp = handle
                        .authenticate_keyboard_interactive_respond(vec![])
                        .await
                        .map_err(|e| AppError::tunnel(tunnel_err::AUTH_FAILED, e.to_string()))?;
                    continue;
                }
                let mut responses = Vec::with_capacity(prompts.len());
                for p in &prompts {
                    let text = if is_otp_prompt(&p.prompt) {
                        current_otp(cfg)?
                    } else {
                        password.to_string()
                    };
                    responses.push(text);
                }
                resp = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .map_err(|e| AppError::tunnel(tunnel_err::AUTH_FAILED, e.to_string()))?;
            }
        }
    }
    Ok(false)
}

// ============ 本地端口转发 (会议3) ============

/// 隧道句柄: 本地监听端口 + 关闭通道
pub struct TunnelHandle {
    #[allow(dead_code)] // 句柄自描述端口: 诊断日志与未来多跳扩展; 当前经 TunnelManager 返回
    pub local_port: u16,
    shutdown: tokio::sync::oneshot::Sender<()>,
    /// 转发任务退出通知 (sshd 断开时由转发协程发出)
    disconnected_rx: Arc<RwLock<Option<tokio::sync::watch::Receiver<bool>>>>,
    /// 保持 SSH 会话存活直至 close
    _session: Option<SshSession>,
    _session2: Option<SshSession>,
}

impl TunnelHandle {
    /// 非阻塞查询隧道是否已被动断开
    pub fn is_disconnected(&self) -> bool {
        // watch receiver 需要在 mut 下 poll; 这里用 try_read
        if let Ok(guard) = self.disconnected_rx.try_read() {
            if let Some(rx) = guard.as_ref() {
                return *rx.borrow();
            }
        }
        false
    }

    /// 主动关闭隧道 (幂等: 重复调用安全)
    pub async fn close(self) {
        let _ = self.shutdown.send(());
        if let Some(s) = self._session {
            let _ = s
                .handle
                .disconnect(Disconnect::ByApplication, "tunnel closed", "en")
                .await;
        }
        if let Some(s) = self._session2 {
            let _ = s
                .handle
                .disconnect(Disconnect::ByApplication, "tunnel closed", "en")
                .await;
        }
    }
}

/// 分配本地端口: bind 127.0.0.1:0, 仅本机可达
async fn bind_local() -> Result<(TcpListener, u16), AppError> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| {
        AppError::tunnel(tunnel_err::PORT_EXHAUSTED, format!("本地端口分配失败: {e}"))
    })?;
    let port = listener.local_addr().map(|a| a.port()).map_err(|e| {
        AppError::tunnel(tunnel_err::PORT_EXHAUSTED, format!("无法读取本地端口: {e}"))
    })?;
    Ok((listener, port))
}

/// 打开 direct 单跳隧道: 返回 (本地端口, 句柄)
pub async fn open_direct_tunnel(
    cfg: SshTunnelConfig,
    db_host: String,
    db_port: u16,
    host_store: Arc<HostKeyStore>,
) -> Result<(u16, TunnelHandle), AppError> {
    validate(&cfg, &db_host)?;
    let session = open_ssh_session(
        &cfg,
        SshTarget {
            user: &cfg.ssh_user,
            host: &cfg.ssh_host,
            port: cfg.ssh_port,
            auth_type: cfg.auth_type,
            password: cfg.ssh_password.as_deref(),
            key_path: cfg.ssh_private_key_path.as_deref(),
        },
        host_store,
    )
    .await?;
    let (listener, local_port) = bind_local().await?;
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let (dc_tx, dc_rx) = tokio::sync::watch::channel(false);
    let handle_clone = session.handle.clone();
    let db_host_c = db_host.clone();

    tokio::spawn(forward_loop(
        listener,
        handle_clone,
        db_host_c,
        db_port,
        shutdown_rx,
        Some(dc_tx),
    ));

    Ok((
        local_port,
        TunnelHandle {
            local_port,
            shutdown: shutdown_tx,
            disconnected_rx: Arc::new(RwLock::new(Some(dc_rx))),
            _session: Some(session),
            _session2: None,
        },
    ))
}

// ============ 内部: 转发循环 ============

async fn forward_loop(
    listener: TcpListener,
    ssh_handle: Arc<client::Handle<TunnelHandler>>,
    target_host: String,
    target_port: u16,
    mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
    disconnected_tx: Option<tokio::sync::watch::Sender<bool>>,
) {
    loop {
        tokio::select! {
            _ = &mut shutdown_rx => break,
            accept = listener.accept() => {
                match accept {
                    Ok((mut stream, _)) => {
                        let h = ssh_handle.clone();
                        let host = target_host.clone();
                        tokio::spawn(async move {
                            match h.channel_open_direct_tcpip(&host, target_port as u32, "127.0.0.1", 0).await {
                                Ok(chan) => {
                                    let mut remote = chan.into_stream();
                                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut remote).await;
                                }
                                Err(e) => {
                                    tracing::warn!(target: "DB::TUNNEL", "direct-tcpip 转发被拒绝 (AllowTcpForwarding?): {e}");
                                }
                            }
                        });
                    }
                    Err(_) => {
                        // listener 关闭
                        break;
                    }
                }
            }
        }
    }
    if let Some(tx) = disconnected_tx {
        let _ = tx.send(true);
    }
}

// ============ 配置校验 (会议5) ============

fn validate(cfg: &SshTunnelConfig, db_host: &str) -> Result<(), AppError> {
    if cfg.ssh_host.trim().is_empty() {
        return Err(AppError::tunnel(tunnel_err::INVALID_CONFIG, "ssh_host 不能为空"));
    }
    if cfg.ssh_user.trim().is_empty() {
        return Err(AppError::tunnel(tunnel_err::INVALID_CONFIG, "ssh_user 不能为空"));
    }
    if db_host.trim().is_empty() {
        return Err(AppError::tunnel(tunnel_err::INVALID_CONFIG, "目标 db_host 不能为空"));
    }
    match cfg.auth_type {
        SshAuthType::Password => {
            if cfg.ssh_password.as_deref().unwrap_or("").is_empty()
                && cfg.otp_secret.as_deref().unwrap_or("").is_empty()
                && cfg.otp_code.as_deref().unwrap_or("").is_empty()
            {
                return Err(AppError::tunnel(
                    tunnel_err::INVALID_CONFIG,
                    "password 认证需要 ssh_password 或 OTP 配置",
                ));
            }
        }
        SshAuthType::PrivateKey => {
            if cfg.ssh_private_key_path.as_deref().unwrap_or("").is_empty() {
                return Err(AppError::tunnel(
                    tunnel_err::INVALID_CONFIG,
                    "privatekey 认证需要 ssh_private_key_path",
                ));
            }
        }
    }
    if cfg.tunnel_type == TunnelType::BastionJump {
        let th = cfg.target_ssh_host.as_deref().unwrap_or("");
        let tu = cfg.target_ssh_user.as_deref().unwrap_or("");
        if th.trim().is_empty() || tu.trim().is_empty() {
            return Err(AppError::tunnel(
                tunnel_err::INVALID_CONFIG,
                "bastion_jump 模式需要 target_ssh_host 与 target_ssh_user",
            ));
        }
    }
    Ok(())
}

// ============ TunnelManager (会议2/3) ============

struct ManagedTunnel {
    handle: TunnelHandle,
    state: TunnelState,
}

/// 隧道管理器: conn_id → 活动隧道。DbService 持有单例。
pub struct TunnelManager {
    tunnels: Arc<RwLock<HashMap<String, ManagedTunnel>>>,
    host_store: Arc<HostKeyStore>,
    /// 被动断开事件总线 (main.rs 转发为 tauri event "tunnel-disconnected")
    disconnect_tx: tokio::sync::broadcast::Sender<String>,
}

impl TunnelManager {
    pub fn new() -> Self {
        let (disconnect_tx, _) = tokio::sync::broadcast::channel(16);
        Self {
            tunnels: Arc::new(RwLock::new(HashMap::new())),
            host_store: Arc::new(HostKeyStore::new(HostKeyStore::default_path())),
            disconnect_tx,
        }
    }

    /// 订阅被动断开事件流 (conn_id)
    pub fn subscribe_disconnects(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.disconnect_tx.subscribe()
    }

    /// 测试注入: 自定义 known_hosts 路径
    #[cfg(test)]
    pub fn with_host_store(path: PathBuf) -> Self {
        let (disconnect_tx, _) = tokio::sync::broadcast::channel(16);
        Self {
            tunnels: Arc::new(RwLock::new(HashMap::new())),
            host_store: Arc::new(HostKeyStore::new(path)),
            disconnect_tx,
        }
    }

    /// 打开隧道 (若 conn_id 已有活动隧道先关闭旧的 — 会议3 重连不泄漏)
    /// 返回本地转发端口
    pub async fn open(
        &self,
        conn_id: &str,
        cfg: SshTunnelConfig,
        db_host: String,
        db_port: u16,
    ) -> Result<u16, AppError> {
        // 先关旧隧道
        self.close(conn_id).await;

        let result = match cfg.tunnel_type {
            TunnelType::Direct => {
                open_direct_tunnel(cfg.clone(), db_host.clone(), db_port, self.host_store.clone()).await
            }
            TunnelType::BastionJump => {
                open_bastion_tunnel(cfg.clone(), db_host.clone(), db_port, self.host_store.clone()).await
            }
        };

        match result {
            Ok((local_port, handle)) => {
                {
                    let mut lock = self.tunnels.write().await;
                    lock.insert(
                        conn_id.to_string(),
                        ManagedTunnel {
                            handle,
                            state: TunnelState::Forwarding,
                        },
                    );
                }
                // 被动断开监控: 每 3s 检查转发协程是否退出 (sshd 被 kill 等), 触发则广播事件
                self.spawn_disconnect_monitor(conn_id.to_string());
                Ok(local_port)
            }
            Err(e) => {
                let mut lock = self.tunnels.write().await;
                let code = match &e {
                    AppError::Tunnel { code, .. } => code.clone(),
                    _ => tunnel_err::INVALID_CONFIG.to_string(),
                };
                lock.insert(
                    conn_id.to_string(),
                    ManagedTunnel {
                        handle: dummy_handle(),
                        state: TunnelState::Failed {
                            code,
                            message: e.to_string(),
                        },
                    },
                );
                Err(e)
            }
        }
    }

    /// 关闭指定隧道 (幂等)
    pub async fn close(&self, conn_id: &str) {
        let mut lock = self.tunnels.write().await;
        if let Some(mut t) = lock.remove(conn_id) {
            t.state = TunnelState::Closing;
            t.handle.close().await;
        }
    }

    /// 关闭全部隧道 (应用退出时调用)
    pub async fn close_all(&self) {
        let mut lock = self.tunnels.write().await;
        let entries: Vec<(String, ManagedTunnel)> = lock.drain().collect();
        drop(lock);
        for (_, mut t) in entries {
            t.state = TunnelState::Closing;
            t.handle.close().await;
        }
    }

    /// 查询隧道状态 (前端角标/诊断用)
    pub async fn state(&self, conn_id: &str) -> TunnelState {
        let lock = self.tunnels.read().await;
        match lock.get(conn_id) {
            Some(t) => {
                // 活动隧道被动断开检测 (sshd 被 kill 等)
                if t.state == TunnelState::Forwarding && t.handle.is_disconnected() {
                    return TunnelState::Failed {
                        code: tunnel_err::DISCONNECTED.to_string(),
                        message: "SSH 隧道已被动断开".to_string(),
                    };
                }
                t.state.clone()
            }
            None => TunnelState::Disconnected,
        }
    }

    /// 当前活动隧道数 (测试泄漏检测用)
    #[allow(dead_code)] // 诊断/测试: 断言隧道关闭后无泄漏句柄
    pub async fn active_count(&self) -> usize {
        let lock = self.tunnels.read().await;
        lock.iter().filter(|(_, t)| t.state.is_active() || t.state == TunnelState::Forwarding).count()
    }

    /// 被动断开监控协程: 隧道被 close/移除或检测到断开时退出
    fn spawn_disconnect_monitor(&self, conn_id: String) {
        let tunnels = self.tunnels.clone();
        let tx = self.disconnect_tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let disconnected = {
                    let mut lock = tunnels.write().await;
                    match lock.get_mut(&conn_id) {
                        None => return, // 已被 close/close_all 移除
                        Some(t) => {
                            if t.state == TunnelState::Forwarding && t.handle.is_disconnected() {
                                t.state = TunnelState::Failed {
                                    code: tunnel_err::DISCONNECTED.to_string(),
                                    message: "SSH 隧道已被动断开 (远端关闭或网络中断)".to_string(),
                                };
                                true
                            } else {
                                false
                            }
                        }
                    }
                };
                if disconnected {
                    let _ = tx.send(conn_id.clone());
                    return;
                }
            }
        });
    }
}

/// Failed 占位句柄 (无真实资源, close 幂等安全)
fn dummy_handle() -> TunnelHandle {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    drop(rx);
    let (_, dc_rx) = tokio::sync::watch::channel(false);
    TunnelHandle {
        local_port: 0,
        shutdown: tx,
        disconnected_rx: Arc::new(RwLock::new(Some(dc_rx))),
        _session: None,
        _session2: None,
    }
}

// ============ bastion_jump 双跳 (会议6) ============

/// 双跳: hop1 堡垒机认证 → hop1.channel_open_direct_tcpip(目标机:22) 作为流
/// → connect_stream 建立 hop2 SSH 会话 → hop2 direct-tcpip 到 DB
pub async fn open_bastion_tunnel(
    cfg: SshTunnelConfig,
    db_host: String,
    db_port: u16,
    host_store: Arc<HostKeyStore>,
) -> Result<(u16, TunnelHandle), AppError> {
    validate(&cfg, &db_host)?;
    let target_host = cfg
        .target_ssh_host
        .clone()
        .ok_or_else(|| AppError::tunnel(tunnel_err::INVALID_CONFIG, "bastion_jump 缺少 target_ssh_host"))?;
    let target_port = cfg.target_ssh_port.unwrap_or(22);
    let target_user = cfg
        .target_ssh_user
        .clone()
        .ok_or_else(|| AppError::tunnel(tunnel_err::INVALID_CONFIG, "bastion_jump 缺少 target_ssh_user"))?;

    // ---- hop1: 堡垒机 ----
    let hop1 = open_ssh_session(
        &cfg,
        SshTarget {
            user: &cfg.ssh_user,
            host: &cfg.ssh_host,
            port: cfg.ssh_port,
            auth_type: cfg.auth_type,
            password: cfg.ssh_password.as_deref(),
            key_path: cfg.ssh_private_key_path.as_deref(),
        },
        host_store.clone(),
    )
    .await
    .map_err(|e| prefix_hop(e, 1))?;

    // hop1 → 目标机 SSH 端口的 direct-tcpip 通道作为 hop2 的传输流
    let chan = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        hop1.handle.channel_open_direct_tcpip(&target_host, target_port as u32, "127.0.0.1", 0),
    )
    .await
    .map_err(|_| AppError::tunnel(tunnel_err::TIMEOUT, "hop1→hop2 通道打开超时 (15s)"))?
    .map_err(|e| {
        AppError::tunnel(
            tunnel_err::CHANNEL_REFUSED,
            format!("堡垒机拒绝转发到 {target_host}:{target_port} (AllowTcpForwarding?): {e}"),
        )
    })?;
    let hop2_stream = chan.into_stream();

    // ---- hop2: 目标内网机 (认证用 target_* 字段) ----
    let hop2 = open_ssh_session_over_stream(
        &cfg,
        &target_user,
        &target_host,
        target_port,
        cfg.target_auth_type.unwrap_or(SshAuthType::Password),
        cfg.target_ssh_password.as_deref(),
        cfg.target_ssh_private_key_path.as_deref(),
        host_store.clone(),
        hop2_stream,
    )
    .await
    .map_err(|e| prefix_hop(e, 2))?;

    // ---- 本地端口 + 转发 (经 hop2 到 DB) ----
    let (listener, local_port) = bind_local().await?;
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let (dc_tx, dc_rx) = tokio::sync::watch::channel(false);
    let h2 = hop2.handle.clone();
    tokio::spawn(forward_loop(
        listener,
        h2,
        db_host.clone(),
        db_port,
        shutdown_rx,
        Some(dc_tx),
    ));

    Ok((
        local_port,
        TunnelHandle {
            local_port,
            shutdown: shutdown_tx,
            disconnected_rx: Arc::new(RwLock::new(Some(dc_rx))),
            _session: Some(hop2),
            _session2: Some(hop1),
        },
    ))
}

/// 错误信息标注具体跳 (会议6: 任一跳失败可定位)
fn prefix_hop(e: AppError, hop: u8) -> AppError {
    match e {
        AppError::Tunnel { code, message } => AppError::Tunnel {
            code,
            message: format!("[hop{hop}] {message}"),
        },
        other => other,
    }
}

/// 在已有异步流 (hop1 的 direct-tcpip 通道) 上建立 hop2 SSH 会话
#[allow(clippy::too_many_arguments)]
async fn open_ssh_session_over_stream<S>(
    cfg: &SshTunnelConfig,
    user: &str,
    host: &str,
    port: u16,
    auth_type: SshAuthType,
    password: Option<&str>,
    key_path: Option<&str>,
    host_store: Arc<HostKeyStore>,
    stream: S,
) -> Result<SshSession, AppError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let host_port = format!("{host}:{port}");
    let host_key_error: Arc<RwLock<Option<String>>> = Arc::new(RwLock::new(None));
    let handler = TunnelHandler {
        host_store: host_store.clone(),
        host_port: host_port.clone(),
        host_key_error: host_key_error.clone(),
    };
    let ssh_config = client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(15)),
        keepalive_max: 3,
        inactivity_timeout: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    };

    let mut handle = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        client::connect_stream(Arc::new(ssh_config), stream, handler),
    )
    .await
    .map_err(|_| AppError::tunnel(tunnel_err::TIMEOUT, format!("hop2 SSH 握手超时 ({host_port})")))?
    .map_err(|e| {
        if let Ok(guard) = host_key_error.try_read() {
            if let Some(msg) = guard.as_ref() {
                return AppError::tunnel(tunnel_err::HOST_KEY_MISMATCH, msg.clone());
            }
        }
        AppError::tunnel(tunnel_err::TIMEOUT, format!("hop2 SSH 连接失败: {e}"))
    })?;

    // 认证链与单跳一致, 但 OTP 配置沿用主 cfg (双跳通常同一套 MFA)
    match auth_type {
        SshAuthType::PrivateKey => {
            let key_path = key_path.ok_or_else(|| {
                AppError::tunnel(tunnel_err::INVALID_CONFIG, "hop2 私钥认证缺少 key path")
            })?;
            let key = load_private_key(key_path, cfg.passphrase.as_deref())?;
            let r = handle
                .authenticate_publickey(user, key)
                .await
                .map_err(|e| AppError::tunnel(tunnel_err::AUTH_FAILED, format!("hop2 publickey 通信失败: {e}")))?;
            if !r.success() {
                return Err(AppError::tunnel(
                    tunnel_err::AUTH_FAILED,
                    format!("hop2 publickey 认证被拒绝 (user={user})"),
                ));
            }
        }
        SshAuthType::Password => {
            let password = password.unwrap_or("");
            let has_otp = cfg.otp_secret.as_deref().map(|s| !s.is_empty()).unwrap_or(false)
                || cfg.otp_code.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
            if has_otp {
                if let Ok(true) = try_keyboard_interactive(&mut handle, user, password, cfg).await {
                    return Ok(SshSession { handle: Arc::new(handle) });
                }
                if let Ok(otp) = current_otp(cfg) {
                    let r = handle.authenticate_password(user, format!("{password}{otp}")).await;
                    if r.map(|r| r.success()).unwrap_or(false) {
                        return Ok(SshSession { handle: Arc::new(handle) });
                    }
                }
                return Err(AppError::tunnel(
                    tunnel_err::AUTH_FAILED,
                    "hop2 OTP 认证失败",
                ));
            }
            let r = handle
                .authenticate_password(user, password)
                .await
                .map_err(|e| AppError::tunnel(tunnel_err::AUTH_FAILED, format!("hop2 password 通信失败: {e}")))?;
            if !r.success() {
                return Err(AppError::tunnel(
                    tunnel_err::AUTH_FAILED,
                    format!("hop2 密码认证被拒绝 (user={user})"),
                ));
            }
        }
    }
    Ok(SshSession { handle: Arc::new(handle) })
}

// ============ WP3 单元测试 ============

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{AppError, AppErrorDto};
    use crate::models::{SshAuthType, SshTunnelConfig, TunnelType};
    use serde_json::json;

    fn base_cfg() -> SshTunnelConfig {
        serde_json::from_value(json!({
            "enabled": true,
            "tunnel_type": "direct",
            "ssh_host": "bastion.example.com",
            "ssh_port": 22,
            "ssh_user": "deploy",
            "auth_type": "password",
            "ssh_password": "hunter2"
        }))
        .unwrap()
    }

    // ---- serde 兼容矩阵 (计划 MS1 Step2: (a)-(e)) ----

    /// (a) 旧 JSON 无 ssh_tunnel 字段 → 默认 None, 可解析
    #[test]
    fn serde_legacy_json_without_ssh_tunnel() {
        let legacy = json!({
            "id": "c1", "name": "old", "db_type": "postgres",
            "host": "db.example.com", "port": 5432, "user": "u",
            "password": "***", "database": "d", "schema": null,
            "env_tag": null, "ssl_mode": null, "read_only": false
        });
        let cfg: crate::models::ConnectionConfig = serde_json::from_value(legacy).unwrap();
        assert!(cfg.ssh_tunnel.is_none());
    }

    /// (b) direct 模式缺 target_* 字段 → 可解析
    #[test]
    fn serde_direct_missing_target_fields() {
        let c = base_cfg();
        assert_eq!(c.tunnel_type, TunnelType::Direct);
        assert!(c.target_ssh_host.is_none());
        assert!(c.target_auth_type.is_none());
    }

    /// (c) enabled=false 可解析
    #[test]
    fn serde_disabled_tunnel() {
        let mut c = base_cfg();
        c.enabled = false;
        let round: SshTunnelConfig =
            serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert!(!round.enabled);
    }

    /// (d) 非法 tunnel_type → 明确报错
    #[test]
    fn serde_invalid_tunnel_type_errors() {
        let bad = json!({
            "enabled": true, "tunnel_type": "triple_hop",
            "ssh_host": "h", "ssh_user": "u", "auth_type": "password",
            "ssh_password": "p"
        });
        let r: Result<SshTunnelConfig, _> = serde_json::from_value(bad);
        let err = r.unwrap_err().to_string();
        // serde 报错形如 "unknown variant `triple_hop`, expected `direct` or `bastion_jump`"
        assert!(
            err.contains("triple_hop") || err.contains("tunnel_type"),
            "错误应指出非法值或字段: {err}"
        );
    }

    /// (e) round-trip 全字段等值 (含 bastion_jump target_*)
    #[test]
    fn serde_roundtrip_bastion_full() {
        let c: SshTunnelConfig = serde_json::from_value(json!({
            "enabled": true, "tunnel_type": "bastion_jump",
            "ssh_host": "bastion", "ssh_port": 2222, "ssh_user": "jump",
            "auth_type": "private_key",
            "ssh_private_key_path": "~/.ssh/id_ed25519",
            "passphrase": "pp", "otp_secret": "JBSWY3DPEHPK3PXP",
            "target_ssh_host": "inner-db", "target_ssh_port": 22,
            "target_ssh_user": "root", "target_auth_type": "password",
            "target_ssh_password": "tp",
            "target_ssh_private_key_path": "~/.ssh/target_key"
        }))
        .unwrap();
        let s = serde_json::to_string(&c).unwrap();
        let back: SshTunnelConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.tunnel_type, TunnelType::BastionJump);
        assert_eq!(back.target_ssh_host.as_deref(), Some("inner-db"));
        assert_eq!(back.target_auth_type, Some(SshAuthType::Password));
        assert_eq!(back.ssh_port, 2222);
        assert_eq!(back.otp_secret.as_deref(), Some("JBSWY3DPEHPK3PXP"));
    }

    // ---- Debug 脱敏 (计划 MS4 Step14) ----

    #[test]
    fn debug_output_masks_secrets() {
        let mut c = base_cfg();
        c.passphrase = Some("secret-pp".into());
        c.otp_secret = Some("JBSWY3DPEHPK3PXP".into());
        let dbg = format!("{:?}", c);
        assert!(!dbg.contains("hunter2"), "Debug 不得含明文密码: {dbg}");
        assert!(!dbg.contains("secret-pp"), "Debug 不得含明文 passphrase");
        assert!(!dbg.contains("JBSWY3DPEHPK3PXP"), "Debug 不得含 OTP secret");
        assert!(dbg.contains("***"), "应显示脱敏占位符");
    }

    // ---- TOTP RFC 6238 附录 B 向量 (6 位模式 = 8 位向量后 6 位) ----

    /// RFC 6238 测试 secret: ASCII "12345678901234567890" 的 base32
    const RFC_SECRET_B32: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn totp_rfc6238_vectors_sha1() {
        let vectors = [
            (59u64, "94287082"),
            (1111111109, "07081804"),
            (1111111111, "14050471"),
            (1234567890, "89005924"),
            (2000000000, "69279037"),
        ];
        for (t, expect8) in vectors {
            let got = generate_otp_at(RFC_SECRET_B32, t).unwrap();
            assert_eq!(got, &expect8[2..], "T={t} 6位码应为 8 位向量后 6 位");
        }
    }

    #[test]
    fn totp_invalid_base32_reports_otp_failed() {
        let err = generate_otp_at("not-base32-!!!", 59).unwrap_err();
        match err {
            AppError::Tunnel { code, .. } => assert_eq!(code, tunnel_err::OTP_FAILED),
            other => panic!("应为 Tunnel/OTP_FAILED: {other:?}"),
        }
    }

    #[test]
    fn otp_prompt_keyword_detection() {
        assert!(is_otp_prompt("Verification code:"));
        assert!(is_otp_prompt("Enter OTP token"));
        assert!(is_otp_prompt("One-time password:"));
        assert!(is_otp_prompt("MFA Code"));
        assert!(!is_otp_prompt("Password:"));
        assert!(!is_otp_prompt("Username:"));
    }

    // ---- 状态机 (计划 MS1 Step3) ----

    #[test]
    fn state_machine_legal_transitions() {
        use TunnelState::*;
        let failed = Failed { code: "X".into(), message: "m".into() };
        assert!(Disconnected.can_transition_to(&Connecting));
        assert!(Connecting.can_transition_to(&Authenticating));
        assert!(Authenticating.can_transition_to(&Forwarding));
        assert!(Forwarding.can_transition_to(&Closing));
        assert!(Closing.can_transition_to(&Disconnected));
        assert!(failed.can_transition_to(&Disconnected));
        assert!(Connecting.can_transition_to(&failed));
        assert!(Forwarding.can_transition_to(&failed));
    }

    #[test]
    fn state_machine_illegal_transitions_rejected() {
        use TunnelState::*;
        assert!(!Disconnected.can_transition_to(&Forwarding), "不得跳级");
        assert!(!Connecting.can_transition_to(&Forwarding), "不得跳过认证");
        assert!(!Forwarding.can_transition_to(&Disconnected), "关闭须经 Closing");
        assert!(!Disconnected.can_transition_to(&Failed { code: "X".into(), message: "m".into() }));
    }

    #[test]
    fn state_serde_tag_format() {
        let s = TunnelState::Failed {
            code: tunnel_err::AUTH_FAILED.into(),
            message: "bad".into(),
        };
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["state"], "failed");
        assert_eq!(json["code"], "TUNNEL_AUTH_FAILED");
        assert_eq!(
            serde_json::to_value(&TunnelState::Forwarding).unwrap()["state"],
            "forwarding"
        );
    }

    // ---- 错误码 DTO 双通道 (计划 MS1 Step4) ----

    #[test]
    fn tunnel_error_serializes_code_and_message() {
        let e = AppError::tunnel(tunnel_err::HOST_KEY_MISMATCH, "指纹不一致");
        let dto: AppErrorDto = e.to_dto();
        assert_eq!(dto.code, "TUNNEL_HOST_KEY_MISMATCH");
        assert_eq!(dto.message, "指纹不一致");
        for code in [
            tunnel_err::AUTH_FAILED,
            tunnel_err::HOST_KEY_MISMATCH,
            tunnel_err::CHANNEL_REFUSED,
            tunnel_err::TIMEOUT,
            tunnel_err::PORT_EXHAUSTED,
            tunnel_err::OTP_FAILED,
            tunnel_err::KEY_FILE_ERROR,
            tunnel_err::INVALID_CONFIG,
            tunnel_err::DISCONNECTED,
        ] {
            assert!(code.starts_with("TUNNEL_"), "{code} 违反冻结命名");
        }
    }

    // ---- 配置校验 ----

    #[test]
    fn validate_rejects_incomplete_configs() {
        let mut c = base_cfg();
        c.ssh_host = " ".into();
        assert!(matches!(
            validate(&c, "db"),
            Err(AppError::Tunnel { code, .. }) if code == tunnel_err::INVALID_CONFIG
        ));

        let mut c2 = base_cfg();
        c2.auth_type = SshAuthType::PrivateKey;
        c2.ssh_private_key_path = None;
        assert!(validate(&c2, "db").is_err(), "privatekey 缺路径应报错");

        let mut c3 = base_cfg();
        c3.tunnel_type = TunnelType::BastionJump;
        assert!(validate(&c3, "db").is_err(), "bastion_jump 缺 target 应报错");
        c3.target_ssh_host = Some("inner".into());
        c3.target_ssh_user = Some("root".into());
        assert!(validate(&c3, "db").is_ok());

        assert!(validate(&base_cfg(), "").is_err(), "空 db_host 应报错");
        assert!(validate(&base_cfg(), "db.internal").is_ok());
    }

    // ---- HostKeyStore TOFU ----

    #[test]
    fn host_key_tofu_trust_then_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let store = HostKeyStore::new(dir.path().join("known_hosts.json"));
        assert!(store.verify_or_trust("h:22", "SHA256:aaa").unwrap());
        assert!(!store.verify_or_trust("h:22", "SHA256:aaa").unwrap());
        let err = store.verify_or_trust("h:22", "SHA256:bbb").unwrap_err();
        match err {
            AppError::Tunnel { code, message } => {
                assert_eq!(code, tunnel_err::HOST_KEY_MISMATCH);
                assert!(message.contains("SHA256:aaa") && message.contains("SHA256:bbb"));
            }
            other => panic!("应为 HOST_KEY_MISMATCH: {other:?}"),
        }
        assert!(store.verify_or_trust("other:22", "SHA256:ccc").unwrap());
    }

    #[test]
    fn host_key_store_survives_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kh.json");
        {
            let s = HostKeyStore::new(path.clone());
            s.verify_or_trust("h:22", "SHA256:x").unwrap();
        }
        let s2 = HostKeyStore::new(path);
        assert!(s2.verify_or_trust("h:22", "SHA256:y").is_err());
    }

    // ---- 路径展开与私钥错误分类 ----

    #[test]
    fn expand_tilde_prefix() {
        let p = expand_tilde("~/.ssh/id_rsa");
        assert!(
            !p.to_string_lossy().starts_with("~/"),
            "~ 应被展开: {p:?}"
        );
        let abs = expand_tilde("/etc/hosts");
        assert_eq!(abs, PathBuf::from("/etc/hosts"), "绝对路径不应改变");
        let rel = expand_tilde(".ssh/id_rsa");
        assert_eq!(rel, PathBuf::from(".ssh/id_rsa"));
    }

    #[test]
    fn private_key_missing_file_error() {
        let err = load_private_key("/nonexistent/path/key_xyz", None).unwrap_err();
        match err {
            AppError::Tunnel { code, message } => {
                assert_eq!(code, tunnel_err::KEY_FILE_ERROR);
                assert!(message.contains("不存在"));
            }
            other => panic!("应为 KEY_FILE_ERROR: {other:?}"),
        }
    }

    #[test]
    fn private_key_bad_format_error() {
        let dir = tempfile::tempdir().unwrap();
        let key_path = dir.path().join("bad_key");
        std::fs::write(&key_path, "this is not a private key at all").unwrap();
        let err = load_private_key(key_path.to_str().unwrap(), None).unwrap_err();
        match err {
            AppError::Tunnel { code, message } => {
                assert_eq!(code, tunnel_err::KEY_FILE_ERROR);
                assert!(message.contains("格式"), "应报格式错误: {message}");
                assert!(
                    !message.contains("this is not a private key"),
                    "错误信息不得含文件内容"
                );
            }
            other => panic!("应为 KEY_FILE_ERROR: {other:?}"),
        }
    }

    // ---- 本地端口分配 (计划 MS2 Step6) ----

    #[tokio::test]
    async fn local_port_allocation_unique_and_loopback() {
        let mut listeners = Vec::new();
        let mut ports = std::collections::HashSet::new();
        for _ in 0..50 {
            let (l, port) = bind_local().await.unwrap();
            let addr = l.local_addr().unwrap();
            assert!(
                addr.ip().is_loopback(),
                "只允许绑定 127.0.0.1, 实际 {}",
                addr.ip()
            );
            assert!(ports.insert(port), "50 次分配端口必须唯一");
            listeners.push(l);
        }
        drop(listeners); // 关闭后端口可复用
        let (_l2, _p2) = bind_local().await.unwrap();
    }

    #[tokio::test]
    async fn local_port_concurrent_allocation() {
        let handles: Vec<_> = (0..20)
            .map(|_| tokio::spawn(async { bind_local().await }))
            .collect();
        let mut ports = std::collections::HashSet::new();
        let mut listeners = Vec::new();
        for h in handles {
            let (l, p) = h.await.unwrap().unwrap();
            assert!(ports.insert(p), "并发分配端口冲突");
            listeners.push(l);
        }
    }

    // ---- TunnelManager 生命周期 ----

    #[tokio::test]
    async fn manager_state_disconnected_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let m = TunnelManager::with_host_store(dir.path().join("kh.json"));
        assert_eq!(m.state("no-such-conn").await, TunnelState::Disconnected);
        assert_eq!(m.active_count().await, 0);
        m.close("no-such-conn").await; // 幂等, 不 panic
        m.close_all().await;
        assert_eq!(m.active_count().await, 0);
    }

    #[tokio::test]
    async fn manager_open_failure_records_failed_state() {
        let dir = tempfile::tempdir().unwrap();
        let m = TunnelManager::with_host_store(dir.path().join("kh.json"));
        let mut cfg = base_cfg();
        cfg.ssh_host = "".into();
        let err = m.open("c1", cfg, "db".into(), 5432).await.unwrap_err();
        assert!(
            matches!(err, AppError::Tunnel { code, .. } if code == tunnel_err::INVALID_CONFIG)
        );
        let st = m.state("c1").await;
        match st {
            TunnelState::Failed { code, .. } => assert_eq!(code, tunnel_err::INVALID_CONFIG),
            other => panic!("应记录 Failed 状态: {other:?}"),
        }
        m.close("c1").await;
        assert_eq!(m.state("c1").await, TunnelState::Disconnected);
    }

    #[tokio::test]
    async fn manager_unreachable_host_reports_tunnel_error() {
        let dir = tempfile::tempdir().unwrap();
        let m = TunnelManager::with_host_store(dir.path().join("kh.json"));
        let mut cfg = base_cfg();
        cfg.ssh_host = "127.0.0.1".into();
        cfg.ssh_port = 1; // 无服务端口 → 连接拒绝
        let err = m.open("c2", cfg, "db".into(), 5432).await.unwrap_err();
        assert!(matches!(err, AppError::Tunnel { .. }), "应为隧道错误: {err:?}");
    }

    // ---- current_otp 优先级 ----

    #[test]
    fn current_otp_manual_code_wins() {
        let mut c = base_cfg();
        c.otp_code = Some("123456".into());
        c.otp_secret = Some(RFC_SECRET_B32.into());
        assert_eq!(current_otp(&c).unwrap(), "123456", "手填 otp_code 优先");

        let mut c2 = base_cfg();
        c2.otp_code = Some("".into());
        c2.otp_secret = Some(RFC_SECRET_B32.into());
        let code = current_otp(&c2).unwrap();
        assert_eq!(code.len(), 6, "应由 secret 生成 6 位码");

        let c3 = base_cfg();
        assert!(current_otp(&c3).is_err(), "无 code 无 secret 应报错");
    }
}
