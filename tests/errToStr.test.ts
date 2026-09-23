/// WP8 T9: errToStr 统一错误提取 — AppErrorDto 是普通对象, String(err) 会得 [object Object]
import { describe, it, expect } from 'vitest';
import { errToStr } from '../src/services/ipc';

describe('WP8 T9: errToStr', () => {
  it('真实 AppErrorDto {code,message} → message（code）', () => {
    expect(errToStr({ code: 'CONN_NOT_FOUND', message: 'Connection not found: conn-1' })).toBe(
      'Connection not found: conn-1（CONN_NOT_FOUND）'
    );
  });
  it('只有 message', () => {
    expect(errToStr({ message: 'permission denied for schema app' })).toBe('permission denied for schema app');
  });
  it('只有 code', () => {
    expect(errToStr({ code: 'DB_ERROR' })).toBe('DB_ERROR');
  });
  it('空对象 {} → JSON 兜底或字符串, 绝不 [object Object]', () => {
    const out = errToStr({});
    expect(out).not.toContain('[object Object]');
  });
  it('字符串直传', () => {
    expect(errToStr('raw string error')).toBe('raw string error');
  });
  it('Error 实例', () => {
    expect(errToStr(new Error('boom'))).toBe('boom');
  });
  it('null/undefined → 占位文案', () => {
    expect(errToStr(null)).toBe('(未知错误)');
    expect(errToStr(undefined)).toBe('(未知错误)');
  });
});
