/**
 * WP9-P2-7 / P2-9: DataGrid 粘贴多行 TSV 造数 + 快捷键速查表
 * 数据形状: ux_demo shop.orders 真实列 (id/customer_id/total/status/ordered_at)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
  Channel: class { onmessage: any; },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const I8 = (val: number) => ({ type: 'Int8' as const, val });
const Int4 = (val: number) => ({ type: 'Int4' as const, val });
const Numeric = (val: string) => ({ type: 'Numeric' as const, val });
const T = (val: any) => ({ type: 'Text' as const, val });

// ux_demo shop.orders 真实 2 行 (可写结果集: is_read_only=false)
const ordersColumns = [
  { name: 'id', data_type: 'bigint' },
  { name: 'customer_id', data_type: 'integer' },
  { name: 'total', data_type: 'numeric' },
  { name: 'status', data_type: 'text' },
];
const writableResult = {
  columns: ordersColumns,
  rows: [
    [I8(1), Int4(1), Numeric('299.00'), T('paid')],
    [I8(2), Int4(1), Numeric('150.50'), T('shipped')],
  ],
  rows_affected: 2,
  elapsed_ms: 3,
  is_read_only: false,
};

let clipboardText = '';
beforeEach(() => {
  invokeMock.mockReset();
  clipboardText = '';
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: vi.fn(() => Promise.resolve()),
      readText: vi.fn(() => Promise.resolve(clipboardText)),
    },
    writable: true, configurable: true,
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('WP9-P2-7: DataGrid 粘贴多行 TSV', () => {
  it('可写结果集才显示"粘贴行"按钮', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    render(<DataGrid result={writableResult as any} isExecuting={false} tableName="orders" />);
    expect(await screen.findByTestId('paste-rows-btn')).toBeTruthy();
  });

  it('只读结果集不显示"粘贴行"按钮', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    render(
      <DataGrid result={{ ...writableResult, is_read_only: true } as any} isExecuting={false} tableName="orders" />
    );
    await screen.findByText('paid');
    expect(screen.queryByTestId('paste-rows-btn')).toBeNull();
  });

  it('粘贴 2 行 TSV → 暂存区新增 2 行 (真实对位分列)', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    // 模拟从 Excel 复制: Tab 分隔, 与列顺序对位
    clipboardText = '3\t2\t88.00\tnew\n4\t3\t1200.00\tdone';
    render(<DataGrid result={writableResult as any} isExecuting={false} tableName="orders" />);
    await screen.findByText('paid');

    fireEvent.click(screen.getByTestId('paste-rows-btn'));

    await waitFor(() => {
      expect(screen.getByText('1200.00')).toBeTruthy();
    });
    expect(screen.getByText('88.00')).toBeTruthy();
    // rows total 计数 2 fetched + 2 new
    await waitFor(() => {
      expect(document.body.textContent).toContain('+2 new');
    });
  });

  it('首行与列名完全一致 → 视为表头自动跳过', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    clipboardText = 'id\tcustomer_id\ttotal\tstatus\n5\t4\t10.00\tcancelled';
    render(<DataGrid result={writableResult as any} isExecuting={false} tableName="orders" />);
    await screen.findByText('paid');

    fireEvent.click(screen.getByTestId('paste-rows-btn'));

    await waitFor(() => expect(screen.getByText('cancelled')).toBeTruthy());
    // 表头没被当数据: 只 +1 new
    expect(document.body.textContent).toContain('+1 new');
    expect(document.body.textContent).not.toContain('+2 new');
  });

  it('剪贴板为空 → 弹提示 (appDialog 渲染, 不静默)', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    clipboardText = '';
    render(<DataGrid result={writableResult as any} isExecuting={false} tableName="orders" />);
    await screen.findByText('paid');

    fireEvent.click(screen.getByTestId('paste-rows-btn'));

    await waitFor(() => {
      expect(document.body.textContent).toContain('剪贴板为空');
    });
  });

  it('列数多于结果集 → 截断并明示提示', async () => {
    const { DataGrid } = await import('../src/components/DataGrid');
    clipboardText = '9\t9\t9.99\tnew\tEXTRA_COL';
    render(<DataGrid result={writableResult as any} isExecuting={false} tableName="orders" />);
    await screen.findByText('paid');

    fireEvent.click(screen.getByTestId('paste-rows-btn'));

    await waitFor(() => {
      expect(document.body.textContent).toContain('多余部分已截断');
    });
    // 数据仍入暂存区 (前 4 列)
    expect(screen.getByText('9.99')).toBeTruthy();
    expect(document.body.textContent).not.toContain('EXTRA_COL');
  });
});

describe('WP9-P2-9: ShortcutsHelpModal 速查表', () => {
  it('isOpen → 渲染快捷键与高频功能; Esc 语义由 App 弹窗栈接管 (组件 onClose 被调用)', async () => {
    const { ShortcutsHelpModal } = await import('../src/components/ShortcutsHelpModal');
    const onClose = vi.fn();
    render(<ShortcutsHelpModal isOpen onClose={onClose} />);
    const el = await screen.findByTestId('shortcuts-help');
    expect(el.textContent).toContain('Cmd/Ctrl + Enter');
    expect(el.textContent).toContain('Cmd/Ctrl + B');
    expect(el.textContent).toContain('粘贴行'); // P2-7 已实现, 速查表可如实宣传
    // 点遮罩关闭
    fireEvent.click(el.parentElement!);
    expect(onClose).toHaveBeenCalled();
  });

  it('isOpen=false → 不渲染', async () => {
    const { ShortcutsHelpModal } = await import('../src/components/ShortcutsHelpModal');
    render(<ShortcutsHelpModal isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('shortcuts-help')).toBeNull();
  });
});
