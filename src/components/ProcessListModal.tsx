import React, { useState, useEffect } from 'react';
import { ProcessItem } from '../types';
import { getProcessList, killProcess } from '../services/ipc';
import { Activity, Skull, RefreshCw, X } from 'lucide-react';

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

  const fetchProcesses = async () => {
    setLoading(true);
    try {
      const res = await getProcessList(connId);
      setProcesses(res || []);
    } catch (err) {
      // Quiet fail
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchProcesses();
    }
  }, [isOpen, connId]);

  if (!isOpen) return null;

  const handleKill = async (pid: number) => {
    if (confirm(`Are you sure you want to KILL session PID ${pid}?`)) {
      try {
        await killProcess(connId, pid);
        fetchProcesses();
      } catch (err: any) {
        alert(`Kill PID ${pid} failed: ${err.message || String(err)}`);
      }
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-[#1e2024] border border-slate-700/80 rounded-2xl w-full max-w-4xl h-[550px] text-slate-200 text-xs shadow-2xl flex flex-col overflow-hidden font-sans">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-[#181a1d]">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base font-bold text-white">Database Process & Lock Inspector (进程锁监控)</h2>
          </div>
          <div className="flex items-center gap-3">
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
