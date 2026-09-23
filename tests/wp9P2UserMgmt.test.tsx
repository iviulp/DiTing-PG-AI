/**
 * WP9-P2-2 / P2-3: UserManagementModal 权限变更历史 + 角色属性筛选
 * 数据来源: 真实 PG17 角色形状 (yuguosheng SUPERUSER / app_writer LOGIN / readonly_user LOGIN,
 *           同 itsmorderopsdb 实测 pg_roles 输出) — 禁止假数据兜底
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

import { UserManagementModal } from '../src/components/UserManagementModal';

const T = (val: any) => ({ type: 'Text' as const, val });
const B = (val: boolean) => ({ type: 'Bool' as const, val });
const NULL = { type: 'Null' as const, val: null };

// 真实 pg_roles 形状 (reloadUsers SQL 输出)
const realUsersRows = [
  [T('yuguosheng'), B(true), B(false), B(true), B(true), B(true), T('infinity')],
  [T('app_writer'), B(false), B(false), B(false), B(true), B(false), NULL],
  [T('readonly_user'), B(false), B(false), B(false), B(true), B(false), NULL],
];

function qr(rows: any[][]) {
  return { columns: [], rows, rows_affected: 0, elapsed_ms: 1, is_read_only: true };
}

/** execute_sql 路由: 探查 SQL 返回真实形状; 写操作 (CREATE ROLE) 记录并成功 */
const executedWrites: string[] = [];
function routeSql(sql: string): any {
  if (sql.includes('FROM pg_roles r')) return qr(realUsersRows);
  if (sql.includes('has_schema_privilege')) return qr([[T('public'), B(false), B(true), B(false), B(false)]]);
  if (sql.includes('has_table_privilege')) return qr([]);
  if (sql.includes('pg_default_acl')) return qr([]);
  return qr([]);
}

beforeEach(() => {
  invokeMock.mockReset();
  executedWrites.length = 0;
  invokeMock.mockImplementation((_cmd: string, args: any) => {
    if (_cmd === 'execute_sql') {
      if (args?.sql?.startsWith('CREATE ROLE')) executedWrites.push(args.sql);
      return Promise.resolve(routeSql(args?.sql || ''));
    }
    return Promise.resolve(null);
  });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    writable: true, configurable: true,
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('WP9-P2-3: 角色属性 chips 筛选', () => {
  it('点 SUPERUSER chip → 只剩 yuguosheng', async () => {
    render(<UserManagementModal isOpen connId="conn-1" connName="t" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('readonly_user')).toBeTruthy(), { timeout: 3000 });

    fireEvent.click(screen.getByTestId('attr-chip-superuser'));

    await waitFor(() => expect(screen.queryByText('readonly_user')).toBeNull());
    expect(screen.getByText('yuguosheng')).toBeTruthy();
    expect(screen.queryByText('app_writer')).toBeNull();
  });

  it('点 可登录 chip → 3 个真实角色都有 LOGIN, 全部保留; 全部 chip 恢复', async () => {
    render(<UserManagementModal isOpen connId="conn-1" connName="t" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('readonly_user')).toBeTruthy(), { timeout: 3000 });

    fireEvent.click(screen.getByTestId('attr-chip-login'));
    await waitFor(() => expect(screen.getByText('readonly_user')).toBeTruthy());
    expect(screen.getByText('yuguosheng')).toBeTruthy();
    expect(screen.getByText('app_writer')).toBeTruthy();

    // chips 与搜索可叠加: SUPERUSER + 搜索 "yugu"
    fireEvent.click(screen.getByTestId('attr-chip-superuser'));
    fireEvent.change(screen.getByLabelText('搜索用户角色'), { target: { value: 'yugu' } });
    await waitFor(() => expect(screen.queryByText('app_writer')).toBeNull());
    expect(screen.getByText('yuguosheng')).toBeTruthy();

    fireEvent.click(screen.getByTestId('attr-chip-all'));
    fireEvent.change(screen.getByLabelText('搜索用户角色'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByText('readonly_user')).toBeTruthy());
  });
});

describe('WP9-P2-2: 权限变更会话历史 (审计回溯)', () => {
  it('创建角色成功后 → 历史面板出现, 记录真实 CREATE ROLE SQL, 密码脱敏', async () => {
    render(<UserManagementModal isOpen connId="conn-1" connName="t" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('readonly_user')).toBeTruthy(), { timeout: 3000 });

    // 打开新建用户弹窗 (WP9 修复后 header 有稳定入口)
    fireEvent.click(screen.getByTestId('open-add-user'));

    await waitFor(() => expect(screen.getByPlaceholderText('e.g. dev_readonly_user')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('e.g. dev_readonly_user'), {
      target: { value: 'qa_tester' },
    });
    // 填密码 (真实流程; 断言历史里已脱敏)
    const pwdInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(pwdInput, { target: { value: 'S3cretPass!' } });

    fireEvent.click(screen.getByText('创建用户'));

    // 等待 CREATE ROLE 执行 + 历史出现
    await waitFor(() => expect(executedWrites.length).toBeGreaterThan(0), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId('change-history')).toBeTruthy());

    const panel = screen.getByTestId('change-history');
    expect(panel.textContent).toContain('1 条');
    expect(panel.textContent).toContain('1 成功');

    // 展开历史 → 看到真实 SQL, 密码必须脱敏
    fireEvent.click(panel.querySelector('button')!);
    await waitFor(() => expect(screen.getByTestId('change-history-list')).toBeTruthy());
    const list = screen.getByTestId('change-history-list');
    expect(list.textContent).toContain('CREATE ROLE "qa_tester"');
    expect(list.textContent).toContain('[REDACTED]');
    expect(list.textContent).not.toContain('S3cretPass!');

    // 复制导出 → 剪贴板收到含脱敏 SQL 的文本
    fireEvent.click(screen.getByTestId('copy-history'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = (navigator.clipboard.writeText as any).mock.calls.at(-1)[0];
    expect(copied).toContain('CREATE ROLE "qa_tester"');
    expect(copied).not.toContain('S3cretPass!');
  });

  it('创建失败 (后端拒绝) → 历史记 FAIL + 真实错误原因', async () => {
    // 模拟真实 PG 报错: 角色已存在 (ux_demo 实测 42710 形状)
    invokeMock.mockImplementation((_cmd: string, args: any) => {
      if (_cmd === 'execute_sql') {
        if (args?.sql?.startsWith('CREATE ROLE')) {
          return Promise.reject({ message: 'ERROR:  role "qa_tester" already exists' });
        }
        return Promise.resolve(routeSql(args?.sql || ''));
      }
      return Promise.resolve(null);
    });
    render(<UserManagementModal isOpen connId="conn-1" connName="t" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('readonly_user')).toBeTruthy(), { timeout: 3000 });

    fireEvent.click(screen.getByTestId('open-add-user'));
    await waitFor(() => expect(screen.getByPlaceholderText('e.g. dev_readonly_user')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('e.g. dev_readonly_user'), {
      target: { value: 'qa_tester' },
    });
    fireEvent.click(screen.getByText('创建用户'));

    await waitFor(() => expect(screen.getByTestId('change-history')).toBeTruthy(), { timeout: 3000 });
    const panel = screen.getByTestId('change-history');
    expect(panel.textContent).toContain('1 失败');
    fireEvent.click(panel.querySelector('button')!);
    await waitFor(() => expect(screen.getByTestId('change-history-list')).toBeTruthy());
    const list = screen.getByTestId('change-history-list');
    expect(list.textContent).toContain('✗');
    expect(list.textContent).toContain('already exists');
  });
});
