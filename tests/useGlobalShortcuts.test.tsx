/**
 * WP9-P1-1: useGlobalShortcuts 单元测试
 * 覆盖: Esc 最上层弹窗优先关闭 / Cmd+B 切 AI 侧栏 / Cmd+R 执行 SQL /
 *       Monaco 焦点内 Cmd+Enter 不抢 (编辑器自己处理, 避免双执行)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useGlobalShortcuts } from '../src/hooks/useGlobalShortcuts';

function Harness({
  modals,
  onExecute,
  onToggle,
}: {
  modals: Array<{ isOpen: boolean; close: () => void }>;
  onExecute: (s?: string) => void;
  onToggle: () => void;
}) {
  useGlobalShortcuts({ modals, onExecute, onToggleAiSidebar: onToggle });
  return <div data-testid="host" />;
}

const key = (k: string, init: Partial<KeyboardEvent> = {}) =>
  fireEvent.keyDown(window, { key: k, bubbles: true, cancelable: true, ...init });

afterEach(cleanup);

describe('WP9-P1-1: useGlobalShortcuts', () => {
  it('Esc 按最上层优先关闭: 第二层开则先关第二层', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    render(
      <Harness
        modals={[
          { isOpen: true, close: closeA },
          { isOpen: true, close: closeB },
        ]}
        onExecute={vi.fn()}
        onToggle={vi.fn()}
      />
    );
    key('Escape');
    expect(closeA).toHaveBeenCalledTimes(1); // 数组顺序 = 优先级
    expect(closeB).not.toHaveBeenCalled();
  });

  it('Esc 跳过未打开的弹窗, 关闭第一个打开的', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    render(
      <Harness
        modals={[
          { isOpen: false, close: closeA },
          { isOpen: true, close: closeB },
        ]}
        onExecute={vi.fn()}
        onToggle={vi.fn()}
      />
    );
    key('Escape');
    expect(closeA).not.toHaveBeenCalled();
    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it('Cmd+B 切换 AI 侧栏 (metaKey 与 ctrlKey 都触发)', () => {
    const onToggle = vi.fn();
    render(<Harness modals={[]} onExecute={vi.fn()} onToggle={onToggle} />);
    key('b', { metaKey: true });
    key('b', { ctrlKey: true });
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('Cmd+R 全局执行 SQL', () => {
    const onExecute = vi.fn();
    render(<Harness modals={[]} onExecute={onExecute} onToggle={vi.fn()} />);
    key('r', { metaKey: true });
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('Monaco 焦点内 Cmd+Enter 不抢 (避免与编辑器双执行); 焦点在外则执行', () => {
    const onExecute = vi.fn();
    const { container } = render(
      <div>
        <div className="monaco-editor" data-testid="monaco">
          <textarea data-testid="monaco-input" />
        </div>
        <Harness modals={[]} onExecute={onExecute} onToggle={vi.fn()} />
      </div>
    );
    const ta = container.querySelector('.monaco-editor textarea')!;
    (ta as HTMLElement).focus();
    key('Enter', { metaKey: true });
    expect(onExecute).not.toHaveBeenCalled(); // Monaco 内被让行

    (ta as HTMLElement).blur(); // 焦点移出 Monaco → 全局兜底生效
    key('Enter', { metaKey: true });
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('无修饰键的 b/r/Enter 不触发任何动作', () => {
    const onExecute = vi.fn();
    const onToggle = vi.fn();
    render(<Harness modals={[]} onExecute={onExecute} onToggle={onToggle} />);
    key('b');
    key('r');
    key('Enter');
    expect(onExecute).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });
});
