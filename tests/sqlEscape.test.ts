/// WP4 步骤3: sqlEscape 前端单测 (T1 镜像用例, 与 Rust sql_escape.rs 对齐)
import { describe, it, expect } from 'vitest';
import {
  escapeSqlLiteral,
  tryEscapeSqlLiteral,
  sanitizeIdentifier,
  quoteIdentifier,
  escapeLikePattern
} from '../src/utils/sqlEscape';

describe('escapeSqlLiteral (T1 镜像)', () => {
  it('#1 注入串单引号翻倍', () => {
    expect(escapeSqlLiteral("'; DROP TABLE users; --")).toBe("''; DROP TABLE users; --");
  });
  it('#2 O\'Brien', () => {
    expect(escapeSqlLiteral("O'Brien")).toBe("O''Brien");
  });
  it('#3 多引号', () => {
    expect(escapeSqlLiteral("a'b'c'd")).toBe("a''b''c''d");
  });
  it('#4 反斜杠原样 (standard_conforming_strings=on)', () => {
    expect(escapeSqlLiteral('back\\slash')).toBe('back\\slash');
  });
  it('#5 tab 放行', () => {
    expect(escapeSqlLiteral('tab\tle')).toBe('tab\tle');
  });
  it('#9 空串/纯空白合法', () => {
    expect(escapeSqlLiteral('')).toBe('');
    expect(escapeSqlLiteral('   ')).toBe('   ');
  });
  it('#11 Unicode 原样', () => {
    expect(escapeSqlLiteral('中文表名🚀')).toBe('中文表名🚀');
  });
  it('#7 NUL 拒绝 (throw)', () => {
    expect(() => escapeSqlLiteral('bad\u0000name')).toThrow(/控制字符/);
  });
  it('#8 换行/回车/ESC 拒绝', () => {
    expect(() => escapeSqlLiteral('new\nline')).toThrow();
    expect(() => escapeSqlLiteral('cr\r')).toThrow();
    expect(() => escapeSqlLiteral('esc\u001b')).toThrow();
  });
  it('DEL 0x7F 拒绝', () => {
    expect(() => escapeSqlLiteral('del\u007f')).toThrow();
  });
  it('tryEscapeSqlLiteral 失败返回 null', () => {
    expect(tryEscapeSqlLiteral("O'Brien")).toBe("O''Brien");
    expect(tryEscapeSqlLiteral('bad\u0000')).toBeNull();
  });
});

describe('identifier 转义 (T1 镜像)', () => {
  it('#1 quote 包裹形式', () => {
    expect(quoteIdentifier("'; DROP TABLE users; --")).toBe("\"'; DROP TABLE users; --\"");
  });
  it('#5 双引号翻倍', () => {
    expect(quoteIdentifier('tab"le')).toBe('"tab""le"');
    expect(sanitizeIdentifier('tab"le')).toBe('tab""le');
  });
  it('#6 前导双引号', () => {
    expect(quoteIdentifier('"; DROP TABLE x; --')).toBe('"""; DROP TABLE x; --"');
  });
  it('#2 单引号在标识符中原样', () => {
    expect(quoteIdentifier("O'Brien")).toBe("\"O'Brien\"");
  });
  it('#10 63 字符合法, 64 拒绝', () => {
    expect(quoteIdentifier('a'.repeat(63))).toBe(`"${'a'.repeat(63)}"`);
    expect(() => quoteIdentifier('a'.repeat(64))).toThrow(/63/);
  });
  it('#10 中文按 UTF-8 字节计: 21 字 (63B) OK, 22 字 (66B) 拒绝', () => {
    expect(quoteIdentifier('表'.repeat(21))).toBeTruthy();
    expect(() => quoteIdentifier('表'.repeat(22))).toThrow();
  });
  it('#11 Unicode 原样', () => {
    expect(quoteIdentifier('中文表名🚀')).toBe('"中文表名🚀"');
  });
  it('控制字符拒绝 (quote 与 sanitize 一致)', () => {
    expect(() => quoteIdentifier('bad\u0000name')).toThrow();
    expect(() => sanitizeIdentifier('bad\nname')).toThrow();
  });
});

describe('escapeLikePattern (T1 #12)', () => {
  it('\\ % _ 均转义', () => {
    expect(escapeLikePattern('100%_a\\b')).toBe('100\\%\\_a\\\\b');
  });
  it('普通串原样', () => {
    expect(escapeLikePattern('plain')).toBe('plain');
  });
  it('顺序契约: 先 LIKE 后 literal', () => {
    expect(escapeSqlLiteral(escapeLikePattern("50%'"))).toBe("50\\%''");
  });
});
