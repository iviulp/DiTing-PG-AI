import React from 'react';
import ReactDOM from 'react-dom/client';

/**
 * WP8-S4: 全局应用内对话框服务 (命令式单例)
 * 背景: Tauri v2 WKWebView 中 window.alert/window.confirm 是 no-op (静默吞掉),
 * 本服务在独立 DOM root 渲染应用内对话框, 全仓 alert/confirm 一律走这里。
 * - showAlert: Promise<void> (点确认/关闭/ESC 后 resolve)
 * - showConfirm: Promise<boolean>
 * 视觉与 AppConfirmDialog/SafetyConfirmDialog 一致。
 */

interface DialogSpec {
  kind: 'alert' | 'confirm';
  title: string;
  message: string;
  danger?: boolean;
  confirmText?: string;
  resolve: (v: boolean) => void;
}

let root: ReactDOM.Root | null = null;
let host: HTMLDivElement | null = null;
let current: DialogSpec | null = null;

function ensureRoot(): ReactDOM.Root {
  if (!root) {
    host = document.createElement('div');
    host.id = 'app-dialog-host';
    document.body.appendChild(host);
    root = ReactDOM.createRoot(host);
  }
  return root;
}

function DialogView({ spec, onClose }: { spec: DialogSpec; onClose: (v: boolean) => void }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(false);
      if (e.key === 'Enter' && spec.kind === 'alert') onClose(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [spec, onClose]);

  return React.createElement(
    'div',
    {
      className: 'fixed inset-0 bg-black/70 z-[200] flex items-center justify-center p-6',
      role: 'dialog',
      'aria-modal': 'true',
      'data-testid': 'global-app-dialog',
    },
    React.createElement(
      'div',
      { className: `bg-[#181b22] border rounded-2xl w-full max-w-md p-5 text-xs text-slate-200 shadow-2xl ${spec.danger ? 'border-red-500/40' : 'border-slate-700/90'}` },
      React.createElement(
        'div',
        { className: 'flex items-start justify-between gap-3 border-b border-slate-800 pb-3' },
        React.createElement('span', { className: `font-bold text-sm leading-snug ${spec.danger ? 'text-red-300' : 'text-white'}` }, spec.title),
        React.createElement('button', { onClick: () => onClose(false), className: 'text-slate-400 hover:text-white shrink-0', 'aria-label': '关闭' }, '✕')
      ),
      React.createElement('div', { className: 'py-4 text-slate-300 leading-relaxed whitespace-pre-wrap break-words font-mono max-h-[50vh] overflow-y-auto' }, spec.message),
      React.createElement(
        'div',
        { className: 'flex justify-end gap-2 pt-3 border-t border-slate-800' },
        spec.kind === 'confirm' &&
          React.createElement('button', { onClick: () => onClose(false), className: 'px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300' }, '取消'),
        React.createElement(
          'button',
          {
            onClick: () => onClose(true),
            autoFocus: true,
            className: `px-4 py-1.5 rounded-lg font-bold shadow-md text-white ${spec.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`,
          },
          spec.confirmText || (spec.kind === 'confirm' ? '确认' : '知道了')
        )
      )
    )
  );
}

function open(spec: Omit<DialogSpec, 'resolve'>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // 若已有对话框, 先以 false 关闭 (队列化非必需; 串行场景下不应出现)
    if (current) {
      current.resolve(false);
      current = null;
    }
    const full: DialogSpec = { ...spec, resolve };
    current = full;
    const r = ensureRoot();
    const close = (v: boolean) => {
      current = null;
      r.render(React.createElement(React.Fragment));
      full.resolve(v);
    };
    r.render(React.createElement(DialogView, { spec: full, onClose: close }));
  });
}

/** 替代 window.alert — 返回 Promise (可 await 也可 fire-and-forget) */
export function showAlert(message: string, opts?: { title?: string; danger?: boolean }): Promise<boolean> {
  return open({ kind: 'alert', title: opts?.title || '提示', message, danger: opts?.danger });
}

/** 替代 window.confirm — Promise<boolean>; danger 时红色确认钮 */
export function showConfirm(message: string, opts?: { title?: string; danger?: boolean; confirmText?: string }): Promise<boolean> {
  return open({ kind: 'confirm', title: opts?.title || '请确认', message, danger: opts?.danger, confirmText: opts?.confirmText });
}
