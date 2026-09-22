/// WP4 (步骤1): 统一 SQL 转义工具 — 消除动态插值注入面
///
/// 语义契约 (与 src/utils/sqlEscape.ts 逐条对齐):
/// - 假设 PostgreSQL standard_conforming_strings=on (PG 9.1+ 默认): 反斜杠在字符串字面量中
///   无转义语义, 原样保留; 唯一需要的字面量转义是 `'` → `''`。
/// - 控制字符 (0x00-0x1F, 除 \t 放行; 0x7F DEL 也拒绝) 一律返回 Err — 拒绝而非清洗,
///   防止 NUL 截断类攻击 (PG 协议本身不允许字符串含 NUL)。
/// - 标识符: `"` → `""` 并包裹双引号; UTF-8 字节长度 >63 (PG NAME_MAX) 返回 Err。
/// - escape_like_pattern: 先转义 LIKE 元字符 (\ % _), 调用顺序契约 —
///   必须【先】escape_like_pattern 再【后】escape_sql_literal 包裹进字面量。

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlEscapeError {
    /// 含控制字符 (0x00-0x1F 除 \t, 及 0x7F)
    ControlCharacter(char),
    /// 标识符 UTF-8 字节长度超过 PostgreSQL 上限 63
    IdentifierTooLong(usize),
}

impl fmt::Display for SqlEscapeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SqlEscapeError::ControlCharacter(c) => {
                write!(f, "值包含不允许的控制字符 U+{:04X}", *c as u32)
            }
            SqlEscapeError::IdentifierTooLong(n) => {
                write!(f, "标识符长度 {n} 字节, 超过 PostgreSQL 上限 63")
            }
        }
    }
}

/// 检查控制字符: 拒绝 0x00-0x1F (放行 \t) 与 0x7F
fn check_control_chars(s: &str) -> Result<(), SqlEscapeError> {
    for c in s.chars() {
        if (c < '\u{20}' && c != '\t') || c == '\u{7F}' {
            return Err(SqlEscapeError::ControlCharacter(c));
        }
    }
    Ok(())
}

/// 字符串字面量转义: `'` → `''`。不含外层引号 (调用方拼接 `'{}'`)。
/// standard_conforming_strings=on 假设下反斜杠原样保留。
pub fn escape_sql_literal(s: &str) -> Result<String, SqlEscapeError> {
    check_control_chars(s)?;
    Ok(s.replace('\'', "''"))
}

/// 标识符安全引用: `"` → `""` 并包裹为 `"..."`。
/// UTF-8 字节长度 >63 拒绝 (PG 会静默截断导致指向错误对象)。
pub fn quote_identifier(s: &str) -> Result<String, SqlEscapeError> {
    check_control_chars(s)?;
    let len = s.len();
    if len > 63 {
        return Err(SqlEscapeError::IdentifierTooLong(len));
    }
    Ok(format!("\"{}\"", s.replace('"', "\"\"")))
}

/// 标识符清洗 (不包裹): `"` → `""`, 供调用方已有外层引号模板使用。
pub fn sanitize_identifier(s: &str) -> Result<String, SqlEscapeError> {
    check_control_chars(s)?;
    let len = s.len();
    if len > 63 {
        return Err(SqlEscapeError::IdentifierTooLong(len));
    }
    Ok(s.replace('"', "\"\""))
}

/// LIKE 模式转义: `\` → `\\`, `%` → `\%`, `_` → `\_`
/// (需配合 `LIKE '...' ESCAPE '\'` 或 PG 默认反斜杠 escape 语义)
pub fn escape_like_pattern(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- T1 全矩阵 (与 TS 端镜像) ----

    #[test]
    fn t1_literal_injection_single_quotes_doubled() {
        // #1
        assert_eq!(
            escape_sql_literal("'; DROP TABLE users; --").unwrap(),
            "''; DROP TABLE users; --"
        );
        // #2
        assert_eq!(escape_sql_literal("O'Brien").unwrap(), "O''Brien");
        // #3
        assert_eq!(escape_sql_literal("a'b'c'd").unwrap(), "a''b''c''d");
        // #4 反斜杠原样 (standard_conforming_strings=on)
        assert_eq!(escape_sql_literal("back\\slash").unwrap(), "back\\slash");
        // #5 tab 放行
        assert_eq!(escape_sql_literal("tab\tle").unwrap(), "tab\tle");
        // #9 空串合法
        assert_eq!(escape_sql_literal("").unwrap(), "");
        assert_eq!(escape_sql_literal("   ").unwrap(), "   ");
        // #11 Unicode 原样
        assert_eq!(escape_sql_literal("中文表名🚀").unwrap(), "中文表名🚀");
    }

    #[test]
    fn t1_literal_control_chars_rejected() {
        // #7 NUL
        assert_eq!(
            escape_sql_literal("bad\u{0}name").unwrap_err(),
            SqlEscapeError::ControlCharacter('\u{0}')
        );
        // #8 换行/回车/ESC
        assert!(escape_sql_literal("new\nline").is_err());
        assert!(escape_sql_literal("cr\r").is_err());
        assert!(escape_sql_literal("esc\u{1b}").is_err());
        // DEL 0x7F
        assert!(escape_sql_literal("del\u{7f}").is_err());
    }

    #[test]
    fn t1_identifier_quoting() {
        // #1 包裹形式
        assert_eq!(
            quote_identifier("'; DROP TABLE users; --").unwrap(),
            "\"'; DROP TABLE users; --\""
        );
        // #5 双引号翻倍
        assert_eq!(quote_identifier("tab\"le").unwrap(), "\"tab\"\"le\"");
        // #6
        assert_eq!(
            quote_identifier("\"; DROP TABLE x; --").unwrap(),
            "\"\"\"; DROP TABLE x; --\""
        );
        // #2/#3 单引号在标识符中原样 (由外层双引号保护)
        assert_eq!(quote_identifier("O'Brien").unwrap(), "\"O'Brien\"");
        // sanitize 版不包裹
        assert_eq!(sanitize_identifier("tab\"le").unwrap(), "tab\"\"le");
        // #11 UTF-8 字节长度
        assert_eq!(quote_identifier("中文表名🚀").unwrap(), "\"中文表名🚀\"");
    }

    #[test]
    fn t1_identifier_length_limit() {
        // #10: 63 字符合法, 64 拒绝
        let ok63 = "a".repeat(63);
        let bad64 = "a".repeat(64);
        assert!(quote_identifier(&ok63).is_ok());
        assert_eq!(
            quote_identifier(&bad64).unwrap_err(),
            SqlEscapeError::IdentifierTooLong(64)
        );
        // 中文按 UTF-8 字节计: 21 个汉字 = 63 字节 OK, 22 个 = 66 字节 Err
        let cn21 = "表".repeat(21);
        let cn22 = "表".repeat(22);
        assert!(quote_identifier(&cn21).is_ok());
        assert!(quote_identifier(&cn22).is_err());
        // 控制字符同规则拒绝
        assert!(quote_identifier("bad\u{0}name").is_err());
        assert!(sanitize_identifier("bad\nname").is_err());
    }

    #[test]
    fn t1_like_pattern_escape() {
        // #12: `\` → `\\`, `%` → `\%`, `_` → `\_`
        assert_eq!(escape_like_pattern("100%_a\\b"), "100\\%\\_a\\\\b");
        assert_eq!(escape_like_pattern("plain"), "plain");
        assert_eq!(escape_like_pattern("it's"), "it's", "LIKE 转义不处理引号, 顺序契约: 先 LIKE 后 literal");
    }

    #[test]
    fn compose_order_like_then_literal() {
        // 调用顺序契约演示: %_% 元字符先转义, 再进字面量
        let composed = escape_sql_literal(&escape_like_pattern("50%'")).unwrap();
        assert_eq!(composed, "50\\%''");
    }
}
