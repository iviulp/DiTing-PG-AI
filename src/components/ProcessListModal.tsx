import React, { useState, useEffect, useRef } from 'react';
import { ProcessItem } from '../types';
import { getProcessList, killProcess , errToStr } from '../services/ipc';
import { Activity, Skull, RefreshCw, X } from 'lucide-react';
import { showAlert, showConfirm } from '../services/appDialog';

interface ProcessListModalProps {
  isOpen: boolean;
  connId: string;
  onClose: () => void;
}

/**
 * 数据库活动进程与锁监控 Inspector 组件
 * 支持查看 PID、客户端 IP、实时 SQL 与一键 Kill Session 强制打断锁表
 */
export const ProcessListModal: React.FC<ProcessListModalProps> = ({ isOpen, connId, onClose }) => {
  const [processes, setProcesses] = useState<ProcessItem[]>([]);
  const [loading, setLoading] = useState(false);
  // WP9-P2-8: 自动刷新 (0=关 / 2000 / 5000 ms) — SRE 盯锁等待不用手动狂点
  const [autoRefreshMs, setAutoRefreshMs] = useState<number>(0);
  // WP9: 拉取失败显式呈现 (原 Quiet fail 违反"该弹错弹错"原则)
  const [fetchError, setFetchError] = useState<string | null>(null);
  const lastFetchAt = useRef<number>(0);
  const [lastFetchLabel, setLastFetchLabel] = useState<string>('');

  const fetchProcesses = async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await getProcessList(connId);
      setProcesses(res || []);
      lastFetchAt.current = Date.now();
      setLastFetchLabel(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } catch (err) {
      setFetchError(errToStr(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchProcesses();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, connId]);

  // WP9-P2-8: 自动刷新定时器 (仅弹窗打开时运行)
  useEffect(() => {
    if (!isOpen || autoRefreshMs <= 0) return;
    const timer = setInterval(() => { fetchProcesses(); }, autoRefreshMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, autoRefreshMs, connId]);

  if (!isOpen) return null;

  const handleKill = async (pid: number) => {
    const ok = await showConfirm(`确定要终止会话 PID ${pid} 吗？\n\n该操作会中断该连接上正在执行的事务。`, { title: '终止数据库会话', danger: true, confirmText: `KILL ${pid}` });
    if (!ok) return;
    try {
      await killProcess(connId, pid);
      fetchProcesses();
    } catch (err: any) {
      showAlert(`Kill PID ${pid} failed: ${errToStr(err)}`, { title: '终止失败', danger: true });
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-[#1e2024] border border-slate-700/80 rounded-2xl w-full max-w-4xl h-[550px] text-slate-200 text-xs shadow-2xl flex flex-col overflow-hidden font-sans">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-[#181a1d]">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base font-bold text-white">Database Process & Lock Inspector (进程锁监控)</h2>
          </div>
          <div className="flex items-center gap-3">
            {/* WP9-P2-8: 自动刷新开关 */}
            <select
              value={autoRefreshMs}
              onChange={(e) => setAutoRefreshMs(Number(e.target.value))}
              className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-300 text-[11px] focus:outline-none focus:border-emerald-500"
              aria-label="自动刷新间隔"
              data-testid="auto-refresh-select"
              title="自动刷新间隔 (盯锁等待时免手动)"
            >
              <option value={0}>自动刷新: 关</option>
              <option value={2000}>自动刷新: 2s</option>
              <option value={5000}>自动刷新: 5s</option>
            </select>
            {lastFetchLabel && !loading && (
              <span className="text-[10px] text-slate-500 font-mono" data-testid="last-fetch-at">
                {lastFetchAt.current && autoRefreshMs > 0 ? '⟳ ' : ''}{lastFetchLabel}
              </span>
            )}
            <button
              onClick={fetchProcesses}
              disabled={loading}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200 flex items-center gap-1.5 border border-slate-700 font-semibold"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            <button onClick={onClose} className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* WP9: 拉取失败显式呈现 (真实报错, 不静默) */}
        {fetchError && (
          <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/40 text-red-300 text-[11px] font-mono break-all" data-testid="process-fetch-error">
            ⚠️ 进程列表拉取失败: {fetchError}
          </div>
        )}

        {/* Process Table Grid */}
        <div className="flex-1 overflow-auto p-4">
          <table className="w-full text-left border-collapse font-sans">
            <thead>
              <tr className="bg-slate-900 border-b border-slate-800 text-slate-400 sticky top-0">
                <th className="px-3 py-2 font-mono">PID</th>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Database</th>
                <th className="px-3 py-2">Client IP</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Current Query</th>
                <th className="px-3 py-2 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
              {processes.map((proc) => (
                <tr key={proc.pid} className="hover:bg-slate-800/40 transition-colors">
                  <td className="px-3 py-2 font-bold text-blue-400">{proc.pid}</td>
                  <td className="px-3 py-2 text-slate-300">{proc.user}</td>
                  <td className="px-3 py-2 text-slate-300">{proc.db}</td>
                  <td className="px-3 py-2 text-slate-400">{proc.client_ip || '127.0.0.1'}</td>
                  <td className="px-3 py-2 font-bold text-amber-400">{proc.duration_seconds}s</td>
                  <td className="px-3 py-2 max-w-xs truncate text-slate-200" title={proc.query}>
                    {proc.query}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => handleKill(proc.pid)}
                      className="px-2 py-1 bg-red-950/80 hover:bg-red-900 text-red-300 border border-red-800 rounded flex items-center gap-1 font-sans mx-auto text-[10px]"
                    >
                      <Skull className="w-3 h-3" />
                      <span>Kill Session</span>
                    </button>
                  </td>
                </tr>
              ))}
              {processes.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-slate-500 font-sans">
                    No active processes or locked queries found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
