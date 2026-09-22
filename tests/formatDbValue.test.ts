/// WP5 T11: formatDbValue vitest — 9 tag + 判空 + hex 截断
import { describe, it, expect } from 'vitest';
import { formatDbValue, isDbValueNull } from '../src/utils/formatDbValue';
import type { DbValue } from '../src/types';

describe('formatDbValue 9-tag 全覆盖', () => {
  it('Null → NULL 哨兵', () => {
    expect(formatDbValue({ type: 'Null', val: null } as DbValue)).toBe('NULL');
    expect(formatDbValue(null)).toBe('NULL');
    expect(formatDbValue(undefined)).toBe('NULL');
  });

  it('Int 原样 (含负数与边界)', () => {
    expect(formatDbValue({ type: 'Int', val: 42 } as DbValue)).toBe('42');
    expect(formatDbValue({ type: 'Int', val: -1 } as DbValue)).toBe('-1');
    expect(formatDbValue({ type: 'Int', val: 9007199254740991 } as DbValue)).toBe('9007199254740991');
  });

  it('Float 原样', () => {
    expect(formatDbValue({ type: 'Float', val: 3.14 } as DbValue)).toBe('3.14');
    expect(formatDbValue({ type: 'Float', val: 0 } as DbValue)).toBe('0');
  });

  it('StringDecimal 高精度无损 (65,30 长串不截断)', () => {
    const big = '12345678901234567890123456789012345.123456789012345678901234567890';
    expect(formatDbValue({ type: 'StringDecimal', val: big } as DbValue)).toBe(big);
  });

  it('Bool → true/false 小写', () => {
    expect(formatDbValue({ type: 'Bool', val: true } as DbValue)).toBe('true');
    expect(formatDbValue({ type: 'Bool', val: false } as DbValue)).toBe('false');
  });

  it('Text/Json/Timestamp 原样字符串', () => {
    expect(formatDbValue({ type: 'Text', val: 'hello' } as DbValue)).toBe('hello');
    expect(formatDbValue({ type: 'Json', val: '{"a":1}' } as DbValue)).toBe('{"a":1}');
    expect(formatDbValue({ type: 'Timestamp', val: '2026-09-22 10:00:00.000+08:00' } as DbValue)).toBe('2026-09-22 10:00:00.000+08:00');
  });

  it('空字符串 Text 不是 NULL', () => {
    expect(formatDbValue({ type: 'Text', val: '' } as DbValue)).toBe('');
    expect(isDbValueNull({ type: 'Text', val: '' } as DbValue)).toBe(false);
  });

  it('BytesHex 0x 前缀 + 短 hex 不截断', () => {
    expect(formatDbValue({ type: 'BytesHex', val: '00ff10' } as DbValue)).toBe('0x00ff10');
    expect(formatDbValue({ type: 'BytesHex', val: '' } as DbValue)).toBe('0x');
  });

  it('BytesHex 超长截断并标注字节数', () => {
    const long = 'ab'.repeat(100); // 200 hex chars = 100 bytes
    const out = formatDbValue({ type: 'BytesHex', val: long } as DbValue);
    expect(out.startsWith('0x' + 'ab'.repeat(32))).toBe(true);
    expect(out).toContain('…');
    expect(out).toContain('(100B)');
  });

  it('decode error 文本透出', () => {
    expect(formatDbValue({ type: 'Text', val: '<decode error: boom>' } as DbValue)).toBe('<decode error: boom>');
  });

  it('isDbValueNull tag 级判定', () => {
    expect(isDbValueNull({ type: 'Null', val: null } as DbValue)).toBe(true);
    expect(isDbValueNull(null)).toBe(true);
    expect(isDbValueNull({ type: 'Int', val: 0 } as DbValue)).toBe(false);
    expect(isDbValueNull({ type: 'Text', val: 'NULL' } as DbValue)).toBe(false, "字符串 'NULL' 不是真 NULL");
  });

  it('未知 tag 保守透出', () => {
    expect(formatDbValue({ type: 'Future' as any, val: 'x' } as any)).toBe('x');
  });
});
