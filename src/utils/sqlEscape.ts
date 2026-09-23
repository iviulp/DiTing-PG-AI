/// WP4 (步骤3): 前端统一 SQL 转义工具
/// 语义与 Rust 端 src-tauri/src/services/sql_escape.rs 逐条对齐:
/// | 函数               | Rust 对应           | 语义                                   |
/// |--------------------|---------------------|----------------------------------------|
/// | escapeSqlLiteral   | escape_sql_literal  | ' → ''；控制字符 throw；\ 原样 (scs=on) |
/// | sanitizeIdentifier | sanitize_identifier | " → ""；不包裹；控制字符/超63字节 throw |
/// | quoteIdentifier    | quote_identifier    | sanitize + 包裹 "..."                  |
/// | escapeLikePattern  | escape_like_pattern | \ → \\, % → \%, _ → \_                |
/// 调用顺序契约: 先 escapeLikePattern 再 escapeSqlLiteral。

/** 控制字符检查: 0x00-0x1F (放行 \t) 与 0x7F 拒绝 */
function assertNoControlChars(s: string): void {
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if ((code < 0x20 && ch !== '\t') || code === 0x7f) {
      throw new Error(
        `值包含不允许的控制字符 U+${code.toString(16).toUpperCase().padStart(4, '0')}`
      );
    }
  }
}

/** UTF-8 字节长度 (与 Rust s.len() 对齐) */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 字符串字面量转义: ' → '' (不含外层引号) */
export function escapeSqlLiteral(s: string): string {
  assertNoControlChars(s);
  return s.replace(/'/g, "''");
}

/** escapeSqlLiteral 的安全版: 失败返回 null */
export function tryEscapeSqlLiteral(s: string): string | null {
  try {
    return escapeSqlLiteral(s);
  } catch {
    return null;
  }
}

/** 标识符清洗: " → "" (不包裹; 调用方模板已有外层引号时使用) */
export function sanitizeIdentifier(s: string): string {
  assertNoControlChars(s);
  const len = utf8ByteLength(s);
  if (len > 63) {
    throw new Error(`标识符长度 ${len} 字节, 超过 PostgreSQL 上限 63`);
  }
  return s.replace(/"/g, '""');
}

/** 标识符安全引用: sanitize + 包裹 "..." */
export function quoteIdentifier(s: string): string {
  return `"${sanitizeIdentifier(s)}"`;
}

/** LIKE 模式转义: \ → \\, % → \%, _ → \_ */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
