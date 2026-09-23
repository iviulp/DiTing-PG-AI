//! AI 智能体核心服务 (WP2 重构版)
//! - OpenAI 兼容协议直连 (reqwest); rig-core 已按会议决议移除
//! - 多轮对话: 前端传 history, 后端拼装 system + 截断历史 + 当前 user (无状态)
//! - 流式输出: SSE 解析 (services/sse.rs) + sink 回调, 由 IPC Channel 层推送
//! - api_key 加密落盘: services/secret_store.rs (Argon2id + AES-256-GCM), 旧明文无感迁移

use crate::error::AppError;
use crate::services::secret_store::{decrypt_secret, encrypt_secret, EncryptedBlob};
use crate::services::sse::SseParser;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

/// 单轮聊天消息 (前端历史与后端组装共用; role 仅接受 user/assistant)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 流式事件 (serde tag="type" camelCase, 前端 Channel 判别)
/// WP9 修复: rename_all 在 enum 容器级只重命名【变体名】(Done→done), 不影响结构体变体字段;
/// 必须加 rename_all_fields="camelCase" (serde ≥1.0.190) 才能把 Done{full_text} 序列化为
/// {"type":"done","fullText":...}, 与前端 AiStreamEvent.fullText 契约对齐。
/// 此前缺该属性 → 前端 msg.fullText=undefined → reply.match() 崩溃 (AI 输出到半截报错)。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    Delta { text: String },
    Done { full_text: String },
    Error { message: String },
}

/// 磁盘持久化格式: api_key 以加密块存储 (api_key_encrypted=true) 或旧明文 (迁移前)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedAiConfig {
    provider_name: String,
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    api_key_blob: Option<EncryptedBlob>,
    #[serde(default)]
    api_key_encrypted: bool,
    model_name: String,
    temperature: f32,
    #[serde(default = "default_max_context_tokens")]
    max_context_tokens: usize,
    #[serde(default = "default_reserved_output_tokens")]
    reserved_output_tokens: usize,
}

fn default_max_context_tokens() -> usize {
    8192
}
fn default_reserved_output_tokens() -> usize {
    1024
}

/// 自定义 AI 配置模型 (内存态: api_key 为明文, 出 IPC 前必须脱敏)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub provider_name: String,
    pub base_url: String,
    pub api_key: String,
    pub model_name: String,
    pub temperature: f32,
    /// WP2: 上下文 token 预算 (字符近似估算)
    #[serde(default = "default_max_context_tokens")]
    pub max_context_tokens: usize,
    /// WP2: 为模型输出预留的 token 数
    #[serde(default = "default_reserved_output_tokens")]
    pub reserved_output_tokens: usize,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider_name: "Custom / LocalAI".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_key: "".into(),
            model_name: "gpt-4o-mini".into(),
            temperature: 0.2,
            max_context_tokens: default_max_context_tokens(),
            reserved_output_tokens: default_reserved_output_tokens(),
        }
    }
}

/// AI 配置脱敏视图 (get_ai_config IPC 返回, 绝不含完整 key)
#[derive(Debug, Clone, Serialize)]
pub struct AiConfigView {
    pub provider_name: String,
    pub base_url: String,
    pub model_name: String,
    pub temperature: f32,
    pub max_context_tokens: usize,
    pub reserved_output_tokens: usize,
    pub has_key: bool,
    /// 掩码尾 4 位 (sk-****abcd)
    pub key_tail4: Option<String>,
}

impl AiConfig {
    pub fn to_view(&self) -> AiConfigView {
        AiConfigView {
            provider_name: self.provider_name.clone(),
            base_url: self.base_url.clone(),
            model_name: self.model_name.clone(),
            temperature: self.temperature,
            max_context_tokens: self.max_context_tokens,
            reserved_output_tokens: self.reserved_output_tokens,
            has_key: !self.api_key.is_empty(),
            key_tail4: if self.api_key.chars().count() >= 4 {
                Some(self.api_key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect())
            } else if !self.api_key.is_empty() {
                Some(self.api_key.clone())
            } else {
                None
            },
        }
    }
}

/// token 估算 (工程近似, 无 tokenizer 依赖):
/// tokens ≈ max(chars/4, CJK 字符数) — 中文场景每字约 1 token, 英文约 4 字符 1 token
pub fn estimate_tokens(s: &str) -> usize {
    let chars = s.chars().count();
    if chars == 0 {
        return 0;
    }
    let cjk = s
        .chars()
        .filter(|c| {
            matches!(c,
                '\u{4E00}'..='\u{9FFF}' |
                '\u{3040}'..='\u{30FF}' |
                '\u{AC00}'..='\u{D7AF}' |
                '\u{3400}'..='\u{4DBF}'
            )
        })
        .count();
    (chars / 4).max(cjk).max(1)
}

/// 历史截断: 预算内从最新往前回填, 整条丢弃保 user/assistant 配对, 结果以 user 开头。
/// 返回 (保留的历史, 是否发生截断)
pub fn truncate_history(history: &[ChatMessage], budget: usize) -> (Vec<ChatMessage>, bool) {
    let mut kept_rev: Vec<ChatMessage> = Vec::new();
    let mut used = 0usize;
    for msg in history.iter().rev() {
        let cost = estimate_tokens(&msg.content) + 4; // role/分隔符开销近似
        if used + cost > budget {
            break;
        }
        used += cost;
        kept_rev.push(msg.clone());
    }
    kept_rev.reverse();

    // 保证序列以 user 开头 (丢弃头部落单的 assistant)
    while kept_rev.first().map(|m| m.role.as_str()) == Some("assistant") {
        kept_rev.remove(0);
    }
    let truncated = kept_rev.len() < history.len();
    (kept_rev, truncated)
}

fn system_prompt(db_context_schema: Option<&str>, truncated: bool) -> String {
    let mut prompt = format!(
        "You are a Principal PostgreSQL DBA & Lead Database Engineer in DiTing (AIDB Desk).\n\
        Your mission: Provide 100% syntactically accurate, high-performance PostgreSQL (v12-v17) SQL queries or concise technical answers.\n\n\
        CONTEXT:\n{}\n\n\
        RULES & CONSTRAINTS:\n\
        1. ACCURACY & DIALECT: Adhere strictly to PostgreSQL standard syntax (e.g. GRANT ON SCHEMA public vs GRANT ON TABLES, JSONB operators `->>`, `?`, ILIKE, FILTER(WHERE ...)).\n\
        2. FORMATTING: When SQL is requested or needed, ALWAYS encapsulate executable SQL in ```sql ``` code blocks.\n\
        3. SAFETY: NEVER generate unrestricted UPDATE/DELETE statements without WHERE clauses. Append LIMIT 100 on large read queries unless aggregate/pagination is specified.\n\
        4. EXPLANATION: Keep natural language explanations sharp, professional, and directly to the point. No fluff.",
        db_context_schema.unwrap_or("No specific schema required.")
    );
    if truncated {
        prompt.push_str("\n\nNOTE: (earlier conversation omitted due to context budget)");
    }
    prompt
}

/// 组装最终 messages: system(含 schema) → 截断后 history → 当前 user
pub fn build_messages(
    cfg: &AiConfig,
    history: &[ChatMessage],
    user_prompt: &str,
    db_context_schema: Option<&str>,
) -> Vec<ChatMessage> {
    let sys_tokens = estimate_tokens(&system_prompt(db_context_schema, false));
    let user_tokens = estimate_tokens(user_prompt);
    let budget = cfg
        .max_context_tokens
        .saturating_sub(sys_tokens)
        .saturating_sub(user_tokens)
        .saturating_sub(cfg.reserved_output_tokens);

    let (kept, truncated) = truncate_history(history, budget);

    let mut messages = Vec::with_capacity(kept.len() + 2);
    messages.push(ChatMessage {
        role: "system".into(),
        content: system_prompt(db_context_schema, truncated),
    });
    // 历史仅保留 user/assistant (防前端伪造 system 角色)
    for m in kept {
        if m.role == "user" || m.role == "assistant" {
            messages.push(m);
        }
    }
    messages.push(ChatMessage {
        role: "user".into(),
        content: user_prompt.to_string(),
    });
    messages
}

fn build_client() -> reqwest::Client {
    // DevOps 决议: connect_timeout 30s, 不设 read timeout (长回答), 靠用户取消
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// AI 编排引擎服务 (无状态: 每次请求前端传全量 history)
pub struct AiService {
    config: Arc<RwLock<AiConfig>>,
    /// 配置落盘路径 (测试可重定向, 避免污染真实 ~/.aidb)
    config_path: Arc<std::path::PathBuf>,
}

impl AiService {
    pub fn new() -> Self {
        let path = Self::default_config_path();
        let loaded = Self::load_from_disk(&path);
        Self {
            config: Arc::new(RwLock::new(loaded)),
            config_path: Arc::new(path),
        }
    }

    /// 测试构造器: 指定 base_url + 临时配置路径
    #[cfg(test)]
    pub fn with_base_url(base_url: &str) -> Self {
        let cfg = AiConfig {
            base_url: base_url.to_string(),
            ..Default::default()
        };
        let path = std::env::temp_dir().join(format!("aidb_test_ai_config_{}.json", uuid::Uuid::new_v4()));
        Self {
            config: Arc::new(RwLock::new(cfg)),
            config_path: Arc::new(path),
        }
    }

    fn default_config_path() -> std::path::PathBuf {
        if let Ok(home) = std::env::var("HOME") {
            let dir = std::path::PathBuf::from(home).join(".aidb");
            let _ = std::fs::create_dir_all(&dir);
            dir.join("ai_config.json")
        } else {
            std::path::PathBuf::from("ai_config.json")
        }
    }

    /// 加载磁盘配置; 检测旧明文格式则无感迁移 (立即加密重写)
    fn load_from_disk(path: &std::path::Path) -> AiConfig {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return AiConfig::default(),
        };
        let persisted: PersistedAiConfig = match serde_json::from_str(&content) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(target: "AI::CONFIG", "Failed to parse ai_config.json: {}", e);
                return AiConfig::default();
            }
        };

        let api_key = if persisted.api_key_encrypted {
            match persisted.api_key_blob {
                Some(blob) => match decrypt_secret(&blob) {
                    Ok(k) => k,
                    Err(e) => {
                        // 解密失败降级: 空 key + warn, 不阻断启动
                        tracing::warn!(target: "AI::CONFIG", "api_key decryption failed, degraded to empty: {}", e);
                        String::new()
                    }
                },
                None => String::new(),
            }
        } else if !persisted.api_key.is_empty() {
            // 旧明文格式 → 无感迁移: 内存照常, 立即加密重写文件
            let key = persisted.api_key.clone();
            tracing::info!(target: "AI::CONFIG", "Migrating legacy plaintext api_key to encrypted store");
            let blob = encrypt_secret(&key).ok();
            let migrated = PersistedAiConfig {
                provider_name: persisted.provider_name.clone(),
                base_url: persisted.base_url.clone(),
                api_key: String::new(),
                api_key_blob: blob,
                api_key_encrypted: true,
                model_name: persisted.model_name.clone(),
                temperature: persisted.temperature,
                max_context_tokens: persisted.max_context_tokens,
                reserved_output_tokens: persisted.reserved_output_tokens,
            };
            if let Err(e) = Self::persist(path, &migrated) {
                tracing::warn!(target: "AI::CONFIG", "Migration rewrite failed: {}", e);
            }
            key
        } else {
            String::new()
        };

        AiConfig {
            provider_name: persisted.provider_name,
            base_url: persisted.base_url,
            api_key,
            model_name: persisted.model_name,
            temperature: persisted.temperature,
            max_context_tokens: persisted.max_context_tokens,
            reserved_output_tokens: persisted.reserved_output_tokens,
        }
    }

    fn persist(path: &std::path::Path, persisted: &PersistedAiConfig) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(persisted).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    /// 更新并加密持久化配置; api_key 为占位符 "__KEEP__" (或空且原有 key) 时保留原 key
    pub async fn update_config(&self, new_config: AiConfig) -> Result<(), AppError> {
        const KEEP_PLACEHOLDER: &str = "__KEEP__";
        let mut lock = self.config.write().await;

        let api_key = if new_config.api_key == KEEP_PLACEHOLDER
            || (new_config.api_key.is_empty() && !lock.api_key.is_empty())
        {
            lock.api_key.clone()
        } else {
            new_config.api_key.clone()
        };

        *lock = AiConfig {
            api_key: api_key.clone(),
            ..new_config.clone()
        };

        let persisted = PersistedAiConfig {
            provider_name: new_config.provider_name.clone(),
            base_url: new_config.base_url.clone(),
            api_key: String::new(),
            api_key_blob: if api_key.is_empty() {
                None
            } else {
                Some(
                    encrypt_secret(&api_key)
                        .map_err(|e| AppError::Internal(format!("api_key encryption failed: {}", e)))?,
                )
            },
            api_key_encrypted: !api_key.is_empty(),
            model_name: new_config.model_name.clone(),
            temperature: new_config.temperature,
            max_context_tokens: new_config.max_context_tokens,
            reserved_output_tokens: new_config.reserved_output_tokens,
        };

        let path = self.config_path.as_ref().clone();
        match Self::persist(&path, &persisted) {
            Ok(_) => tracing::info!(target: "AI::CONFIG", path = ?path, "AI Config encrypted & persisted"),
            Err(e) => tracing::warn!(target: "AI::CONFIG", "Failed to persist AI config: {}", e),
        }
        Ok(())
    }

    /// 获取当前配置 (内存态含明文 key — 仅限后端内部使用; IPC 出口必须走 get_config_view)
    #[allow(dead_code)] // 后端内部 API + 测试断言; IPC 出口走 get_config_view
    pub async fn get_config(&self) -> AiConfig {
        self.config.read().await.clone()
    }

    /// IPC 出口: 脱敏视图
    pub async fn get_config_view(&self) -> AiConfigView {
        self.config.read().await.to_view()
    }

    fn request_payload(cfg: &AiConfig, messages: &[ChatMessage], stream: bool) -> serde_json::Value {
        serde_json::json!({
            "model": cfg.model_name,
            "messages": messages.iter().map(|m| serde_json::json!({
                "role": m.role,
                "content": m.content
            })).collect::<Vec<_>>(),
            "temperature": cfg.temperature,
            "stream": stream
        })
    }

    fn apply_auth(req: reqwest::RequestBuilder, cfg: &AiConfig) -> reqwest::RequestBuilder {
        if cfg.api_key.is_empty() {
            req
        } else {
            req.header("Authorization", format!("Bearer {}", cfg.api_key))
        }
    }

    /// 同步 (非流式) 多轮对话 — 保留为 fallback
    pub async fn prompt(
        &self,
        history: &[ChatMessage],
        user_prompt: &str,
        db_context_schema: Option<&str>,
    ) -> Result<String, AppError> {
        let cfg = self.config.read().await.clone();
        let messages = build_messages(&cfg, history, user_prompt, db_context_schema);

        let client = build_client();
        let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
        let req = Self::apply_auth(
            client.post(&url).json(&Self::request_payload(&cfg, &messages, false)),
            &cfg,
        );

        let resp = req.send().await.map_err(|e| AppError::Ai(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let err_body = resp.text().await.unwrap_or_default();
            return Err(AppError::Ai(Self::friendly_http_error(status, &err_body)));
        }

        let json_resp: serde_json::Value = resp.json().await.map_err(|e| AppError::Ai(e.to_string()))?;
        let content = json_resp["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("No response generated.")
            .to_string();
        Ok(content)
    }

    /// 流式对话: SSE delta 逐个喂给 sink; 结束回调 Done(full_text)
    pub async fn prompt_stream<F>(
        &self,
        history: &[ChatMessage],
        user_prompt: &str,
        db_context_schema: Option<&str>,
        mut sink: F,
    ) -> Result<(), AppError>
    where
        F: FnMut(StreamEvent),
    {
        let cfg = self.config.read().await.clone();
        let messages = build_messages(&cfg, history, user_prompt, db_context_schema);

        let client = build_client();
        let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
        let req = Self::apply_auth(
            client.post(&url).json(&Self::request_payload(&cfg, &messages, true)),
            &cfg,
        );

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                sink(StreamEvent::Error {
                    message: e.to_string(),
                });
                return Ok(());
            }
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let err_body = resp.text().await.unwrap_or_default();
            sink(StreamEvent::Error {
                message: Self::friendly_http_error(status, &err_body),
            });
            return Ok(());
        }

        let mut stream = resp.bytes_stream();
        let mut parser = SseParser::new();
        let mut full_text = String::new();

        while let Some(chunk) = stream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(e) => {
                    sink(StreamEvent::Error {
                        message: format!("Stream read error: {}", e),
                    });
                    return Ok(());
                }
            };
            for delta in parser.feed(&bytes) {
                full_text.push_str(&delta);
                sink(StreamEvent::Delta { text: delta });
            }
            if parser.finished {
                break;
            }
        }

        sink(StreamEvent::Done { full_text });
        Ok(())
    }

    fn friendly_http_error(status: reqwest::StatusCode, body: &str) -> String {
        let hint = match status.as_u16() {
            401 | 403 => " (请检查 API Key 是否正确/过期)",
            404 => " (请检查 BaseURL 与模型名是否正确)",
            429 => " (请求过于频繁或额度用尽)",
            _ => "",
        };
        let head: String = body.chars().take(300).collect();
        format!("AI Server HTTP Error {}: {}{}", status.as_u16(), head, hint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    /// WP9: StreamEvent serde 契约测试 — 验证序列化后的 JSON 字段名与前端 TS 判别对齐。
    /// 根因: `#[serde(tag="type", rename_all="camelCase")]` 中 rename_all 在 enum 容器级
    /// 只重命名【变体名】(Done→done), 不重命名【结构体变体的字段】(full_text 仍是 snake_case)。
    /// 前端 AiStreamEvent 期望 { type:'done', fullText } → 取到 undefined → reply.match() 崩溃。
    /// 修复: 加 rename_all_fields="camelCase" (serde ≥1.0.190)。本测试守护该契约。
    #[test]
    fn stream_event_serde_field_names_match_frontend_contract() {
        // Delta: { type:'delta', text } — 字段名 text 两端一致
        let delta = serde_json::to_value(StreamEvent::Delta { text: "hi".into() }).unwrap();
        assert_eq!(delta["type"], "delta");
        assert_eq!(delta["text"], "hi", "Delta.text 必须是 text");

        // Done: 前端读 msg.fullText — 序列化字段名必须是 fullText (不是 full_text)
        let done = serde_json::to_value(StreamEvent::Done { full_text: "完整回复".into() }).unwrap();
        assert_eq!(done["type"], "done");
        assert!(
            done.get("fullText").is_some(),
            "Done 必须序列化为 camelCase 'fullText' (前端契约); 实际: {}",
            done
        );
        assert_eq!(done["fullText"], "完整回复");
        assert!(
            done.get("full_text").is_none(),
            "不得残留 snake_case 'full_text' 字段 (前端读不到)"
        );

        // Error: { type:'error', message } — 两端一致
        let err = serde_json::to_value(StreamEvent::Error { message: "boom".into() }).unwrap();
        assert_eq!(err["type"], "error");
        assert_eq!(err["message"], "boom");
    }

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: content.into(),
        }
    }

    // ---------- estimate_tokens ----------

    #[test]
    fn estimate_tokens_empty() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn estimate_tokens_english() {
        let s = "a".repeat(100);
        assert_eq!(estimate_tokens(&s), 25);
    }

    #[test]
    fn estimate_tokens_cjk() {
        assert_eq!(estimate_tokens("数据库客户端测试工具你好"), 12);
    }

    #[test]
    fn estimate_tokens_emoji_and_mixed() {
        assert!(estimate_tokens("🔐🔐🔐🔐🔐🔐🔐🔐") >= 2);
        let mixed = "SELECT * FROM users WHERE name='张三'";
        assert!(estimate_tokens(mixed) >= 2);
    }

    // ---------- truncate_history ----------

    #[test]
    fn truncate_budget_enough_keeps_all() {
        let h = vec![msg("user", "hi"), msg("assistant", "hello"), msg("user", "bye")];
        let (kept, truncated) = truncate_history(&h, 10_000);
        assert_eq!(kept.len(), 3);
        assert!(!truncated);
    }

    #[test]
    fn truncate_over_budget_drops_oldest() {
        let h = vec![
            msg("user", &"x".repeat(400)),
            msg("assistant", &"y".repeat(400)),
            msg("user", "latest question"),
        ];
        let (kept, truncated) = truncate_history(&h, 30);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].content, "latest question");
        assert!(truncated);
    }

    #[test]
    fn truncate_starts_with_user() {
        let h = vec![
            msg("user", &"a".repeat(4000)),
            msg("assistant", "short answer"),
            msg("user", "q"),
        ];
        let (kept, _) = truncate_history(&h, 30);
        assert_eq!(kept[0].role, "user");
    }

    #[test]
    fn truncate_single_oversized_message() {
        let h = vec![msg("user", &"z".repeat(100_000))];
        let (kept, truncated) = truncate_history(&h, 10);
        assert!(kept.is_empty());
        assert!(truncated);
    }

    #[test]
    fn truncate_empty_history() {
        let (kept, truncated) = truncate_history(&[], 1000);
        assert!(kept.is_empty());
        assert!(!truncated);
    }

    #[test]
    fn truncate_odd_history_pairs() {
        let h = vec![
            msg("user", &"1".repeat(100)),
            msg("assistant", &"2".repeat(100)),
            msg("user", &"3".repeat(100)),
            msg("assistant", &"4".repeat(100)),
            msg("user", "5"),
        ];
        let (kept, _) = truncate_history(&h, 60);
        assert!(kept.first().map(|m| m.role.as_str()) == Some("user"));
        assert_eq!(kept.last().unwrap().content, "5");
    }

    // ---------- build_messages ----------

    #[test]
    fn build_messages_order_and_roles() {
        let cfg = AiConfig::default();
        let history = vec![msg("user", "q1"), msg("assistant", "a1")];
        let msgs = build_messages(&cfg, &history, "q2", Some("schema X"));
        assert_eq!(msgs[0].role, "system");
        assert!(msgs[0].content.contains("schema X"));
        assert_eq!(msgs[1].role, "user");
        assert_eq!(msgs[1].content, "q1");
        assert_eq!(msgs[2].role, "assistant");
        assert_eq!(msgs.last().unwrap().content, "q2");
        assert_eq!(msgs.last().unwrap().role, "user");
    }

    #[test]
    fn build_messages_rejects_fake_system_role() {
        let cfg = AiConfig::default();
        let history = vec![msg("system", "evil override"), msg("user", "q")];
        let msgs = build_messages(&cfg, &history, "q2", None);
        assert_eq!(msgs.iter().filter(|m| m.role == "system").count(), 1);
        assert!(!msgs.iter().any(|m| m.content == "evil override"));
    }

    // ---------- AiConfigView 脱敏 ----------

    #[test]
    fn config_view_masks_key() {
        let cfg = AiConfig {
            api_key: "sk-1234567890abcd".into(),
            ..Default::default()
        };
        let view = cfg.to_view();
        assert!(view.has_key);
        assert_eq!(view.key_tail4.as_deref(), Some("abcd"));
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("sk-1234567890abcd"));
    }

    #[test]
    fn config_view_no_key() {
        let cfg = AiConfig::default();
        let view = cfg.to_view();
        assert!(!view.has_key);
        assert!(view.key_tail4.is_none());
    }

    // ---------- 旧配置兼容 ----------

    #[test]
    fn old_config_json_deserializes_with_defaults() {
        let old = r#"{
            "provider_name": "Custom BaseURL",
            "base_url": "https://api.openai.com/v1",
            "api_key": "sk-legacy",
            "model_name": "gpt-4o-mini",
            "temperature": 0.2
        }"#;
        let p: PersistedAiConfig = serde_json::from_str(old).unwrap();
        assert_eq!(p.max_context_tokens, 8192);
        assert_eq!(p.reserved_output_tokens, 1024);
        assert!(!p.api_key_encrypted);
        assert_eq!(p.api_key, "sk-legacy");
    }

    // ---------- 磁盘加载/迁移 ----------

    #[test]
    fn load_migrates_plaintext_key_to_encrypted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai_config.json");
        std::fs::write(
            &path,
            r#"{
                "provider_name": "P",
                "base_url": "http://x/v1",
                "api_key": "sk-plaintext-legacy",
                "model_name": "m",
                "temperature": 0.1
            }"#,
        )
        .unwrap();

        let cfg = AiService::load_from_disk(&path);
        assert_eq!(cfg.api_key, "sk-plaintext-legacy");

        // 文件已被加密重写: 无明文 key, 有 blob
        let rewritten = std::fs::read_to_string(&path).unwrap();
        assert!(!rewritten.contains("sk-plaintext-legacy"));
        let p: PersistedAiConfig = serde_json::from_str(&rewritten).unwrap();
        assert!(p.api_key_encrypted);
        assert!(p.api_key_blob.is_some());
        assert_eq!(
            decrypt_secret(p.api_key_blob.as_ref().unwrap()).unwrap(),
            "sk-plaintext-legacy"
        );
    }

    #[test]
    fn load_encrypted_roundtrip_and_tamper_degrades() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai_config.json");

        let blob = encrypt_secret("sk-good-key").unwrap();
        let persisted = PersistedAiConfig {
            provider_name: "P".into(),
            base_url: "http://x/v1".into(),
            api_key: String::new(),
            api_key_blob: Some(blob),
            api_key_encrypted: true,
            model_name: "m".into(),
            temperature: 0.2,
            max_context_tokens: 8192,
            reserved_output_tokens: 1024,
        };
        std::fs::write(&path, serde_json::to_string(&persisted).unwrap()).unwrap();
        let cfg = AiService::load_from_disk(&path);
        assert_eq!(cfg.api_key, "sk-good-key");

        // 篡改密文 → 降级为空 key, 不 panic
        let mut bad = persisted.clone();
        let mut b = bad.api_key_blob.clone().unwrap();
        b.ciphertext = B64.encode(b"tampered-garbage-bytes");
        bad.api_key_blob = Some(b);
        std::fs::write(&path, serde_json::to_string(&bad).unwrap()).unwrap();
        let cfg2 = AiService::load_from_disk(&path);
        assert_eq!(cfg2.api_key, "");
    }

    // ---------- 网络层 wiremock ----------

    #[tokio::test]
    async fn prompt_multi_turn_request_body() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "SELECT 1;"}}]
            })))
            .expect(1)
            .mount(&server)
            .await;

        let svc = AiService::with_base_url(&format!("{}/v1", server.uri()));
        let history = vec![msg("user", "prev q"), msg("assistant", "prev a")];
        let out = svc.prompt(&history, "now q", Some("schema S")).await.unwrap();
        assert_eq!(out, "SELECT 1;");

        let req = &server.received_requests().await.unwrap()[0];
        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert!(msgs[0]["content"].as_str().unwrap().contains("schema S"));
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "prev q");
        assert_eq!(msgs[2]["role"], "assistant");
        assert_eq!(msgs[3]["role"], "user");
        assert_eq!(msgs[3]["content"], "now q");
        assert_eq!(body["stream"], false);
    }

    #[tokio::test]
    async fn prompt_no_key_no_auth_header() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "ok"}}]
            })))
            .mount(&server)
            .await;

        let svc = AiService::with_base_url(&format!("{}/v1", server.uri()));
        svc.prompt(&[], "q", None).await.unwrap();
        let req = &server.received_requests().await.unwrap()[0];
        let auth_name: reqwest::header::HeaderName = "authorization".parse().unwrap();
        assert!(!req.headers.contains_key(&auth_name));
    }

    #[tokio::test]
    async fn prompt_http_error_maps_to_ai_error() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid key"))
            .mount(&server)
            .await;

        let svc = AiService::with_base_url(&format!("{}/v1", server.uri()));
        let err = svc.prompt(&[], "q", None).await.unwrap_err();
        match err {
            AppError::Ai(m) => {
                assert!(m.contains("401"), "msg={}", m);
                assert!(m.contains("API Key"), "msg={}", m);
            }
            _ => panic!("expected AppError::Ai"),
        }
    }

    #[tokio::test]
    async fn stream_events_sequence() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let sse_body = "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n\
                        data: {\"choices\":[{\"delta\":{\"content\":\"好 SQL\"}}]}\n\n\
                        data: [DONE]\n\n";
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(sse_body),
            )
            .mount(&server)
            .await;

        let svc = AiService::with_base_url(&format!("{}/v1", server.uri()));
        let events: Arc<std::sync::Mutex<Vec<StreamEvent>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let ev2 = events.clone();
        svc.prompt_stream(&[], "q", None, move |e| {
            ev2.lock().unwrap().push(e);
        })
        .await
        .unwrap();

        let evs = events.lock().unwrap();
        assert_eq!(evs.len(), 3);
        match &evs[0] {
            StreamEvent::Delta { text } => assert_eq!(text, "你"),
            _ => panic!("expected Delta"),
        }
        match &evs[1] {
            StreamEvent::Delta { text } => assert_eq!(text, "好 SQL"),
            _ => panic!("expected Delta"),
        }
        match &evs[2] {
            StreamEvent::Done { full_text } => assert_eq!(full_text, "你好 SQL"),
            _ => panic!("expected Done"),
        }
    }

    #[tokio::test]
    async fn stream_http_error_emits_error_event_no_done() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&server)
            .await;

        let svc = AiService::with_base_url(&format!("{}/v1", server.uri()));
        let events: Arc<std::sync::Mutex<Vec<StreamEvent>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let ev2 = events.clone();
        svc.prompt_stream(&[], "q", None, move |e| {
            ev2.lock().unwrap().push(e);
        })
        .await
        .unwrap();

        let evs = events.lock().unwrap();
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            StreamEvent::Error { message } => assert!(message.contains("500"), "msg={}", message),
            _ => panic!("expected Error"),
        }
    }

    #[tokio::test]
    async fn update_config_keep_placeholder_preserves_key() {
        // KEEP 占位符语义: 前端未改 key 时传 __KEEP__, 后端保留原值
        let svc = AiService::with_base_url("http://x/v1");
        let cfg = AiConfig {
            api_key: "sk-original".into(),
            ..Default::default()
        };
        {
            let mut lock = svc.config.write().await;
            *lock = cfg.clone();
        }
        let update = AiConfig {
            api_key: "__KEEP__".into(),
            model_name: "new-model".into(),
            ..Default::default()
        };
        // 注: update_config 会写默认路径, 测试环境 HOME 可写, 仅验证内存语义
        svc.update_config(update).await.unwrap();
        let now = svc.get_config().await;
        assert_eq!(now.api_key, "sk-original");
        assert_eq!(now.model_name, "new-model");
    }
}
