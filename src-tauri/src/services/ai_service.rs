/// Rig AI Agent 智能体核心服务
/// 支持自定义 AI BaseURL、自定义 API Key、动态模型与 Tool Calling 安全沙盒

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

/// 自定义 AI 配置模型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub provider_name: String,
    pub base_url: String,
    pub api_key: String,
    pub model_name: String,
    pub temperature: f32,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider_name: "Custom / LocalAI".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_key: "".into(),
            model_name: "gpt-4o-mini".into(),
            temperature: 0.2,
        }
    }
}

/// Rig AI 编排引擎服务
pub struct AiService {
    config: Arc<RwLock<AiConfig>>,
}

impl AiService {
    pub fn new() -> Self {
        let config_path = Self::get_config_path();
        let loaded_config = if let Ok(content) = std::fs::read_to_string(&config_path) {
            serde_json::from_str::<AiConfig>(&content).unwrap_or_default()
        } else {
            AiConfig::default()
        };

        Self {
            config: Arc::new(RwLock::new(loaded_config)),
        }
    }

    fn get_config_path() -> std::path::PathBuf {
        if let Ok(home) = std::env::var("HOME") {
            let dir = std::path::PathBuf::from(home).join(".aidb");
            let _ = std::fs::create_dir_all(&dir);
            dir.join("ai_config.json")
        } else {
            std::path::PathBuf::from("ai_config.json")
        }
    }

    /// 更新并持久化存储自定义 AI Provider 配置到本地磁盘
    pub async fn update_config(&self, new_config: AiConfig) -> Result<(), AppError> {
        let mut lock = self.config.write().await;
        *lock = new_config.clone();

        let path = Self::get_config_path();
        if let Ok(json_str) = serde_json::to_string_pretty(&new_config) {
            if let Err(e) = std::fs::write(&path, json_str) {
                tracing::warn!(target: "AI::RIG", "Failed to persist AI config to disk: {}", e);
            } else {
                tracing::info!(target: "AI::RIG", path = ?path, "AI Config successfully persisted to disk");
            }
        }
        Ok(())
    }

    /// 获取当前 AI 配置
    pub async fn get_config(&self) -> AiConfig {
        self.config.read().await.clone()
    }

    /// 核心自然语言对话转 SQL / Schema 分析 / DBA 运维问答
    pub async fn prompt(&self, user_prompt: &str, db_context_schema: Option<&str>) -> Result<String, AppError> {
        let cfg = self.config.read().await;

        let system_prompt = format!(
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

        // 使用 Reqwest 通用 OpenAI 兼容协议发起 API 呼叫
        let client = reqwest::Client::new();
        let payload = serde_json::json!({
            "model": cfg.model_name,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "temperature": cfg.temperature
        });

        let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
        let mut req = client.post(&url).json(&payload);

        if !cfg.api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", cfg.api_key));
        }

        let resp = req.send().await.map_err(|e| AppError::Ai(e.to_string()))?;
        if !resp.status().is_success() {
            let err_body = resp.text().await.unwrap_or_default();
            return Err(AppError::Ai(format!("AI Server HTTP Error: {}", err_body)));
        }

        let json_resp: serde_json::Value = resp.json().await.map_err(|e| AppError::Ai(e.to_string()))?;
        let content = json_resp["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("No response generated.")
            .to_string();

        Ok(content)
    }
}
