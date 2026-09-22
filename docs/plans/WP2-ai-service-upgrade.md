# WP2『AI 服务升级』开发计划

> 项目：DiTing PG AI (Tauri 2.0 + Rust + React18 + Zustand)
> 工作包范围：① 多轮对话历史（含 token 预算截断）② 流式输出（tauri::ipc::Channel + SSE，保留非流式 fallback）③ api_key AES-256-GCM 加密落盘 ④ rig-core 0.7 去留决议 ⑤ 全项 cargo 单元测试（网络 mock）
> 背景文件：`src-tauri/src/services/ai_service.rs`（129 行，reqwest 直连 /chat/completions，prompt() 单轮无历史）、`src-tauri/src/commands/mod.rs`（ai_chat/update_ai_config/get_ai_config，已有 export/import_encrypted_bundle 的 Argon2id+AES-256-GCM 先例，固定密码 `yuguosheng`）、`src/components/AiSidebar.tsx`（651 行，三模式意图路由 + @表名补全 + schemaContext 拼装，前端已维护 messages state）、`src/store/useAppStore.ts` askAi、`src/services/ipc.ts` aiChat。
> 产出方式：十角色评审会议 × 10 次，每次一议题，纪要如下；最后一节为开发步骤清单（验收标准 + 测试清单）。本文档为计划，不含源码改动。

---

## 会议 1｜产品经理：WP2 需求边界与优先级

**议题**：确定 WP2 五项范围的用户价值、验收口径与优先级排序。

**角色发言要点**：
- **产品经理（主持）**：WP2 的核心用户价值排序为：流式输出（体验感知最强，逐字渲染消除长等待焦虑）> 多轮对话（DBA 场景天然是追问式：先要 SQL、再要优化、再要解释）> api_key 加密（信任与合规底线）> 测试覆盖（工程底线）> rig-core 决议（技术债清理）。范围外明确不做：RAG/向量检索、Tool Calling 实际执行、多 Provider 并发路由——留待 WP3。
- **UX 设计**：流式输出必须有可见的"正在生成"状态与停止按钮诉求；多轮历史在 UI 上应支持"清空会话"。
- **QA 测试**：验收口径必须可测——"超长截断"要有明确数字边界，"流式"要能断言 delta 顺序。
- **发布经理**：api_config.json 格式变更涉及老用户升级兼容，必须列入验收（旧明文文件能无感迁移）。

**决议**：
1. 优先级：流式 > 多轮 > 加密 > 测试 > rig-core；但开发顺序按依赖排（见步骤清单）。
2. 每项的完成定义（DoD）：cargo 测试通过 + AiSidebar 端到端手工验证 + 旧配置文件自动迁移。
3. 范围冻结：不引入 rig-core 新能力、不做会话持久化到磁盘（会话仅存在于前端 state 与单次请求生命周期内）。

---

## 会议 2｜系统架构师：总体技术方案与模块划分

**议题**：多轮历史的归属（前端传全量 vs 后端维护会话）、流式通道架构、加密模块分层。

**角色发言要点**：
- **系统架构师（主持）**：三个关键架构决策——
  (a) **会话归属**：选"前端持有历史、每次请求传 messages 数组"。理由：Tauri 单进程单窗口场景下后端维护 session 需要引入会话 ID、TTL、清理策略、内存泄漏防护，复杂度不成比例；前端 AiSidebar.tsx 已维护 messages state，改造成本最低；后端保持无状态、易测试。代价是每次 IPC 传全量历史，靠 token 预算截断兜底。
  (b) **流式通道**：新增 `ai_chat_stream` command，签名带 `channel: tauri::ipc::Channel<StreamEvent>`；保留原 `ai_chat` 不动作为 fallback。StreamEvent 为 serde 枚举：`Delta(String) / Done { full_text } / Error(String)`。
  (c) **加密分层**：新建 `services/secret_store.rs`，ai_service.rs 只依赖其 `encrypt_api_key/decrypt_api_key` 接口，不感知密钥派生细节。
- **Rust 后端**：同意无状态方案；建议 messages 数组用共享的 `ChatMessage { role, content }` struct，system prompt 仍由后端拼装（前端只传 user/assistant 历史），避免前端伪造 system 角色。
- **AI 工程师**：schemaContext 目前每轮都全量拼在 user prompt 里，多轮后会导致 token 爆炸；应改为只在最新一轮或 system prompt 中携带 schema。
- **安全工程师**：secret_store 的密钥派生方案在会议 5 专项讨论，本会只定接口。
- **DevOps**：ai_service.rs 的 reqwest 调用需抽出可注入的 client/base_url，否则单测无法 mock。

**决议**：
1. 后端无状态，前端传 `history: Vec<ChatMessage>`；system prompt 与 schema 注入由后端统一负责。
2. 新增 `ai_chat_stream`（Channel 推 delta），`ai_chat` 保留为同步 fallback；两者共用同一个"组装 messages + 发请求"内核，仅响应处理不同。
3. 新增 `services/secret_store.rs` 承载加解密；`services/sse.rs`（或 ai_service 内模块）承载 SSE 行解析，纯函数便于单测。
4. schemaContext 只随最新一条 user 消息传递，历史消息不重复携带。

---

## 会议 3｜Rust 后端：多轮对话历史与 Token 预算实现

**议题**：`prompt()` 改造为接收 messages 数组；token 预算控制与截断算法。

**角色发言要点**：
- **Rust 后端（主持）**：改造点——
  - 定义 `#[derive(Serialize, Deserialize, Clone)] pub struct ChatMessage { pub role: String, pub content: String }`，role 校验只接受 `"user" | "assistant"`。
  - `prompt(&self, history: &[ChatMessage], user_prompt: &str, db_context_schema: Option<&str>)`；组装顺序：system（含 schema）→ 截断后的 history → 当前 user_prompt。
  - **token 预算**：不引入 tokenizer 依赖（tiktoken-rs 体积大且离线），采用工程近似：`估算 tokens ≈ chars/4`（英文）与 `chars/2`（中文混合场景保守取 `max(chars/4, cjk_count)`）。实现 `fn estimate_tokens(s: &str) -> usize`，纯函数可单测。
  - **截断算法**：总预算 = `MAX_CONTEXT_TOKENS`（配置项，默认 8192）− system prompt tokens − 当前 user tokens − 预留输出 tokens（默认 1024）。剩余预算从**最新历史往前**回填，装不下的最早消息整条丢弃（不做半条截断，避免破坏 user/assistant 配对）；丢弃后保证序列以 user 开头（成对丢弃）。
- **AI 工程师**：整条丢弃 + 保配对是对的；建议截断发生时在 system prompt 尾部附加一句 "(earlier conversation omitted)"，让模型知晓上下文不完整。预算默认 8192 对 gpt-4o-mini（128k）保守但安全，本地模型（Ollama 常见 4k-8k）也兼容。
- **系统架构师**：MAX_CONTEXT_TOKENS 与 reserved output 应放入 AiConfig，带 serde default，保证旧配置文件反序列化不炸。
- **QA 测试**：截断函数必须可脱离网络单测：给定预算与消息列表，断言保留哪些、丢弃哪些、配对完整性。
- **产品经理**：截断对用户透明即可，UI 不需提示"历史被裁剪"（低价值噪音）。

**决议**：
1. `prompt()` 签名改为接收 `history + 当前 user_prompt + schema`；后端负责 system 拼装与角色校验。
2. token 估算用字符近似法（无新依赖），`estimate_tokens` 为 pub 纯函数。
3. 截断：从新到旧回填、整条丢弃、保 user/assistant 配对、丢弃后序列以 user 开头；预算字段进 AiConfig（serde default 兼容旧配置）。
4. 单测覆盖：估算函数、空历史、单条超长、正常多轮、恰好边界、奇数条历史。

---

## 会议 4｜AI 工程师 + Rust 后端：SSE 流式输出与 Channel 集成

**议题**：stream:true 的 SSE 解析、tauri::ipc::Channel 推送、非流式 fallback、错误处理。

**角色发言要点**：
- **AI 工程师（主持）**：OpenAI 兼容 SSE 格式要点——每行 `data: {json}`，json 取 `choices[0].delta.content`（可能为 null，如首帧只有 role）；结束标志 `data: [DONE]`；心跳空行要跳过；**注意跨 TCP 包的半行数据**必须缓冲拼接（按 `\n` 切分，余量留 buffer）；部分兼容端（如某些本地网关）会发 `: comment` 行，需忽略。建议解析器做成纯函数 `feed(&mut buffer, chunk) -> Vec<String>`（返回本批完整 delta 文本），与 reqwest/Channel 解耦，直接可单测。
- **Rust 后端**：reqwest 侧用 `resp.bytes_stream()`（需 `futures_util::StreamExt`），逐 chunk 喂解析器，每个 delta 通过 `channel.send(StreamEvent::Delta(text))` 推送；流结束发 `Done { full_text }`（后端同时累积全文，供前端校验/落库）。请求体加 `"stream": true`。HTTP 非 2xx 时读 body 发 `Error`（不走 Done）。
- **系统架构师**：`StreamEvent` 定义在 ai_service.rs 并导出，serde tag 用 `{"type": "delta", "text": ...}` 形式，前端好判别。Channel 参数在 command 签名里 Tauri 2.0 会自动注入，不进 invoke payload。
- **React 前端**：ipc.ts 新增 `aiChatStream(prompt, history, schemaContext, onDelta): Promise<string>`，内部 `new Channel<StreamEvent>()`，onmessage 分发；AiSidebar 收到 delta 即 setState 追加到最后一条 assistant 消息（React18 高频 setState 需确认渲染压力，可用 ref 累积 + rAF/50ms 节流刷新）。fallback：捕获流式异常或配置开关关闭时，退回 `aiChat` 一次性返回。
- **QA 测试**：SSE 解析器单测素材：标准多帧、[DONE]、半行跨 chunk、空 delta、`:comment`、CRLF 行尾、非法 JSON 帧（跳过不崩）。
- **DevOps**：流式请求超时策略与非流式不同——连接超时 30s，但读超时要放宽或禁用（长回答可能 >60s 无字节间隙小）；建议用 `reqwest::Client::builder().connect_timeout(30s)` 且不设 read timeout，靠用户取消。
- **UX 设计**：流式期间输入框禁用发送、显示闪烁光标；错误帧要以红色气泡呈现且保留已生成部分。

**决议**：
1. SSE 解析器为独立纯模块（`services/sse.rs`）：`SseParser::feed(chunk) -> Vec<String>`，处理半行缓冲、[DONE]、注释行、null delta、非法帧跳过。
2. 新增 `ai_chat_stream(prompt, history, schema_context, channel)` command；StreamEvent = Delta/Done/Error 三态；后端累积 full_text 随 Done 下发。
3. 保留 `ai_chat`（同步改为传 history），前端流式失败自动降级一次。
4. 前端 delta 渲染加节流（≥16ms 合帧）；流式期间提供停止能力（本期用 abort 前端不再消费 + 后端流自然结束，强杀连接留 WP3）。
5. reqwest client 统一 builder：connect_timeout 30s、无 read timeout。

---

## 会议 5｜安全工程师：api_key 加密落盘方案权衡

**议题**：~/.aidb/ai_config.json 明文 api_key 改造：密钥来源方案对比与迁移策略。

**角色发言要点**：
- **安全工程师（主持）**：威胁模型——防的是"配置文件被拷走/误备份/被其他进程读取"，不防本机 root 与内存 dump。三个候选方案：
  - **A. 机器指纹派生**：MAC/主机名/OS 用户 + Argon2id → 密钥。优点：无用户交互、换文件到别的机器即失效。缺点：macOS 上取稳定指纹需枚举网络接口（权限/虚拟机变更会漂移），指纹一旦变化（换网卡、改主机名）用户 key 永久丢失且无提示，工程上坑多；指纹收集代码平台分支重。
  - **B. 固定 vault 密码**：沿用项目现有 `export_encrypted_bundle` 的做法（Argon2id(固定密码 `yuguosheng`) + AES-256-GCM）。优点：与现有代码一致、实现一天内完成、永不"锁死"用户。缺点：密码硬编码在二进制里，逆向即得——安全强度实为"混淆级"，只挡随手翻文件。
  - **C. OS 钥匙串**（macOS Keychain / Windows Credential Manager，keyring crate）。优点：真正的系统级保护。缺点：引入平台依赖与 CI 复杂度，Linux 上 Secret Service 常不可用，跨平台一致性差。
  - **推荐**：本期选 **B+**：固定密码方案，但做两点加固——(1) 密钥材料 = Argon2id(固定密码 + 每文件随机 salt)，salt/nonce 随密文存储（与现有 vault 格式一致）；(2) 配置结构加 `"api_key_encrypted": true` 标记字段与 format 版本号，为 WP3 升级到方案 C（keyring）预留迁移位。方案 A 明确否决：指纹漂移导致的数据丢失风险 > 其边际安全收益；方案 C 记入 WP3 备选。
- **Rust 后端**：实现上 secret_store.rs 提供 `encrypt_secret(plain) -> EncryptedBlob{salt,nonce,ciphertext}` 与 `decrypt_secret(blob) -> String`，序列化用 base64（现有代码用 urlencoding 存二进制，建议新模块统一改 base64，更易读且标准）。解密失败时的行为：记 warn 日志、api_key 视为空，不 panic 不阻断启动。
- **系统架构师**：AiConfig 磁盘格式改为 `api_key` 字段存密文对象或加 `api_key_enc`；内存中 AiConfig 仍持明文 key（get_config 返回给前端时必须**脱敏**，只回 `has_key: bool` + 尾 4 位）。
- **React 前端**：设置页显示 `sk-****abcd` 样式掩码；保存时若用户未改动 key 字段，前端传 null/占位符，后端保留原 key（避免掩码被当真 key 存回去）。
- **产品经理**：旧明文配置迁移必须无感：启动加载时检测到明文 `api_key` 字段 → 加密重写文件。
- **QA 测试**：roundtrip 单测 + 篡改密文断言解密报错 + 旧明文迁移测试（构造旧格式文件断言加载后被加密重写）。

**决议**：
1. 采用方案 B+：Argon2id(固定密码+随机 salt) → AES-256-GCM；文件存 `{format_version, salt, nonce, ciphertext}`（base64）；机器指纹方案否决，keyring 列入 WP3。
2. 新建 `services/secret_store.rs`；ai_config.json 中 api_key 以加密块存储，内存持明文。
3. `get_ai_config` 返回脱敏视图（has_key + 尾 4 位），前端保存时未改 key 则传占位符，后端保留原值。
4. 启动时无感迁移旧明文配置；解密失败降级为空 key + warn 日志，不阻断启动。

---

## 会议 6｜React 前端：AiSidebar 多轮 + 流式渲染改造

**议题**：messages state 到 IPC 的映射、schemaContext 传参时机、流式 UI 状态机、降级路径。

**角色发言要点**：
- **React 前端（主持）**：现状——AiSidebar.tsx 本地 messages state（{role, content} 形态已接近 ChatMessage），发送时只传 `userMsg + schemaContext`，历史被丢弃。改造：
  - `askAi(prompt, schemaContext)` 签名扩为 `askAi(prompt, history, schemaContext)`；history 从 messages state 过滤出 role∈{user,assistant} 的最近 N 条（N 由后端预算裁剪，前端只设上限如 20 条防 IPC 过大）。
  - **schemaContext 时机**：按会议 2 决议只随最新 user 消息传；历史消息保持原样。注意三模式（NL2SQL/DBA_ADMIN/ERROR_FIX）切换时 schemaContext 变化——决议：**模式切换即清空会话**（不同 system 语境混历史会误导模型），UI 给轻提示。
  - **流式状态机**：`idle → streaming(累积 delta 到临时 assistant 消息) → done/error`；streaming 中禁用发送按钮、自动滚底（用户手动上滚则暂停跟随）；Done 后用 full_text 替换累积文本（一致性校验）。
  - **降级**：invoke ai_chat_stream 抛异常（旧后端/Channel 不支持）时 catch → 走 aiChat 同步路径，用户无感（只是没有逐字效果）。
- **UX 设计**：流式气泡加闪烁光标动画；错误气泡红色 + "重试"按钮；清空会话按钮放会话头部；模式切换清空前弹确认（若已有 ≥2 轮对话）。
- **系统架构师**：types.ts 补 `ChatMessage`、`StreamEvent` 类型，与 Rust 侧 serde 命名严格对齐（camelCase via serde rename_all）。
- **QA 测试**：前端以手工验收为主：多轮追问指代（"把上面的 SQL 改成按周聚合"应能理解）、流式中断网、模式切换清空、长回答滚动行为。
- **DevOps**：Zustand store 中 askAi 的错误处理保持现有 toast 通道，不新增状态树分支。

**决议**：
1. ipc.ts：`aiChat(prompt, history, schemaContext)` 更新 + 新增 `aiChatStream(..., onDelta): Promise<string>`（Channel 封装，返回 full_text）。
2. useAppStore.askAi 扩展 history 参数；AiSidebar 传最近 ≤20 条历史。
3. 模式切换清空会话（有历史时确认弹窗）；流式状态机含节流渲染、自动滚底、Done 校验替换。
4. 流式异常自动降级同步调用一次；serde 命名 camelCase 对齐，types.ts 补类型。

---

## 会议 7｜QA 测试：测试策略与 mock 方案

**议题**：五项功能的 cargo 单测清单、网络 mock 手段、边界与回归范围。

**角色发言要点**：
- **QA 测试（主持）**：可测性设计——
  - **SSE 解析**：纯函数直测，无需网络。用例：标准帧序列、跨 chunk 半行、`data: [DONE]`、空行/注释行、delta.content 为 null、非法 JSON 帧、CRLF、多 choice（取第 0 个）、中文多字节字符被 chunk 切断（UTF-8 边界——**重要**：bytes_stream 可能把多字节字符切半，SseParser 必须按字节缓冲、仅对完整行做 String 转换或容忍 lossy）。
  - **历史截断**：estimate_tokens 边界（空串/纯中文/纯英文/emoji）；truncate_history 用例：预算充足全保留、丢最早保配对、恰好装满、单条超预算（丢该条继续回填还是停止？决议：单条超预算则丢弃并继续尝试更早的——不，更早的更该丢；**正确策略：从新到旧回填，遇到装不下的即停止**，保证保留的是最近连续后缀）、全丢空。
  - **加解密 roundtrip**：encrypt→decrypt 相等；密文篡改 1 字节→decrypt Err；错误密码→Err；同明文两次加密密文不同（随机 salt/nonce）；旧明文迁移函数测试（临时目录 + 环境变量 HOME 重定向）。
  - **网络 mock**：prompt/stream 的 HTTP 层用 `wiremock`（dev-dependency）起本地 mock server，AiService 构造时注入 base_url 指向 mock；断言请求体含 messages 数组/ stream 标志，回放固定 SSE 字节流。AiService::new 需拆出 `with_base_url(url)` 测试构造器。
  - **回归**：现有 export/import_encrypted_bundle 测试不受 secret_store 抽取影响；ai_chat 旧签名调用方全部更新后 `cargo build` 零警告。
- **Rust 后端**：同意 wiremock；补充 `tokio::test` 异步用例跑 stream command 内核（channel.send 可用 mpsc 替身抽象——决议：把"发事件"抽象为 trait 或闭包，command 层薄壳不测，内核 `stream_completion(events_sink)` 可测）。
- **DevOps**：CI 上 `cargo test` 全量跑，wiremock 端口用 0（随机）避免并发冲突。
- **发布经理**：发版前手工冒烟脚本列入发布 checklist（真实 OpenAI 兼容端 + Ollama 本地端各一次流式对话）。

**决议**：
1. 测试分层：纯函数（SSE/截断/加解密）直测；HTTP 层 wiremock；stream 内核用事件 sink 抽象解耦 Channel。
2. 截断策略定案：从新到旧回填，遇装不下即停，保留最近连续后缀。
3. UTF-8 跨 chunk 切断列入 SSE 必测用例。
4. dev-dependencies 新增 wiremock；AiService 提供测试构造器注入 base_url。

---

## 会议 8｜UX 设计：流式与多轮体验细节

**议题**：流式渲染的感知性能、会话管理交互、错误与降级体验。

**角色发言要点**：
- **UX 设计（主持）**：体验规格——
  - **首 token 延迟**是流式的核心指标：从发送到首个 delta 出现 >2s 时显示"正在连接模型…"占位气泡；delta 到达即替换为逐字文本 + 光标动画。
  - **节流**：渲染合帧 ≥60fps 下每 50ms 批量 flush 一次累积文本，避免每 delta 一次 re-render 拖垮 651 行的 AiSidebar（其含 schema 拼装逻辑）。
  - **滚动**：streaming 中若用户视口在底部则跟随滚动，用户上滚超过一屏则停止跟随并显示"回到底部"浮标。
  - **会话管理**：头部新增"清空会话"图标按钮；三模式切换时若有 ≥2 轮历史，弹轻量确认（"切换模式将清空当前对话"）。
  - **错误**：Error 事件→红色气泡显示可读信息（HTTP 401 提示检查 API Key，超时提示检查网络/BaseUrl），附"重试"；降级到同步模式时不提示（无逐字效果即隐式反馈）。
  - **掩码 key**：设置页 api_key 输入框 placeholder 显示 `已保存 (sk-...abcd)`，留空提交=不修改。
- **React 前端**：50ms flush 用 `useRef` 累积 + `setInterval` 或 rAF 实现，Done 时最终 flush；可行。
- **产品经理**：全部采纳；"回到底部"浮标若实现成本高可降级为仅停止跟随。
- **QA 测试**：体验项列入手工验收清单（首 token 占位、滚动跟随/脱离、清空确认、掩码显示）。

**决议**：
1. 采纳上述体验规格；渲染 flush 间隔 50ms；首 delta 前显示连接占位。
2. 滚动跟随策略：底部跟随、上滚脱离 + 回底浮标（可降级）。
3. 清空会话按钮 + 模式切换确认弹窗；错误气泡分类文案 + 重试。
4. api_key 掩码显示与"留空不修改"交互定案。

---

## 会议 9｜DevOps + Rust 后端：依赖、构建与 rig-core 决议

**议题**：Cargo.toml 变更（rig-core 去留、新增依赖）、wiremock/CI、构建体积。

**角色发言要点**：
- **DevOps（主持）**：当前 Cargo.toml 声明 `rig-core = "0.7"` 但源码零引用（仅注释里提 "Rig"），Cargo.lock 已拖入其依赖树（含 async-openai 等），**纯粹增加编译时间与二进制体积，无任何收益**。
- **Rust 后端**：确认全仓 `grep rig` 无 use 语句。rig-core 的价值在 Agent/Tool-Calling 编排，但本项目直连 OpenAI 兼容协议（含大量本地 Ollama/vLLM 端点），reqwest 手写更可控；rig 对非标兼容端的适配反而是风险。即便 WP3 做 Tool Calling，也可用 OpenAI function-calling 协议直接实现。**建议移除**，同时把 ai_service.rs 顶部误导性注释（"Rig AI Agent"）改为实际描述。
- **AI 工程师**：同意移除；rig-core 0.7 API 尚不稳定（版本迭代快、破坏性变更多），锁定 0.7 未来升级成本更高。
- **系统架构师**：新增依赖核定——运行时需要：`futures-util`（bytes_stream，若未在依赖树则加）、`base64`（secret_store 编码）；已有可复用：reqwest（需确认 `stream` feature 已开启）、aes-gcm、argon2、rand、serde。dev 依赖：`wiremock`。总增量小。
- **DevOps**：reqwest features 检查是关键——`stream` feature 未开则 `bytes_stream()` 不存在，编译期即暴露，但要在步骤清单里显式列出。CI：`cargo clippy -- -D warnings` + `cargo test` 现有流水线直接覆盖新增测试，无需改动。
- **发布经理**：移除 rig-core 后 Cargo.lock 需提交更新；二进制体积预计下降（rig 依赖树较大），作为附带收益记录。

**决议**：
1. **rig-core 0.7 移除**（声明未用、API 不稳、直连协议更可控）；同步修正 ai_service.rs 注释；提交更新后的 Cargo.lock。
2. 依赖变更：确认/开启 reqwest `stream` feature；新增 `futures-util`（如缺）、`base64`；dev-dependencies 加 `wiremock`。
3. CI 无结构改动，clippy -D warnings + cargo test 覆盖。
4. 构建验证：移除 rig-core 后全量 clean build 通过且体积不增。

---

## 会议 10｜发布经理：迁移、兼容与发布验收

**议题**：配置文件迁移、版本兼容矩阵、发布 checklist、回滚预案。

**角色发言要点**：
- **发布经理（主持）**：发布风险点与对策——
  - **配置迁移**：旧版 ai_config.json（明文 api_key、无新字段）在新版首次启动时：读取 → 检测明文 → 加密重写（含 format_version）；新增字段（token 预算等）走 serde default。**回滚风险**：新版加密后的文件旧版读不懂（旧版把密文对象当 api_key 字符串→请求 401）。对策：发布说明中注明"升级后请勿回滚到 <本版本；如需回滚，先在设置页重新保存配置或手删 ai_config.json"。可接受（个人工具型产品，用户量小）。
  - **IPC 兼容**：前端与后端同仓同构建，不存在版本错位；ai_chat 签名变更（新增 history 参数）用 `Option<Vec<ChatMessage>>` + `#[serde(default)]` 保持宽容。
  - **兼容矩阵冒烟**：macOS（主平台）+ OpenAI 兼容云端、Ollama 本地（stream 支持情况不同：Ollama 的 /v1/chat/completions 兼容层支持 SSE，需实测）、无 api_key 本地模型（Authorization 头省略逻辑保持）。
  - **发布 checklist**：cargo test 全绿 → clippy 零警告 → clean build → 手工冒烟（流式多轮追问、模式切换清空、key 掩码保存、旧配置迁移、断网降级）→ 更新 CHANGELOG（WP2 条目）→ 打 tag。
- **QA 测试**：手工冒烟脚本固化为 checklist 文档，随发布单执行。
- **产品经理**：CHANGELOG 用户可见文案三条：AI 对话支持多轮上下文、回答流式逐字输出、API Key 加密存储。
- **DevOps**：tag 与构建产物流程沿用现状，无新增。
- **安全工程师**：发布前复核——get_ai_config 脱敏生效（前端 Network/IPC 日志中不出现完整 key）、ai_config.json 落盘无明文。

**决议**：
1. 迁移策略定案：首启检测明文自动加密重写；serde default 保证旧文件可读；ai_chat history 参数 Option 化保持宽容。
2. 回滚预案：发布说明标注回滚限制与恢复手段（重存配置或删文件）。
3. 冒烟矩阵：OpenAI 兼容云端 + Ollama 本地 ×（流式/同步/无 key）；断网降级必测。
4. 发布 checklist 与安全复核项（IPC 无完整 key 泄漏）纳入发布单。

---

## 开发步骤清单

> 依赖顺序执行；每步含改动文件、验收标准与测试。全部完成定义：`cargo test` 全绿、`cargo clippy -- -D warnings` 零警告、手工冒烟通过。

### Step 1：清理 rig-core 与依赖调整（会议 9）
- 改动：`src-tauri/Cargo.toml`（删 `rig-core = "0.7"`；确认 reqwest 含 `stream` feature；按需加 `futures-util`、`base64`；dev-deps 加 `wiremock`）、`src-tauri/src/services/ai_service.rs` 顶部注释、提交新 Cargo.lock。
- 验收：clean build 通过；`rg rig-core src-tauri/src` 零命中。
- 测试：无新增（编译即验证）。

### Step 2：ChatMessage 类型 + token 估算与历史截断（会议 2/3）
- 改动：ai_service.rs 新增 `ChatMessage`（serde camelCase）、`estimate_tokens()`、`truncate_history(history, budget) -> Vec<ChatMessage>`；AiConfig 增加 `max_context_tokens`（default 8192）、`reserved_output_tokens`（default 1024），serde default。
- 验收：截断保留"最近连续后缀"、user/assistant 配对完整、序列以 user 开头；旧 ai_config.json（无新字段）可正常反序列化。
- 测试（cargo，纯函数）：
  - estimate_tokens：空串 / 纯英文 / 纯中文 / emoji / 混合。
  - truncate_history：预算充足全保留；超预算丢最早；恰好边界；单条超预算；空历史；奇数条历史配对。

### Step 3：prompt() 多轮改造 + wiremock 集成测试（会议 3/7）
- 改动：`prompt(&self, history, user_prompt, schema)`——组装 system(含 schema + 截断提示) → 截断后 history → 当前 user；AiService 增加测试构造器 `with_base_url()`。
- 验收：mock server 收到的请求体 messages 数组顺序与角色正确；schemaContext 仅出现在 system/最新一轮。
- 测试（wiremock）：多轮请求体断言；401/500 错误映射 AppError::Ai；无 api_key 时不发 Authorization 头。

### Step 4：SSE 解析器（会议 4/7）
- 改动：新建 `src-tauri/src/services/sse.rs`：`SseParser { buffer }`，`feed(&mut self, chunk: &[u8]) -> Vec<String>`；处理半行缓冲、UTF-8 跨 chunk、`data: [DONE]`（置 finished 标志）、注释/空行、null delta、非法 JSON 跳过。
- 验收：任意切分方式喂入同一 SSE 字节流，输出 delta 序列一致。
- 测试（纯函数）：标准多帧；单字节逐字喂入（半行+UTF-8 切断）；[DONE]；`:comment`；空行；CRLF；`delta.content` null；坏 JSON 帧；多 choice 取 [0]。

### Step 5：ai_chat_stream command + Channel 推送（会议 4）
- 改动：ai_service.rs 定义 `StreamEvent`（Delta{text}/Done{fullText}/Error{message}，serde tag="type" camelCase）；内核 `stream_completion(cfg, messages, sink)`（sink 为异步闭包/trait，可测）；commands/mod.rs 新增 `ai_chat_stream(prompt, history: Option<Vec<ChatMessage>>, schema_context, channel: Channel<StreamEvent>)`；main.rs 注册；reqwest client 统一 builder（connect_timeout 30s，无 read timeout）；请求体加 `"stream": true`。
- 验收：mock SSE 回放时 sink 依次收到 Delta…→Done{full_text 等于拼接结果}；HTTP 非 2xx 收到 Error 且无 Done。
- 测试：wiremock 回放固定 SSE 流（含半行/中文），断言事件序列；错误状态码→Error 事件。

### Step 6：secret_store 加密落盘（会议 5）
- 改动：新建 `src-tauri/src/services/secret_store.rs`：Argon2id(固定密码+随机 salt 16B)→AES-256-GCM(nonce 12B)，`EncryptedBlob{format_version, salt, nonce, ciphertext}`（base64）；ai_service.rs 加载/保存走 secret_store：保存时 api_key 加密写入，加载时解密到内存；**明文迁移**：检测到旧明文格式→内存解密态照常 + 立即加密重写文件；解密失败→api_key 置空 + warn，不阻断。
- 验收：新写 ai_config.json 无任何明文 key；旧明文文件首启后自动变加密格式且 key 可用；篡改密文启动后降级为空 key 不崩溃。
- 测试：roundtrip（含空串/中文/超长 key）；篡改 1 字节→Err；同明文两次加密结果不同；`migrate_if_plaintext` 用 tempdir+HOME 重定向测旧文件迁移。

### Step 7：get_ai_config 脱敏 + update 保留语义（会议 5/6）
- 改动：commands/mod.rs——`get_ai_config` 返回脱敏视图（has_key、key_tail4，不含完整 key）；`update_ai_config` 接收 `api_key: Option<String>`：None/占位符→保留内存中原 key，Some→更新。前端 types.ts 对齐。
- 验收：IPC 返回值与前端日志中不出现完整 key；不改 key 保存其他字段后原 key 仍有效（wiremock 断言 Authorization 头）。
- 测试：update 保留语义单测（None 不覆盖）；脱敏输出格式断言。

### Step 8：前端 ipc/store/AiSidebar 改造（会议 6/8）
- 改动：`src/services/ipc.ts`——aiChat 加 history 参数；新增 aiChatStream（Channel 封装，onDelta 回调，返回 full_text，异常时由调用方降级）；`src/store/useAppStore.ts` askAi 扩展；`src/components/AiSidebar.tsx`——发送时传最近 ≤20 条历史（仅 user/assistant）；流式状态机（idle/streaming/done/error）：50ms 节流 flush、光标动画、底部跟随滚动+上滚脱离、Done 后 full_text 替换校验；流式失败自动降级 aiChat 一次；清空会话按钮；模式切换有历史时确认弹窗并清空；错误气泡分类文案（401→检查 Key）+重试；设置页 key 掩码 placeholder、留空不修改。
- 验收（手工+构建）：`npm run build` 零 TS 错误；多轮追问指代正确（"把上面的 SQL 改成按周聚合"）；逐字渲染流畅无卡顿；断网/坏 BaseUrl 时错误气泡与降级正确；模式切换清空生效。
- 测试：前端以 tsc 构建 + 手工验收清单为准（本项目无前端单测框架，不新增）。

### Step 9：端到端联调与发布验收（会议 10）
- 改动：无源码（修复联调缺陷除外）；CHANGELOG 三条用户文案；发布说明含回滚限制。
- 验收 checklist：
  1. `cargo test` 全绿、`cargo clippy -- -D warnings` 零警告、clean build 体积不增。
  2. 冒烟矩阵：OpenAI 兼容云端 ×（流式多轮/同步降级/脱敏）、Ollama 本地 ×（流式/无 key）。
  3. 旧明文配置迁移实测（备份真机 ai_config.json 旧格式→启动→验证加密重写+对话可用）。
  4. 安全复核：IPC/前端日志无完整 key；~/.aidb/ai_config.json 无明文。
  5. 手工清单：首 token 占位、滚动跟随/回底、清空会话、模式切换确认、错误重试、断网降级。
- 测试：手工冒烟 + 既有 cargo 测试全量回归。

### 关键决议速查
| 议题 | 决议 |
|---|---|
| 会话归属 | 后端无状态，前端传 history（≤20 条），后端预算截断 |
| 截断策略 | 估算 tokens（字符近似，无 tokenizer 依赖）；从新到旧回填，遇装不下即停；整条丢弃保配对 |
| 流式通道 | `ai_chat_stream` + `Channel<StreamEvent>`（Delta/Done/Error）；SSE 解析独立纯模块；保留 ai_chat fallback，前端自动降级 |
| api_key 加密 | Argon2id(固定密码+随机 salt)+AES-256-GCM（方案 B+）；机器指纹否决；keyring 列 WP3；get 脱敏、留空不修改、旧文件无感迁移 |
| rig-core | **移除**（声明未用、API 不稳、直连更可控），修正注释，提交 Cargo.lock |
