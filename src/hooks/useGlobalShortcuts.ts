/**
 * WP9-P1-1: 全局快捷键 hook (从 App.tsx 内联逻辑抽取, 可独立单测)
 *
 * 职责:
 * - Esc: 按"最上层优先"顺序关闭弹窗 (调用方传入 [isOpen, close] 栈)
 * - Cmd/Ctrl+B: 切换 AI 侧栏
 * - Cmd/Ctrl+R: 执行 SQL (全局兜底; Cmd+Enter 在 Monaco 内由编辑器处理, 此处不抢)
 *
 * 注: cmdRef 模式避免把 execute 函数放进依赖数组导致监听器反复重建。
 */
import { useEffect, useRef } from 'react';

export interface ShortcutModalEntry {
  /** 该弹窗当前是否打开 */
  isOpen: boolean;
  /** 关闭动作 */
  close: () => void;
}

export interface GlobalShortcutsOptions {
  /** 弹窗栈, 数组顺序 = Esc 关闭优先级 (越靠前越先关) */
  modals: ShortcutModalEntry[];
  /** 执行 SQL (取最新引用) */
  onExecute: (selectedSql?: string) => void;
  /** 切换 AI 侧栏 */
  onToggleAiSidebar: () => void;
}

export function useGlobalShortcuts(opts: GlobalShortcutsOptions): void {
  // 每次 render 同步最新引用 (effect 只在挂载时注册一次)
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Esc: 最上层弹窗优先关闭
      if (e.key === 'Escape' && !mod) {
        for (const m of ref.current.modals) {
          if (m.isOpen) {
            m.close();
            e.preventDefault();
            return;
          }
        }
        return;
      }

      // Cmd+B: 切换 AI 侧栏
      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        ref.current.onToggleAiSidebar();
        return;
      }

      // Cmd+Enter / Cmd+R: 执行 SQL
      // Monaco 焦点内 Cmd+Enter 由编辑器自身处理 (避免双执行), 其余场景全局兜底
      if (mod && (e.key === 'Enter' || e.key.toLowerCase() === 'r')) {
        const inMonaco = !!(document.activeElement as Element | null)?.closest?.('.monaco-editor');
        if (e.key === 'Enter' && inMonaco) return;
        e.preventDefault();
        ref.current.onExecute();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // 仅挂载时注册一次; 状态经 ref 读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
