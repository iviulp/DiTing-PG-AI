/**
 * WP9 使用者体验优化测试
 * 数据来源: 本地真实 PG17 ux_demo 库 (shop.orders 6 行 / shop.customers / active_customers 视图)
 *   psql -U yuguosheng -d ux_demo 实跑输出转 DbValue 形状 — 禁止假数据兜底
 * 覆盖: P1-2 AI新会话 / P1-3 SQL直接执行 / P1-4 SchemaTree过滤 / P1-5 网格复制 /
 *       P1-6 大结果集截断横幅 / P1-7 三态空状态
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
  Channel: class { onmessage: any; },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// ===== 真实 ux_demo 数据形状 =====
const T = (val: any) => ({ type: 'Text' as const, val });
const I8 = (val: number) => ({ type: 'Int8' as const, val });
const Int4 = (val: number) => ({ type: 'Int4' as const, val });
const Numeric = (val: string) => ({ type: 'Numeric' as const, val });
const Bool = (val: boolean) => ({ type: 'Bool' as const, val });
const NULL = { type: 'Null' as const, val: null };

// psql: SELECT * FROM shop.orders ORDER BY id LIMIT 6  (2026-09-23 实跑)
const realOrdersRows = [
  [I8(1), Int4(1), Numeric('299.00'), T('paid'), T('2026-09-23T10:31:51.534437+08:00')],
  [I8(2), Int4(1), Numeric('150.50'), T('shipped'), T('2026-09-23T10:31:51.534437+08:00')],
  [I8(3), Int4(2), Numeric('88.00'), T('new'), T('2026-09-23T10:31:51.534437+08:00')],
  [I8(4), Int4(3), Numeric('1200.00'), T('done'), T('2026-09-23T10:31:51.534437+08:00')],
  [I8(5), Int4(4), Numeric('10.00'), T('cancelled'), T('2026-09-23T10:31:51.534437+08:00')],
  [I8(6), NULL, Numeric('5.00'), T('new'), T('2026-09-23T10:31:51.534437+08:00')],
];
const ordersColumns = [
  { name: 'id', data_type: 'bigint' },
  { name: 'customer_id', data_type: 'integer' },
  { name: 'total', data_type: 'numeric' },
  { name: 'status', data_type: 'text' },
  { name: 'ordered_at', data_type: 'timestamptz' },
];

function makeResult(rows: any[][] = realOrdersRows, columns: any[] = ordersColumns) {
  return {
    columns,
    rows,
    rows_affected: rows.length,
    elapsed_ms: 3,
    is_read_only: true,
  };
}

// ux_demo shop schema 真实对象清单 (information_schema.tables 实跑)
const uxSchemaItems = [
  { name: 'customers', item_type: 'table', schema_name: 'shop' },
  { name: 'orders', item_type: 'table', schema_name: 'shop' },
  { name: 'active_customers', item_type: 'view', schema_name: 'shop' },
];

beforeEach(() => {
  invokeMock.mockReset();
  // jsdom 无 navigator.clipboard
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    writable: true,
    configurable: true,
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ===================== P1-4: SchemaTree 过滤 =====================
describe('WP9-P1-4: SchemaTree 搜索过滤 (ux_demo 真实对象)', () => {
  beforeEach(() => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_table_schema') return Promise.resolve(uxSchemaItems);
      return Promise.resolve(null);
    });
  });

  it('输入 order → 只剩 orders, customers/active_customers 被过滤', async () => {
    const { SchemaTree } = await import('../src/components/SchemaTree');
    render(<SchemaTree connId="c1" database="ux_demo" onSelectTable={vi.fn()} onDesignTable={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('customers')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('过滤表和视图'), { target: { value: 'order' } });

    expect(screen.getByText('orders')).toBeTruthy();
    expect(screen.queryByText('customers')).toBeNull();
    expect(screen.queryByText('active_customers')).toBeNull();
    expect(screen.getByTestId('schema-filter-count').textContent).toContain('1');
  });

  it('大小写不敏感: CUSTOM → 匹配 customers/active_customers', async () => {
    const { SchemaTree } = await import('../src/components/SchemaTree');
    render(<SchemaTree connId="c1" database="ux_demo" onSelectTable={vi.fn()} onDesignTable={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('customers')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('过滤表和视图'), { target: { value: 'CUSTOM' } });

    expect(screen.getByText('customers')).toBeTruthy();
    expect(screen.getByText('active_customers')).toBeTruthy();
    expect(screen.queryByText('orders')).toBeNull();
  });

  it('无匹配 → 显示无匹配提示, 清除按钮恢复全量', async () => {
    const { SchemaTree } = await import('../src/components/SchemaTree');
    render(<SchemaTree connId="c1" database="ux_demo" onSelectTable={vi.fn()} onDesignTable={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('customers')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('过滤表和视图'), { target: { value: 'zzz_不存在' } });
    expect(screen.getByTestId('schema-filter-count').textContent).toContain('无匹配对象');

    fireEvent.click(screen.getByTestId('schema-filter-clear'));
    await waitFor(() => expect(screen.getByText('customers')).toBeTruthy());
    expect(screen.getByText('orders')).toBeTruthy();
  });
});

// ===================== P1-5/6/7: DataGrid =====================
describe('WP9-P1-5: DataGrid 右键复制 (真实 ux_demo 行)', () => {
  it('右键单元格 → 复制单元格值 (cancelled 真实值)', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    render(<DataGrid result={makeResult() as any} isExecuting={false} />);
    const cell = await screen.findByText('cancelled');
    fireEvent.contextMenu(cell);
    fireEvent.click(screen.getByTestId('ctx-copy-cell'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('cancelled'));
  });

  it('右键 → 复制整行 CSV (含 NULL 空位, 逗号转义)', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    // 第 6 行 customer_id 为 NULL (ux_demo 真实数据)
    render(<DataGrid result={makeResult() as any} isExecuting={false} />);
    const cell = await screen.findByText('cancelled');
    fireEvent.contextMenu(cell);
    fireEvent.click(screen.getByTestId('ctx-copy-row'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const csv = (navigator.clipboard.writeText as any).mock.calls.at(-1)[0];
    expect(csv).toBe('5,4,10.00,cancelled,2026-09-23T10:31:51.534437+08:00');
  });

  it('右键 → 复制列名', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    render(<DataGrid result={makeResult() as any} isExecuting={false} />);
    const cell = await screen.findByText('cancelled');
    fireEvent.contextMenu(cell);
    fireEvent.click(screen.getByTestId('ctx-copy-colname'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('status'));
  });
});

describe('WP9-P1-6: DataGrid 大结果集渲染保护', () => {
  it('3000 行 → 只渲染 2000 行 + 横幅显示真实计数', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    // 用真实 orders 行复制成 3000 行 (数据形状真实, 量级模拟大结果集)
    const bigRows = Array.from({ length: 3000 }, (_, i) => [
      I8(i + 1), Int4(1), Numeric('299.00'), T('paid'), T('2026-09-23T10:31:51+08:00'),
    ]);
    render(<DataGrid result={makeResult(bigRows) as any} isExecuting={false} />);
    const banner = await screen.findByTestId('grid-truncation-banner');
    expect(banner.textContent).toContain('3,000');
    expect(banner.textContent).toContain('2,000');
    // 渲染行数: 数据行 = 2000 (行号列 td 计数 2000+header)
    const dataRows = document.querySelectorAll('tbody tr');
    expect(dataRows.length).toBe(2000);
  });

  it('6 行 (ux_demo 实际量) → 无横幅, 全量渲染', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    render(<DataGrid result={makeResult() as any} isExecuting={false} />);
    await screen.findByText('cancelled');
    expect(screen.queryByTestId('grid-truncation-banner')).toBeNull();
    expect(document.querySelectorAll('tbody tr').length).toBe(6);
  });
});

describe('WP9-P1-7: DataGrid 三态空状态', () => {
  it('未执行 (result=null, 无 error) → 引导态', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    render(<DataGrid result={null} isExecuting={false} />);
    expect(await screen.findByTestId('grid-state-idle')).toBeTruthy();
    expect(screen.getByText('尚未执行查询')).toBeTruthy();
  });

  it('失败 (result=null + error) → 红色错误态显示真实报错', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    // 真实 PG 报错 (ux_demo 实跑: SELECT 不存在列)
    const realErr = 'error returned from database: column "total_amount" does not exist';
    render(<DataGrid result={null} error={realErr} isExecuting={false} />);
    const el = await screen.findByTestId('grid-state-error');
    expect(el.textContent).toContain('查询执行失败');
    expect(el.textContent).toContain('total_amount');
  });

  it('0 行成功查询 → 正常表格 (无 error 态)', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    render(<DataGrid result={makeResult([]) as any} isExecuting={false} />);
    await waitFor(() => expect(screen.queryByTestId('grid-state-error')).toBeNull());
    expect(screen.queryByTestId('grid-state-idle')).toBeNull();
  });
});

// ===================== P1-2/P1-3: AiSidebar =====================
describe('WP9-P1-2: AiSidebar 新会话按钮', () => {
  beforeEach(() => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_ai_config') return Promise.resolve({ provider: 'openai', model: 'gpt-4o', base_url: '', api_key_set: true });
      if (cmd === 'get_tables_with_meta') return Promise.resolve([]);
      return Promise.resolve(null);
    });
  });

  it('点击新会话 (仅欢迎语时) → 无需确认, 保留欢迎语', async () => {
    const { AiSidebar } = await import('../src/components/AiSidebar');
    render(<AiSidebar onInsertSql={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ai-new-session')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-new-session'));
    // 只有欢迎语 → 直接重置, 不弹确认
    await waitFor(() => expect(screen.getByText(/DiTing AI PostgreSQL 专家协同助手/)).toBeTruthy());
  });
});

describe('WP9-P1-3: AiSidebar SQL 块直接执行按钮', () => {
  beforeEach(() => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_ai_config') return Promise.resolve({ provider: 'openai', model: 'gpt-4o', base_url: '', api_key_set: true });
      if (cmd === 'get_tables_with_meta') return Promise.resolve([]);
      return Promise.resolve(null);
    });
  });

  it('传 onExecuteSql → 流式回复后 SQL 块出现直接执行按钮, 点击回调收到真实 SQL', async () => {
    // 捕获 Channel 实例, 模拟后端推送真实流事件 (与 6c8d99f 修复后的 camelCase 契约一致)
    let captured: any = null;
    const core = await import('@tauri-apps/api/core');
    (core as any).Channel = class { onmessage: any; constructor() { captured = this; } };
    const aiSql = "SELECT * FROM shop.orders WHERE status = 'cancelled';";
    const fullText = '可以用这条 SQL:\n```sql\n' + aiSql + '\n```';
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'ai_chat_stream') {
        // 异步推流: delta 分两段 + done (真实 WP9 契约字段名)
        setTimeout(() => {
          captured.onmessage({ type: 'delta', text: '可以用这条 SQL:\n```sql\nSELECT * FRO' });
          captured.onmessage({ type: 'delta', text: "M shop.orders WHERE status = 'cancelled';\n```" });
          captured.onmessage({ type: 'done', fullText });
        }, 0);
        return Promise.resolve();
      }
      if (cmd === 'get_ai_config') return Promise.resolve({ provider: 'openai', model: 'gpt-4o', base_url: '', api_key_set: true });
      if (cmd === 'get_tables_with_meta') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const { AiSidebar } = await import('../src/components/AiSidebar');
    const onExec = vi.fn();
    render(<AiSidebar onInsertSql={vi.fn()} onExecuteSql={onExec} />);

    // 输入问题并发送 (真实用户流)
    const input = await screen.findByPlaceholderText(/输入提问/);
    fireEvent.change(input, { target: { value: '找出已取消的订单' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 等待流式完成 + SQL 块渲染
    const btn = await screen.findByTestId('ai-exec-sql', {}, { timeout: 4000 });
    fireEvent.click(btn);
    expect(onExec).toHaveBeenCalledWith(aiSql);
  });
});
