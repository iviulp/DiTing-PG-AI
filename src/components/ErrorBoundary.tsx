import React from 'react';

/**
 * WP8-S2: 全局/弹窗层错误边界
 * React 18 无 Boundary 时任一渲染期异常 → 整树 unmount → 全窗黑屏 (根因 H1)。
 * fallback 呈现: 错误 message + 可展开 stack + 复制按钮 + 恢复/关闭出口。
 */
interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** fallback 形态: 'page' 全屏 | 'modal' 弹窗内错误卡片 */
  variant?: 'page' | 'modal';
  /** modal 形态时的关闭回调 (提供则显示关闭按钮) */
  onClose?: () => void;
  /** 边界名称, 用于日志定位 */
  name?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  showStack: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, showStack: false };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.name || 'root'}]`, error, info.componentStack);
    // dev 诊断钩子 (WP8 计划 S2)
    try {
      (window as any).__lastBoundaryError = { error: String(error?.message || error), componentStack: info.componentStack };
    } catch { /* noop */ }
  }

  private copyDetail = async () => {
    const { error } = this.state;
    const text = `${error?.message || error}\n\n${error?.stack || ''}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard 不可用时退化为选中文本提示
      console.warn('clipboard unavailable; error detail printed to console:\n' + text);
    }
  };

  private reset = () => this.setState({ error: null, showStack: false });

  render() {
    const { error, showStack } = this.state;
    if (!error) return this.props.children;

    const isModal = this.props.variant === 'modal';
    const containerCls = isModal
      ? 'flex-1 m-4 p-5 bg-red-950/40 border border-red-500/40 rounded-2xl overflow-y-auto'
      : 'fixed inset-0 z-[100] bg-[#090b0e] flex items-center justify-center p-8';

    return (
      <div className={containerCls} role="alert" data-testid="error-boundary-fallback">
        <div className={isModal ? '' : 'max-w-2xl w-full bg-[#101216] border border-red-500/40 rounded-2xl p-6'}>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-red-300">
              ⚠️ 界面渲染发生错误{this.props.name ? `（${this.props.name}）` : ''}
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={this.copyDetail}
                className="px-2.5 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700"
              >
                复制错误详情
              </button>
              {!isModal && (
                <button
                  onClick={this.reset}
                  className="px-2.5 py-1 text-[11px] bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-semibold"
                >
                  尝试恢复
                </button>
              )}
              {isModal && this.props.onClose && (
                <button
                  onClick={this.props.onClose}
                  className="px-2.5 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700"
                >
                  关闭
                </button>
              )}
              {isModal && (
                <button
                  onClick={this.reset}
                  className="px-2.5 py-1 text-[11px] bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-semibold"
                >
                  重试
                </button>
              )}
            </div>
          </div>
          <p className="mt-3 text-xs text-red-200/90 font-mono break-all whitespace-pre-wrap">
            {String(error?.message || error)}
          </p>
          <p className="mt-2 text-[11px] text-slate-400">
            应用未崩溃，其余界面仍可正常使用。可复制错误详情反馈给开发者。
          </p>
          <button
            onClick={() => this.setState((s) => ({ showStack: !s.showStack }))}
            className="mt-2 text-[11px] text-slate-500 hover:text-slate-300 underline"
          >
            {showStack ? '收起调用栈' : '展开调用栈'}
          </button>
          {showStack && (
            <pre className="mt-2 p-3 bg-slate-950/80 border border-slate-800 rounded-xl text-[10px] text-slate-400 overflow-x-auto whitespace-pre-wrap">
              {error?.stack || '(no stack)'}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
