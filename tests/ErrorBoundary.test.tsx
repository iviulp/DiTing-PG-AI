/// WP8 T1/T2: ErrorBoundary 测试
/// T1: 必抛子组件 → fallback 出现, 兄弟子树存活
/// T2: 弹窗层 Boundary: 弹窗崩 → 弹窗错误卡片, 主界面存活
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

const Boom: React.FC = () => {
  throw new Error('渲染期爆炸: cannot read property of undefined');
};

describe('WP8: ErrorBoundary (黑屏根因 H1 防线)', () => {
  beforeEach(() => {
    // React 会把 boundary 捕获的错误也打到 console.error — 静音以免污染输出
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('T1: 子组件渲染抛异常 → fallback 错误卡片出现, 错误 message 可读', () => {
    render(
      <ErrorBoundary name="测试边界">
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeTruthy();
    expect(screen.getByText(/渲染期爆炸/)).toBeTruthy();
    // dev 诊断钩子
    expect((window as any).__lastBoundaryError?.error).toContain('渲染期爆炸');
  });

  it('T2: 弹窗层 Boundary 崩溃不影响兄弟子树 (主界面存活 = 不全窗黑屏)', () => {
    render(
      <div>
        <div data-testid="main-ui">主界面内容</div>
        <ErrorBoundary variant="modal" name="用户权限管理" onClose={() => {}}>
          <Boom />
        </ErrorBoundary>
      </div>
    );
    expect(screen.getByTestId('main-ui').textContent).toBe('主界面内容');
    expect(screen.getByTestId('error-boundary-fallback')).toBeTruthy();
  });

  it('无异常时正常透传 children', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">正常内容</div>
      </ErrorBoundary>
    );
    expect(screen.getByTestId('child')).toBeTruthy();
    expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
  });
});
