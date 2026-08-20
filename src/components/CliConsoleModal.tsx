import React, { useState, useEffect, useRef } from 'react';
import { executeSql } from '../services/ipc';
import { QueryResult } from '../types';
import {
  Terminal,
  Play,
  RotateCcw,
  Copy,
  Check,
  Maximize2,
  Minimize2
} from 'lucide-react';

interface CliConsoleModalProps {
  isOpen: boolean;
  connId: string;
  connName: string;
  activeDatabase?: string;
  user?: string;
  onClose: () => void;
  onApplySqlToEditor?: (sql: string) => void;
}

interface CliHistoryItem {
  id: string;
  command: string;
  output: string;
  isError?: boolean;
  tableData?: QueryResult | null;
  elapsedMs?: number;
  timestamp: string;
}

export const CliConsoleModal: React.FC<CliConsoleModalProps> = ({
  isOpen,
  connId,
  connName,
  activeDatabase = 'postgres',
  user = 'postgres',
  onClose,
  onApplySqlToEditor,
}) => {
  const [history, setHistory] = useState<CliHistoryItem[]>([
    {
      id: 'init_welcome',
      command: '\\welcome',
      output: `╔══════════════════════════════════════════════════════════════════════════════╗
║              DiTing PostgreSQL Native CLI Engine (psql Emulation)            ║
║  100% 离线内置 · 纯原生驱动 · 无需安装本地 psql/zsh/bash · 全平台零依赖      ║
╚══════════════════════════════════════════════════════════════════════════════╝
输入 SQL 语句或 psql 元命令开始执行。输入 \\? 或 help 查看常用运维元命令。`,
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);

  const [inputVal, setInputVal] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyPointer, setHistoryPointer] = useState<number>(-1);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const cliInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => cliInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  if (!isOpen) return null;

  // 格式化表格为 CLI ASCII 经典终端表格输出
  const formatAsciiTable = (res: QueryResult): string => {
    if (!res.columns || res.columns.length === 0) {
      return `(0 rows returned, ${res.elapsed_ms.toFixed(2)} ms)`;
    }

    const colNames = res.columns.map((c) => c.name);
    const rows = res.rows.map((r) => r.map((cell) => (cell.val === null ? 'NULL' : String(cell.val))));

    // 计算每列最大宽度
    const colWidths = colNames.map((name, i) => {
      const maxValWidth = rows.reduce((max, r) => Math.max(max, (r[i] || '').length), 0);
      return Math.max(name.length, maxValWidth, 4);
    });

    const header = colNames.map((name, i) => name.padEnd(colWidths[i])).join(' | ');
    const divider = colWidths.map((w) => '-'.repeat(w)).join('-+-');
    const body = rows
      .slice(0, 200)
      .map((r) => r.map((v, i) => v.padEnd(colWidths[i])).join(' | '))
      .join('\n');

    const footer = `\n(${res.rows.length} rows, execution time: ${res.elapsed_ms.toFixed(2)} ms)`;
    return `${header}\n${divider}\n${body}${footer}`;
  };

  const handleRunCommand = async () => {
    const cmd = inputVal.trim();
    if (!cmd || isExecuting) return;

    // 加入历史记录栈
    setCommandHistory((prev) => [cmd, ...prev]);
    setHistoryPointer(-1);
    setInputVal('');
    setIsExecuting(true);

    const now = new Date().toLocaleTimeString();
    const cleanLower = cmd.toLowerCase();

    // 1. 本地内置辅助命令拦截
    if (cleanLower === 'clear' || cleanLower === 'cls' || cleanLower === '\\c clear') {
      setHistory([]);
      setIsExecuting(false);
      return;
    }

    if (cleanLower === '\\?' || cleanLower === 'help' || cleanLower === '\\h') {
      setHistory((prev) => [
        ...prev,
        {
          id: `cmd_${Date.now()}`,
          command: cmd,
          output: `=== PostgreSQL 常用 psql 元命令与操作指南 ===
  \\dt              列出当前库下的所有数据物理表 (List tables)
  \\d <table_name>   查看指定表的字段定义、类型与约束 (Describe table)
  \\dv              列出所有视图 (List views)
  \\di              列出所有索引 (List indexes)
  \\dn              列出所有模式 Schema (List schemas)
  \\du / \\dg        列出所有角色与用户权限属性 (List roles & privileges)
  \\df              列出所有存储过程与函数 (List functions)
  \\l               列出当前实例下的所有数据库 (List databases)
  \\c <dbname>      切换当前活动数据库 (Connect to database)
  clear / cls       清屏控制台
  SELECT/DML/DDL   支持执行任意标准 SQL 语句 (以分号结束或直接回车)`,
          timestamp: now,
        },
      ]);
      setIsExecuting(false);
      return;
    }

    // 2. 真实数据库命令执行 (通过 Rust psql 元命令转译层与 SQL 引擎)
    try {
      const res = await executeSql(connId, cmd);
      const formattedOutput = formatAsciiTable(res);
      setHistory((prev) => [
        ...prev,
        {
          id: `cmd_${Date.now()}`,
          command: cmd,
          output: formattedOutput,
          tableData: res,
          elapsedMs: res.elapsed_ms,
          timestamp: now,
        },
      ]);
    } catch (err: any) {
      setHistory((prev) => [
        ...prev,
        {
          id: `cmd_${Date.now()}`,
          command: cmd,
          output: `ERROR: ${err.message || String(err)}`,
          isError: true,
          timestamp: now,
        },
      ]);
    } finally {
      setIsExecuting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRunCommand();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const nextPtr = Math.min(historyPointer + 1, commandHistory.length - 1);
        setHistoryPointer(nextPtr);
        setInputVal(commandHistory[nextPtr]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyPointer > 0) {
        const nextPtr = historyPointer - 1;
        setHistoryPointer(nextPtr);
        setInputVal(commandHistory[nextPtr]);
      } else if (historyPointer === 0) {
        setHistoryPointer(-1);
        setInputVal('');
      }
    } else if (e.key === 'Tab') {
      // 常见元命令 Tab 补全
      e.preventDefault();
      const metaCmds = ['\\dt', '\\d ', '\\dv', '\\di', '\\dn', '\\du', '\\df', '\\l', '\\c ', 'SELECT * FROM ', 'clear'];
      const matched = metaCmds.find((m) => m.startsWith(inputVal));
      if (matched) {
        setInputVal(matched);
      }
    }
  };

  const handleCopyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4 select-none font-sans">
      <div
        className={`bg-[#0c0e14] border border-slate-800 rounded-3xl flex flex-col shadow-2xl overflow-hidden transition-all duration-300 ${
          isFullScreen ? 'w-full h-full rounded-none border-0' : 'w-full max-w-5xl h-[85vh]'
        }`}
      >
        {/* Top Header Bar */}
        <div className="px-5 py-3.5 border-b border-slate-800/80 bg-[#11141c] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 shadow-sm">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-sm text-slate-100 font-mono">
                  PostgreSQL Native CLI Interactive Console
                </h3>
                <span className="px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 font-mono text-[11px] border border-slate-700">
                  {connName}
                </span>
                <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 font-mono text-[11px] border border-emerald-500/20">
                  db: {activeDatabase}
                </span>
                <span className="px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-300 font-mono text-[11px] border border-purple-500/20">
                  user: {user}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-sans mt-0.5">
                无需依赖系统是否安装 psql / bash / powershell，100% 离线原生物理会话直通 PostgreSQL 引擎
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setHistory([])}
              className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded-lg transition-colors"
              title="清屏 (clear)"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              onClick={() => setIsFullScreen(!isFullScreen)}
              className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded-lg transition-colors"
              title={isFullScreen ? '还原窗口' : '全屏终端'}
            >
              {isFullScreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors"
              title="关闭终端"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Terminal Screen Body */}
        <div
          onClick={() => cliInputRef.current?.focus()}
          className="flex-1 p-5 overflow-y-auto bg-[#08090d] font-mono text-xs text-slate-300 space-y-4 cursor-text select-text"
        >
          {history.map((item) => (
            <div key={item.id} className="space-y-1.5 group">
              {/* Command Prompt Line */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-400 font-bold">
                  <span className="text-emerald-400 font-bold">{user}@{activeDatabase}=#</span>
                  <span className="text-white select-text">{item.command}</span>
                </div>
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="text-[10px] text-slate-600 font-sans">{item.timestamp}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopyText(item.output, item.id);
                    }}
                    className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200"
                    title="复制输出结果"
                  >
                    {copiedId === item.id ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                  {onApplySqlToEditor && !item.command.startsWith('\\') && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onApplySqlToEditor(item.command);
                        onClose();
                      }}
                      className="text-[10px] px-2 py-0.5 bg-blue-600/30 hover:bg-blue-600 text-blue-300 hover:text-white rounded transition-colors"
                      title="将这条 SQL 填入主编辑器"
                    >
                      填入主编辑器
                    </button>
                  )}
                </div>
              </div>

              {/* Command Result Box */}
              <pre
                className={`p-3 rounded-xl overflow-x-auto leading-relaxed border select-text ${
                  item.isError
                    ? 'bg-red-950/20 border-red-800/40 text-rose-300'
                    : 'bg-slate-950/80 border-slate-800/80 text-emerald-300/90'
                }`}
              >
                <code>{item.output}</code>
              </pre>
            </div>
          ))}

          {isExecuting && (
            <div className="flex items-center gap-2 text-blue-400 italic">
              <span className="animate-spin">⠋</span>
              <span>PostgreSQL 引擎正在执行...</span>
            </div>
          )}

          <div ref={terminalEndRef} />
        </div>

        {/* Bottom Command Prompt Input */}
        <div className="p-3 border-t border-slate-800 bg-[#0d1017] flex items-center gap-2 font-mono text-xs">
          <span className="text-emerald-400 font-bold shrink-0">
            {user}@{activeDatabase}=#
          </span>
          <input
            ref={cliInputRef}
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isExecuting}
            placeholder="输入 SQL (如 SELECT * FROM ...;) 或 psql 元命令 (\\dt, \\d <table>, \\du, help)..."
            className="flex-1 bg-transparent border-0 outline-none text-slate-100 placeholder-slate-600 font-mono text-xs focus:ring-0"
          />
          <button
            onClick={handleRunCommand}
            disabled={!inputVal.trim() || isExecuting}
            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg font-bold text-xs flex items-center gap-1 transition-all shadow"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>执行 (Enter)</span>
          </button>
        </div>
      </div>
    </div>
  );
};
