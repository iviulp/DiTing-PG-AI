/// WP4 步骤4: getTableColumnsMetaData 转义与 schema 参数测试 (T3, mock invoke)
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock @tauri-apps/api/core 的 invoke, 捕获 SQL
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (_cmd: string, args?: any) => ({
    columns: [],
    rows: [],
    rows_affected: 0,
    elapsed_ms: 0,
    is_read_only: true,
    __capturedSql: args?.sql ?? ''
  })),
  Channel: class {}
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { getTableColumnsMetaData } from '../src/services/ipc';

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

function capturedSql(): string {
  // 取最后一次带 sql 参数的 execute_sql 调用
  for (let i = mockInvoke.mock.calls.length - 1; i >= 0; i--) {
    const args = mockInvoke.mock.calls[i][1];
    if (args && typeof args.sql === 'string') return args.sql;
  }
  throw new Error('未捕获到含 sql 的 invoke 调用');
}

describe('getTableColumnsMetaData (T3)', () => {
  beforeEach(() => mockInvoke.mockClear());

  it("表名含单引号 → table_name = 'tbl''name'", async () => {
    await getTableColumnsMetaData('c1', "tbl'name");
    const sql = capturedSql();
    expect(sql).toContain("table_name = 'tbl''name'");
    expect(sql).toContain("table_schema = 'public'");
  });

  it('注入尝试被字面量化, 无多语句', async () => {
    await getTableColumnsMetaData('c1', "x'; DROP TABLE users; --");
    const sql = capturedSql();
    expect(sql).toContain("table_name = 'x''; DROP TABLE users; --'");
    // 分号只应出现在字面量内部 (整个语句仍是一条 SELECT)
    expect(sql.trim().startsWith('SELECT')).toBe(true);
  });

  it('schema 参数透传', async () => {
    await getTableColumnsMetaData('c1', 'orders', 'sales');
    const sql = capturedSql();
    expect(sql).toContain("table_schema = 'sales'");
    expect(sql).toContain("table_name = 'orders'");
  });

  it('schema 含单引号也转义', async () => {
    await getTableColumnsMetaData('c1', 't', "sch'ema");
    const sql = capturedSql();
    expect(sql).toContain("table_schema = 'sch''ema'");
  });

  it('col_description 使用 %I.%I regclass 形式', async () => {
    await getTableColumnsMetaData('c1', 't');
    const sql = capturedSql();
    expect(sql).toContain("format('%I.%I', c.table_schema, c.table_name)::regclass");
    expect(sql).not.toContain("format('%s.%s'");
  });
});
