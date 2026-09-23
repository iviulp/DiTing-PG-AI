# WP3 开发计划：SSH 隧道后端实现（Tauri 2.0 + Rust + React18）

> 产出方式：多角色评审团队十次会议纪要 + 开发步骤清单
> 范围：为 DiTing PG AI 补齐 Rust 后端 SSH 隧道能力（direct 单跳 / bastion_jump 堡垒机双跳、password/private_key/passphrase 认证、TOTP OTP），前端 `SshTunnelConfig`（src/types/index.ts:57-80）与 `ConnectionModal.tsx`（722 行，SSH UI 已就绪）无需结构性改动。
> 现状事实核查（评审基线）：
> - 后端 `ConnectionConfig`（src-tauri/src/models/mod.rs，75 行）**无 ssh_tunnel 字段**；
> - `DbService::connect()`（src-tauri/src/services/db_service.rs:100-153）直接 `format!` URL 连远端，池存储为 `pools: Arc<RwLock<HashMap<String, (AnyPool, ConnectionConfig)>>>`（db_service.rs:24）；
> - Cargo.toml 技术栈：tokio 1.38 full、sqlx 0.8（runtime-tokio）、serde 1.0、zeroize/secrecy 已在依赖中，无 SSH/TOTP crate；
> - Rust 侧 grep 无任何 ssh/otp/totp 实现痕迹。

---

## 会议 1：SSH crate 选型评审（russh vs ssh2）

**议题**：确定 WP3 使用的 SSH 客户端库，权衡 async 契合度、二级转发支持、维护状态。

**角色发言要点**
- **系统架构师**：项目全异步栈（tokio + sqlx runtime-tokio + tauri async command）。ssh2 是 libssh2 的 FFI 同步绑定，每次 channel 操作都要 `spawn_blocking` 包裹，双跳场景下需要嵌套两层 blocking，代码形态割裂、易死锁（RwLock 跨 blocking 边界）。russh 是纯 Rust tokio 原生实现，`channel_open_direct_tcpip` 天然返回 AsyncRead/AsyncWrite 流，可直接接本地 TcpListener 转发循环。
- **Rust后端**：russh 双跳实现路径清晰——先 `connect(bastion)`，在堡垒机 session 上 `channel_open_direct_tcpip(target_host, target_port)` 得到流，再以该流作为传输层再跑一个 russh client 会话（ProxyStream 模式），第二跳上再开 direct-tcpip 指向 DB。ssh2 做二级转发要用 `session.channel_direct_tcpip` + 手工把 channel 桥进第二个 ssh2::Session，官方示例稀少。
- **网络工程师**：russh 支持 chacha20-poly1305、aes-gcm、curve25519、ed25519、keyboard-interactive、OpenSSH 证书；认证方式覆盖 password/publickey/keyboard-interactive，满足堡垒机常见配置。keepalive/心跳需自己按 `Handler::check_server_key` 之外补 `channel` 级探活，可接受。
- **安全工程师**：russh 代码内 `deny(clippy::unwrap_used/panic)`，CryptoVec 用 mlock 保护敏感内存，与我们已有 zeroize 策略一致；纯 Rust 无 C 依赖，供应链攻击面小于 libssh2。ssh2 crate 依赖系统 libssl/libssh2，交叉编译（mac/win 打包）时 OpenSSL 版本地狱。
- **DevOps**：russh 无 C 依赖 → `cargo build` 在 macOS/Windows CI 上零额外安装；ssh2 需要 vcpkg/brew libssh2，Tauri 打包脚本复杂度上升。
- **发布经理**：russh 0.63.x（2026-09 仍在发版，Warp 公司主导维护，1.8k stars，被 Warpgate/Devolutions Gateway 等生产级堡垒机项目采用）；风险是 0.x 版本 API 有 breaking change 历史，需锁定次版本。ssh2 crate 更新缓慢。

**决议**
1. **选用 russh（锁定 `russh = "0.63"`，启用 `ring` 或 `aws-lc-rs` 加密后端），不引入 ssh2。**
2. 双跳采用「流上再跑 SSH 会话」模式：hop1 session → `channel_open_direct_tcpip(target)` → 以该 channel 为 AsyncRead/AsyncWrite 建 hop2 session → `channel_open_direct_tcpip(db_host, db_port)` → 桥接本地端口。
3. TOTP 选用 `totp-rs = "5"`（MIT、~95万月下载、支持 RFC 6238 默认参数、Secret::Encoded base32 输入与前端 otp_secret 语义吻合）。
4. 在 Cargo.toml 固定次版本并记录 russh 升级需回归隧道集成测试。

---

## 会议 2：TunnelManager 总体架构

**议题**：TunnelManager 服务的模块划分、对外 API、与 DbService 的集成点。

**角色发言要点**
- **系统架构师**：新增 `src-tauri/src/services/tunnel_service.rs`，暴露 `TunnelManager`：`open(cfg: &SshTunnelConfig, db_host: &str, db_port: u16) -> Result<TunnelHandle>`、`close(handle_id)`、`close_all()`。返回的 `TunnelHandle { id: Uuid, local_port: u16, join_task: JoinHandle<()> }`。DbService 不感知 SSH 细节，只拿到 `127.0.0.1:local_port`。
- **Rust后端**：TunnelHandle 实现 Drop 时发送关闭信号（oneshot），转发 task 用 `tokio::select!` 监听 shutdown；每条 TCP 连接一个 forward task（accept loop → spawn 双向 copy）。`connect()` 改造点唯一：db_service.rs:103 前插入「若 `config.ssh_tunnel.enabled` 则 open 隧道，并将后续 URL 的 host/port 替换为 127.0.0.1/local_port」。
- **产品经理**：用户心智是「勾选 SSH 后连接体验不变」，失败必须给出可读错误（堡垒机拒绝/密码错/OTP 过期/目标不可达分别区分），这决定 AppError 要扩展隧道错误变体。
- **网络工程师**：direct 模式语义澄清——本机端口 → ssh_host → 目标 db（db_host:db_port 是 SSH 服务器视角的远端地址，即 `channel_open_direct_tcpip(config.host, config.port)`）；bastion_jump 是 本机 → 堡垒机 → target_ssh_host → db（第二跳 SSH 到 target 机器，再 direct-tcpip 到 db）。两种模式共享同一个 forward 层，仅跳数不同。
- **QA测试**：TunnelManager 需要状态可查询（`state(handle_id) -> TunnelState`），否则测试与 UI 状态显示都无从断言；状态机见会议 3。
- **UX设计**：连接中需要中间态反馈（"正在连接堡垒机…"→"正在建立二跳…"→"正在连接数据库…"），建议 open 接口带进度 callback / 事件（Tauri emit `tunnel://progress`），MVP 可先只做整体 loading，但架构上留出。

**决议**
1. 新增 `TunnelManager`（tunnel_service.rs），注册为 Tauri managed state；API：`open / close / close_all / state`。
2. `connect()` 中当 `ssh_tunnel.enabled == true` 且 db_type != Sqlite 时先建隧道，sqlx URL 指向 `127.0.0.1:{local_port}`，其余建池逻辑（max_connections=5、acquire_timeout=10s）不变。
3. SQLite + ssh_tunnel 组合直接返回参数错误（无网络端点可转发）。
4. AppError 增加 `TunnelError` 变体族：认证失败、主机密钥校验失败、通道打开失败、超时、端口耗尽，前端 toast 文案可区分。
5. 进度事件用 Tauri emit 预留 `tunnel-progress` 事件名，MVP 阶段仅在关键跳完成时发一次。

---

## 会议 3：隧道生命周期与端口分配策略

**议题**：隧道句柄与连接池的绑定、断开/重连/应用退出时的清理、本地端口分配。

**角色发言要点**
- **Rust后端**：pools map 当前 value 是 `(AnyPool, ConnectionConfig)`，扩展为 `(AnyPool, ConnectionConfig, Option<TunnelHandle>)`（或建独立 `tunnels: HashMap<conn_id, TunnelHandle>` 并保证两 map 同锁原子更新）。disconnect(conn_id) 时：先 `pool.close().await`（排空 sqlx 连接，防止仍有流量打在隧道上），再 drop/close TunnelHandle。`connect()` 重复调用刷新配置时（db_service.rs:150 注释已声明允许），必须**先关旧隧道再开新隧道**，避免句柄泄漏。
- **系统架构师**：App 退出钩子（Tauri `RunEvent::Exit` / `on_window_event Destroyed`）调用 `close_all()`；转发 task 全部为 daemon 式 spawn，父 task 收到 shutdown 后 abort 子 copy task。崩溃兜底：本地 TcpListener drop 即端口释放，OS 层无残留。
- **网络工程师（端口分配）**：方案 A 固定区间（如 15000-16000）轮询；方案 B `TcpListener::bind("127.0.0.1:0")` 让 OS 分配，再 `local_addr()` 读实际端口。方案 B 无竞争、无需持久化分配表、多实例安全，唯一注意点：bind 到 listener 交给 russh accept loop 之间存在毫秒级窗口，但监听 socket 未关闭，端口不会被别人抢走 → 采用 B。
- **DBA**：sqlx 连接池 5 个连接全部走同一本地端口，隧道 forward loop 每连接一个 task，5+1（accept）task 开销可忽略；提醒 MySQL 的 wait_timeout 与 SSH 通道空闲断开的叠加效应——隧道断但池不知道，会产生"看似活着"的死连接，建议 forward task 异常退出时把 conn_id 标记为失效并 emit 事件，UI 显示"连接已断开"。
- **QA测试**：需要覆盖：断开时端口已释放（bind 同端口应成功）、connect 二次调用不泄漏旧隧道（隧道计数不增长）、应用退出后无残留进程/task。
- **DevOps**：Windows 上 127.0.0.1:0 行为一致，无平台特判需要。

**决议**
1. 端口分配采用 **`bind("127.0.0.1:0")` OS 动态分配**，绑定后不释放 socket，直接 move 进 accept 循环；拒绝固定区间方案。
2. pools map value 扩展为三元组 `(AnyPool, ConnectionConfig, Option<TunnelHandle>)`；disconnect 与重连均遵循「先关池、后关隧道；重连先关旧再开新」。
3. TunnelHandle Drop ⇒ oneshot 通知 ⇒ accept/forward task 优雅退出；`close_all()` 挂接 Tauri Exit 事件。
4. 隧道异常断开（远端 RST/心跳失败）⇒ emit `tunnel-disconnected` 事件（携带 conn_id），MVP 不做自动重连（记入 backlog）。
5. keepalive：russh config `keepalive_interval = 15s`、`keepalive_max = 3`，防堡垒机空闲踢线。

---

## 会议 4：OTP (TOTP) 支持方案

**议题**：otp_secret 生成动态码、与堡垒机 keyboard-interactive 认证的对接、时钟偏移处理。

**角色发言要点**
- **安全工程师**：RFC 6238 TOTP，默认 SHA1/30s/6 位；`totp-rs` 的 `Rfc6238::with_defaults(Secret::Encoded(otp_secret).to_bytes())` 直接匹配前端存储的 base32 secret。生成时机必须是**认证握手进行中**（keyboard-interactive challenge 到达时）而非提前生成，避免 30s 窗口滑过导致 OTP 失效。
- **Rust后端**：堡垒机 OTP 通常走 keyboard-interactive：russh `Handler::check_server_key` 之外，认证失败回退链为 publickey → password → keyboard-interactive；在 keyboard-interactive 回调里，若 prompt 含 "otp/token/code/验证码" 且配置了 otp_secret，则注入 `totp.generate_current()`；若用户手填了 `otp_code`（一次性场景），优先用手填码（password 拼接模式：部分堡垒机要求 `password+otp` 直接拼在密码后）。两种注入策略都实现，按堡垒机类型选择。
- **网络工程师**：注意 SSH keyboard-interactive 可能多轮 prompt（先密码后 OTP），实现需逐 prompt 匹配而非一次性提交。
- **DBA**：TOTP 只在隧道认证阶段使用，与 DB 认证无关，边界清晰，无异议。
- **QA测试**：RFC 6238 Appendix B 测试向量（SHA1，secret "12345678901234567890" ⇒ base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ，T=59s→"94287082" 8位；6 位标准向量见测试清单）；还需覆盖 secret 非法 base32、时钟偏移 ±30s（totp-rs 的 `check_current` 带 skew）。
- **UX设计**：前端已有 otp_code 输入框；建议 placeholder 提示"留空则自动从 otp_secret 生成"；OTP 过期错误文案明确提示检查系统时间。

**决议**
1. 引入 `totp-rs = "5"`，封装 `fn generate_otp(secret_b32: &str) -> Result<String>`（SHA1/30s/6位，RFC 6238 默认）。
2. 认证回退链：private_key（含 passphrase 解密）→ password → keyboard-interactive；keyboard-interactive prompt 命中 OTP 关键词时：`otp_code` 手填值优先，否则实时 `generate_current()`。
3. 兼容"password+OTP 拼接"型堡垒机：配置层增加判定——若 auth_type=password 且 otp_secret/otp_code 存在，认证时尝试 `format!("{}{}", password, otp)`（作为 password 认证失败后 keyboard-interactive 之前的备选，日志脱敏）。
4. secret 非法/时钟异常返回专用错误 `TunnelError::OtpGenerationFailed`，前端提示检查系统时间。
5. otp_secret 属敏感数据：内存中用 zeroize 包装，日志永不输出（与会议 5 一致）。

---

## 会议 5：Rust ConnectionConfig 扩展与 serde 兼容性

**议题**：models/mod.rs 增加 ssh_tunnel 可选字段，保证前后端 JSON 双向兼容与旧数据可加载。

**角色发言要点**
- **Rust后端**：镜像 TS 定义新增 `SshTunnelConfig` struct，全部可选字段用 `Option<T>` + `#[serde(default)]`；`ConnectionConfig` 加 `#[serde(default)] pub ssh_tunnel: Option<SshTunnelConfig>`。关键点：**旧版本前端/已存 JSON 无此字段必须能反序列化**（serde(default) 保证），**新后端序列化回给旧前端多出的字段会被忽略**（TS 端 ssh_tunnel 本来就是可选，天然兼容）。`tunnel_type` 用 `#[serde(rename_all = "snake_case")] enum TunnelType { Direct, BastionJump }` 映射 'direct'/'bastion_jump'。
- **系统架构师**：前端 TS 的 `tunnel_type` 默认 'direct'，Rust enum 实现 `Default for TunnelType = Direct`，防止旧数据缺失该键时反序列化失败（Option<SshTunnelConfig> 内部字段也要 `#[serde(default)]`，因前端对 direct 模式会把 target_* 序列化为 undefined → JSON 中缺键）。
- **DBA（连接配置持久化视角）**：连接配置若存于前端 store/localStorage，后端只是过路解析，无迁移负担；但若 vault（argon2/aes-gcm 已存在）加密存储配置，ssh_password/passphrase/otp_secret 应进入加密通道而非明文 JSON——本期先保证传输层正确，加密落盘复用现有 vault 机制记为约束：`SshTunnelConfig` 敏感字段实现 `Zeroize` 派生，日志 Debug 输出用 `redact`（自定义 Debug 或用 secrecy::Secret 包裹）。
- **安全工程师**：`Debug` derive 会打印密码——要求敏感字段（ssh_password、passphrase、target_ssh_password、otp_secret）自定义 Debug 输出 `***`；serde 序列化给前端回显时密码字段原样返回（前端编辑回显需要，见 ConnectionModal.tsx:86-104 已依赖此行为），但 tracing 日志中一律脱敏。
- **QA测试**：兼容性矩阵测试——(a) 无 ssh_tunnel 键的旧 JSON；(b) ssh_tunnel 存在但 target_* 全缺（direct 模式）；(c) enabled=false；(d) tunnel_type 非法值应报明确 serde 错误；(e) 双向 round-trip（序列化→反序列化等值）。

**决议**
1. models/mod.rs 新增 `TunnelType` enum（Direct/BastionJump，snake_case，Default=Direct）与 `SshTunnelConfig` struct，字段与 TS 一一对应，全 Option/serde(default)。
2. `ConnectionConfig` 增加 `#[serde(default)] pub ssh_tunnel: Option<SshTunnelConfig>`；不改动既有字段，旧数据零迁移。
3. 敏感字段自定义 Debug 脱敏 + `Zeroize` 派生；tracing 日志禁止输出任何凭据。
4. 验收：兼容性矩阵 (a)-(e) 全部通过单测。

---

## 会议 6：双跳转发数据面与错误处理（网络专项）

**议题**：direct-tcpip 通道桥接实现细节、超时、并发转发、堡垒机主机密钥策略。

**角色发言要点**
- **网络工程师**：本地 `TcpStream ⇄ russh Channel` 桥接用 `tokio::io::copy_bidirectional`（Channel 已实现 AsyncRead/AsyncWrite）；bastion_jump 时 hop1 的 direct-tcpip channel 直接作为 hop2 `russh::client::connect_stream` 的传输。连接超时统一 15s（`tokio::time::timeout` 包裹 connect 与 channel_open），与 sqlx acquire_timeout=10s 匹配（隧道先建好，池超时独立）。
- **安全工程师**：主机密钥校验——MVP 采用 TOFU（trust-on-first-use）+ 指纹记录：首次连接存指纹到本地，后续不一致则硬失败并提示（防中间人）；禁止实现"永远接受"的 `check_server_key -> Ok(true)` 走捷径。known_hosts 文件解析列为 backlog。
- **Rust后端**：并发上限——单隧道 forward task 数不设硬限（DB 池 max 5，实际并发低）；accept loop 错误（channel_open 被拒）只杀单条连接并 tracing::warn，不掀翻整个隧道；russh `Handler` 需要实现 `check_server_key`、`server_session_disconnected`（触发会议 3 的失效标记）。
- **DBA**：MySQL 握手包较大时 russh channel 窗口（默认 2MB 级）足够；提醒 PostgreSQL SSL 协商走隧道明文转发即可（TLS 端到端由 sqlx tls-rustls 处理，隧道只当 TCP 管子，不做 TLS 终止）——这正是正确分层。
- **QA测试**：异常注入清单：堡垒机端口不通、认证失败、channel_open_direct_tcpip 被服务器拒绝（AllowTcpForwarding no）、转发中途远端断开、目标 DB 端口错（隧道通但 DB 拒连，错误应归因 DB 而非隧道）。
- **DevOps**：集成测试环境用 docker `lscr.io/linuxserver/openssh-server` 或自建 sshd 容器（配 AllowTcpForwarding yes + password/publickey + 可选 Google Authenticator PAM 测 OTP），compose 编排两台（bastion+target）模拟双跳。

**决议**
1. 桥接统一 `copy_bidirectional`；每跳 connect/channel_open 加 15s 超时。
2. 主机密钥策略：TOFU + 指纹持久化（存 app data dir），不一致硬失败；`check_server_key` 禁止无条件放行。
3. channel_open 失败/单流断开仅影响单条 TCP 连接；session 级断开才触发隧道失效事件。
4. 隧道定位为纯 TCP 转发层，DB TLS 仍由 sqlx 端到端处理，不在隧道内做 TLS。
5. 集成测试 docker sshd 双容器方案立项为**可选**（P2），CI 默认只跑单测 + 单容器冒烟。

---

## 会议 7：安全专项评审

**议题**：凭据处理、内存安全、日志脱敏、攻击面收敛。

**角色发言要点**
- **安全工程师（主讲）**：① ssh_password/passphrase/otp_secret 仅存于内存与既有 vault 加密通道，禁止写入 tracing、panic backtrace 可打印路径（Debug 脱敏已在会议 5 决议）；② 私钥文件读取支持 `~` 展开（前端默认值就是 `~/.ssh/id_rsa`，见 ConnectionModal.tsx:94），读取失败错误不得回显文件内容；③ passphrase 解密私钥用 russh-keys（`load_secret_key`），失败区分"文件不存在/格式错/passphrase 错"；④ 本地监听仅绑 127.0.0.1，绝不 0.0.0.0（防止局域网他人借用隧道打内网 DB——这是堡垒机场景最大风险）；⑤ TOTP secret 为高危凭据，UI 上建议后续加掩码显示。
- **Rust后端**：russh CryptoVec 已 mlock；我方持有的 String 密码在 TunnelHandle 生命周期结束用 zeroize 清零（`Zeroizing<String>` 包装配置克隆体）。
- **产品经理**：本地端口仅回环 ⇒ 多用户共享一台机器时其他 OS 用户可连 127.0.0.1 端口？——安全工程师确认：DB 自身仍有账号密码认证，且桌面单用户场景风险可接受，记录为已知限制。
- **DevOps**：依赖审计——russh/totp-rs 纳入 `cargo audit` CI 步骤。
- **QA测试**：安全测试项：绑核验证（netstat 确认 127.0.0.1）、日志 grep 密码明文必须为零命中、错误消息不含凭据片段。

**决议**
1. 监听强制 `127.0.0.1:0`，代码评审时作为硬门禁。
2. 凭据三不落：不落日志、不落明文磁盘（新增持久化仅限主机密钥指纹）、不落错误消息。
3. 私钥路径支持 `~` 与绝对路径；passphrase 解密失败给出区分性错误。
4. `cargo audit` 加入 CI；russh 锁次版本，升级走回归。
5. 已知限制记录：同机其他 OS 用户可访问回环端口（DB 认证兜底）。

---

## 会议 8：测试策略与验收口径（QA 主导）

**议题**：单元测试、集成测试范围，RFC 6238 向量，隧道状态机可测性，docker sshd 方案取舍。

**角色发言要点**
- **QA测试（主讲）**：单测四组——① **配置解析**：serde 兼容矩阵（会议 5 的 a-e）；② **端口分配**：连续 open 50 个隧道端口互不相同、close 后端口可复用、并发 open 无重复；③ **TOTP**：RFC 6238 附录 B 向量（SHA1/SHA256/SHA512 各取 T=59、1111111109、1111111111、1234567890、2000000000、20000000000 六个时间点，8 位模式；另测 6 位默认模式与 base32 secret 解码错误）；④ **状态机**：Disconnected→Connecting→Authenticating→Forwarding→Closing→Disconnected 全转移路径、非法转移拒绝、失败态携带错误原因。
- **Rust后端**：状态机可测性设计——`TunnelState` 为纯枚举 + `TunnelManager` 内部 `HashMap<Uuid, TunnelState>`，单测可不经真实 SSH 断言状态（把 russh 交互抽到 trait `SshConnector` 后 mock，或状态机逻辑独立成纯函数模块）。
- **系统架构师**：同意 trait 抽象（`SshConnector`），mock 实现用于全部状态机/错误路径单测；真实 russh 路径由集成测试覆盖。
- **DevOps**：docker sshd **可选**（P2）：compose 起 bastion（sshd+AllowTcpForwarding）+ target（sshd+postgres/mysql 容器）三节点；CI 上标 `#[ignore]` 或 feature gate `integration-tests`，本地 `cargo test --features integration-tests` 手动跑。不阻塞 WP3 验收。
- **DBA**：集成冒烟最小集——经隧道对 postgres 执行 `SELECT 1`、对 MySQL 执行 `SELECT 1`、断开隧道后池查询应失败且事件发出。
- **产品经理**：验收口径确认为「单测全绿 + 手动 docker 双跳冒烟通过 + 前端 ConnectionModal 不改代码即可连通」。

**决议**
1. 单测四组全列为 P0 验收项；RFC 6238 向量采用附录 B 标准时间点。
2. 引入 `SshConnector` trait 隔离 russh，状态机与错误路径 100% mock 单测覆盖。
3. docker sshd 集成测试为 P2 可选：提供 `docker-compose.ssh-test.yml` + `#[ignore]` 标注测试，不进 CI 门禁。
4. 前端零改动连通性作为最终人工验收步骤（UX 会议 9 确认交互口径）。

---

## 会议 9：前端交互与错误呈现（UX/产品对齐）

**议题**：现有 ConnectionModal 是否够用、错误文案、连接中状态、OTP 输入体验。

**角色发言要点**
- **UX设计（主讲）**：ConnectionModal.tsx 的 SSH 区块（enabled 开关、direct/bastion_jump 切换、双段凭据表单、otp_secret/otp_code）已完整，WP3 **不改前端结构**；需要补的是错误呈现——后端 TunnelError 变体映射中文文案：认证失败→"SSH 认证失败：请检查密码/私钥/passphrase"；OTP 失败→"动态验证码无效，请检查 otp_secret 与系统时间"；主机密钥变更→"堡垒机主机密钥已变更，可能存在安全风险"（附指纹对比）；超时→"连接 {host}:{port} 超时"。
- **产品经理**：MVP 不做进度分段 UI（会议 2 预留的 tunnel-progress 事件先埋点不消费）；断开事件（tunnel-disconnected）MVP 需要消费——连接列表项显示断开角标，否则用户对着死连接执行 SQL 会困惑。
- **Rust后端**：错误映射在前端一处 `mapTunnelError(code)` 工具函数完成，后端 AppError 携带稳定的 error code 字符串 + 人类可读 message 双通道。
- **QA测试**：UI 验收走查清单：direct 连通、bastion_jump 连通、密码错误提示、OTP 过期提示、编辑已存隧道配置回显（含 target_* 字段，ConnectionModal.tsx:99-104 已实现回显，验证后端 round-trip 不丢字段）。
- **发布经理**：WP3 出口不含前端代码变更 ⇒ 不需要前端回归全量，只回归 ConnectionModal 相关路径。

**决议**
1. 前端零结构改动；仅新增错误码→文案映射函数与 tunnel-disconnected 事件消费（连接列表断开角标）。
2. 后端错误响应统一 `{ code: string, message: string }`，code 枚举冻结于本文档附录。
3. 进度分段 UI、known_hosts 管理 UI 记入 backlog。
4. UI 验收走查清单纳入最终验收（见开发步骤清单）。

---

## 会议 10：发布计划与里程碑（发布经理主导）

**议题**：任务排序、依赖关系、里程碑、风险与回退。

**角色发言要点**
- **发布经理（主讲）**：依赖链——models 扩展（M5 决议）是一切前提 → tunnel_service 骨架+状态机 → russh 单跳 direct → 双跳 bastion_jump → TOTP → DbService 集成 → 前端错误映射/事件消费 → 测试收口。建议 4 个里程碑：MS1 数据模型+骨架（可编译可单测）、MS2 direct 隧道端到端打通、MS3 bastion_jump+TOTP、MS4 集成+测试+文档。
- **Rust后端**：MS1/MS2 是最小可演示单元，建议 MS2 结束即做一次真机手动验证（真实堡垒机或本地 sshd），避免 russh API 理解偏差堆积到后期。
- **DevOps**：russh 0.63 首次引入会拉长编译时间（纯 Rust 加密栈），CI 缓存 Cargo registry；发布前 `cargo audit` + macOS/Windows 双平台打包冒烟（验证无 C 依赖的交叉编译优势兑现）。
- **QA测试**：MS4 出口 = 会议 8 决议的 P0 全绿 + P2 docker 冒烟手动通过 + 会议 9 UI 走查通过。
- **产品经理**：风险 Top3：① russh keyboard-interactive 多轮 prompt 实现复杂度（缓解：MS3 预留 2 天缓冲，先做 password+OTP 拼接兜底）；② 真实堡垒机环境不可控（缓解：本地 sshd 容器先行，真机验证列为 MS3 出口人工步骤）；③ russh 0.x API 变动（缓解：锁版本）。
- **系统架构师**：回退策略——ssh_tunnel 字段全程可选，功能以 `enabled` 开关隔离，任何阶段出问题不影响既有直连功能发布；极端情况 feature flag（Cargo feature `ssh-tunnel`）整体编译剔除。

**决议**
1. 里程碑 MS1→MS4 按依赖链排序（详见开发步骤清单），MS2 后强制真机/容器手动验证一次。
2. 风险缓冲：MS3 含 +2 天 OTP/keyboard-interactive 缓冲。
3. 发布门禁：cargo audit 零高危、双平台打包冒烟、P0 测试全绿。
4. 回退方案：功能由 `ssh_tunnel.enabled` 隔离，直连路径零改动风险；可选 Cargo feature 整体裁剪。
5. Backlog（不入 WP3）：自动重连、known_hosts 管理 UI、进度分段 UI、多跳（>2）泛化、SSH agent 转发。

---

## 开发步骤清单

### 阶段 MS1：数据模型与服务骨架（P0）

| # | 步骤 | 文件 | 验收标准 |
|---|------|------|----------|
| 1 | Cargo.toml 增加 `russh = "0.63"`（ring 后端）、`totp-rs = "5"`、`dirs`（~ 展开，若未有） | src-tauri/Cargo.toml | `cargo check` 通过，锁版本 |
| 2 | 新增 `TunnelType` enum（serde snake_case，Default=Direct）、`SshTunnelConfig` struct（全字段镜像 TS，Option+serde(default)，敏感字段 Debug 脱敏+Zeroize 派生）；`ConnectionConfig` 加 `#[serde(default)] ssh_tunnel: Option<SshTunnelConfig>` | src-tauri/src/models/mod.rs | 兼容矩阵单测 (a)-(e) 全过：旧 JSON 可解析、direct 缺 target_* 可解析、非法 tunnel_type 报明确错误、round-trip 等值 |
| 3 | 新建 tunnel_service.rs：`TunnelState` 枚举（Disconnected/Connecting/Authenticating/Forwarding/Closing/Failed）、`TunnelHandle`、`SshConnector` trait（russh 交互抽象）、`TunnelManager { open/close/close_all/state }` 骨架 + mock connector | src-tauri/src/services/tunnel_service.rs | 状态机单测：全部合法转移、非法转移拒绝、失败态带错误码 |
| 4 | AppError 扩展 `TunnelError` 变体（AuthFailed/HostKeyMismatch/ChannelOpenRefused/Timeout/PortExhausted/OtpGenerationFailed/KeyFileError/InvalidConfig），`{code, message}` 双通道 | src-tauri/src/error.rs（或现有错误模块） | 错误 code 枚举与文档附录一致，单测断言序列化 |

### 阶段 MS2：direct 单跳隧道端到端（P0）

| # | 步骤 | 文件 | 验收标准 |
|---|------|------|----------|
| 5 | 实现 russh `Handler`：check_server_key（TOFU+指纹持久化，不一致硬失败）、password/publickey(passphrase)/keyboard-interactive 认证链、keepalive 15s×3 | tunnel_service.rs | 单容器 sshd 手动冒烟：认证成功建立会话；主机密钥变更被拒绝 |
| 6 | 端口分配 `bind("127.0.0.1:0")` + accept loop + `copy_bidirectional` 转发；direct 模式 `channel_open_direct_tcpip(db_host, db_port)` | tunnel_service.rs | 端口单测：50 次 open 端口唯一、close 后可复用、并发 open 无冲突；监听地址仅 127.0.0.1（netstat 验证） |
| 7 | DbService::connect 集成：ssh_tunnel.enabled && db_type!=Sqlite 时先 open 隧道，URL 改指 127.0.0.1:local_port；pools map 扩为三元组；disconnect/重连先关池后关旧隧道；Sqlite+ssh 报 InvalidConfig | src-tauri/src/services/db_service.rs | 经隧道对 PG/MySQL 各执行 `SELECT 1` 成功；重连 10 次隧道句柄数不泄漏；SQLite+ssh 明确报错 |
| 8 | Tauri Exit 事件挂 `close_all()`；session 断开 emit `tunnel-disconnected` | src-tauri/src/lib.rs (或 main.rs) | 退出后无残留监听端口；kill sshd 后前端收到事件 |

### 阶段 MS3：bastion_jump 双跳 + TOTP（P0，含 2 天缓冲）

| # | 步骤 | 文件 | 验收标准 |
|---|------|------|----------|
| 9 | 双跳：hop1 channel_open_direct_tcpip(target_ssh_host, target_ssh_port) → 以该 channel 为流 `connect_stream` hop2 → hop2 direct-tcpip 到 db；每跳 15s 超时 | tunnel_service.rs | docker 双 sshd 容器冒烟：本机→堡垒机→目标机→DB `SELECT 1` 成功；任一跳失败错误码可区分定位到具体跳 |
| 10 | TOTP：`generate_otp(secret_b32)`（SHA1/30s/6位）；keyboard-interactive 多轮 prompt OTP 关键词注入（手填 otp_code 优先）；password+OTP 拼接备选路径 | tunnel_service.rs + 新 util | RFC 6238 附录 B 向量全过（SHA1/256/512 × 6 时间点，8 位；另 6 位默认模式用例）；非法 base32 报 OtpGenerationFailed |
| 11 | 私钥路径 `~` 展开；passphrase 解密错误区分（文件不存在/格式错/passphrase 错） | tunnel_service.rs | 单测 + 手动：错误私钥三类错误消息互不相同且不含文件内容 |

### 阶段 MS4：前端错误呈现 + 测试收口 + 发布门禁（P0/P2）

| # | 步骤 | 文件 | 验收标准 |
|---|------|------|----------|
| 12 | 前端 `mapTunnelError(code)` 文案映射；消费 tunnel-disconnected 事件显示断开角标（不改 ConnectionModal 结构） | src/utils/（新文件）+ 连接列表组件 | UI 走查：密码错/OTP 过期/超时/主机密钥变更四类文案正确；断开角标出现 |
| 13 | 编辑回显验证：bastion_jump 配置保存→重开 Modal→target_* 字段完整回显（后端 round-trip 不丢字段） | 无代码改动（验证项） | ConnectionModal.tsx:86-104 回显路径全字段一致 |
| 14 | 安全验收：日志 grep 全部凭据字段零命中；cargo audit 零高危；Debug 输出脱敏单测 | CI | 门禁通过 |
| 15 | （P2 可选）docker-compose.ssh-test.yml（bastion+target+PG/MySQL，可选 Google Authenticator PAM）+ `#[ignore]` 集成测试（含 AllowTcpForwarding no 拒绝、转发中断开、DB 端口错归因） | src-tauri/tests/、docker/ | 本地 `cargo test -- --ignored` 手动全过；不进 CI 门禁 |
| 16 | macOS + Windows 双平台打包冒烟（验证纯 Rust SSH 栈交叉编译）；文档更新（README/DESIGN.md 隧道章节） | build.sh、docs | 双平台安装包可连通 direct+bastion_jump |

### 测试清单汇总

**单元测试（P0，CI 门禁）**
- [ ] serde 兼容矩阵：(a) 无 ssh_tunnel 旧 JSON (b) direct 缺 target_* (c) enabled=false (d) 非法 tunnel_type 报错 (e) round-trip 等值
- [ ] 端口分配：50 次唯一 / close 后复用 / 并发无冲突 / 仅绑 127.0.0.1
- [ ] TOTP RFC 6238 附录 B 向量：SHA1/SHA256/SHA512 × T∈{59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000}（8 位）+ 6 位默认模式 + 非法 base32 secret
- [ ] 隧道状态机：合法转移全路径 / 非法转移拒绝 / Failed 携带错误码 / close_all 全量归零
- [ ] 错误码：TunnelError 变体 → {code,message} 序列化断言
- [ ] Debug 脱敏：含密码配置的 Debug 输出不含明文

**集成测试（P2 可选，docker sshd，`#[ignore]`）**
- [ ] direct：本机→sshd→PG `SELECT 1`、→MySQL `SELECT 1`
- [ ] bastion_jump：双容器双跳 `SELECT 1`
- [ ] 认证失败路径：错密码 / 错 passphrase / AllowTcpForwarding no / OTP 过期
- [ ] 生命周期：disconnect 后端口释放（可重新 bind）；kill sshd → tunnel-disconnected 事件；重连 10 次无句柄泄漏
- [ ] 主机密钥变更拒绝

**人工 UI 走查（P0 验收）**
- [ ] ConnectionModal 不改代码：direct 连通 / bastion_jump 连通 / 编辑回显完整
- [ ] 四类错误文案正确显示
- [ ] 断开角标出现

### 附录：TunnelError 错误码冻结清单
`TUNNEL_AUTH_FAILED` / `TUNNEL_HOST_KEY_MISMATCH` / `TUNNEL_CHANNEL_REFUSED` / `TUNNEL_TIMEOUT` / `TUNNEL_PORT_EXHAUSTED` / `TUNNEL_OTP_FAILED` / `TUNNEL_KEY_FILE_ERROR` / `TUNNEL_INVALID_CONFIG` / `TUNNEL_DISCONNECTED`

### Backlog（不入 WP3）
自动重连、known_hosts 管理 UI、连接进度分段 UI、>2 跳泛化、SSH agent 转发、otp_secret UI 掩码。
