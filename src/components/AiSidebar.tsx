import React, { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { getTableSchema, getTableColumnsMetaData, executeSql } from '../services/ipc';
import { QueryResult } from '../types';
import {
  Bot,
  Send,
  Sparkles,
  Table as TableIcon,
  RefreshCw,
  Copy,
  Check,
  Play,
  ShieldAlert,
  Wrench,
  Database,
  Hash,
  Terminal
} from 'lucide-react';

interface AiSidebarProps {
  onInsertSql: (sql: string) => void;
  currentSql?: string;
  currentError?: string | null;
  activeDatabase?: string;
}

type QueryIntent = 'DBA_ADMIN' | 'ERROR_FIX' | 'TABLE_QUERY' | 'GENERAL';

interface ColumnMeta {
  column_name: string;
  data_type: string;
  comment?: string;
}

export const AiSidebar: React.FC<AiSidebarProps> = ({
  onInsertSql,
  currentSql,
  currentError,
  activeDatabase,
}) => {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [tables, setTables] = useState<Array<{ name: string; type: string; schema_name?: string }>>([]);
  const [selectedTable, setSelectedTable] = useState<string>('AUTO');
  const [loadingTables, setLoadingTables] = useState<boolean>(false);
  const [copiedBlockId, setCopiedBlockId] = useState<string | null>(null);
  
  const [activeTableColumns, setActiveTableColumns] = useState<ColumnMeta[]>([]);

  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const [chatLog, setChatLog] = useState<
    Array<{
      role: 'user' | 'assistant';
      text: string;
      autoQueryResult?: QueryResult | null;
      summaryAnalysis?: string | null;
      executedSql?: string;
      isMutating?: boolean;
      intentTag?: string;
    }>
  >([
    {
      role: 'assistant',
      text: '👋 你好！我是 **DiTing AI PostgreSQL 专家协同助手**。\n\n💡 **核心能力**：\n• **智能意图路由**：权限管理/DBA运维/语法直接秒级答复；数据查询精准匹配字段元数据。\n• **@ 快捷补全**：输入 `@` 可快速引用当前库中的数据表与字段。\n• **错误一键修复**：遇到 SQL 报错可点击下方快捷按钮一键诊断。'
    }
  ]);

  const { activeConnId, askAi } = useAppStore();

  const fetchTables = async () => {
    if (!activeConnId) return;
    setLoadingTables(true);
    try {
      const items = await getTableSchema(activeConnId);
      const fetchedTables = items.map((i: any) => ({
        name: i.item_name || i.name,
        type: i.item_type || 'table',
        schema_name: i.schema_name || 'public'
      }));
      setTables(fetchedTables);
    } catch (err) {
      console.error('Failed to fetch table schema for AI context:', err);
    } finally {
      setLoadingTables(false);
    }
  };

  useEffect(() => {
    fetchTables();
  }, [activeConnId, activeDatabase]);

  useEffect(() => {
    if (selectedTable !== 'AUTO' && selectedTable !== 'NONE' && activeConnId) {
      getTableColumnsMetaData(activeConnId, selectedTable)
        .then((cols) => {
          setActiveTableColumns(
            cols.map((c) => ({
              column_name: c.column_name,
              data_type: c.data_type,
              comment: c.column_comment || c.comment || ''
            }))
          );
        })
        .catch(() => setActiveTableColumns([]));
    } else {
      setActiveTableColumns([]);
    }
  }, [selectedTable, activeConnId]);

  const classifyIntent = (userQuery: string): QueryIntent => {
    const q = userQuery.toLowerCase();
    
    if (q.includes('error') || q.includes('报错') || q.includes('失败') || q.includes('fix') || q.includes('错误')) {
      return 'ERROR_FIX';
    }

    const dbaKeywords = [
      'grant', 'revoke', 'privilege', '权限', '授权', '回收',
      'create role', 'alter role', 'drop role', '用户', '密码',
      'vacuum', 'reindex', 'wal', 'checkpoint', 'explain analyze',
      'pg_stat_', 'pg_catalog', 'information_schema', '参数', '配置',
      'postgresql.conf', 'pg_hba', 'deadlock', '锁', '连接数', 'max_connections'
    ];
    if (dbaKeywords.some((kw) => q.includes(kw))) {
      return 'DBA_ADMIN';
    }

    if (selectedTable !== 'AUTO' && selectedTable !== 'NONE') {
      return 'TABLE_QUERY';
    }

    return 'GENERAL';
  };

  const handleSend = async (customPrompt?: string) => {
    const userMsg = (customPrompt || prompt).trim();
    if (!userMsg || loading) return;

    setPrompt('');
    setShowMentionMenu(false);

    const intent = classifyIntent(userMsg);
    let intentLabel = '';
    if (intent === 'DBA_ADMIN') intentLabel = '⚡ [PostgreSQL DBA 运维模式]';
    else if (intent === 'ERROR_FIX') intentLabel = '🛠️ [SQL 错误自愈诊断]';
    else if (selectedTable !== 'AUTO' && selectedTable !== 'NONE') intentLabel = `📊 [聚焦表: ${selectedTable}]`;

    setChatLog((prev) => [
      ...prev,
      { role: 'user', text: intentLabel ? `${intentLabel} ${userMsg}` : userMsg, intentTag: intent }
    ]);
    setLoading(true);

    try {
      let schemaContext = '';

      if (intent === 'DBA_ADMIN') {
        schemaContext = `Mode: PostgreSQL DBA Administration & Syntax Advisor.
Active Database: "${activeDatabase || 'postgres'}".
Focus: Provide 100% syntactically correct PostgreSQL 12-17 DDL/DCL/Administrative SQL commands. Do not assume or hallucinate custom business tables unless requested.`;
      }
      else if (intent === 'ERROR_FIX') {
        schemaContext = `Mode: SQL Error Auto-Fixer.
Active Database: "${activeDatabase || 'postgres'}".
${currentSql ? `Current Failing SQL:\n\`\`\`sql\n${currentSql}\n\`\`\`\n` : ''}
${currentError ? `Database Engine Error Message:\n"${currentError}"\n` : ''}
Available Tables in Current DB: ${tables.map((t) => t.name).slice(0, 30).join(', ')}.
Instruction: Pinpoint the exact cause of error and provide the corrected PostgreSQL SQL statement.`;
      }
      else if (selectedTable !== 'AUTO' && selectedTable !== 'NONE' && activeTableColumns.length > 0) {
        const colDetails = activeTableColumns
          .map((c) => `  • "${c.column_name}" (Type: ${c.data_type})${c.comment ? ` [注释: ${c.comment}]` : ''}`)
          .join('\n');
        schemaContext = `Target Table: "${selectedTable}" in database "${activeDatabase || 'postgres'}".
Columns & Physical Data Types:
${colDetails}

PostgreSQL Type Rules:
- If column type is "boolean" or "bool", write literal TRUE / FALSE (NOT string 'true'/'false').
- If column type is varchar/text/char, write string literal 'true'/'false'.
- Use PostgreSQL standard syntax with double quotes on identifiers and LIMIT 100 on SELECT queries.`;
      }
      else {
        // 智能探查：自动匹配提问或当前 SQL 中涉及的表名
        let targetTables = tables.filter((t) => 
          userMsg.toLowerCase().includes(t.name.toLowerCase()) || 
          (currentSql && currentSql.toLowerCase().includes(t.name.toLowerCase()))
        );

        if (targetTables.length === 0 && tables.length > 0) {
          // 若未显式提及，提取当前聚焦的前 3 张业务表
          targetTables = tables.slice(0, 3);
        }

        // 动态并发探查这些表的真实物理字段名与数据类型
        let tableSchemasWithTypes = '';
        if (activeConnId && targetTables.length > 0) {
          try {
            const tableInfos = await Promise.all(
              targetTables.slice(0, 5).map(async (tbl) => {
                const cols = await getTableColumnsMetaData(activeConnId, tbl.name);
                const colStr = cols.map((c) => `"${c.column_name}" (${c.data_type})`).join(', ');
                return `Table "${tbl.name}": [${colStr}]`;
              })
            );
            tableSchemasWithTypes = tableInfos.join('\n');
          } catch (e) {
            console.warn('Failed to pre-fetch table columns for AI:', e);
          }
        }

        schemaContext = `Database: "${activeDatabase || 'postgres'}".
Actual Table Schemas & Column Physical Types in Database:
${tableSchemasWithTypes || tables.map((t) => `Table "${t.name}"`).slice(0, 20).join(', ')}

PostgreSQL Data Type & Case Sensitivity Rules:
1. Identifier Casing (表名/字段名):
   - Always wrap table and column names in double quotes exactly as declared above (e.g., "tableName", "CamelColumn") to avoid PostgreSQL folding them to lowercase.
2. Value Casing (查询条件/字段值):
   - If filtering text where the exact casing might vary (e.g. user types lowercase 'approved' but db might store 'APPROVED' or 'Approved'):
     • Use case-insensitive operators: \`ILIKE 'approved'\` or \`LOWER("status") = 'approved'\` or \`UPPER("status") = 'APPROVED'\`.
3. Strict Type Matching:
   - For "boolean/bool" columns, use TRUE / FALSE directly (DO NOT use string 'true'/'false', DO NOT ask the user).
   - For timestamp/date/varchar/integer/jsonb, apply standard PostgreSQL operators.`;
      }

      const reply = await askAi(userMsg, schemaContext);
      const sqlMatch = reply.match(/```(?:sql)?([\s\S]*?)```/i);
      const extractedSql = sqlMatch && sqlMatch[1] ? sqlMatch[1].trim() : null;

      let isMutating = false;
      let autoQueryResult: QueryResult | null = null;

      if (extractedSql) {
        const cleanSql = extractedSql.trim().toLowerCase();
        if (
          cleanSql.startsWith('update') ||
          cleanSql.startsWith('delete') ||
          cleanSql.startsWith('insert') ||
          cleanSql.startsWith('drop') ||
          cleanSql.startsWith('alter') ||
          cleanSql.startsWith('create') ||
          cleanSql.startsWith('truncate') ||
          cleanSql.startsWith('grant') ||
          cleanSql.startsWith('revoke')
        ) {
          isMutating = true;
        } else if (cleanSql.startsWith('select') || cleanSql.startsWith('with') || cleanSql.startsWith('explain')) {
          if (activeConnId) {
            try {
              autoQueryResult = await executeSql(activeConnId, extractedSql);
            } catch (execErr) {
              console.warn('Auto execution of AI SELECT failed:', execErr);
            }
          }
        }
      }

      setChatLog((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: reply,
          executedSql: extractedSql || undefined,
          autoQueryResult,
          isMutating
        }
      ]);
    } catch (err: any) {
      setChatLog((prev) => [
        ...prev,
        { role: 'assistant', text: `⚠️ 请求 AI 失败: ${err.message || String(err)}` }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setPrompt(val);

    const atIndex = val.lastIndexOf('@');
    if (atIndex !== -1 && atIndex === val.length - 1) {
      setShowMentionMenu(true);
      setMentionFilter('');
      setMentionSelectedIndex(0);
    } else if (atIndex !== -1 && showMentionMenu) {
      setMentionFilter(val.slice(atIndex + 1).toLowerCase());
      setMentionSelectedIndex(0);
    } else {
      setShowMentionMenu(false);
    }
  };

  const insertMention = (name: string) => {
    const atIndex = prompt.lastIndexOf('@');
    if (atIndex !== -1) {
      const nextPrompt = prompt.slice(0, atIndex) + `"${name}" ` + prompt.slice(atIndex + 1 + mentionFilter.length);
      setPrompt(nextPrompt);
    } else {
      setPrompt((prev) => `${prev} "${name}" `);
    }
    setShowMentionMenu(false);
    setMentionSelectedIndex(0);
    inputRef.current?.focus();
  };

  const filteredMentions = tables
    .filter((t) => t.name.toLowerCase().includes(mentionFilter))
    .slice(0, 8);

  return (
    <div className="h-full w-full flex flex-col bg-slate-900 border-l border-slate-800 text-slate-200 text-xs">
      <div className="p-3 border-b border-slate-800 flex items-center justify-between bg-slate-800/40">
        <div className="flex items-center gap-2 font-semibold overflow-hidden">
          <Bot className="w-4 h-4 text-blue-400 shrink-0" />
          <span className="truncate">AI 智能协同助手</span>
          {activeDatabase && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono truncate">
              {activeDatabase}
            </span>
          )}
        </div>
        <Sparkles className="w-3.5 h-3.5 text-amber-400 animate-pulse shrink-0" />
      </div>

      <div className="px-3 py-2 border-b border-slate-800 bg-slate-950/70 space-y-2">
        <div className="flex items-center gap-2">
          <TableIcon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          <span className="text-[11px] text-slate-400 shrink-0 font-medium">聚焦范围:</span>
          <div className="flex-1 flex items-center gap-1 min-w-0">
            <select
              value={selectedTable}
              onChange={(e) => setSelectedTable(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500 truncate font-mono"
            >
              <option value="AUTO">🤖 自动意图与表路由 (Auto-Detect)</option>
              <option value="NONE">⚡ 纯 PostgreSQL DBA / 运维模式 (No Tables)</option>
              <optgroup label="─── 当前数据库数据表 ───">
                {tables.map((t, i) => (
                  <option key={i} value={t.name}>
                    📊 {t.name}
                  </option>
                ))}
              </optgroup>
            </select>
            <button
              onClick={fetchTables}
              disabled={loadingTables}
              className="p-1 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded border border-slate-700 shrink-0"
              title="刷新表与元数据"
            >
              <RefreshCw className={`w-3 h-3 ${loadingTables ? 'animate-spin text-blue-400' : ''}`} />
            </button>
          </div>
        </div>

        {selectedTable !== 'AUTO' && selectedTable !== 'NONE' && activeTableColumns.length > 0 && (
          <div className="pt-1 border-t border-slate-800/80">
            <div className="text-[10px] text-slate-400 flex items-center gap-1 mb-1">
              <Hash className="w-3 h-3 text-slate-500" />
              <span>快速引用字段 (点击插入):</span>
            </div>
            <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto pr-1">
              {activeTableColumns.map((col) => (
                <button
                  key={col.column_name}
                  onClick={() => {
                    setPrompt((prev) => `${prev} "${col.column_name}" `);
                    inputRef.current?.focus();
                  }}
                  className="px-1.5 py-0.5 bg-slate-800/80 hover:bg-blue-600/30 text-slate-300 hover:text-blue-300 rounded text-[10px] font-mono border border-slate-700/60 transition-colors flex items-center gap-1"
                  title={`${col.column_name} (${col.data_type}) ${col.comment ? `\n注释: ${col.comment}` : ''}`}
                >
                  <span>{col.column_name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {currentError && (
          <div className="p-2 bg-red-950/40 border border-red-800/60 rounded-lg flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 overflow-hidden text-red-300 text-[11px] font-mono truncate">
              <ShieldAlert className="w-3.5 h-3.5 text-red-400 shrink-0" />
              <span className="truncate">检测到 SQL 执行报错</span>
            </div>
            <button
              onClick={() => handleSend(`帮我分析并修复此 SQL 报错：${currentError}`)}
              disabled={loading}
              className="px-2 py-0.5 bg-red-600/80 hover:bg-red-500 text-white rounded text-[10px] font-semibold flex items-center gap-1 shrink-0 shadow transition-colors"
            >
              <Wrench className="w-3 h-3" />
              <span>一键修复此错误</span>
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {chatLog.map((msg, idx) => (
          <div
            key={idx}
            className={`p-3 rounded-xl max-w-[95%] shadow-sm select-text ${
              msg.role === 'user'
                ? 'bg-blue-600/25 text-blue-100 ml-auto border border-blue-500/30'
                : 'bg-slate-800/90 text-slate-200 border border-slate-700/80'
            }`}
          >
            {/* 智能消息解析：逐段渲染普通文本与带操作栏的 SQL / psql 代码块 */}
            <div className="space-y-2">
              {(() => {
                const parts: Array<{ type: 'text' | 'code'; content: string; lang?: string }> = [];
                const regex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
                let lastIdx = 0;
                let match: RegExpExecArray | null;

                while ((match = regex.exec(msg.text)) !== null) {
                  if (match.index > lastIdx) {
                    parts.push({ type: 'text', content: msg.text.slice(lastIdx, match.index) });
                  }
                  parts.push({ type: 'code', lang: match[1] || 'sql', content: match[2].trim() });
                  lastIdx = regex.lastIndex;
                }

                if (lastIdx < msg.text.length) {
                  parts.push({ type: 'text', content: msg.text.slice(lastIdx) });
                }

                if (parts.length === 0) {
                  return <p className="whitespace-pre-wrap leading-relaxed font-sans select-text">{msg.text}</p>;
                }

                return parts.map((part, pIdx) => {
                  if (part.type === 'text') {
                    if (!part.content.trim()) return null;
                    return (
                      <p key={pIdx} className="whitespace-pre-wrap leading-relaxed font-sans select-text">
                        {part.content}
                      </p>
                    );
                  }

                  const copyBlockKey = `copy_${idx}_${pIdx}`;
                  const appendBlockKey = `append_${idx}_${pIdx}`;

                  return (
                    <div
                      key={pIdx}
                      className="my-2 rounded-xl bg-slate-950/90 border border-slate-700/80 overflow-hidden font-mono text-xs shadow-lg"
                    >
                      <div className="px-3 py-1.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
                        <span className="text-[10px] text-blue-400 font-bold uppercase tracking-wider">
                          {part.lang || 'SQL'}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => {
                              onInsertSql(part.content);
                              setCopiedBlockId(copyBlockKey);
                              setTimeout(() => setCopiedBlockId(null), 1500);
                            }}
                            className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] flex items-center gap-1 transition-colors border border-slate-700"
                            title="覆盖填入主 Monaco 编辑器"
                          >
                            {copiedBlockId === copyBlockKey ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-400" />
                                <span className="text-emerald-300 font-semibold">已覆盖</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                <span>覆盖填入</span>
                              </>
                            )}
                          </button>

                          <button
                            onClick={() => {
                              const appended = currentSql ? `${currentSql.trim()}\n\n${part.content}` : part.content;
                              onInsertSql(appended);
                              setCopiedBlockId(appendBlockKey);
                              setTimeout(() => setCopiedBlockId(null), 1500);
                            }}
                            className="px-2 py-0.5 bg-blue-600/80 hover:bg-blue-500 text-white rounded text-[10px] font-semibold flex items-center gap-1 transition-colors shadow"
                            title="在主编辑器末尾追加此段 SQL"
                          >
                            {copiedBlockId === appendBlockKey ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-300" />
                                <span>已追加</span>
                              </>
                            ) : (
                              <>
                                <Terminal className="w-3 h-3" />
                                <span>追加到编辑器</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                      <pre className="p-3 overflow-x-auto text-emerald-300 text-[11px] leading-relaxed whitespace-pre-wrap select-text">
                        <code>{part.content}</code>
                      </pre>
                    </div>
                  );
                });
              })()}
            </div>

            {/* 只读 SELECT 自动执行结果渲染 */}
            {msg.autoQueryResult && (
              <div className="mt-3 p-2.5 bg-slate-950/80 border border-emerald-500/40 rounded-lg space-y-2 select-text">
                <div className="flex items-center justify-between text-[11px] text-emerald-400 font-bold">
                  <span className="flex items-center gap-1.5">
                    <Play className="w-3 h-3 fill-current" /> 只读查询已自动执行 ({msg.autoQueryResult.rows.length} 行, {msg.autoQueryResult.elapsed_ms.toFixed(1)} ms)
                  </span>
                </div>
                <div className="max-h-48 overflow-auto border border-slate-800 rounded select-text">
                  <table className="w-full text-[11px] text-left border-collapse font-mono select-text">
                    <thead>
                      <tr className="bg-slate-900 text-slate-300 border-b border-slate-800">
                        {msg.autoQueryResult.columns.map((c, ci) => (
                          <th key={ci} className="px-2 py-1 border-r border-slate-800 font-semibold select-text">
                            {c.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {msg.autoQueryResult.rows.slice(0, 5).map((r, ri) => (
                        <tr key={ri} className="border-b border-slate-800/60 hover:bg-slate-900/40">
                          {r.map((cell, ci) => (
                            <td key={ci} className="px-2 py-1 border-r border-slate-800 truncate max-w-[120px] text-slate-300 select-text">
                              {String(cell.val)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="p-3 rounded-xl bg-slate-800/40 text-slate-400 italic text-xs flex items-center gap-2 border border-slate-800">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-400" />
            <span>PostgreSQL AI 专家正在分析并调度最佳解答...</span>
          </div>
        )}
      </div>

      {/* @ 语法智能补全悬浮弹窗 */}
      {showMentionMenu && filteredMentions.length > 0 && (
        <div className="mx-2.5 mb-1 bg-[#151821] border border-blue-500/40 rounded-2xl shadow-2xl overflow-hidden text-xs z-20 font-mono backdrop-blur-xl">
          <div className="px-3 py-1.5 bg-slate-900/90 text-[10px] text-slate-400 font-sans font-semibold border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-1 text-blue-400">
              <Database className="w-3 h-3" />
              <span>快捷引用表名:</span>
            </div>
            <div className="flex items-center gap-1.5 text-[9px] text-slate-500 font-mono">
              <span className="bg-slate-800 px-1 py-0.5 rounded text-slate-300">↑↓ 选择</span>
              <span className="bg-slate-800 px-1 py-0.5 rounded text-amber-300">Tab / ↵ 填入</span>
              <span className="bg-slate-800 px-1 py-0.5 rounded text-slate-400">Esc 关闭</span>
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto p-1 space-y-0.5">
            {filteredMentions.map((t, idx) => {
              const isSelected = idx === mentionSelectedIndex;
              return (
                <div
                  key={t.name}
                  onClick={() => insertMention(t.name)}
                  onMouseEnter={() => setMentionSelectedIndex(idx)}
                  className={`px-3 py-1.5 rounded-xl cursor-pointer flex items-center justify-between transition-colors ${
                    isSelected
                      ? 'bg-blue-600/30 text-blue-300 font-bold border border-blue-500/40 shadow-sm'
                      : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
                  }`}
                >
                  <span className="font-bold">@{t.name}</span>
                  <span className="text-[10px] text-slate-500 font-sans">{t.type}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 底部输入控制条 */}
      <div className="p-2.5 border-t border-slate-800 bg-slate-950 flex gap-1.5 relative">
        <input
          ref={inputRef}
          type="text"
          value={prompt}
          onChange={handleInputChange}
          onKeyDown={(e) => {
            if (showMentionMenu && filteredMentions.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionSelectedIndex((prev) => (prev + 1) % filteredMentions.length);
                return;
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionSelectedIndex((prev) => (prev - 1 + filteredMentions.length) % filteredMentions.length);
                return;
              } else if (e.key === 'Tab' || e.key === 'Enter') {
                e.preventDefault();
                const target = filteredMentions[mentionSelectedIndex] || filteredMentions[0];
                if (target) {
                  insertMention(target.name);
                }
                return;
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setShowMentionMenu(false);
                return;
              }
            }

            if (e.key === 'Enter') {
              handleSend();
            }
          }}
          placeholder="输入提问、输入 @ 引用表名、或请求 DDL 授权/报错诊断..."
          className="flex-1 px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-blue-500 placeholder-slate-500 text-xs font-sans"
        />
        <button
          onClick={() => handleSend()}
          disabled={loading}
          className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium disabled:opacity-50 flex items-center justify-center transition-colors shadow"
          title="发送提问 (Enter)"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};


