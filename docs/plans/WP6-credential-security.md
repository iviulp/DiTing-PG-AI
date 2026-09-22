# WP6 开发计划：凭证与密钥安全

> 项目：DiTing PG AI（Tauri 2.0 + Rust + React18）
> 工作包：WP6『凭证与密钥安全』
> 评审形式：十角色团队会议 ×10 场（产品经理、系统架构师、Rust后端、React前端、密码学/安全工程师、合规、QA测试、UX设计、DevOps、发布经理）
> 文档状态：评审完成，进入开发排期
> 约束：本地单机桌面工具，无服务端；威胁模型 = 磁盘被拷走 / 备份文件泄露。

## 0. 现状盘点（评审输入）

| # | 问题 | 位置 | 现状 |
|---|------|------|------|
| 1 | 备份导出/导入密码硬编码 | `src-tauri/src/commands/mod.rs` `export_encrypted_bundle` / `import_encrypted_bundle`（L551/L610 `let password = b"yuguosheng"`） | Argon2id + AES-256-GCM 算法本身合格，但密码写死在二进制里，攻击者反编译即得密钥，加密形同虚设 |
| 2 | 连接密码明文存浏览器 | `src/store/useAppStore.ts`，`localStorage['aidb_connections']` | 数据库连接含明文密码，WebView localStorage 位于 `~/Library/WebKit/...`（macOS）等磁盘路径，直接可读 |
| 3 | AI 配置明文 api_key | `ai_config.json`（`src-tauri/src/services/ai_service.rs` L54）+ `localStorage['aidb_ai_config']` | 明文 JSON 落盘 |
| 4 | 鉴权空壳 + 模板残留 | `src-tauri/src/services/auth_service.rs`（`authenticate` 不校验密码直接放行）；`src-tauri/src/lib.rs`（Tauri 模板 `greet` 命令） | 假安全感；`greet` 是死代码 |
| 5 | 无安全相关单元测试 | `src-tauri/` | 加解密 roundtrip、错误密码、迁移逻辑均无覆盖 |

威胁模型定位：本地单机工具，无服务端。攻击面 = (a) 磁盘/整机被拷走；(b) `.ditingvault` 备份文件泄露；(c) 同机其他进程读取用户目录。**不在威胁模型内**：已登录系统下的内存转储对抗、恶意 root、侧信道。

---

## 1. 会议一（主持人：产品经理）——WP6 范围界定与优先级

**议题**：WP6 的边界是什么？四个子项如何排优先级？与 WP2 的分工怎么切？

**角色发言要点**：
- **产品经理**：用户可感知的价值排序——① 连接密码明文落盘是最高风险（每个用户每天都在裸奔）；② 硬编码密码使"加密备份"功能对外是虚假承诺，属于诚信问题必须修；③ api_key 明文次之（泄露损失是钱，不是数据）；④ auth_service 空壳不修也不新增风险，但留着会误导后续开发。范围冻结：本 WP 只做存储层 vault 服务与迁移，不做 UI 大改版，不做云同步。
- **系统架构师**：同意。建议抽出一个统一的 `VaultService`（Rust 端），三个子项（备份加解密、连接加密存储、ai_config 加密存储）共用同一套密钥派生与加解密原语，避免三处各写一遍 AES。
- **密码学/安全工程师**：支持统一 vault。提醒：三个用途必须密钥隔离（不同 context/purpose 派生不同子密钥），一把钥匙开三把锁是反模式。
- **React前端**：前端只保留脱敏数据（连接名、host、端口、库名），密码字段从此不出现在任何 TS 类型里。这实际是简化前端。
- **发布经理**：硬编码密码是"已知安全缺陷"，一旦发版被指出很难看，建议进下一个 minor 版本必修项，不拖到大版本。
- **QA测试**：需要明确"完成"的定义，见会议十的测试清单。

**决议**：
1. WP6 范围冻结为四项：备份主密码化、连接加密存储+迁移、api_key 纳入 vault、auth_service/greet 处置；外加单元测试。
2. 优先级：P0 = 硬编码密码移除 + 连接加密存储；P1 = api_key 入 vault；P2 = auth_service/greet 清理。
3. 与 WP2 分工：**WP6 只做存储层 vault 服务（含命令接口），WP2 负责调用方接入**（AI 调用时从 vault 取 key）。本 WP 交付后 ai_config 的读写 API 保持兼容签名，WP2 无需感知加密细节。

---

## 2. 会议二（主持人：系统架构师）——统一 Vault 服务架构设计

**议题**：VaultService 的模块结构、密钥层次、Tauri 命令面设计。

**角色发言要点**：
- **系统架构师**：提出三层密钥架构：
  - L0 主密钥（KEK）：由用户主密码经 Argon2id 派生，或从 OS keychain 取随机 KEK；
  - L1 用途子密钥：`HKDF-SHA256(KEK, info="diting/connections/v1")`、`"diting/aiconfig/v1"`、`"diting/bundle/v1"` 三条独立子密钥；
  - L2 每条记录可直接用 L1 子密钥 + 独立随机 nonce 做 AES-256-GCM。
  新模块 `src-tauri/src/services/vault_service.rs`，`commands/mod.rs` 中的备份导出/导入迁移为调用 vault 的 crypto 工具函数（`vault/crypto.rs`）。
- **Rust后端**：现有 `export/import_encrypted_bundle` 里的 Argon2id+AES-GCM 代码可直接抽成 `derive_key(password, salt) -> [u8;32]` 与 `encrypt/decrypt(key, plaintext)` 纯函数，commands 只留编排。vault 文件路径定为 `~/.aidb/connections.enc`（与任务书一致），ai_config 加密后写 `~/.aidb/ai_config.enc`，原 `ai_config.json` 迁移后删除。
- **密码学/安全工程师**：HKDF 用途隔离方案正确。补充要求：文件格式带自描述头 `{format:"AIDB_ENC_V1", kdf, salt, nonce, ciphertext}`，密文用 base64（现状用的是 urlencoding::encode_binary 做二进制转文本，**建议统一换 base64**，urlencoding 转二进制是易错且不标准的做法）。nonce 每次加密必须新生成，禁止复用。
- **DevOps**：`~/.aidb/` 目录权限 0700，文件 0600。CI 上跑测试不需要 keychain（测试走密码派生路径）。
- **React前端**：命令面希望是：`vault_list_connections()`（脱敏）、`vault_upsert_connection(conn_with_password)`、`vault_delete_connection(id)`、`vault_get_ai_config_masked()`、`vault_set_ai_config(full)`，密码只进不出。
- **产品经理**：脱敏规则确认——连接列表显示 host/port/dbname/user，密码永不下发前端；ai_config 下发时 api_key 只显示后 4 位。

**决议**：
1. 新建 `vault_service.rs` + `vault/crypto.rs`（derive/hkdf/aes-gcm 纯函数），commands 层瘦身。
2. 密钥层次：KEK → HKDF 三条用途子密钥（connections / aiconfig / bundle），info 字符串带版本号。
3. 密文文件格式 v1：`{format, kdf:"argon2id", salt, nonce, ciphertext}`，二进制字段统一 base64；旧的 urlencoding 编码在导入时兼容读取（见会议三）。
4. 存储路径：`~/.aidb/connections.enc`、`~/.aidb/ai_config.enc`，目录 0700 / 文件 0600。
5. Tauri 命令面按前端提案定稿（详见会议七接口清单）。

---

## 3. 会议三（主持人：密码学/安全工程师）——备份格式 v2 与旧 vault 兼容/迁移策略

**议题**：`.ditingvault` 改为用户主密码后，旧格式（硬编码密码 + urlencoding）文件怎么办？

**角色发言要点**：
- **密码学/安全工程师**：新格式 v2 定义：`{format:"DITING_ENCRYPTED_VAULT", version:2, kdf:{alg:"argon2id", m:19456, t:2, p:1}, salt_b64, nonce_b64, ciphertext_b64}`。参数沿用现有 Argon2id(19MiB, t=2, p=1)——满足 OWASP 2023 最低推荐（19MiB/2/1），本地桌面场景导入频率低，可接受。旧格式（version 缺失或 =1、urlencoding 编码、密码 yuguosheng）的处置有三个选项：
  - A. 直接拒绝导入，报错提示"旧版备份已不安全，请用旧版应用重新导出"——最安全但用户旧备份作废；
  - B. 静默用硬编码密码解密——等于把漏洞保留在新二进制里，否决；
  - C. 检测到旧格式时弹窗明确告知"此备份使用旧版弱加密（密钥内置），存在泄露风险"，用户确认后一次性用旧密码解密 → 立即要求用户输入新主密码 → 以 v2 重加密写回/导入，并提示删除旧文件。
- **产品经理**：选 C。这是单机工具，用户量小但旧备份是真实存在的用户数据，直接拒绝（A）会丢数据；C 给用户知情权和迁移路径。
- **合规**：C 方案符合"最小惊讶 + 知情同意"。要求迁移弹窗文案明确写出风险，且日志中记录"检测到 legacy vault"但不记录密码。
- **Rust后端**：实现上，导入函数先解析 JSON 看 `version` 字段：缺失/1 → legacy 分支（内置旧密码解密 + 返回 `legacy: true` 标记给前端触发迁移 UI）；2 → 要求前端传入用户主密码解密。旧密码常量只保留在 legacy 迁移分支中并加注释与 `#[deprecated]` 语义标记，这是唯一允许出现 `yuguosheng` 的地方，下一大版本移除。
- **QA测试**：测试用例需要覆盖：v1 文件导入成功且返回 legacy 标记、v1→v2 重导出后旧密码不再能解开、v2 文件错误密码被 GCM tag 拒绝、v1 文件被篡改一个字节导入失败。
- **UX设计**：迁移流程 UI：① 选择文件 → ② 检测到旧格式，风险告知弹窗（"该备份由旧版本创建，使用内置密钥加密，任何拿到文件的人都能解密。建议立即迁移。"）→ ③ 设置新主密码（两次输入+强度提示）→ ④ 完成，提示妥善保存密码（无找回机制）。
- **发布经理**：无服务端意味着**主密码丢失 = 数据永久丢失**，发布说明里必须用醒目措辞声明，不做密码找回。

**决议**：
1. 备份格式升级为 v2（用户主密码 + Argon2id + AES-256-GCM + base64），格式头含 version 与 kdf 参数。
2. 旧格式兼容策略 = **方案 C**：检测 legacy → 风险告知弹窗 → 旧密码一次性解密 → 强制设新主密码 → v2 重加密导入；旧密码常量仅存于 legacy 迁移分支。
3. 主密码无找回机制，UI 与发布说明双重提示。
4. 导出时密码由前端弹窗采集，经 Tauri command 参数传入 Rust，用完即弃（不落日志、不进前端持久化状态）。

---

## 4. 会议四（主持人：系统架构师 + DevOps）——connections.enc 密钥来源：主密码 vs 机器指纹 keyring

**议题**：`~/.aidb/connections.enc` 的 KEK 从哪来？任务书给了两个候选：用户主密码派生 vs 机器指纹/keyring。

**角色发言要点**：
- **DevOps**：平台能力盘点——macOS 有 Keychain（`security` 命令/keyring crate 成熟）；Windows 有 DPAPI/Credential Manager；Linux 有 Secret Service（libsecret），但无头/WSL/部分发行版没有。跨平台库 `keyring-rs` 可统一封装，Linux 上需 fallback。机器指纹方案（CPU/主板序列号 hash）单独用是**伪安全**：指纹数据本机可读，攻击者拷走磁盘时往往也能在同一台机器上跑程序，指纹不构成秘密；且换硬件/重装系统后指纹变化会导致数据无法解密，可靠性差。
- **密码学/安全工程师**：对照威胁模型分析：
  - 威胁 (a) 磁盘被拷走（攻击者拿不到本机运行环境）：keychain 随机 KEK **足够**——KEK 在 Keychain 里，不在磁盘文件中；指纹方案不够（指纹可从同盘推出）；主密码派生也够。
  - 威胁 (b) 备份文件泄露：由会议三的 v2 主密码方案覆盖，与本地存储 KEK 无关。
  - 威胁 (c) 同机其他进程：macOS Keychain 有 ACL（可绑定到本 app），能挡一部分；纯文件方案挡不住。
  - **结论倾向：OS keychain 存随机 256 位 KEK 为主方案**，用户无感（不用每次输密码，桌面工具体验好），安全性覆盖威胁模型。Linux 无 Secret Service 时 fallback：随机 KEK 写 `~/.aidb/.kek`（0600）——诚实标注这只防"文件级"泄露不防整机拷贝，但优于明文。
- **产品经理**：强烈支持 keychain 主方案。要求用户每次启动输主密码会杀死这个工具的日常体验（它是高频使用的 DB 客户端）。主密码只保留在**备份导出/导入**场景。
- **系统架构师**：定两层结构——本地存储 KEK 走 keychain（无感），备份 bundle 密钥走用户主密码（有感知、可携带）。两者通过 HKDF info 隔离，互不派生。`keyring-rs` 依赖需评估体积与 Linux 构建依赖（libdbus）。
- **Rust后端**：`keyring-rs` v3 支持 macOS/Windows/Linux Secret Service，可加 `crypto-rust` feature 避免 OpenSSL。service 名 `com.diting.aidb`，account 名 `vault-kek-v1`。KEK 首次使用时懒生成（32 字节随机）写入 keychain；读取失败（keychain 被清）时的行为要定义。
- **合规**：keychain 方案不涉及新增个人数据处理，无合规增量。要求在隐私说明中写明"密钥存于操作系统密钥链"。
- **QA测试**：测试环境 CI 无 keychain → `VaultService` 必须支持注入式 KEK provider（trait），测试注入内存/文件 provider，生产注入 keychain provider。这也是可测性设计要求。
- **UX设计**：KEK 丢失（换机器、keychain 被重置）但 connections.enc 还在的场景：解密失败时给出明确错误"本机密钥已丢失，连接配置无法恢复，请从 .ditingvault 备份导入或重新添加连接"，并提供一键清空重建入口，不能白屏。

**决议**：
1. **本地加密 KEK 采用 OS keychain 存随机 256 位密钥**（`keyring-rs`，service `com.diting.aidb`），不采用机器指纹方案（指纹非秘密且不可靠，否决）。
2. Fallback 链：macOS Keychain / Windows Credential Manager → Linux Secret Service → 文件 `~/.aidb/.kek`（0600，日志警告降级）。
3. 主密码仅用于备份导出/导入（会议三 v2 格式），与本地 KEK 完全独立、HKDF info 隔离。
4. `VaultService` 通过 `KekProvider` trait 注入密钥来源，保证 CI 可测。
5. KEK 丢失时的用户恢复路径：错误提示 + 从备份导入或重建，禁止静默失败。

---

## 5. 会议五（主持人：React前端 + UX设计）——localStorage 明文迁移路径

**议题**：如何把 `localStorage['aidb_connections']` / `['aidb_ai_config']` 的存量明文数据吸入后端加密存储并清除？

**角色发言要点**：
- **React前端**：现状 `useAppStore.ts` L28 启动时从 localStorage 读连接数组，L51-97 每次增删改写回。迁移方案：应用启动时（store 初始化前）执行一次性迁移动作：
  1. 调用新命令 `vault_migrate_from_localstorage(connections_json, ai_config_json)`（Rust 端负责加密写入 `connections.enc` / `ai_config.enc`）；
  2. Rust 返回成功后，前端 `localStorage.removeItem('aidb_connections')` 与 `removeItem('aidb_ai_config')`，并写入标记 `aidb_vault_migrated=1`；
  3. 之后 store 的连接数据源改为 `vault_list_connections()`（脱敏）。
  顺序关键点：**必须先确认后端写入成功再删 localStorage**，否则迁移失败会丢数据。
- **系统架构师**：更稳的顺序是"写入→回读校验→删除"。另外迁移判断放在 Rust 端更好：前端把两个 raw string 原样传给后端，后端检测 `~/.aidb/connections.enc` 是否已存在——已存在则拒绝覆盖（幂等保护），不存在则写入并返回 `migrated: true`。前端只根据返回值删 localStorage。
- **Rust后端**：同意。`vault_migrate_from_localstorage` 语义：目标文件已存在且非空 → 直接返回 `already_migrated`，不动数据（幂等）；否则解析 JSON（容忍脏数据：单条解析失败的连接跳过并计数）→ 加密写入 → fsync → 返回成功与迁移条数。ai_config 同理，迁移成功后由 Rust 删除 `ai_config.json` 明文文件。
- **UX设计**：迁移对用户应无感（一次性、启动时、<1s）。仅两种情况需要 UI：① 迁移失败 → 顶部横幅"安全迁移未完成，连接数据暂存原处，请重试"，不阻塞使用；② 成功 → 一次性 toast"连接凭证已升级为加密存储"。不做引导页。
- **QA测试**：幂等性用例：连续两次触发迁移，第二次必须返回 already_migrated 且数据不变；迁移中途 kill 进程 → 重启后要么完整迁移要么完整保留原状（Rust 端先写临时文件再 rename 保证原子性）；localStorage 为空/畸形 JSON 时迁移不崩。
- **DevOps**：注意 WebView localStorage 物理文件在迁移后仍可能残留于磁盘（WebKit 的 db 文件），`removeItem` 后建议说明文档提示用户旧数据可能在 SQLite WAL 中短暂残留，必要时可提示重启清理。可接受，不额外处理。
- **合规**：迁移属于安全增强，不需用户同意弹窗，但发布说明应写明"升级后旧版应用将无法读取连接列表"（数据已搬走）。
- **发布经理**：降级兼容问题——用户从新版回退旧版会发现连接全丢（localStorage 已清）。发布说明标注"此版本起不支持无损回退到 < vX.Y"。

**决议**：
1. 迁移入口：前端启动时调用 `vault_migrate_from_localstorage(connections_json, ai_config_json)`，**Rust 端持有幂等判断**（目标 enc 文件已存在 → already_migrated）。
2. 写入顺序：Rust 临时文件 + 原子 rename + fsync → 返回成功 → 前端删 localStorage 两个 key + 写 migrated 标记。
3. `ai_config.json` 明文文件由 Rust 在迁移成功后删除。
4. 迁移失败不阻塞应用，横幅提示 + 可重试；成功仅 toast 一次。
5. 发布说明声明不支持无损回退。

---

## 6. 会议六（主持人：Rust后端）——执行链路改造：conn_id 取密与 ai_config 兼容

**议题**：前端只拿脱敏列表后，测试连接/执行 SQL/AI 调用如何拿到真凭证？

**角色发言要点**：
- **Rust后端**：改造点清单：
  1. 所有需要密码的现有命令（测试连接、执行查询等）签名从"前端传完整连接对象"改为"前端传 `conn_id` + 覆盖参数"，Rust 端 `VaultService.get_connection_secret(conn_id)` 取真密码，用完 zeroize。现有命令中接受明文 password 参数的路径标记废弃。
  2. `AiService` 读配置改为从 vault 读解密后的 `AiConfig`；`update_ai_config` / `get_ai_config` 命令保留（WP2 依赖），但 get 返回时 api_key 脱敏为 `****后4位`，update 收到脱敏占位值时保留原 key 不覆盖（"未修改"语义）。
  3. 新增执行类命令若需要临时凭证（如前端新建连接时"测试连接"按钮），提供 `vault_test_connection(conn_payload)` 一次性通道：payload 含密码，仅用于测试，不落盘不入日志。
- **系统架构师**：注意"前端传覆盖参数"不要开成后门——不允许前端传 password 字段覆盖 vault 值（否则明文又回来了）。唯一带密码的通道是 upsert（用户显式保存）和 test_connection（用户显式测试），两者都是用户主动动作。
- **密码学/安全工程师**：内存卫生：解密出的密码用 `secrecy::SecretString`（项目已有依赖，auth_service.rs 在用）包裹；tracing 日志全链路禁止打印连接密码/api_key，建议在 vault 模块入口做字段级 redact 审查。错误信息不得回显密文/密钥材料。
- **React前端**：前端类型改造——`Connection` 类型删除 `password` 字段，改为 `password_set: boolean`（UI 显示"已保存/未设置"）；编辑连接时密码输入框 placeholder 显示"••••（未修改则留空）"，留空提交 = 保留旧密码。`ipc.ts` 同步更新。
- **UX设计**："留空 = 不修改"是通用惯例，加 helper text 即可。新建连接时密码为必填，编辑时选填。
- **QA测试**：回归重点——现有全部 SQL 执行/连接测试功能在新链路下端到端可用；编辑连接不改密码后执行查询仍成功；api_key 脱敏显示但 AI 调用仍工作（与 WP2 联调项，标记依赖）。
- **DevOps**：`vault_test_connection` 这类一次性通道要在命令白名单里注释清楚安全语义，防止后人复用成"查询密码"接口。**明确不提供任何 `get_connection_password` 命令**——密码永不出 Rust 边界。

**决议**：
1. 执行链路统一改为 `conn_id` 寻址，真密码只在 Rust 进程内存在（`SecretString` + zeroize），**不提供任何向前端返回明文密码的命令**。
2. 带密码入参的命令仅两个：`vault_upsert_connection`（保存）、`vault_test_connection`（测试）。
3. `get_ai_config` 返回脱敏 api_key（`****` + 后4位）；`update_ai_config` 对脱敏占位值执行"保留原值"语义；命令签名不变以兼容 WP2。
4. 前端 `Connection` 类型移除 password、增加 `password_set`；编辑时留空=不修改。
5. 全链路日志脱敏审查作为代码评审 checklist 项。

---

## 7. 会议七（主持人：合规 + 发布经理）——auth_service 空壳与 lib.rs greet 处置

**议题**：`auth_service.rs`（authenticate 不校验密码）删除还是实现？`lib.rs` 的模板 `greet` 怎么办？

**角色发言要点**：
- **合规**：空壳鉴权是审计红旗——代码里存在"认证"字样但实际不认证，比没有更糟（误导评审者与用户）。单机本地工具、威胁模型不含"同机多用户对抗"（OS 账户已隔离用户），**没有真实的本地登录需求**。
- **系统架构师**：同意删除。未来若做"会话锁定"（离开工位自动锁 vault），那是在 VaultService 上加 lock/unlock（清内存 KEK），不是用户鉴权，不需要 auth_service 这个概念。`UserProfile`/多用户模型是过度设计。
- **Rust后端**：确认 `AuthService` 当前无任何调用方（`#[allow(dead_code)]` 满屏，main.rs 未注册），删除零风险。`lib.rs` 的 `greet` 是 Tauri 模板残留，检查前端是否有 `invoke('greet')` 调用后删除；注意 lib.rs 与 main.rs 的 handler 注册关系，删干净避免编译警告。
- **React前端**：全局搜索确认前端无 greet 调用（如有 App.tsx 模板残留一并清理）。
- **产品经理**：备选方案"实现主密码解锁会话"评估：给本地工具加启动密码会显著伤害日常体验（会议四已决定本地 KEK 走 keychain 无感方案），且主密码概念已收敛到备份场景。**不做启动解锁**。
- **发布经理**：删除死代码对发布无风险，随 WP6 一起走。CHANGELOG 记一条 "Removed: 未使用的鉴权空壳与模板代码"。
- **QA测试**：删除后全量编译 + 现有测试回归即可，无行为变更。

**决议**：
1. **删除 `auth_service.rs`**（整个文件及 services/mod.rs 中的导出），不实现本地登录/解锁会话；理由：无真实需求、空壳误导审计、体验成本高。未来"会话锁定"需求以 VaultService lock/unlock 形式另行立项。
2. **删除 `lib.rs` 中的 `greet`** 命令及注册，前端如有模板调用一并清理；确认 `cargo build` 无警告、前端编译通过。
3. `secrecy::SecretString` 依赖保留（vault 模块继续使用）。

---

## 8. 会议八（主持人：UX设计）——主密码交互与错误状态设计

**议题**：导出/导入弹窗、密码强度、错误提示、KEK 丢失恢复的完整 UX 流程。

**角色发言要点**：
- **UX设计**：四个流程定稿：
  1. **导出**：设置页"导出加密备份" → 弹窗（主密码 + 确认密码 + 强度条）→ 导出中（Argon2id 派生约 0.3-1s，需 loading 态防重复点击）→ 成功 toast 显示保存路径 + "请牢记密码，无法找回"。
  2. **导入**：选择文件 → 后端探测格式：v2 → 输密码弹窗；legacy → 风险告知弹窗（会议三文案）→ 解密成功 → 设置新主密码 → 完成。密码错误 → 弹窗内联错误"密码不正确或文件已损坏"，不关闭弹窗，允许重试，**连续 5 次失败后禁用 30 秒**（本地限速，防脚本爆破）。
  3. **密码强度**：最低 8 位；zxcvbn 类强度提示（弱/中/强）仅提示不强制拦截（单机工具，用户自主权衡），但 <8 位硬拦截。
  4. **KEK 丢失**（keychain 被清但 enc 文件在）：启动时连接列表为空 + 顶部警示条"本机密钥丢失，检测到加密配置无法解锁，[从备份导入] [清空重建]"。
- **React前端**：密码输入框 `type="password"` + autocomplete="off" + 新密码字段 `autocomplete="new-password"`；密码 state 用完即清（不存 zustand 持久层）；弹窗关闭时重置。失败限速计数放前端（后端也做一层，见下）。
- **密码学/安全工程师**：限速必须**后端也做**（前端限速可绕过）：Rust 端对 import 命令按进程内计数，5 次失败 sleep 递增。强度校验后端同样执行（≥8 字节）。
- **合规**：错误文案不得泄露失败原因细节（"密码错误"与"文件损坏"对攻击者是区分信息，但本场景文件在用户手里，可合并为一条模糊提示——已按 UX 稿合并）。
- **产品经理**：文案全部中文，术语统一："主密码"（不叫"证书密码"——现状注释里"内置证书/固定密钥"是错误术语，清理掉）。
- **QA测试**：UI 用例：错误密码 5 次触发限速、loading 态防双击、legacy 迁移全流程走通、弹窗 Esc 关闭后密码 state 清空。

**决议**：
1. 采用 UX 稿四流程（导出/导入含 legacy 分支/强度提示/KEK 丢失恢复）。
2. 密码规则：≥8 位硬拦截（前后端双重校验），强度仅提示；失败限速前后端双层（5 次 → 30s）。
3. 术语统一为"主密码"，清理代码注释中"内置证书/固定密钥"等错误表述。
4. 密码只存在于弹窗组件临时 state 与 Rust 栈内存，不进任何持久化层。

---

## 9. 会议九（主持人：DevOps）——依赖、构建与跨平台 CI

**议题**：新增依赖、平台差异、CI 测试环境。

**角色发言要点**：
- **DevOps**：新增 Rust 依赖清单：`keyring`（v3，feature `crypto-rust` 避免 OpenSSL 链接问题）、`hkdf`、`sha2`（若未有）、`base64`、`zeroize`；已有：`argon2`、`aes-gcm`、`rand`、`secrecy`、`chrono`。移除依赖：无（urlencoding 若他处仍用则保留，仅 vault 路径弃用）。Linux CI 需 `libdbus` 开发包（keyring 的 Secret Service 后端）——但 CI 测试走注入式 KekProvider（会议四决议），运行时不触碰 keychain，可禁用相关 feature 或用 mock，CI 矩阵 macOS/Windows/Linux 均可跑。
- **Rust后端**：`keyring-rs` v3 在无 Secret Service 的 Linux 上 `Entry::new` 即返回 Err，正好落入 fallback 分支（文件 KEK），行为可预期。macOS 上首次写 keychain 可能弹系统授权框（取决于 signing），开发模式（未签名）下通常直接允许本机访问，需要在真机验证一次并记录到 README。
- **系统架构师**：KekProvider trait 设计：`fn get_or_create_kek() -> Result<[u8;32]>`，实现三个：`KeychainKek`（生产）、`FileKek`（fallback/开发）、`MemoryKek`（测试）。编译期不切 feature，运行期按平台探测 + 降级，日志记录所用 provider。
- **QA测试**：CI 增加 `cargo test`（vault 单元测试）+ `cargo clippy -- -D warnings`；前端 vitest 覆盖 store 迁移逻辑（mock invoke）。
- **发布经理**：版本策略——本 WP 含数据格式变更（localStorage→enc、json→enc、vault v1→v2），属于**不可逆迁移**，按 minor 版本发布（如 0.x → 0.x+1），发布说明包含：迁移行为、主密码无找回、不支持无损回退三条必读。建议发布前用旧版本真实数据做一轮手工升级演练。
- **DevOps**：构建脚本 `build.sh` 无需改动（无新系统级依赖强约束）；Windows 打包验证 keyring Credential Manager 路径。

**决议**：
1. 依赖增补：`keyring`(crypto-rust)、`hkdf`、`sha2`、`base64`、`zeroize`；vault 路径弃用 urlencoding。
2. `KekProvider` 三实现（Keychain/File/Memory），运行期探测降级，日志记录 provider（不记录密钥）。
3. CI：`cargo test` + `clippy -D warnings` + 前端 vitest；三平台矩阵，测试不依赖真实 keychain。
4. 发布级别 minor，发布说明三条必读（迁移、无找回、不可回退）；发布前旧数据升级演练。
5. macOS 首次 keychain 访问授权行为需在真机验证并记录。

---

## 10. 会议十（主持人：QA测试）——测试策略与验收标准

**议题**：单元测试、集成测试、验收标准的最终清单。

**角色发言要点**：
- **QA测试**：按任务书四项测试要求展开：
  1. **加解密 roundtrip**：对三条用途子密钥各做 encrypt→decrypt 相等；大 payload（1MB）roundtrip；base64 编解码 roundtrip。
  2. **错误密码拒绝**：v2 bundle 用错误主密码 import → 返回解密失败错误（GCM tag 校验），不 panic、不返回部分数据；错误密码尝试不产生任何文件副作用。
  3. **旧格式检测**：构造 v1 格式样本（urlencoding + 无 version 字段）→ 导入识别为 legacy 并返回标记；构造 format 字段错误的文件 → 拒绝；构造 v1 文件篡改 ciphertext 一字节 → 拒绝。
  4. **迁移幂等**：首次 migrate 写入成功返回条数；二次 migrate 返回 already_migrated 且文件 mtime/内容不变；enc 文件存在 + localStorage 也有数据时以 enc 为准不覆盖。
  另加：nonce 唯一性（两次加密同明文 ciphertext 不同）、HKDF 用途隔离（不同 info 派生密钥不同）、KEK provider 降级路径（Keychain mock 失败 → FileKek 生效）、upsert 后 get 脱敏（返回值不含明文密码、api_key 仅后4位）。
- **Rust后端**：Rust 单元测试放 `vault_service.rs` / `crypto.rs` 的 `#[cfg(test)]` 模块，用 MemoryKek；legacy v1 样本用测试代码现场生成（用旧算法参数加密一个 fixture），不提交含真实密码的 fixture 文件。
- **React前端**：vitest：store 初始化时迁移调用顺序（invoke 成功 → removeItem 被调；invoke 失败 → removeItem 不被调）；Connection 类型无 password 字段的编译期保证（tsc）。
- **密码学/安全工程师**：加一条安全审查项（非自动化测试）：grep 全仓库确认 `yuguosheng` 只出现在 legacy 迁移分支一处；日志输出审查（跑一遍全流程，确认日志无密钥/密码/api_key）。
- **合规**：验收增加文案审查：风险告知弹窗、无找回提示、发布说明三条必读齐全。
- **产品经理**：验收标准（DoD）汇总：① 全仓库无硬编码密码（除 legacy 迁移分支）；② 全新安装 → 添加连接 → 重启 → 连接可用且 localStorage 无 'aidb_connections'；③ 旧版升级 → 自动迁移 → localStorage 清空 → 功能回归通过；④ 导出 v2 → 删本地数据 → 导入恢复成功；⑤ 错误密码被拒；⑥ v1 旧备份走迁移流程成功转 v2；⑦ `ai_config.json` 不再存在，`~/.aidb/ai_config.enc` 生效且 AI 调用正常（与 WP2 联调）；⑧ auth_service.rs 与 greet 已删除，编译零警告；⑨ 测试清单全绿。
- **发布经理**：DoD ⑦ 依赖 WP2 接入进度，若 WP2 未就绪则以"vault 层 API 契约测试通过"为替代验收，联调项单独跟踪。

**决议**：
1. 测试清单与 DoD 按上述定稿，写入下文"开发步骤清单"。
2. legacy fixture 由测试代码生成，不入库真实密文样本。
3. 安全审查两项人工执行：硬编码 grep + 日志脱敏跑查。
4. DoD ⑦ 与 WP2 解耦的替代验收方案确认。

---

## 11. 开发步骤清单

> 依赖顺序：S1 → S2 → (S3 ∥ S4) → S5 → S6 → S7 → S8 → S9。每步含改动点与验收标准。

### S1 加密原语层 `vault/crypto.rs`
- 抽取纯函数：`derive_key_argon2id(password, salt) -> [u8;32]`（参数 19MiB/t2/p1）、`hkdf_subkey(kek, info) -> [u8;32]`（info：`diting/connections/v1`、`diting/aiconfig/v1`、`diting/bundle/v1`）、`aes_gcm_encrypt/decrypt(key, plaintext) -> (nonce, ct)`（每次新随机 nonce）、base64 编解码工具。
- 新增依赖：`hkdf`、`sha2`、`base64`、`zeroize`。
- **验收**：roundtrip / nonce 唯一性 / HKDF 隔离单测通过；clippy 零警告。

### S2 KEK 管理 `vault/kek.rs` + `KekProvider` trait
- 三实现：`KeychainKek`（keyring-rs，service `com.diting.aidb`，account `vault-kek-v1`）、`FileKek`（`~/.aidb/.kek`，0600）、`MemoryKek`（测试）。运行期探测 + 降级 + 日志记录 provider 名。
- `~/.aidb/` 目录创建（0700）。
- **验收**：macOS 真机 keychain 读写验证；mock Keychain 失败 → FileKek 降级用例通过。

### S3 VaultService 存储层 `services/vault_service.rs`
- `~/.aidb/connections.enc`、`~/.aidb/ai_config.enc` 读写（临时文件 + 原子 rename + fsync）；文件格式 `{format:"AIDB_ENC_V1", salt, nonce, ciphertext(base64)}`。
- API：list（脱敏，含 `password_set`）/ upsert / delete / get_secret(conn_id)（`SecretString`）/ ai_config get（脱敏 `****后4位`）/ set（占位值=保留原值）。
- 删除 `ai_service.rs` 中 `ai_config.json` 明文读写，改走 vault；`update_ai_config`/`get_ai_config` 命令签名不变（WP2 兼容）。
- **验收**：文件权限 0600；脱敏返回值单测；占位值保留语义单测。

### S4 备份 bundle v2 + legacy 迁移（commands 层）
- `export_encrypted_bundle(payload, master_password, save_dir)`：v2 格式头（version:2 + kdf 参数），用户主密码派生。
- `import_encrypted_bundle(file_content, master_password: Option<String>)`：version 探测；v2 → 主密码解密（后端失败限速 5 次/30s）；legacy（v1/urlencoding）→ 旧密码分支解密 + 返回 `legacy:true` 标记；错误密码 → 统一模糊错误。
- 旧密码常量仅存 legacy 分支并注释标记待移除；清理"内置证书"错误注释。
- **验收**：v2 roundtrip、错误密码拒绝、legacy 检测与 v1→v2 转换、篡改拒绝单测全绿；grep 确认 `yuguosheng` 仅一处。

### S5 localStorage 迁移命令与前端切换
- 新命令 `vault_migrate_from_localstorage(connections_json, ai_config_json)`：Rust 端幂等（enc 已存在 → already_migrated）、脏数据容忍（跳过并计数）、迁移成功后删除 `ai_config.json`。
- 前端：启动流程改造（迁移 → 成功后 removeItem 两个 key + 写 `aidb_vault_migrated` 标记 → 数据源切 `vault_list_connections`）；`Connection` 类型删 password 加 password_set；`ipc.ts` 更新；失败横幅 + 成功 toast。
- **验收**：DoD ②③（全新安装 / 旧版升级两条路径）；vitest 覆盖调用顺序；迁移幂等 + 中断原子性单测。

### S6 执行链路 conn_id 化
- 测试连接/执行 SQL 等命令改 `conn_id` 寻址，禁止 password 覆盖参数；新增 `vault_test_connection(conn_payload)` 一次性通道；不提供任何返回明文密码的命令。
- 解密凭证 `SecretString` + zeroize；日志脱敏审查。
- **验收**：现有 SQL/连接功能端到端回归；编辑连接留空密码 → 执行仍成功；日志跑查无敏感字段。

### S7 主密码前端交互（导出/导入弹窗）
- 导出弹窗（密码+确认+强度条，≥8 位硬拦截）、导入弹窗（v2 密码 / legacy 风险告知 → 设新密码两阶段）、内联错误 + 前端限速、loading 防重、KEK 丢失恢复入口（警示条 + 从备份导入/清空重建）。
- 密码 state 弹窗级临时存储，关闭即清。
- **验收**：会议八 UX 用例全过；文案合规审查（风险告知/无找回提示）。

### S8 死代码清理
- 删除 `auth_service.rs` 及 mod 导出；删除 `lib.rs` `greet` 与注册；清理前端模板残留调用（如有）。
- **验收**：DoD ⑧；`cargo build` 与前端构建零警告；确认无调用方引用。

### S9 测试收尾与发布准备
- 汇总测试清单执行（见下）；CI 三平台矩阵跑通（cargo test + clippy -D warnings + vitest + tsc）。
- 旧版本真实数据手工升级演练（发布经理主持）。
- 发布说明三条必读：自动迁移行为 / 主密码无找回 / 不支持无损回退。
- **验收**：DoD ①-⑨ 全项签核；DoD ⑦ 若 WP2 未就绪，以 vault API 契约测试替代并记录联调跟踪项。

### 测试清单（自动化）
| # | 用例 | 层级 |
|---|------|------|
| T1 | 三条子密钥 encrypt→decrypt roundtrip（含 1MB payload） | Rust 单测 |
| T2 | 同明文两次加密 ciphertext 不同（nonce 唯一） | Rust 单测 |
| T3 | HKDF 不同 info 派生密钥不同（用途隔离） | Rust 单测 |
| T4 | v2 bundle 错误主密码 → 解密失败错误，无 panic 无副作用 | Rust 单测 |
| T5 | legacy v1 样本（测试内生成）→ 识别 legacy + 旧密码解密成功 + 返回标记 | Rust 单测 |
| T6 | v1 文件 ciphertext 篡改 1 字节 → 拒绝 | Rust 单测 |
| T7 | format 字段非法文件 → 拒绝 | Rust 单测 |
| T8 | v1 → v2 重加密后，旧密码无法解开新文件 | Rust 单测 |
| T9 | 迁移幂等：二次 migrate → already_migrated，文件不变 | Rust 单测 |
| T10 | 迁移脏数据：畸形连接条目跳过并计数，整体不崩 | Rust 单测 |
| T11 | KekProvider 降级：Keychain mock 失败 → FileKek 生效 | Rust 单测 |
| T12 | list/get 脱敏：返回不含明文密码；api_key 仅后4位 | Rust 单测 |
| T13 | update_ai_config 占位值 → 原 key 保留 | Rust 单测 |
| T14 | import 失败限速：5 次后触发延迟 | Rust 单测 |
| T15 | 前端迁移顺序：invoke 成功才 removeItem；失败不删 | vitest |
| T16 | Connection 类型无 password 字段 | tsc 编译期 |
| T17 | grep 全仓 `yuguosheng` 仅 legacy 分支一处 | CI/人工 |
| T18 | 全流程日志跑查无密码/api_key/密钥材料 | 人工 |

### 验收标准（DoD）
1. 全仓库无硬编码密码（唯一例外：legacy 迁移分支，带移除标记注释）。
2. 全新安装 → 添加连接 → 重启 → 连接可用，localStorage 无 `aidb_connections`。
3. 旧版数据升级 → 自动迁移成功 → localStorage 清空 → 功能回归通过。
4. 导出 v2 备份 → 清除本地数据 → 主密码导入恢复成功；错误密码被拒。
5. v1 旧备份 → 风险告知 → 迁移为 v2 → 旧密码对新文件无效。
6. `ai_config.json` 不再产生，`~/.aidb/ai_config.enc` 生效，AI 调用正常（或 vault API 契约测试通过，联调项移交 WP2 跟踪）。
7. `auth_service.rs` 与 `greet` 已删除，编译零警告。
8. T1-T18 全绿；CI 三平台矩阵通过。
9. 发布说明含三条必读；旧数据升级演练完成。
