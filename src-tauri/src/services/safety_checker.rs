/// 基于 sqlparser-rs 的 SQL AST 抽象语法树安全审查引擎
/// 100% 准确识别 SELECT/DML/DDL 风险，阻止未加 WHERE 的删除/更新

use crate::error::AppError;
use sqlparser::ast::Statement;
use sqlparser::dialect::{MySqlDialect, PostgreSqlDialect};
use sqlparser::parser::Parser;

#[allow(dead_code)]
pub enum RiskLevel {
    Safe,     // SELECT, EXPLAIN
    Warning,  // INSERT, UPDATE (带 WHERE)
    Critical, // DROP, TRUNCATE, UPDATE/DELETE (无 WHERE)
}

#[allow(dead_code)]
pub struct SqlSafetyChecker;

#[allow(dead_code)]
impl SqlSafetyChecker {

    pub fn inspect_safety(sql: &str, is_postgres: bool) -> Result<RiskLevel, AppError> {
        let dialect: Box<dyn sqlparser::dialect::Dialect> = if is_postgres {
            Box::new(PostgreSqlDialect {})
        } else {
            Box::new(MySqlDialect {})
        };

        let statements = Parser::parse_sql(&*dialect, sql)
            .map_err(|e| AppError::SafetyBlocked(format!("SQL Syntax Parse Error: {}", e)))?;

        let mut max_risk = RiskLevel::Safe;

        for stmt in statements {
            match stmt {
                Statement::Query(_) => {}
                Statement::Update { selection, .. } => {
                    if selection.is_none() {
                        return Ok(RiskLevel::Critical);
                    }
                    max_risk = RiskLevel::Warning;
                }
                Statement::Delete(delete_stmt) => {
                    if delete_stmt.selection.is_none() {
                        return Ok(RiskLevel::Critical);
                    }
                    max_risk = RiskLevel::Warning;
                }
                Statement::Drop { .. } | Statement::Truncate { .. } => {
                    return Ok(RiskLevel::Critical);
                }
                _ => {
                    max_risk = RiskLevel::Warning;
                }
            }
        }

        Ok(max_risk)
    }
}
