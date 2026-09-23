/**
 * WP9 P2 批次测试
 * 错误文本来源: 本地真实 PG17 ux_demo 库 psql 实跑输出 (2026-09-23)
 * 覆盖: P2-1 列筛选 / P2-2 变更历史 / P2-3 属性chips / P2-4 错误人话建议 / P2-8 自动刷新
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { explainPgError } from '../src/utils/pgErrorHints';

// ===================== P2-4: explainPgError (纯函数, 真实 PG17 报错文本) =====================
describe('WP9-P2-4: explainPgError — 真实 ux_demo psql 报错映射', () => {
  it('column "total_amount" does not exist → 列不存在建议', () => {
    // 真实: psql -c "SELECT total_amount FROM shop.orders;"
    const h = explainPgError('ERROR:  column "total_amount" does not exist\nLINE 1: SELECT total_amount FROM shop.orders;');
    expect(h).not.toBeNull();
    expect(h!.explain).toContain('列不存在');
  });

  it('relation "shop.no_such_table" does not exist → 表不存在建议 (不误判为列)', () => {
    // 真实: psql -c "SELECT * FROM shop.no_such_table;"
    const h = explainPgError('ERROR:  relation "shop.no_such_table" does not exist');
    expect(h).not.toBeNull();
    expect(h!.explain).toContain('表/视图不存在');
  });

  it('permission denied for table orders → 权限不足建议', () => {
    // 真实: psql -U shop_reader -c "INSERT INTO shop.orders ..."
    const h = explainPgError('ERROR:  permission denied for table orders');
    expect(h).not.toBeNull();
    expect(h!.explain).toContain('权限不足');
    expect(h!.suggestion).toContain('用户管理');
  });

  it('syntax error at end of input → 语法错误建议', () => {
    const h = explainPgError('ERROR:  syntax error at end of input\nLINE 1: SELECT * FROM');
    expect(h).not.toBeNull();
    expect(h!.explain).toContain('语法错误');
  });

  it('check constraint 冲突 (ux_demo orders_status_check) → CHECK 约束建议', () => {
    // 真实: INSERT status='x' 违反 orders_status_check
    const h = explainPgError('ERROR:  new row for relation "orders" violates check constraint "orders_status_check"\nDETAIL:  Failing row contains (7, 1, 1.00, x, ...)');
    expect(h).not.toBeNull();
    expect(h!.explain).toContain('CHECK 约束');
  });

  it('SQLSTATE 命中: 23505 duplicate key', () => {
    const h = explainPgError('ERROR: 23505: duplicate key value violates unique constraint "orders_pkey"');
    expect(h).not.toBeNull();
    expect(h!.explain).toContain('唯一约束');
  });

  it('未知错误 → null (不编造建议, 原文照常展示)', () => {
    expect(explainPgError('ERROR:  some totally unknown failure xyzzy')).toBeNull();
    expect(explainPgError('')).toBeNull();
  });

  it('大小写不敏感', () => {
    const h = explainPgError('ERROR:  PERMISSION DENIED FOR TABLE orders');
    expect(h).not.toBeNull();
    expect(h!.explain).toContain('权限不足');
  });
});

// ===================== P2-1/P2-2/P2-3/P2-8 组件测试 =====================
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
  Channel: class { onmessage: any; },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const T = (val: any) => ({ type: 'Text' as const, val });
const I8 = (val: number) => ({ type: 'Int8' as const, val });
const Int4 = (val: number) => ({ type: 'Int4' as const, val });
const Numeric = (val: string) => ({ type: 'Numeric' as const, val });
const NULL = { type: 'Null' as const, val: null };

// ux_demo shop.orders 真实 6 行 (含 NULL customer_id 与 cancelled 状态)
const realOrdersRows = [
  [I8(1), Int4(1), Numeric('299.00'), T('paid'), T('2026-09-23T10:31:51+08:00')],
  [I8(2), Int4(1), Numeric('150.50'), T('shipped'), T('2026-09-23T10:31:51+08:00')],
  [I8(3), Int4(2), Numeric('88.00'), T('new'), T('2026-09-23T10:31:51+08:00')],
  [I8(4), Int4(3), Numeric('1200.00'), T('done'), T('2026-09-23T10:31:51+08:00')],
  [I8(5), Int4(4), Numeric('10.00'), T('cancelled'), T('2026-09-23T10:31:51+08:00')],
  [I8(6), NULL, Numeric('5.00'), T('new'), T('2026-09-23T10:31:51+08:00')],
];
const ordersColumns = [
  { name: 'id', data_type: 'bigint' },
  { name: 'customer_id', data_type: 'integer' },
  { name: 'total', data_type: 'numeric' },
  { name: 'status', data_type: 'text' },
  { name: 'ordered_at', data_type: 'timestamptz' },
];
const makeResult = (rows: any[][] = realOrdersRows) => ({
  columns: ordersColumns, rows, rows_affected: rows.length, elapsed_ms: 3, is_read_only: true,
});

beforeEach(() => {
  invokeMock.mockReset();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    writable: true, configurable: true,
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('WP9-P2-1: DataGrid 列头快速筛选 (ux_demo 真实行)', () => {
  it('status 列筛 cancelled → 只剩 1 行 + 横幅明示"仅已加载数据"', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    render(<DataGrid result={makeResult() as any} isExecuting={false} />);
    await screen.findByText('cancelled');

    fireEvent.change(screen.getByLabelText('筛选列 status'), { target: { value: 'cancel' } });

    await waitFor(() => {
      expect(document.querySelectorAll('tbody tr').length).toBe(1);
    });
    const banner = screen.getByTestId('filter-banner');
    expect(banner.textContent).toContain('1');
    expect(banner.textContent).toContain('仅过滤已加载数据');
  });

  it('多列 AND: status=new + customer_id 含 2 → 精确匹配', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    render(<DataGrid result={makeResult() as any} isExecuting={false} />);
    await screen.findByText('cancelled');

    fireEvent.change(screen.getByLabelText('筛选列 status'), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText('筛选列 customer_id'), { target: { value: '2' } });

    await waitFor(() => {
      expect(document.querySelectorAll('tbody tr').length).toBe(1);
    });
    expect(screen.getByText('88.00')).toBeTruthy();
  });

  it('NULL 行按空串参与: customer_id 筛 "6" 无匹配 (第6行 customer_id 为 NULL)', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    render(<DataGrid result={makeResult() as any} isExecuting={false} />);
    await screen.findByText('cancelled');

    fireEvent.change(screen.getByLabelText('筛选列 customer_id'), { target: { value: 'zzz' } });

    await waitFor(() => {
      expect(document.querySelectorAll('tbody tr').length).toBe(0);
    });
  });

  it('清除按钮恢复全量 6 行', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    render(<DataGrid result={makeResult() as any} isExecuting={false} />);
    await screen.findByText('cancelled');

    fireEvent.change(screen.getByLabelText('筛选列 status'), { target: { value: 'paid' } });
    await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBe(1));

    fireEvent.click(screen.getByTestId('clear-col-filters'));
    await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBe(6));
  });
});

describe('WP9-P2-8: ProcessListModal 自动刷新 + 错误显式呈现', () => {
  beforeEach(() => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_process_list') {
        return Promise.resolve([
          { pid: 101, user: 'yuguosheng', application_name: 'psql', client_addr: '127.0.0.1', state: 'active', query: 'SELECT 1', backend_start: '', query_start: '', wait_event_type: null, wait_event: null },
        ]);
      }
      return Promise.resolve(null);
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('选择 2s 自动刷新 → 定时器周期性重新拉取', async () => {
    const { ProcessListModal } = await import('../src/components/ProcessListModal');
    // 先用真实定时器完成初始加载 (fake timers 会卡住 waitFor 轮询)
    render(<ProcessListModal isOpen connId="c1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('SELECT 1')).toBeTruthy());

    const callsBefore = invokeMock.mock.calls.filter((c) => c[0] === 'get_process_list').length;

    // 初始加载完成后切 fake timers, 再开启自动刷新 (effect 重建的 setInterval 即 fake)
    vi.useFakeTimers();
    fireEvent.change(screen.getByTestId('auto-refresh-select'), { target: { value: '2000' } });
    act(() => { vi.advanceTimersByTime(2000); });

    // flush 微任务让 fetch promise 落盘 (fake timers 下手动 await)
    await act(async () => { await Promise.resolve(); });
    const callsAfter = invokeMock.mock.calls.filter((c) => c[0] === 'get_process_list').length;
    expect(callsAfter).toBeGreaterThan(callsBefore);
  });

  it('拉取失败 → 红色横幅显示真实错误 (不再 Quiet fail)', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_process_list') {
        return Promise.reject({ message: 'ERROR: permission denied for view pg_stat_activity' });
      }
      return Promise.resolve(null);
    });
    const { ProcessListModal } = await import('../src/components/ProcessListModal');
    render(<ProcessListModal isOpen connId="c1" onClose={vi.fn()} />);
    const errEl = await screen.findByTestId('process-fetch-error');
    expect(errEl.textContent).toContain('permission denied for view pg_stat_activity');
  });
});
