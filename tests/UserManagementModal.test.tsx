/// WP8 复现测试: UserManagementModal 黑屏缺陷
/// 数据来源: 本地真实 PG17 (itsmorderopsdb) psql -A -t 实际输出转换的 DbValue 形状
/// 原则: 禁止假数据兜底 — 所有 fixture 均为真实查询结果; 该弹错弹错 — 断言错误显式呈现
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

// ---- mock Tauri ipc 层 (仅拦截传输层, SQL 逻辑走真实组件代码) ----
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
  Channel: class {
    onmessage: any;
  },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { UserManagementModal } from '../src/components/UserManagementModal';

// ---- 真实 PG17 输出 fixture (2026-09-23 psql itsmorderopsdb 实跑) ----
// reloadUsers SQL: SELECT rolname, is_superuser, can_create_db, can_create_role, can_login, is_current_user, valid_until
const T = (val: any) => ({ type: 'Text' as const, val });
const B = (val: boolean) => ({ type: 'Bool' as const, val });
const NULL = { type: 'Null' as const, val: null };

// 后端 WP5 DbValue 序列化: Bool 列 val 是 JS boolean (不再是字符串)
const realUsersRows = [
  [T('yuguosheng'), B(true), B(false), B(true), B(true), B(true), T('infinity')],
  [T('app_writer'), B(false), B(false), B(false), B(true), B(false), NULL],
  [T('readonly_user'), B(false), B(false), B(false), B(true), B(false), NULL],
];

// schemaSql (readonly_user): nspname, rolsuper, has_usage, has_create, is_system
const realSchemaRows = [
  [T('app'), B(false), B(false), B(false), B(false)],
  [T('information_schema'), B(false), B(true), B(false), B(true)],
  [T('pg_catalog'), B(false), B(true), B(false), B(true)],
  [T('pg_toast'), B(false), B(false), B(false), B(true)],
  [T('public'), B(false), B(true), B(false), B(false)],
];

// granularTableSql (readonly_user): schema, table, can_select..can_trigger (7 bool 列)
const realTableRows = [
  [T('public'), T('config'), B(true), B(false), B(false), B(false), B(false), B(false), B(false)],
  [T('public'), T('audit_log'), B(true), B(false), B(false), B(false), B(false), B(false), B(false)],
  [T('app'), T('users'), B(false), B(false), B(false), B(false), B(false), B(false), B(false)],
  [T('app'), T('orders'), B(false), B(false), B(false), B(false), B(false), B(false), B(false)],
];

// defaultAclSql: nspname, defaclacl::text — 真实 aclitem 文本
const realDefaultAclRows = [
  [T('app'), T('{readonly_user=r/yuguosheng}')],
];

function qr(rows: any[][]) {
  return {
    columns: [],
    rows,
    rows_affected: 0,
    elapsed_ms: 1,
    is_read_only: true,
  };
}

/** 按 SQL 特征路由到真实结果集 (与后端 execute_sql 行为一致: 成功 resolve QueryResult) */
function routeSql(sql: string): any {
  if (sql.includes('FROM pg_roles r') && sql.includes('ORDER BY is_current_user')) return qr(realUsersRows);
  if (sql.includes('has_schema_privilege')) return qr(realSchemaRows);
  if (sql.includes('has_table_privilege')) return qr(realTableRows);
  if (sql.includes('pg_default_acl')) return qr(realDefaultAclRows);
  return qr([]);
}

describe('WP8: UserManagementModal 黑屏缺陷复现与修复验证', () => {
  let consoleErrors: string[];
  let alertCalls: string[];

  beforeEach(() => {
    consoleErrors = [];
    alertCalls = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => consoleErrors.push(String(a[0])));
    // Tauri WKWebView 里 alert/confirm 是 no-op — 测试里记录但不弹窗, 模拟真实行为
    vi.stubGlobal('alert', vi.fn((m: string) => alertCalls.push(m)));
    vi.stubGlobal('confirm', vi.fn(() => true));
    invokeMock.mockImplementation((_cmd: string, args: any) => {
      if (_cmd === 'execute_sql') return Promise.resolve(routeSql(args.sql));
      return Promise.reject(new Error('unexpected invoke: ' + _cmd));
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('T1: 打开弹窗不导致 React 树崩溃 (黑屏=整树卸载)', async () => {
    const { container } = render(
      <UserManagementModal isOpen connId="conn-1" connName="12.0.216.216_admin" onClose={() => {}} />
    );
    await waitFor(() => expect(screen.getByText(/readonly_user/)).toBeTruthy(), { timeout: 3000 });
    // React 树仍然挂载 = 未黑屏
    expect(container.innerHTML.length).toBeGreaterThan(1000);
  });

  it('T2: 真实用户列表渲染 (3 角色, 来自真实 pg_roles)', async () => {
    render(<UserManagementModal isOpen connId="conn-1" connName="test" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('readonly_user')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText('yuguosheng')).toBeTruthy();
    expect(screen.getByText('app_writer')).toBeTruthy();
  });

  it('T3: Bool 类型 DbValue (WP5 形状) 正确解析 — superuser 判定不靠字符串 "t"', async () => {
    render(<UserManagementModal isOpen connId="conn-1" connName="test" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('yuguosheng')).toBeTruthy(), { timeout: 3000 });
    // yuguosheng 是 superuser → 列表里应显示 SUPERUSER 标记
    const superLabels = screen.getAllByText('SUPERUSER');
    expect(superLabels.length).toBeGreaterThanOrEqual(1);
  });

  it('T4: 默认选中当前用户并探查权限 (schema 矩阵非空)', async () => {
    render(<UserManagementModal isOpen connId="conn-1" connName="test" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('readonly_user')).toBeTruthy(), { timeout: 3000 });
    // schema_privs 是默认 tab; 真实数据含 app/public 两个非系统 schema
    await waitFor(() => expect(screen.getAllByText('app').length).toBeGreaterThan(0), { timeout: 3000 });
  });

  it('T5: 渲染期无未捕获异常 (console.error 不应出现 React 崩溃日志)', async () => {
    render(<UserManagementModal isOpen connId="conn-1" connName="test" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('readonly_user')).toBeTruthy(), { timeout: 3000 });
    const crashes = consoleErrors.filter((e) => /unmount|render|boundary|Cannot read|undefined is not/i.test(e));
    expect(crashes).toEqual([]);
  });

  it('T6: 后端连接失败时错误显式可见 (该弹错弹错, 不黑屏不静默)', async () => {
    invokeMock.mockImplementation((_cmd: string) =>
      Promise.reject({ code: 'CONNECTION_NOT_FOUND', message: 'connection not found: conn-bad' })
    );
    const { container } = render(
      <UserManagementModal isOpen connId="conn-bad" connName="bad" onClose={() => {}} />
    );
    await waitFor(() => {
      // 修复后契约: 错误必须以 DOM 可见形式呈现 (inline banner), 而不是仅靠 alert
      const visible = container.textContent || '';
      expect(visible).toMatch(/connection not found|加载.*失败/i);
    }, { timeout: 3000 });
    expect(container.innerHTML.length).toBeGreaterThan(500); // 树未卸载
  });

  it('T8: 恶意角色名 (含控制字符) → 拒绝探查 + 显式错误, 不静默兜底不发 SQL', async () => {
    invokeMock.mockClear();
    // 用户列表里含一个非法角色名 (含 \x00 控制字符 — PG 中不可能, 但防御性验证转义层)
    invokeMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'execute_sql' && args.sql.includes('ORDER BY is_current_user')) {
        return Promise.resolve(qr([[T('evil\u0000role'), B(false), B(false), B(false), B(true), B(true), NULL]]));
      }
      return Promise.resolve(routeSql(args?.sql || ''));
    });
    const { container } = render(
      <UserManagementModal isOpen connId="conn-1" connName="t" onClose={() => {}} />
    );
    await waitFor(() => {
      expect(container.textContent).toMatch(/含非法字符|已拒绝/);
    }, { timeout: 3000 });
    // 探查 SQL 不应带着非法角色名发出去
    const probeCalls = invokeMock.mock.calls.filter((c: any[]) =>
      c[0] === 'execute_sql' && c[1].sql.includes('has_schema_privilege')
    );
    expect(probeCalls.length).toBe(0);
  });

  it('T9: isOpen false→true 重渲染不触发 React #310 (hooks 顺序回归 — 原始黑屏真因)', async () => {
    // 复现真实用户流: 组件随 App 常驻挂载 (isOpen=false), 用户右键打开时切 true。
    // 修复前 `if (!isOpen) return null` 在部分 useState/useMemo 之前 → hooks 数量不一致 → React #310。
    const { rerender, container } = render(
      <UserManagementModal isOpen={false} connId="conn-1" connName="t" onClose={() => {}} />
    );
    // 关闭态: 不渲染弹窗内容
    expect(container.querySelector('[data-testid="inline-banner"]')).toBeNull();
    expect(container.textContent || '').not.toContain('User & Privilege Manager');

    // 打开态: 必须正常渲染, 不得抛 #310 (若抛, ErrorBoundary 之外会直接冒泡使本用例失败)
    rerender(<UserManagementModal isOpen connId="conn-1" connName="t" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('readonly_user')).toBeTruthy(), { timeout: 3000 });
    expect(container.textContent).toContain('User & Privilege Manager');
    // 反向: true→false 再关闭也不崩
    rerender(<UserManagementModal isOpen={false} connId="conn-1" connName="t" onClose={() => {}} />);
    expect(container.textContent || '').not.toContain('User & Privilege Manager');
  });

  it('T10: React 渲染期无 hooks 顺序错误 (console.error 不含 #310/fewer hooks)', async () => {
    const { rerender } = render(
      <UserManagementModal isOpen={false} connId="conn-1" connName="t" onClose={() => {}} />
    );
    rerender(<UserManagementModal isOpen connId="conn-1" connName="t" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('readonly_user')).toBeTruthy(), { timeout: 3000 });
    const hooksErr = consoleErrors.filter((e) => /#310|fewer hooks|more hooks|rendered (fewer|more)|hooks can only/i.test(e));
    expect(hooksErr).toEqual([]);
  });

  it('T7: AppErrorDto 对象错误能提取可读消息 (不显示 [object Object])', async () => {
    invokeMock.mockImplementation((_cmd: string) =>
      Promise.reject({ code: 'DB_ERROR', message: 'permission denied for schema app' })
    );
    const { container } = render(
      <UserManagementModal isOpen connId="conn-1" connName="t" onClose={() => {}} />
    );
    await waitFor(() => {
      expect(container.textContent).toMatch(/permission denied/);
    }, { timeout: 3000 });
    expect(container.textContent).not.toContain('[object Object]');
  });
});
