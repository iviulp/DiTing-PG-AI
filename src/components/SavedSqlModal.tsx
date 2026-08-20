import React, { useState, useEffect } from 'react';
import { SavedSqlSnippet } from '../types';
import {
  Bookmark,
  Plus,
  Search,
  Trash2,
  Edit3,
  Play,
  Copy,
  Check,
  ExternalLink,
  Code2
} from 'lucide-react';

interface SavedSqlModalProps {
  isOpen: boolean;
  connId: string;
  connName: string;
  activeDatabase?: string;
  currentSql?: string;
  onClose: () => void;
  onOpenSql: (sql: string, mode: 'replace' | 'append' | 'run') => void;
}

const STORAGE_KEY = 'diting_saved_sql_snippets';

export const SavedSqlModal: React.FC<SavedSqlModalProps> = ({
  isOpen,
  connId,
  connName,
  activeDatabase,
  currentSql = '',
  onClose,
  onOpenSql,
}) => {
  const [snippets, setSnippets] = useState<SavedSqlSnippet[]>([]);
  const [selectedSnippetId, setSelectedSnippetId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTag, setSelectedTag] = useState<string>('ALL');

  // 新建/编辑状态
  const [isEditing, setIsEditing] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [formTitle, setFormTitle] = useState('');
  const [formSql, setFormSql] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formTags, setFormTags] = useState('');

  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 加载该连接下的所有已存 SQL 脚本
  const loadSnippets = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const all: SavedSqlSnippet[] = raw ? JSON.parse(raw) : [];
      // 严格连接隔离：只筛选属于当前连接 conn_id 的 SQL
      const filtered = all.filter((s) => s.conn_id === connId);
      setSnippets(filtered);
      if (filtered.length > 0 && !selectedSnippetId) {
        setSelectedSnippetId(filtered[0].id);
      }
    } catch (e) {
      console.error('Failed to load saved snippets:', e);
      setSnippets([]);
    }
  };

  useEffect(() => {
    if (isOpen && connId) {
      loadSnippets();
      setIsEditing(false);
    }
  }, [isOpen, connId]);

  if (!isOpen) return null;

  // 收集所有标签
  const allTags = Array.from(
    new Set(snippets.flatMap((s) => s.tags || []).filter(Boolean))
  );

  // 过滤脚本列表
  const filteredSnippets = snippets.filter((s) => {
    const matchesSearch =
      s.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.sql.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (s.description && s.description.toLowerCase().includes(searchTerm.toLowerCase()));

    const matchesTag = selectedTag === 'ALL' || (s.tags && s.tags.includes(selectedTag));
    return matchesSearch && matchesTag;
  });

  const selectedSnippet = snippets.find((s) => s.id === selectedSnippetId) || filteredSnippets[0];

  const handleOpenCreateModal = () => {
    setEditId(null);
    setFormTitle(`查询脚本_${new Date().toLocaleDateString()}`);
    setFormSql(currentSql || 'SELECT * FROM "information_schema"."tables" LIMIT 100;');
    setFormDesc('');
    setFormTags('常用,运维');
    setIsEditing(true);
  };

  const handleOpenEditModal = (snippet: SavedSqlSnippet) => {
    setEditId(snippet.id);
    setFormTitle(snippet.title);
    setFormSql(snippet.sql);
    setFormDesc(snippet.description || '');
    setFormTags((snippet.tags || []).join(', '));
    setIsEditing(true);
  };

  const handleSaveSnippet = () => {
    if (!formTitle.trim()) {
      alert('请输入 SQL 脚本名称！');
      return;
    }
    if (!formSql.trim()) {
      alert('SQL 脚本内容不能为空！');
      return;
    }

    const tagList = formTags
      .split(/[,， ]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const all: SavedSqlSnippet[] = raw ? JSON.parse(raw) : [];

      if (editId) {
        // 更新已有
        const updated = all.map((item) => {
          if (item.id === editId) {
            return {
              ...item,
              title: formTitle.trim(),
              sql: formSql.trim(),
              description: formDesc.trim(),
              tags: tagList,
              database: activeDatabase,
              updated_at: new Date().toISOString(),
            };
          }
          return item;
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } else {
        // 新建
        const newSnippet: SavedSqlSnippet = {
          id: `sql_${Date.now()}`,
          conn_id: connId,
          title: formTitle.trim(),
          sql: formSql.trim(),
          description: formDesc.trim(),
          tags: tagList,
          database: activeDatabase,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        all.unshift(newSnippet);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
        setSelectedSnippetId(newSnippet.id);
      }

      loadSnippets();
      setIsEditing(false);
    } catch (e: any) {
      alert(`保存失败: ${e.message || String(e)}`);
    }
  };

  const handleDeleteSnippet = (id: string, title: string) => {
    if (!confirm(`确认要删除已存 SQL 脚本 "${title}" 吗？`)) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const all: SavedSqlSnippet[] = raw ? JSON.parse(raw) : [];
      const remaining = all.filter((s) => s.id !== id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));
      loadSnippets();
      if (selectedSnippetId === id) {
        setSelectedSnippetId(null);
      }
    } catch (e: any) {
      alert(`删除失败: ${e.message || String(e)}`);
    }
  };

  const handleCopy = (sql: string, id: string) => {
    navigator.clipboard.writeText(sql);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-md z-50 flex items-center justify-center p-6 select-none font-sans">
      <div className="bg-[#101216] border border-slate-800 rounded-3xl w-full max-w-5xl h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Top Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-[#14171d]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shadow-sm">
              <Bookmark className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-100">Saved SQL Snippets (已存 SQL 脚本库)</h2>
                <span className="px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-mono text-xs border border-blue-500/30">
                  {connName}
                </span>
                {activeDatabase && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono text-xs border border-emerald-500/30">
                    db: {activeDatabase}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">
                专属绑定当前连接的常用 SQL 脚本库，支持随时调用、分类标签管理与一键直接执行
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenCreateModal}
              className="px-3.5 py-1.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-bold text-xs rounded-xl flex items-center gap-1.5 shadow-lg shadow-amber-500/20 transition-all"
            >
              <Plus className="w-4 h-4 stroke-[3]" />
              <span>保存当前 SQL</span>
            </button>
            <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800">
              ✕
            </button>
          </div>
        </div>

        {/* Main Content Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Sidebar: Snippet List with Search & Tag Filter */}
          <div className="w-80 border-r border-slate-800 bg-[#12141a] flex flex-col overflow-hidden">
            {/* Search Input */}
            <div className="p-3 border-b border-slate-800/80 space-y-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="搜索 SQL 名称、内容或描述..."
                  className="w-full pl-8 pr-3 py-1.5 bg-slate-900 border border-slate-700/80 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500/80"
                />
              </div>

              {/* Tags Horizontal Scroll */}
              <div className="flex items-center gap-1 overflow-x-auto py-0.5">
                <button
                  onClick={() => setSelectedTag('ALL')}
                  className={`px-2 py-0.5 rounded-lg text-[10px] font-bold transition-colors whitespace-nowrap ${
                    selectedTag === 'ALL'
                      ? 'bg-amber-500 text-slate-950 shadow'
                      : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  全部 ({snippets.length})
                </button>
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setSelectedTag(tag)}
                    className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold transition-colors whitespace-nowrap ${
                      selectedTag === tag
                        ? 'bg-amber-500 text-slate-950 font-bold shadow'
                        : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            </div>

            {/* List Items */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {filteredSnippets.length > 0 ? (
                filteredSnippets.map((s) => {
                  const isSelected = selectedSnippet?.id === s.id;
                  return (
                    <div
                      key={s.id}
                      onClick={() => {
                        setSelectedSnippetId(s.id);
                        setIsEditing(false);
                      }}
                      className={`p-3 rounded-2xl cursor-pointer transition-all border ${
                        isSelected
                          ? 'bg-amber-500/10 border-amber-500/40 text-amber-200 shadow-sm'
                          : 'bg-slate-900/40 border-slate-800/80 text-slate-300 hover:bg-slate-800/50 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-bold text-xs truncate">{s.title}</span>
                        <div className="flex items-center gap-1 opacity-80 shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenEditModal(s);
                            }}
                            className="p-1 hover:text-amber-400 rounded transition-colors"
                            title="编辑"
                          >
                            <Edit3 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteSnippet(s.id, s.title);
                            }}
                            className="p-1 hover:text-red-400 rounded transition-colors"
                            title="删除"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      {s.description && (
                        <p className="text-[11px] text-slate-400 line-clamp-1 mb-1.5 font-sans">
                          {s.description}
                        </p>
                      )}

                      <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                        <span className="truncate max-w-[120px]">
                          {s.database ? `db: ${s.database}` : 'Global'}
                        </span>
                        <span>{new Date(s.updated_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="p-8 text-center text-xs text-slate-500">
                  {searchTerm ? '未找到匹配的 SQL 脚本' : '当前连接暂无已保存的 SQL 脚本，点击上方按钮开始保存。'}
                </div>
              )}
            </div>
          </div>

          {/* Right Pane: Snippet Detail Viewer OR Editor */}
          <div className="flex-1 flex flex-col bg-[#14171d] overflow-hidden">
            {isEditing ? (
              /* 编辑 / 新建模式 */
              <div className="flex-1 flex flex-col p-6 overflow-y-auto space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <h3 className="font-bold text-sm text-white flex items-center gap-2">
                    <Code2 className="w-4 h-4 text-amber-400" />
                    <span>{editId ? '编辑已存 SQL 脚本' : '保存新的常用 SQL 脚本'}</span>
                  </h3>
                  <button
                    onClick={() => setIsEditing(false)}
                    className="text-xs text-slate-400 hover:text-slate-200"
                  >
                    取消编辑
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      脚本标题名称 (Title) *
                    </label>
                    <input
                      type="text"
                      value={formTitle}
                      onChange={(e) => setFormTitle(e.target.value)}
                      placeholder="e.g. 每日高频慢查询统计 / 审批流全量实例回滚"
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-500/80"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      SQL 脚本内容 (SQL Statements) *
                    </label>
                    <textarea
                      rows={10}
                      value={formSql}
                      onChange={(e) => setFormSql(e.target.value)}
                      placeholder="输入或粘贴标准 PostgreSQL SQL 脚本..."
                      className="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl font-mono text-xs text-emerald-300 placeholder-slate-600 focus:outline-none focus:border-amber-500/80 leading-relaxed"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      业务用途说明与操作备注 (Description)
                    </label>
                    <input
                      type="text"
                      value={formDesc}
                      onChange={(e) => setFormDesc(e.target.value)}
                      placeholder="e.g. 用于生产巡检，只读查询，无锁执行"
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-500/80"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      分类标签 (Tags - 逗号分隔)
                    </label>
                    <input
                      type="text"
                      value={formTags}
                      onChange={(e) => setFormTags(e.target.value)}
                      placeholder="e.g. 巡检, 生产报表, DDL"
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-500/80"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
                  <button
                    onClick={() => setIsEditing(false)}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSaveSnippet}
                    className="px-5 py-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 rounded-xl text-xs font-bold shadow-lg shadow-amber-500/20"
                  >
                    确认保存脚本
                  </button>
                </div>
              </div>
            ) : selectedSnippet ? (
              /* 查看与运行模式 */
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Detail Top Toolbar */}
                <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-[#11141a]">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-sm text-white">{selectedSnippet.title}</h3>
                      {selectedSnippet.tags?.map((t) => (
                        <span
                          key={t}
                          className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded text-[10px] text-amber-300 font-medium"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                    {selectedSnippet.description && (
                      <p className="text-xs text-slate-400">{selectedSnippet.description}</p>
                    )}
                  </div>

                  {/* Actions: Run / Fill to Monaco / Copy */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleCopy(selectedSnippet.sql, selectedSnippet.id)}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors"
                      title="复制 SQL 到剪贴板"
                    >
                      {copiedId === selectedSnippet.id ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-400 font-bold">已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 text-slate-400" />
                          <span>复制 SQL</span>
                        </>
                      )}
                    </button>

                    <button
                      onClick={() => {
                        onOpenSql(selectedSnippet.sql, 'append');
                        onClose();
                      }}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shadow"
                      title="保留当前正在编写的 SQL，将此脚本追加到编辑器末尾"
                    >
                      <Plus className="w-3.5 h-3.5 text-cyan-400" />
                      <span>追加到末尾</span>
                    </button>

                    <button
                      onClick={() => {
                        if (currentSql && currentSql.trim() && currentSql.trim() !== selectedSnippet.sql.trim()) {
                          const confirmReplace = confirm(
                            '⚠️ 覆盖确认提示：\n\n主编辑器当前有未保存的 SQL 内容。\n点击确定将【完全覆盖】当前编辑区。\n\n（提示：如需保留当前内容，建议点击【追加到末尾】或【保存当前 SQL】）。\n\n是否继续覆盖？'
                          );
                          if (!confirmReplace) return;
                        }
                        onOpenSql(selectedSnippet.sql, 'replace');
                        onClose();
                      }}
                      className="px-3 py-1.5 bg-blue-600/80 hover:bg-blue-500 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shadow"
                      title="覆盖当前编辑器内容"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>覆盖填入</span>
                    </button>

                    <button
                      onClick={() => {
                        onOpenSql(selectedSnippet.sql, 'run');
                        onClose();
                      }}
                      className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shadow-lg shadow-emerald-500/20"
                      title="不影响当前编辑器草稿，直接在主窗口执行此段 SQL 并呈现结果"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>立即执行</span>
                    </button>
                  </div>
                </div>

                {/* SQL Code Body */}
                <div className="flex-1 p-4 overflow-auto bg-[#0a0c10]">
                  <pre className="p-4 rounded-2xl bg-[#0e1117] border border-slate-800 text-emerald-300 font-mono text-xs leading-relaxed whitespace-pre-wrap select-text">
                    <code>{selectedSnippet.sql}</code>
                  </pre>
                </div>

                {/* Footer Metadata */}
                <div className="px-4 py-2.5 border-t border-slate-800/80 bg-[#12141a] text-[11px] text-slate-500 font-mono flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span>
                      创建时间: {new Date(selectedSnippet.created_at).toLocaleString()}
                    </span>
                    <span>
                      最后更新: {new Date(selectedSnippet.updated_at).toLocaleString()}
                    </span>
                  </div>
                  <div>ID: {selectedSnippet.id}</div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-500 text-xs">
                请在左侧选择要查看的 SQL 脚本
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
