/// 基于 sqlparser-rs 的 SQL AST 抽象语法树安全审查引擎 (WP1 重构版)
/// - 三方言支持: PostgreSQL / MySQL / SQLite
/// - 风险分级: Safe / Warning / Critical (未显式列出的语句类型 fail-safe 归 Critical)
/// - read_only AST 白名单: 仅放行 Query / Explain(内层Query) / SHOW 族 / Pragma
///
/// 安全判定唯一收敛点: db_service.execute_query (前端判断仅为体验层, 不作安全依据)

use crate::error::AppError;
use crate::models::DatabaseType;
use serde::{Deserialize, Serialize};
use sqlparser::ast::Statement;
use sqlparser::dialect::{Dialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

/// SQL 风险等级
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    /// SELECT / EXPLAIN / SHOW / PRAGMA 等只读语句
    Safe,
    /// INSERT / 带 WHERE 的 UPDATE、DELETE / CREATE INDEX 等, 仅徽标提示不弹框
    Warning,
    /// 无 WHERE 的 UPDATE/DELETE、DROP、TRUNCATE、ALTER、GRANT/REVOKE、COPY 及一切未显式列出的语句 (fail-safe)
    Critical,
}

impl RiskLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            RiskLevel::Safe => "safe",
            RiskLevel::Warning => "warning",
            RiskLevel::Critical => "critical",
        }
    }
}

/// 安全审查裁决结果
#[derive(Debug, Clone, Serialize)]
pub struct SafetyVerdict {
    pub level: RiskLevel,
    /// 人类可读的风险原因列表 (用于前端确认框展示)
    pub reasons: Vec<String>,
    /// Critical 且非 force 时为 true: 需用户二次确认后携带 force 重试
    pub requires_confirmation: bool,
}

pub struct SqlSafetyChecker;

fn dialect_for(db_type: &DatabaseType) -> Box<dyn Dialect> {
    match db_type {
        DatabaseType::Postgres => Box::new(PostgreSqlDialect {}),
        DatabaseType::Mysql => Box::new(MySqlDialect {}),
        DatabaseType::Sqlite => Box::new(SQLiteDialect {}),
    }
}

/// 判断单条语句是否属于 SHOW 家族 (只读元数据)
fn is_show_statement(stmt: &Statement) -> bool {
    matches!(
        stmt,
        Statement::ShowVariable { .. }
            | Statement::ShowFunctions { .. }
            | Statement::ShowStatus { .. }
            | Statement::ShowVariables { .. }
            | Statement::ShowColumns { .. }
            | Statement::ShowTables { .. }
            | Statement::ShowDatabases { .. }
            | Statement::ShowSchemas { .. }
            | Statement::ShowCollation { .. }
            | Statement::ShowCreate { .. }
            | Statement::ShowViews { .. }
    )
}

/// 语句类型的简短可读名称 (用于错误消息)
fn statement_kind(stmt: &Statement) -> &'static str {
    match stmt {
        Statement::Query(_) => "SELECT/WITH query",
        Statement::Insert { .. } => "INSERT",
        Statement::Update { .. } => "UPDATE",
        Statement::Delete { .. } => "DELETE",
        Statement::Drop { .. } => "DROP",
        Statement::Truncate { .. } => "TRUNCATE",
        Statement::AlterTable { .. } => "ALTER TABLE",
        Statement::CreateTable { .. } => "CREATE TABLE",
        Statement::CreateIndex { .. } => "CREATE INDEX",
        Statement::CreateView { .. } => "CREATE VIEW",
        Statement::CreateSchema { .. } => "CREATE SCHEMA",
        Statement::CreateDatabase { .. } => "CREATE DATABASE",
        Statement::Grant { .. } => "GRANT",
        Statement::Revoke { .. } => "REVOKE",
        Statement::Copy { .. } => "COPY",
        Statement::Explain { .. } | Statement::ExplainTable { .. } => "EXPLAIN",
        Statement::Pragma { .. } => "PRAGMA",
        Statement::SetVariable { .. } => "SET",
        Statement::Commit { .. } => "COMMIT",
        Statement::Rollback { .. } => "ROLLBACK",
        Statement::StartTransaction { .. } => "BEGIN/START TRANSACTION",
        _ => "OTHER",
    }
}

impl SqlSafetyChecker {
    /// 对 SQL (可能含多条语句) 做风险分级审查。
    /// 语法解析失败时: 先做关键词 fail-safe 扫描 (sqlparser 不认识但 DB 能执行的写语句,
    /// 如 PG 数据修改 CTE `WITH d AS (DELETE ...) RETURNING`), 命中写关键词按 Critical 拦截;
    /// 未命中则透传解析错误, 交由数据库本身报语法错。
    pub fn inspect_safety(sql: &str, db_type: &DatabaseType) -> Result<SafetyVerdict, AppError> {
        let dialect = dialect_for(db_type);
        let statements = match Parser::parse_sql(&*dialect, sql) {
            Ok(stmts) => stmts,
            Err(e) => {
                if let Some(kind) = Self::scan_write_keywords(sql) {
                    return Ok(Self::critical(vec![format!(
                        "SQL 解析器无法完整解析, 但检测到写操作关键词 ({}), 按最高风险处理",
                        kind
                    )]));
                }
                return Err(AppError::SafetyBlocked(format!(
                    "SQL Syntax Parse Error: {}",
                    e
                )));
            }
        };

        let mut max_level = RiskLevel::Safe;
        let mut reasons: Vec<String> = Vec::new();

        for stmt in &statements {
            match stmt {
                // ---- Safe ----
                Statement::Query(_) => {}
                Statement::Explain { statement, .. } => {
                    // EXPLAIN 内层若不是 Query (如 EXPLAIN INSERT) 按内层重审
                    if !matches!(**statement, Statement::Query(_)) {
                        let inner = Self::inspect_single(statement);
                        if inner.0 == RiskLevel::Critical {
                            reasons.push(format!("EXPLAIN 包裹的写语句: {}", inner.1));
                        }
                        max_level = Self::escalate(max_level, inner.0);
                    }
                }
                Statement::ExplainTable { .. } => {}
                Statement::Pragma { .. } => {}
                s if is_show_statement(s) => {}

                // ---- Warning ----
                Statement::Insert { .. } => {
                    max_level = Self::escalate(max_level, RiskLevel::Warning);
                    reasons.push("INSERT 写入语句".to_string());
                }
                Statement::CreateIndex { .. } => {
                    max_level = Self::escalate(max_level, RiskLevel::Warning);
                    reasons.push("CREATE INDEX (非破坏性 DDL)".to_string());
                }
                Statement::Update { selection, .. } => {
                    if selection.is_none() {
                        reasons.push("UPDATE 语句缺少 WHERE 条件, 将影响全表".to_string());
                        return Ok(Self::critical(reasons));
                    }
                    max_level = Self::escalate(max_level, RiskLevel::Warning);
                    reasons.push("UPDATE 语句 (带 WHERE 条件)".to_string());
                }
                Statement::Delete(del) => {
                    if del.selection.is_none() {
                        reasons.push("DELETE 语句缺少 WHERE 条件, 将删除全表数据".to_string());
                        return Ok(Self::critical(reasons));
                    }
                    max_level = Self::escalate(max_level, RiskLevel::Warning);
                    reasons.push("DELETE 语句 (带 WHERE 条件)".to_string());
                }

                // ---- Critical ----
                Statement::Drop { .. } => {
                    reasons.push("DROP 语句将永久删除数据库对象".to_string());
                    return Ok(Self::critical(reasons));
                }
                Statement::Truncate { .. } => {
                    reasons.push("TRUNCATE 语句将清空整张表".to_string());
                    return Ok(Self::critical(reasons));
                }
                Statement::AlterTable { .. } => {
                    reasons.push("ALTER TABLE 可能破坏表结构 (如 DROP COLUMN)".to_string());
                    return Ok(Self::critical(reasons));
                }
                Statement::Grant { .. } | Statement::Revoke { .. } => {
                    reasons.push("GRANT/REVOKE 权限变更属高危操作".to_string());
                    return Ok(Self::critical(reasons));
                }
                Statement::Copy { .. } => {
                    reasons.push("COPY 可读写文件/批量写表".to_string());
                    return Ok(Self::critical(reasons));
                }

                // ---- fail-safe 兜底: 未显式列出的语句一律 Critical ----
                _ => {
                    reasons.push(format!(
                        "未识别为安全类型的语句 ({}) 按最高风险处理",
                        statement_kind(stmt)
                    ));
                    return Ok(Self::critical(reasons));
                }
            }
        }

        let requires_confirmation = max_level == RiskLevel::Critical;
        Ok(SafetyVerdict {
            level: max_level,
            reasons,
            requires_confirmation,
        })
    }

    /// read_only 模式 AST 白名单: 逐条检查, 任何一条不在白名单即整体拒绝。
    /// 解析失败也一律拦截 (无法证明只读就不放行)。
    pub fn check_read_only(sql: &str, db_type: &DatabaseType) -> Result<(), AppError> {
        let dialect = dialect_for(db_type);
        let statements = Parser::parse_sql(&*dialect, sql).map_err(|e| {
            AppError::SafetyBlocked(format!(
                "Read-Only mode: SQL 语法解析失败, 无法证明其为只读语句, 已拦截。Parse error: {}",
                e
            ))
        })?;

        for stmt in &statements {
            let allowed = match stmt {
                Statement::Query(_) => true, // SELECT 与 WITH...SELECT (CTE 属 Query)
                Statement::Explain { statement, .. } => matches!(**statement, Statement::Query(_)),
                Statement::ExplainTable { .. } => true,
                Statement::Pragma { .. } => true, // SQLite 只读元数据查询
                s => is_show_statement(s),
            };
            if !allowed {
                return Err(AppError::SafetyBlocked(format!(
                    "Read-Only mode: {} is not allowed in read-only connection.",
                    statement_kind(stmt)
                )));
            }
        }
        Ok(())
    }

    fn critical(reasons: Vec<String>) -> SafetyVerdict {
        SafetyVerdict {
            level: RiskLevel::Critical,
            reasons,
            requires_confirmation: true,
        }
    }

    /// 解析失败时的关键词 fail-safe 扫描: 检测 sqlparser 不认识但数据库能执行的写/维护语句
    /// (如 PG 数据修改 CTE、VACUUM、CALL、DO 块等)。命中返回语句类别名。
    fn scan_write_keywords(sql: &str) -> Option<&'static str> {
        // 剥掉行注释与块注释后按词边界扫描
        let cleaned = Self::strip_comments(sql).to_uppercase();
        const WRITE_KEYWORDS: &[(&str, &str)] = &[
            ("INSERT", "INSERT"),
            ("UPDATE", "UPDATE"),
            ("DELETE", "DELETE"),
            ("DROP", "DROP"),
            ("TRUNCATE", "TRUNCATE"),
            ("ALTER", "ALTER"),
            ("CREATE", "CREATE"),
            ("GRANT", "GRANT"),
            ("REVOKE", "REVOKE"),
            ("COPY", "COPY"),
            ("VACUUM", "VACUUM"),
            ("REINDEX", "REINDEX"),
            ("CLUSTER", "CLUSTER"),
            ("LOCK", "LOCK"),
            ("CALL", "CALL"),
            ("DO", "DO block"),
            ("EXECUTE", "EXECUTE"),
            ("REPLACE", "REPLACE"),
            ("MERGE", "MERGE"),
            ("SETVAL", "SETVAL"),
            ("NEXTVAL", "NEXTVAL"),
            ("COMMENT", "COMMENT ON"),
        ];
        for (kw, label) in WRITE_KEYWORDS {
            if Self::contains_word(&cleaned, kw) {
                return Some(label);
            }
        }
        None
    }

    /// 粗粒度剥离 SQL 注释 (-- 行注释与 /* */ 块注释), 供关键词扫描使用
    fn strip_comments(sql: &str) -> String {
        let mut out = String::with_capacity(sql.len());
        let chars: Vec<char> = sql.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '-' && i + 1 < chars.len() && chars[i + 1] == '-' {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            } else if chars[i] == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i = (i + 2).min(chars.len());
            } else {
                out.push(chars[i]);
                i += 1;
            }
        }
        out
    }

    /// 词边界匹配 (避免 "UPDATED_AT" 误命中 "UPDATE")
    fn contains_word(haystack_upper: &str, word_upper: &str) -> bool {
        let mut search_from = 0;
        while let Some(pos) = haystack_upper[search_from..].find(word_upper) {
            let abs = search_from + pos;
            let before_ok = abs == 0
                || !haystack_upper[abs - 1..abs]
                    .chars()
                    .next()
                    .map(|c| c.is_alphanumeric() || c == '_')
                    .unwrap_or(false);
            let end = abs + word_upper.len();
            let after_ok = end >= haystack_upper.len()
                || !haystack_upper[end..end + 1]
                    .chars()
                    .next()
                    .map(|c| c.is_alphanumeric() || c == '_')
                    .unwrap_or(false);
            if before_ok && after_ok {
                return true;
            }
            search_from = abs + 1;
        }
        false
    }

    fn escalate(cur: RiskLevel, new: RiskLevel) -> RiskLevel {
        use RiskLevel::*;
        match (cur, new) {
            (Critical, _) | (_, Critical) => Critical,
            (Warning, _) | (_, Warning) => Warning,
            _ => Safe,
        }
    }

    /// 单条语句快速分级 (用于 EXPLAIN 内层审查)
    fn inspect_single(stmt: &Statement) -> (RiskLevel, String) {
        match stmt {
            Statement::Query(_) => (RiskLevel::Safe, "query".into()),
            Statement::Insert { .. } => (RiskLevel::Warning, "INSERT".into()),
            Statement::Update { selection, .. } if selection.is_some() => {
                (RiskLevel::Warning, "UPDATE with WHERE".into())
            }
            Statement::Delete(d) if d.selection.is_some() => {
                (RiskLevel::Warning, "DELETE with WHERE".into())
            }
            _ => (RiskLevel::Critical, statement_kind(stmt).into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict(sql: &str, db: DatabaseType) -> SafetyVerdict {
        SqlSafetyChecker::inspect_safety(sql, &db).expect("parse ok")
    }

    fn pg(sql: &str) -> SafetyVerdict {
        verdict(sql, DatabaseType::Postgres)
    }

    // ---------- 分级规则 ----------

    #[test]
    fn select_is_safe() {
        assert_eq!(pg("SELECT * FROM users;").level, RiskLevel::Safe);
        assert_eq!(
            pg("WITH x AS (SELECT 1) SELECT * FROM x;").level,
            RiskLevel::Safe
        );
        assert_eq!(pg("EXPLAIN SELECT 1;").level, RiskLevel::Safe);
        assert_eq!(pg("SHOW server_version;").level, RiskLevel::Safe);
    }

    #[test]
    fn insert_is_warning() {
        let v = pg("INSERT INTO t (a) VALUES (1);");
        assert_eq!(v.level, RiskLevel::Warning);
        assert!(!v.requires_confirmation);
    }

    #[test]
    fn update_delete_with_where_is_warning() {
        assert_eq!(pg("UPDATE t SET a=1 WHERE id=2;").level, RiskLevel::Warning);
        assert_eq!(pg("DELETE FROM t WHERE id=2;").level, RiskLevel::Warning);
    }

    #[test]
    fn update_delete_without_where_is_critical() {
        let v = pg("UPDATE t SET a=1;");
        assert_eq!(v.level, RiskLevel::Critical);
        assert!(v.requires_confirmation);
        assert!(v.reasons.iter().any(|r| r.contains("WHERE")));

        let v2 = pg("DELETE FROM t;");
        assert_eq!(v2.level, RiskLevel::Critical);
        assert!(v2.requires_confirmation);
    }

    #[test]
    fn ddl_and_acl_are_critical() {
        for sql in [
            "DROP TABLE users;",
            "TRUNCATE users;",
            "ALTER TABLE users DROP COLUMN email;",
            "GRANT SELECT ON users TO bob;",
            "REVOKE ALL ON users FROM bob;",
        ] {
            assert_eq!(pg(sql).level, RiskLevel::Critical, "sql={}", sql);
        }
    }

    #[test]
    fn create_index_is_warning_not_critical() {
        assert_eq!(
            pg("CREATE INDEX idx ON users(id);").level,
            RiskLevel::Warning
        );
    }

    #[test]
    fn unknown_statement_fails_safe_to_critical() {
        // VACUUM 等未显式列出 → Critical 兜底 (fail-safe)
        assert_eq!(pg("VACUUM;").level, RiskLevel::Critical);
    }

    // ---------- 四类绕过向量 (SEC 验收口径) ----------

    #[test]
    fn bypass_comment_prefix() {
        assert_eq!(
            pg("/* comment */ DELETE FROM users;").level,
            RiskLevel::Critical
        );
    }

    #[test]
    fn bypass_mixed_case() {
        assert_eq!(pg("dElEtE FrOm users;").level, RiskLevel::Critical);
        assert_eq!(pg("  DrOp TABLE x;").level, RiskLevel::Critical);
    }

    #[test]
    fn bypass_with_cte_wrapped_write() {
        // PG 数据修改 CTE: 至少不得判为 Safe
        let v = pg("WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d;");
        assert_ne!(v.level, RiskLevel::Safe, "CTE-wrapped write must not be Safe");
    }

    #[test]
    fn bypass_multi_statement() {
        // 多语句: 只要有一条 Critical 即整体 Critical
        let v = pg("SELECT 1; DROP TABLE users;");
        assert_eq!(v.level, RiskLevel::Critical);
        assert!(v.requires_confirmation);
    }

    // ---------- read_only AST 白名单 ----------

    #[test]
    fn read_only_allows_select_family() {
        let pg = DatabaseType::Postgres;
        assert!(SqlSafetyChecker::check_read_only("SELECT 1;", &pg).is_ok());
        assert!(SqlSafetyChecker::check_read_only(
            "WITH x AS (SELECT 1) SELECT * FROM x;",
            &pg
        )
        .is_ok());
        assert!(SqlSafetyChecker::check_read_only("EXPLAIN SELECT 1;", &pg).is_ok());
        assert!(SqlSafetyChecker::check_read_only("SHOW server_version;", &pg).is_ok());
    }

    #[test]
    fn read_only_blocks_all_writes_and_ddl() {
        let pg = DatabaseType::Postgres;
        for sql in [
            "INSERT INTO t VALUES (1);",
            "UPDATE t SET a=1 WHERE id=2;",
            "DELETE FROM t WHERE id=2;",
            "DROP TABLE t;",
            "TRUNCATE t;",
            "ALTER TABLE t ADD COLUMN c INT;",
            "CREATE TABLE t (a INT);",
            "GRANT SELECT ON t TO bob;",
        ] {
            let r = SqlSafetyChecker::check_read_only(sql, &pg);
            assert!(r.is_err(), "should block: {}", sql);
            match r {
                Err(AppError::SafetyBlocked(msg)) => assert!(msg.contains("Read-Only"), "msg={}", msg),
                _ => panic!("expected SafetyBlocked"),
            }
        }
    }

    #[test]
    fn read_only_bypass_vectors_blocked() {
        let pg = DatabaseType::Postgres;
        // 注释前缀
        assert!(SqlSafetyChecker::check_read_only("/*c*/ UPDATE t SET a=1;", &pg).is_err());
        // 大小写混合
        assert!(SqlSafetyChecker::check_read_only("InSeRt INTO t VALUES (1);", &pg).is_err());
        // WITH 包裹写 (PG 数据修改 CTE)
        assert!(SqlSafetyChecker::check_read_only(
            "WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d;",
            &pg
        )
        .is_err());
        // 多语句夹带
        assert!(SqlSafetyChecker::check_read_only("SELECT 1; DROP TABLE x;", &pg).is_err());
    }

    #[test]
    fn read_only_blocks_unparseable_sql() {
        // 解析失败 → 无法证明只读 → 拦截
        assert!(
            SqlSafetyChecker::check_read_only("THIS IS NOT SQL $$$", &DatabaseType::Postgres).is_err()
        );
    }

    #[test]
    fn read_only_sqlite_pragma_allowed() {
        let lite = DatabaseType::Sqlite;
        assert!(SqlSafetyChecker::check_read_only("PRAGMA table_info('users');", &lite).is_ok());
        assert!(SqlSafetyChecker::check_read_only("SELECT * FROM sqlite_master;", &lite).is_ok());
        assert!(SqlSafetyChecker::check_read_only("DELETE FROM users;", &lite).is_err());
    }

    // ---------- 方言 ----------

    #[test]
    fn mysql_dialect_works() {
        assert_eq!(verdict("SELECT 1;", DatabaseType::Mysql).level, RiskLevel::Safe);
        assert_eq!(
            verdict("DELETE FROM t;", DatabaseType::Mysql).level,
            RiskLevel::Critical
        );
        assert_eq!(
            verdict("SHOW DATABASES;", DatabaseType::Mysql).level,
            RiskLevel::Safe
        );
    }

    #[test]
    fn sqlite_dialect_works() {
        assert_eq!(verdict("SELECT 1;", DatabaseType::Sqlite).level, RiskLevel::Safe);
        assert_eq!(
            verdict("DROP TABLE t;", DatabaseType::Sqlite).level,
            RiskLevel::Critical
        );
    }

    #[test]
    fn syntax_error_returns_blocked() {
        let r = SqlSafetyChecker::inspect_safety("SELEC FROM WHERE;", &DatabaseType::Postgres);
        assert!(matches!(r, Err(AppError::SafetyBlocked(_))));
    }

    #[test]
    fn risk_level_serialization_lowercase() {
        assert_eq!(serde_json::to_string(&RiskLevel::Critical).unwrap(), "\"critical\"");
        assert_eq!(serde_json::to_string(&RiskLevel::Safe).unwrap(), "\"safe\"");
    }
}
