import React, { useCallback, useRef, useState } from 'react';

/**
 * WP8-S4: 应用内确认对话框 (Promise 化)
 * 背景: Tauri v2 WKWebView 中 window.alert/window.confirm 为 no-op,
 * 错误与危险操作确认被静默吞掉 (WP8 黑屏共因)。所有 alert/confirm 一律走本组件。
 * 视觉复用 SafetyConfirmDialog 风格; 危险操作需输入确认词或按住按钮由调用方决定。
 */
export interface ConfirmOptions {
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** danger: 红色确认按钮 (DROP/REVOKE 类) */
  danger?: boolean;
}

export function useAppConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  dialogElement: React.ReactNode;
} {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...opts, resolve });
    });
  }, []);

  const close = (v: boolean) => {
    const cur = stateRef.current;
    setState(null);
    cur?.resolve(v);
  };

  const dialogElement = state ? (
    <div
      className="absolute inset-0 bg-black/75 z-[60] flex items-center justify-center p-4"
      data-testid="app-confirm-dialog"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-[#181b22] border border-slate-700/90 rounded-2xl w-full max-w-md p-5 text-xs text-slate-200 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <span className={`font-bold text-sm ${state.danger ? 'text-red-300' : 'text-white'}`}>
            {state.danger ? '⚠️ ' : ''}{state.title}
          </span>
          <button onClick={() => close(false)} className="text-slate-400 hover:text-white" aria-label="关闭">✕</button>
        </div>
        <div className="py-4 text-slate-300 leading-relaxed whitespace-pre-wrap break-words">{state.message}</div>
        <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
          <button
            onClick={() => close(false)}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300"
          >
            {state.cancelText || '取消'}
          </button>
          <button
            onClick={() => close(true)}
            autoFocus
            className={`px-4 py-1.5 rounded-lg font-bold shadow-md text-white ${
              state.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'
            }`}
          >
            {state.confirmText || '确认'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, dialogElement };
}

/** 弹窗内联通知横幅 (error/success), 替代 alert */
export interface BannerState {
  kind: 'error' | 'success' | 'warn';
  text: string;
}

export const InlineBanner: React.FC<{ banner: BannerState | null; onDismiss: () => void }> = ({ banner, onDismiss }) => {
  if (!banner) return null;
  const styles = {
    error: 'bg-red-950/60 border-red-500/50 text-red-200',
    success: 'bg-emerald-950/60 border-emerald-500/50 text-emerald-200',
    warn: 'bg-amber-950/60 border-amber-500/50 text-amber-200',
  }[banner.kind];
  const icon = { error: '⛔', success: '✅', warn: '⚠️' }[banner.kind];
  return (
    <div className={`mx-4 mt-3 px-4 py-2.5 rounded-xl border text-xs flex items-start justify-between gap-3 ${styles}`} role="status" data-testid="inline-banner">
      <span className="whitespace-pre-wrap break-all font-mono leading-relaxed">
        {icon} {banner.text}
      </span>
      <button onClick={onDismiss} className="shrink-0 opacity-70 hover:opacity-100" aria-label="关闭提示">✕</button>
    </div>
  );
};
