import React, { useEffect, useState } from 'react';
import { AlertTriangle, ShieldAlert, X } from 'lucide-react';
import { SafetyBlockedPayload } from '../types';

interface Props {
  payload: SafetyBlockedPayload;
  sql: string;
  connName?: string;
  envTag?: string;
  onApprove: () => void;
  onReject: () => void;
}

/**
 * WP1: 全局 Critical 高危 SQL 二次确认对话框 (规格见 docs/plans/WP1 会议七)
 * - 红色 CRITICAL 徽标 + reasons 列表 + 只读 SQL 展示 + 连接名/env_tag (PROD 角标)
 * - 防误触: 首次点击确认 → 3 秒倒计时激活 → 再点击才生效; 默认焦点在取消
 * - Esc / 遮罩点击 = 取消
 */
export const SafetyConfirmDialog: React.FC<Props> = ({ payload, sql, connName, envTag, onApprove, onReject }) => {
  const [armed, setArmed] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    setArmed(false);
    setCountdown(0);
  }, [payload, sql]);

  useEffect(() => {
    if (!armed) return;
    setCountdown(3);
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [armed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onReject();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onReject]);

  const canConfirm = armed && countdown === 0;
  const isProd = (envTag || '').toUpperCase() === 'PROD';

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onReject}
    >
      <div
        className="w-[560px] max-w-[92vw] rounded-xl border border-red-500/40 bg-[#1a1012] shadow-2xl shadow-red-900/40"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-red-500/20 px-5 py-4">
          <div className="flex items-center gap-3">
            <ShieldAlert className="h-6 w-6 text-red-500" />
            <span className="text-base font-bold text-red-400">高危 SQL 确认</span>
            <span className="rounded bg-red-500/20 px-2 py-0.5 text-xs font-black tracking-widest text-red-400">
              CRITICAL
            </span>
            {isProd && (
              <span className="rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white animate-pulse">
                生产环境
              </span>
            )}
          </div>
          <button onClick={onReject} className="text-zinc-500 hover:text-zinc-300" autoFocus>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* 风险原因列表 */}
          <div className="space-y-1.5">
            {(payload.reasons || [payload.message]).map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-sm text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                <span>{r}</span>
              </div>
            ))}
          </div>

          {/* 目标连接 */}
          {connName && (
            <div className="text-xs text-zinc-400">
              目标连接: <span className="font-mono text-zinc-200">{connName}</span>
              {envTag && (
                <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${isProd ? 'bg-red-500/20 text-red-400' : 'bg-zinc-700 text-zinc-300'}`}>
                  {envTag}
                </span>
              )}
            </div>
          )}

          {/* 只读 SQL 展示 */}
          <div className="max-h-[200px] overflow-auto rounded-lg border border-zinc-700/60 bg-[#0d0a0b] p-3">
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-amber-200/90">{sql}</pre>
          </div>
        </div>

        {/* 按钮区: 默认焦点在取消 (防回车误确认) */}
        <div className="flex items-center justify-end gap-3 border-t border-red-500/20 px-5 py-4">
          <button
            onClick={onReject}
            className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
          >
            取消 (Esc)
          </button>
          <button
            onClick={() => {
              if (canConfirm) {
                onApprove();
              } else {
                setArmed(true);
              }
            }}
            className={`rounded-lg px-4 py-2 text-sm font-bold transition ${
              canConfirm
                ? 'bg-red-600 text-white hover:bg-red-500'
                : 'border border-red-500/50 bg-red-500/10 text-red-400'
            }`}
          >
            {canConfirm
              ? '我已知悉风险，强制执行'
              : armed
                ? `确认中… ${countdown}s 后可执行`
                : '我已知悉风险，强制执行'}
          </button>
        </div>
      </div>
    </div>
  );
};
