/**
 * WP10: 分页条 + 过滤构建器 + store 分页状态机组件测试
 * 数据形状: ux_demo shop.orders 真实 6 行 (含 NULL customer_id / cancelled)
 * 原则: mock 仅拦截 IPC 传输层, SQL 生成走真实 browseSqlBuilder, 断言真实 SQL 文本
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

import { useAppStore } from '../src/store/useAppStore';
import { PaginationBar } from '../src/components/PaginationBar';
import { FilterBuilder } from '../src/components/FilterBuilder';
import type { PagingState } from '../src/store/useAppStore';

const T = (val: any) => ({ type: 'Text' as const, val });
const I8 = (val: number) => ({ type: 'Int8' as const, val });
const Int4 = (val: number) => ({ type: 'Int4' as const, val });
const Numeric = (val: string) => ({ type: 'Numeric' as const, val });
const NULL = { type: 'Null' as const, val: null };

// ux_demo shop.orders 真实 6 行
const allOrders = [
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
const qr = (rows: any[][], cols: any[] = ordersColumns) => ({
  columns: cols, rows, rows_affected: rows.length, elapsed_ms: 2, is_read_only: true,
});

/** IPC 路由: 按 SQL 特征返回 ux_demo 真实形状结果 (与后端 execute_sql 行为一致) */
function routeSql(sql: string): any {
  if (sql.includes('reltuples')) return qr([[I8(6)]], [{ name: 'estimate', data_type: 'bigint' }]);
  if (sql.includes('indisprimary')) return qr([[T('id')]], [{ name: 'attname', data_type: 'name' }]);
  if (sql.includes('count(*)')) {
    // 真实 COUNT 语义模拟: cancelled→1 (引号/无引号两种形态), IS NULL→1, 无过滤→6
    if (sql.includes(`status" = 'cancelled'`) || sql.includes(`status = 'cancelled'`)) return qr([[I8(1)]], [{ name: 'total', data_type: 'bigint' }]);
    if (sql.includes('"customer_id" IS NULL')) return qr([[I8(1)]], [{ name: 'total', data_type: 'bigint' }]);
    return qr([[I8(6)]], [{ name: 'total', data_type: 'bigint' }]);
  }
  if (sql.includes('information_schema.columns')) {
    return qr(
      ordersColumns.map((c) => [T(c.name), T(c.data_type), T('YES'), NULL]),
      [
        { name: 'column_name', data_type: 'text' },
        { name: 'data_type', data_type: 'text' },
        { name: 'is_nullable', data_type: 'text' },
        { name: 'column_comment', data_type: 'text' },
      ]
    );
  }
  // 数据页: 解析 LIMIT/OFFSET 返回真实行的对应切片
  const lim = /LIMIT (\d+)/.exec(sql);
  const off = /OFFSET (\d+)/.exec(sql);
  let rows = allOrders;
  if (sql.includes(`status" = 'cancelled'`) || sql.includes(`status = 'cancelled'`)) rows = allOrders.filter((r) => r[3].val === 'cancelled');
  if (sql.includes('"customer_id" IS NULL')) rows = allOrders.filter((r) => r[1].val === null);
  const o = off ? Number(off[1]) : 0;
  const l = lim ? Number(lim[1]) : 100;
  return qr(rows.slice(o, o + l));
}

const executedSqls: string[] = [];
beforeEach(() => {
  invokeMock.mockReset();
  executedSqls.length = 0;
  invokeMock.mockImplementation((_cmd: string, args: any) => {
    if (_cmd === 'execute_sql') {
      if (args?.sql) executedSqls.push(args.sql);
      return Promise.resolve(routeSql(args?.sql || ''));
    }
    if (_cmd === 'sql_safety_check' || _cmd === 'analyze_sql') {
      return Promise.resolve({ risk_level: 'Safe', reasons: [], requires_confirmation: false });
    }
    return Promise.resolve(null);
  });
  useAppStore.setState({ activeConnId: 'ux-demo-conn', queryResult: null, errorMsg: null, paging: null } as any);
  localStorage.clear(); // WP10-S6: 偏好持久化跨测试隔离
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('WP10: store.browseTable — 估算→PK→COUNT→第1页 (真实 SQL 序列)', () => {
  it('单击表后依次发出 reltuples / PK / COUNT / 第1页 SELECT, 状态正确', async () => {
    await act(async () => {
      await useAppStore.getState().browseTable('shop', 'orders');
    });
    // SQL 序列断言 (真实执行链, 非假数据)
    expect(executedSqls.some((q) => q.includes('reltuples'))).toBe(true);
    expect(executedSqls.some((q) => q.includes('indisprimary'))).toBe(true);
    expect(executedSqls.some((q) => q.includes('count(*) AS total FROM "shop"."orders"'))).toBe(true);
    const pageSql = executedSqls.find((q) => q.startsWith('SELECT * FROM "shop"."orders"'));
    expect(pageSql).toBe('SELECT * FROM "shop"."orders" ORDER BY "id" ASC LIMIT 100 OFFSET 0;');

    const p = useAppStore.getState().paging!;
    expect(p.mode).toBe('table');
    expect(p.total).toBe(6);
    expect(p.totalIsEstimate).toBe(false); // 精确 COUNT 已替换估算
    expect(p.orderByColumns).toEqual(['id']);
    expect(useAppStore.getState().queryResult!.rows.length).toBe(6);
    expect(p.currentPageSql).toBe(pageSql);
  });

  it('翻页 → 自动执行第二个 SQL (OFFSET 变化, 用户不手写)', async () => {
    await act(async () => { await useAppStore.getState().browseTable('shop', 'orders'); });
    executedSqls.length = 0;
    await act(async () => { await useAppStore.getState().pagingSetPageSize(2); }); // 回第1页 size=2
    await act(async () => { await useAppStore.getState().pagingGotoPage(3); });

    const last = executedSqls[executedSqls.length - 1];
    expect(last).toBe('SELECT * FROM "shop"."orders" ORDER BY "id" ASC LIMIT 2 OFFSET 4;');
    const p = useAppStore.getState().paging!;
    expect(p.page).toBe(3);
    // 第 3 页真实数据 = 第 5,6 行 (cancelled + NULL 行)
    const rows = useAppStore.getState().queryResult!.rows;
    expect(rows.length).toBe(2);
    expect(rows[0][3].val).toBe('cancelled');
  });

  it('COUNT 失败 → 保留估算值 (约 6 行), 翻页仍工作 (分析师会议 #4 + D1 语义)', async () => {
    invokeMock.mockImplementation((_cmd: string, args: any) => {
      const sql = args?.sql || '';
      if (_cmd === 'execute_sql') {
        if (sql.includes('count(*)')) {
          // 真实 PG 权限报错形状
          return Promise.reject({ message: 'ERROR: permission denied for table orders' });
        }
        executedSqls.push(sql);
        return Promise.resolve(routeSql(sql));
      }
      return Promise.resolve(null);
    });
    await act(async () => { await useAppStore.getState().browseTable('shop', 'orders'); });
    const p = useAppStore.getState().paging!;
    // COUNT 失败但 reltuples 估算成功 → 保留估算 (totalIsEstimate 仍 true)
    expect(p.total).toBe(6);
    expect(p.totalIsEstimate).toBe(true);
    // 数据页仍然拉到了 (COUNT 失败不阻塞)
    expect(useAppStore.getState().queryResult!.rows.length).toBe(6);
  });

  it('reltuples 与 COUNT 都失败 → total=null "总数不可用"', async () => {
    invokeMock.mockImplementation((_cmd: string, args: any) => {
      const sql = args?.sql || '';
      if (_cmd === 'execute_sql') {
        if (sql.includes('reltuples') || sql.includes('count(*)')) {
          return Promise.reject({ message: 'ERROR: permission denied' });
        }
        return Promise.resolve(routeSql(sql));
      }
      return Promise.resolve(null);
    });
    await act(async () => { await useAppStore.getState().browseTable('shop', 'orders'); });
    const p = useAppStore.getState().paging!;
    expect(p.total).toBeNull();
    expect(useAppStore.getState().queryResult!.rows.length).toBe(6); // 数据页不受影响
  });
});

describe('WP10: store.pagingSetFilters — 服务端过滤', () => {
  it("status='cancelled' → COUNT 重算=1, 回第1页, 真实 SQL 含 WHERE", async () => {
    await act(async () => { await useAppStore.getState().browseTable('shop', 'orders'); });
    executedSqls.length = 0;
    await act(async () => {
      await useAppStore.getState().pagingSetFilters(
        [{ column: 'status', operator: '=', value: 'cancelled' }], 'AND'
      );
    });
    expect(executedSqls.some((q) => q.includes(`WHERE "status" = 'cancelled'`) && q.includes('count(*)'))).toBe(true);
    const pageSql = executedSqls.find((q) => q.startsWith('SELECT *'));
    expect(pageSql).toBe(`SELECT * FROM "shop"."orders" WHERE "status" = 'cancelled' ORDER BY "id" ASC LIMIT 100 OFFSET 0;`);
    const p = useAppStore.getState().paging!;
    expect(p.total).toBe(1);
    expect(p.page).toBe(1);
    expect(useAppStore.getState().queryResult!.rows.length).toBe(1);
  });

  it('customer_id IS NULL → 命中 ux_demo 真实第 6 行', async () => {
    await act(async () => { await useAppStore.getState().browseTable('shop', 'orders'); });
    await act(async () => {
      await useAppStore.getState().pagingSetFilters(
        [{ column: 'customer_id', operator: 'IS NULL' }], 'AND'
      );
    });
    const rows = useAppStore.getState().queryResult!.rows;
    expect(rows.length).toBe(1);
    expect(rows[0][0].val).toBe(6);
    expect(useAppStore.getState().paging!.total).toBe(1);
  });

  it('过滤条件变更后翻页从第 1 页开始 (QA 矩阵第 5 条)', async () => {
    await act(async () => { await useAppStore.getState().browseTable('shop', 'orders'); });
    await act(async () => { await useAppStore.getState().pagingSetPageSize(2); });
    await act(async () => { await useAppStore.getState().pagingGotoPage(2); });
    expect(useAppStore.getState().paging!.page).toBe(2);
    await act(async () => {
      await useAppStore.getState().pagingSetFilters([{ column: 'status', operator: '=', value: 'new' }], 'AND');
    });
    expect(useAppStore.getState().paging!.page).toBe(1);
  });
});

describe('WP10: store.runQueryPaged — 手写 SQL 分页 (D2)', () => {
  it('手写 SELECT → COUNT 子查询 + LIMIT/OFFSET 自动接管', async () => {
    await act(async () => {
      await useAppStore.getState().runQueryPaged("SELECT * FROM shop.orders WHERE status = 'cancelled'");
    });
    expect(executedSqls.some((q) => q.includes('SELECT count(*) AS total FROM ('))).toBe(true);
    const pageSql = executedSqls.find((q) => q.includes('LIMIT 100 OFFSET 0'));
    expect(pageSql).toContain(`WHERE status = 'cancelled'`);
    const p = useAppStore.getState().paging!;
    expect(p.mode).toBe('sql');
    expect(p.total).toBe(1);
  });

  it('手写 SQL 自带 LIMIT → 剥离接管并标记 (UI 显示"原 LIMIT 已接管")', async () => {
    await act(async () => {
      await useAppStore.getState().runQueryPaged('SELECT * FROM shop.orders LIMIT 100');
    });
    const p = useAppStore.getState().paging!;
    expect(p.strippedOwnLimit).toBe(true);
    expect(p.normalizedSql).toBe('SELECT * FROM shop.orders');
  });

  it('写操作 SQL → 不分页, 回退普通执行 (paging=null)', async () => {
    await act(async () => {
      await useAppStore.getState().runQueryPaged('DELETE FROM shop.orders WHERE id=999');
    });
    // runQueryPaged 内部回退 runQuery → errorMsg 或执行; paging 必须为 null
    expect(useAppStore.getState().paging).toBeNull();
  });
});

describe('WP10: PaginationBar 组件渲染', () => {
  const basePaging: PagingState = {
    mode: 'table', schema: 'shop', table: 'orders',
    orderByColumns: ['id'], orderByDirection: 'ASC', allColumns: [],
    filters: [], combinator: 'AND',
    page: 2, pageSize: 2, total: 6, totalIsEstimate: false, loading: false,
    currentPageSql: 'SELECT * FROM "shop"."orders" ORDER BY "id" ASC LIMIT 2 OFFSET 2;',
  };

  it('精确总数 → "共 6 行"; 页码 2/3; 上/下页可用', async () => {
    render(<PaginationBar paging={basePaging} currentRowCount={2} />);
    expect(screen.getByTestId('paging-total').textContent).toBe('共 6 行');
    expect(screen.getByTestId('paging-pageinfo').textContent).toContain('第 2 / 3 页');
    expect((screen.getByLabelText('上一页') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('下一页') as HTMLButtonElement).disabled).toBe(false);
  });

  it('估算态 → "约 N 行 (估算)"; 总数不可用 → "总数不可用"', () => {
    const { rerender } = render(<PaginationBar paging={{ ...basePaging, totalIsEstimate: true }} currentRowCount={2} />);
    expect(screen.getByTestId('paging-total').textContent).toContain('约');
    rerender(<PaginationBar paging={{ ...basePaging, total: null }} currentRowCount={2} />);
    expect(screen.getByTestId('paging-total').textContent).toBe('总数不可用');
  });

  it('第 1 页 → 首页/上一页禁用; 末页 → 下一页/末页禁用', () => {
    const { rerender } = render(<PaginationBar paging={{ ...basePaging, page: 1 }} currentRowCount={2} />);
    expect((screen.getByLabelText('首页') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('上一页') as HTMLButtonElement).disabled).toBe(true);
    rerender(<PaginationBar paging={{ ...basePaging, page: 3 }} currentRowCount={2} />);
    expect((screen.getByLabelText('下一页') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('末页') as HTMLButtonElement).disabled).toBe(true);
  });

  it('"查看本页 SQL" → 显示当前页真实 SQL (透明不黑盒)', () => {
    render(<PaginationBar paging={basePaging} currentRowCount={2} />);
    fireEvent.click(screen.getByTestId('paging-sql-toggle'));
    expect(screen.getByTestId('paging-current-sql').textContent).toContain('LIMIT 2 OFFSET 2');
  });

  it('strippedOwnLimit → 显示"原 LIMIT 已接管"提示', () => {
    render(<PaginationBar paging={{ ...basePaging, mode: 'sql', normalizedSql: 'SELECT 1', strippedOwnLimit: true }} currentRowCount={2} />);
    expect(screen.getByText('原 LIMIT 已接管')).toBeTruthy();
  });
});

describe('WP10: FilterBuilder 组件 (列自动带出 + 类型感知)', () => {
  const cols = [
    { column_name: 'id', data_type: 'bigint' },
    { column_name: 'status', data_type: 'text', column_comment: '订单状态' },
    { column_name: 'total', data_type: 'numeric' },
    { column_name: 'paid', data_type: 'boolean' },
    { column_name: 'ordered_at', data_type: 'timestamptz' },
    { column_name: 'meta', data_type: 'jsonb' },
  ];

  it('列下拉自动带出全部列 (含类型与注释), 无需手打', async () => {
    render(<FilterBuilder isOpen onClose={vi.fn()} columns={cols} initialFilters={[]} initialCombinator="AND" onApply={vi.fn()} />);
    const select = await screen.findByLabelText('过滤列');
    const opts = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(opts.some((t) => t?.includes('status') && t?.includes('订单状态'))).toBe(true);
    expect(opts.length).toBe(6);
  });

  it('文本列操作符含 LIKE; 切到数值列 → 操作符自动换为数值集 (含 BETWEEN)', async () => {
    render(<FilterBuilder isOpen onClose={vi.fn()} columns={cols} initialFilters={[]} initialCombinator="AND" onApply={vi.fn()} />);
    const colSel = await screen.findByLabelText('过滤列');
    fireEvent.change(colSel, { target: { value: 'status' } });
    let ops = Array.from(screen.getByLabelText('操作符').querySelectorAll('option')).map((o) => o.value);
    expect(ops).toContain('LIKE');
    expect(ops).not.toContain('BETWEEN');

    fireEvent.change(colSel, { target: { value: 'total' } });
    ops = Array.from(screen.getByLabelText('操作符').querySelectorAll('option')).map((o) => o.value);
    expect(ops).toContain('BETWEEN');
    expect(ops).toContain('>=');
  });

  it('布尔列 → 值输入是 true/false 下拉 (不用打字)', async () => {
    render(<FilterBuilder isOpen onClose={vi.fn()} columns={cols} initialFilters={[]} initialCombinator="AND" onApply={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('过滤列'), { target: { value: 'paid' } });
    const boolSel = screen.getByLabelText('布尔值');
    expect(Array.from(boolSel.querySelectorAll('option')).map((o) => o.value)).toEqual(['true', 'false']);
  });

  it('IS NULL → 值输入框自动隐藏', async () => {
    render(<FilterBuilder isOpen onClose={vi.fn()} columns={cols} initialFilters={[]} initialCombinator="AND" onApply={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('过滤列'), { target: { value: 'status' } });
    fireEvent.change(screen.getByLabelText('操作符'), { target: { value: 'IS NULL' } });
    expect(screen.queryByLabelText('过滤值')).toBeNull();
    expect(screen.getByTestId('fb-preview').textContent).toBe('"status" IS NULL');
  });

  it('实时 SQL 预览随点选更新; IN 缺值 → 预览显示真实错误且应用被禁', async () => {
    render(<FilterBuilder isOpen onClose={vi.fn()} columns={cols} initialFilters={[]} initialCombinator="AND" onApply={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('过滤列'), { target: { value: 'status' } });
    fireEvent.change(screen.getByLabelText('过滤值'), { target: { value: 'cancelled' } });
    expect(screen.getByTestId('fb-preview').textContent).toBe(`"status" = 'cancelled'`);

    fireEvent.change(screen.getByLabelText('操作符'), { target: { value: 'IN' } });
    // IN 无标签 → buildWhere 抛"至少一个值" → 预览显示错误, 应用禁用
    expect(screen.getByTestId('fb-preview-error').textContent).toContain('至少一个值');
    expect((screen.getByTestId('fb-apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('应用 → onApply 收到真实 filters; ≠ 提示 NULL 语义', async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<FilterBuilder isOpen onClose={onClose} columns={cols} initialFilters={[]} initialCombinator="AND" onApply={onApply} />);
    fireEvent.change(await screen.findByLabelText('过滤列'), { target: { value: 'status' } });
    fireEvent.change(screen.getByLabelText('操作符'), { target: { value: '!=' } });
    fireEvent.change(screen.getByLabelText('过滤值'), { target: { value: 'cancelled' } });
    expect(screen.getByText(/≠ 不匹配 NULL 行/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('fb-apply'));
    expect(onApply).toHaveBeenCalledWith(
      [{ column: 'status', operator: '!=', value: 'cancelled' }], 'AND'
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('添加多条件 + OR 组合 → 预览正确', async () => {
    render(<FilterBuilder isOpen onClose={vi.fn()} columns={cols} initialFilters={[]} initialCombinator="AND" onApply={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('过滤列'), { target: { value: 'status' } });
    fireEvent.change(screen.getByLabelText('过滤值'), { target: { value: 'new' } });
    fireEvent.click(screen.getByTestId('fb-add-row'));
    const colSels = screen.getAllByLabelText('过滤列');
    fireEvent.change(colSels[1], { target: { value: 'status' } });
    const valInputs = screen.getAllByLabelText('过滤值');
    fireEvent.change(valInputs[1], { target: { value: 'paid' } });
    fireEvent.change(screen.getByTestId('fb-combinator'), { target: { value: 'OR' } });
    expect(screen.getByTestId('fb-preview').textContent).toBe(`"status" = 'new' OR "status" = 'paid'`);
  });

  it('时间列快捷按钮"今天" → BETWEEN 真实日期边界', async () => {
    render(<FilterBuilder isOpen onClose={vi.fn()} columns={cols} initialFilters={[]} initialCombinator="AND" onApply={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('过滤列'), { target: { value: 'ordered_at' } });
    fireEvent.click(screen.getByTitle(/BETWEEN 今天/));
    const preview = screen.getByTestId('fb-preview').textContent || '';
    expect(preview).toContain('"ordered_at" BETWEEN');
    // 真实日期格式 (非假数据占位)
    expect(preview).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('isOpen false→true 重挂载无 React #310 (WP8 教训回归)', async () => {
    const consoleErrors: string[] = [];
    const origError = console.error;
    console.error = (...a: any[]) => { consoleErrors.push(String(a[0])); origError(...a); };
    const { rerender } = render(
      <FilterBuilder isOpen={false} onClose={vi.fn()} columns={cols} initialFilters={[]} initialCombinator="AND" onApply={vi.fn()} />
    );
    rerender(
      <FilterBuilder isOpen onClose={vi.fn()} columns={cols} initialFilters={[]} initialCombinator="AND" onApply={vi.fn()} />
    );
    await waitFor(() => expect(screen.getByTestId('filter-builder')).toBeTruthy());
    expect(consoleErrors.filter((e) => /fewer hooks|more hooks|#310/.test(e))).toEqual([]);
    console.error = origError;
  });
});

describe('WP10-S6: 浏览偏好持久化 (conn+table 记忆)', () => {
  beforeEach(() => { localStorage.clear(); });

  it('pagingSetFilters 后偏好写入 localStorage; 重新 browseTable 恢复过滤器', async () => {
    await act(async () => { await useAppStore.getState().browseTable('shop', 'orders'); });
    await act(async () => {
      await useAppStore.getState().pagingSetFilters(
        [{ column: 'status', operator: '=', value: 'cancelled' }], 'AND'
      );
    });
    const raw = localStorage.getItem('aidb_browse_prefs');
    expect(raw).toBeTruthy();
    const prefs = JSON.parse(raw!);
    const key = 'ux-demo-conn|shop|orders';
    expect(prefs[key].filters).toEqual([{ column: 'status', operator: '=', value: 'cancelled' }]);

    // 退出后重进同表 → 过滤器恢复 (COUNT/页 SQL 带 WHERE)
    useAppStore.setState({ paging: null } as any);
    executedSqls.length = 0;
    await act(async () => { await useAppStore.getState().browseTable('shop', 'orders'); });
    const pageSql = executedSqls.find((q) => q.startsWith('SELECT * FROM "shop"."orders"'));
    expect(pageSql).toContain(`WHERE "status" = 'cancelled'`);
    expect(useAppStore.getState().paging!.filters.length).toBe(1);
  });

  it('pagingSetPageSize 记忆页大小', async () => {
    await act(async () => { await useAppStore.getState().browseTable('shop', 'orders'); });
    await act(async () => { await useAppStore.getState().pagingSetPageSize(200); });
    const prefs = JSON.parse(localStorage.getItem('aidb_browse_prefs')!);
    expect(prefs['ux-demo-conn|shop|orders'].pageSize).toBe(200);
  });
});

// ============ 用户 2026-09-23 反馈回归: 分页条不显示 + 过滤要就地展开 ============
import { DataGrid } from '../src/components/DataGrid';

const gridPaging: PagingState = {
  mode: 'table', schema: 'shop', table: 'orders',
  orderByColumns: ['id'], orderByDirection: 'ASC', allColumns: ['id'],
  filters: [], combinator: 'AND',
  page: 1, pageSize: 2, total: 6, totalIsEstimate: false, loading: false,
  currentPageSql: 'SELECT * FROM "shop"."orders" ORDER BY "id" ASC LIMIT 2 OFFSET 0;',
};

describe('回归: 普通可写连接 (is_read_only=false) 也要显示分页条', () => {
  it('DataGrid paging 存在即渲染 PaginationBar (原 bug: 误判 result.is_read_only)', () => {
    const result = {
      columns: [{ name: 'id', data_type: 'bigint' }, { name: 'status', data_type: 'text' }],
      rows: [[I8(5), T('cancelled')], [I8(6), T('new')]],
      rows_affected: 2, elapsed_ms: 3, is_read_only: false, // 普通可写连接
    };
    useAppStore.setState({ paging: gridPaging, queryResult: result } as any);
    render(<DataGrid result={result} tableName="orders" />);
    expect(screen.getByTestId('paging-total').textContent).toBe('共 6 行');
    expect(screen.getByLabelText('下一页')).toBeTruthy();
  });
});

describe('回归: 点"过滤"按钮 → 就地展开内联面板直接填条件 (非全屏弹窗)', () => {
  it('面板收起时点"过滤"按钮 → onFilterPanelOpenChange(true) (就地展开)', () => {
    const onPanelChange = vi.fn();
    const result = {
      columns: [{ name: 'id', data_type: 'bigint' }],
      rows: [[I8(5)]], rows_affected: 1, elapsed_ms: 1, is_read_only: true,
    };
    useAppStore.setState({ paging: gridPaging, queryResult: result } as any);
    render(
      <DataGrid
        result={result}
        tableName="orders"
        filterColumns={[{ column_name: 'status', data_type: 'text' }]}
        filterPanelOpen={false}
        onFilterPanelOpenChange={onPanelChange}
      />
    );
    // 面板初始收起
    expect(screen.queryByTestId('filter-builder')).toBeNull();
    fireEvent.click(screen.getByTestId('open-filter-builder'));
    expect(onPanelChange).toHaveBeenCalledWith(true);
  });

  it('filterPanelOpen=true → 内联面板渲染且含列下拉 (直接填过滤信息)', () => {
    const result = {
      columns: [{ name: 'id', data_type: 'bigint' }],
      rows: [[I8(5)]], rows_affected: 1, elapsed_ms: 1, is_read_only: true,
    };
    useAppStore.setState({ paging: gridPaging, queryResult: result } as any);
    const onApplyFilters = vi.fn();
    const onPanelChange = vi.fn();
    render(
      <DataGrid
        result={result}
        tableName="orders"
        filterColumns={[{ column_name: 'status', data_type: 'text' }]}
        filterPanelOpen
        onFilterPanelOpenChange={onPanelChange}
        onApplyFilters={onApplyFilters}
      />
    );
    expect(screen.getByTestId('filter-builder')).toBeTruthy();
    // 内联面板里直接选列填值应用
    fireEvent.change(screen.getByLabelText('过滤列'), { target: { value: 'status' } });
    fireEvent.change(screen.getByLabelText('过滤值'), { target: { value: 'cancelled' } });
    fireEvent.click(screen.getByTestId('fb-apply'));
    expect(onApplyFilters).toHaveBeenCalledWith([{ column: 'status', operator: '=', value: 'cancelled' }], 'AND');
    expect(onPanelChange).toHaveBeenCalledWith(false); // 应用后收起
  });
});
