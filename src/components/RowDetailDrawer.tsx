import React, { useState } from 'react';
import {
  X,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  Code,
  Eye,
  Edit3,
  AlignLeft,
  Layers,
  Sparkles
} from 'lucide-react';

export interface RowDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  columns: Array<{ name: string; data_type: string }>;
  rowData: Array<{ val: any }>;
  rowIndex: number;
  tableName?: string;
  onCellEdit?: (colName: string, newValue: string) => void;
  isReadOnly?: boolean;
}

export const RowDetailDrawer: React.FC<RowDetailDrawerProps> = ({
  isOpen,
  onClose,
  columns,
  rowData,
  rowIndex,
  tableName,
  onCellEdit,
  isReadOnly = false
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [editingColName, setEditingColName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  // 储存每个字段当前的显示模式: 'preview' | 'source' | 'raw'
  const [fieldTabs, setFieldTabs] = useState<Record<string, 'preview' | 'source' | 'raw'>>({});

  if (!isOpen) return null;

  const handleCopy = (colName: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(colName);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleStartEdit = (colName: string, currentValStr: string) => {
    setEditingColName(colName);
    setEditValue(currentValStr);
  };

  const handleSaveEdit = (colName: string) => {
    if (onCellEdit) {
      onCellEdit(colName, editValue);
    }
    setEditingColName(null);
  };

  // 检测内容类型 (JSON / Markdown / Plain text)
  const isJson = (str: string) => {
    if (!str || str === 'NULL') return false;
    const trimmed = str.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };

  // 简易 Markdown 渲染逻辑
  const renderMarkdown = (text: string) => {
    if (text === 'NULL') {
      return <span className="italic text-slate-500 font-sans text-xs">NULL (空值)</span>;
    }

    const lines = text.split('\n');
    return (
      <div className="space-y-1.5 text-slate-200 font-sans text-xs leading-relaxed">
        {lines.map((line, idx) => {
          if (line.startsWith('# ')) {
            return (
              <h1 key={idx} className="text-base font-bold border-b border-slate-700/80 pb-1 text-amber-400 mt-2">
                {line.replace(/^#\s+/, '')}
              </h1>
            );
          }
          if (line.startsWith('## ')) {
            return (
              <h2 key={idx} className="text-sm font-bold text-amber-300 mt-1.5">
                {line.replace(/^##\s+/, '')}
              </h2>
            );
          }
          if (line.startsWith('### ')) {
            return (
              <h3 key={idx} className="text-xs font-semibold text-amber-200 mt-1">
                {line.replace(/^###\s+/, '')}
              </h3>
            );
          }
          if (line.startsWith('> ')) {
            return (
              <blockquote key={idx} className="border-l-2 border-amber-500 pl-2.5 py-0.5 text-slate-300 bg-slate-900/60 rounded-r text-[11px]">
                {line.replace(/^>\s+/, '')}
              </blockquote>
            );
          }
          if (line.startsWith('- ') || line.startsWith('* ')) {
            return (
              <li key={idx} className="ml-4 list-disc text-slate-300">
                {line.replace(/^[-*]\s+/, '')}
              </li>
            );
          }
          if (line.startsWith('```')) {
            return (
              <div key={idx} className="text-[11px] font-mono bg-slate-950 p-2 rounded border border-slate-800 text-emerald-400 my-1">
                {line}
              </div>
            );
          }
          return <p key={idx} className="min-h-[1em]">{line || '\u00A0'}</p>;
        })}
      </div>
    );
  };

  const renderJsonPretty = (text: string) => {
    try {
      const parsed = JSON.parse(text);
      return (
        <pre className="font-mono text-xs text-emerald-300 bg-[#0a0b0d] p-3 rounded-lg overflow-auto max-h-80 border border-slate-800/80 leading-5">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    } catch {
      return <pre className="font-mono text-xs text-slate-300 whitespace-pre-wrap">{text}</pre>;
    }
  };

  return (
    <div
      className={`fixed top-0 right-0 h-full bg-[#14161b] border-l border-slate-800 shadow-2xl z-40 flex flex-col transition-all duration-300 ${
        isExpanded ? 'w-full md:w-3/4' : 'w-full md:w-[540px] lg:w-[640px]'
      }`}
    >
      {/* 1. Header */}
      <div className="px-4 py-3 bg-[#1a1c22] border-b border-slate-800 flex items-center justify-between shadow-sm flex-shrink-0">
        <div className="flex items-center gap-2 overflow-hidden">
          <Layers className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <div className="truncate">
            <span className="font-bold text-xs text-slate-100">完整行详情 (Row #{rowIndex + 1})</span>
            {tableName && (
              <span className="ml-2 px-2 py-0.5 bg-amber-500/10 text-amber-400 text-[10px] rounded border border-amber-500/20 font-mono">
                {tableName}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
            共 {columns.length} 个字段
          </span>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 hover:bg-slate-700 text-slate-400 hover:text-slate-100 rounded transition-colors"
            title={isExpanded ? '收起详情页' : '全屏展开详情页'}
          >
            {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-slate-700 text-slate-400 hover:text-slate-100 rounded transition-colors"
            title="关闭详情面板 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 2. Main Scrollable List of All Fields */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4 bg-[#101115]">
        {columns.map((col, idx) => {
          const rawCellVal = rowData && rowData[idx] ? rowData[idx].val : '';
          const cellValStr = rawCellVal === null || rawCellVal === undefined ? 'NULL' : String(rawCellVal);
          const isNull = cellValStr === 'NULL';
          const isLongText = cellValStr.length > 60 || cellValStr.includes('\n');
          const isEditingThis = editingColName === col.name;
          const activeTab = fieldTabs[col.name] || 'preview';

          return (
            <div
              key={col.name}
              className={`bg-[#181a20] border rounded-xl overflow-hidden transition-colors shadow-sm ${
                isEditingThis ? 'border-amber-500/80 ring-1 ring-amber-500/40' : 'border-slate-800/90 hover:border-slate-700'
              }`}
            >
              {/* Field Header Card */}
              <div className="px-3.5 py-2.5 bg-[#1f2128] border-b border-slate-800/80 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] font-bold text-slate-400 w-5 text-right">
                    #{idx + 1}
                  </span>
                  <span className="font-mono text-xs font-bold text-amber-400">
                    {col.name}
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono">
                    ({col.data_type.toLowerCase()})
                  </span>
                  {isLongText && (
                    <span className="px-1.5 py-0.2 bg-amber-500/10 text-amber-300 text-[10px] rounded border border-amber-500/20 flex items-center gap-0.5">
                      <Sparkles className="w-2.5 h-2.5" /> 大文本
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {/* View mode switcher for long text/markdown */}
                  {isLongText && !isEditingThis && (
                    <div className="flex items-center gap-0.5 bg-[#101115] p-0.5 rounded border border-slate-800">
                      <button
                        onClick={() => setFieldTabs((prev) => ({ ...prev, [col.name]: 'preview' }))}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 transition-colors ${
                          activeTab === 'preview' ? 'bg-amber-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200'
                        }`}
                        title="Markdown/JSON 预览"
                      >
                        <Eye className="w-3 h-3" /> 预览
                      </button>
                      <button
                        onClick={() => setFieldTabs((prev) => ({ ...prev, [col.name]: 'source' }))}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 transition-colors ${
                          activeTab === 'source' ? 'bg-amber-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200'
                        }`}
                        title="格式化源码"
                      >
                        <Code className="w-3 h-3" /> 源码
                      </button>
                      <button
                        onClick={() => setFieldTabs((prev) => ({ ...prev, [col.name]: 'raw' }))}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 transition-colors ${
                          activeTab === 'raw' ? 'bg-amber-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200'
                        }`}
                        title="纯文本"
                      >
                        <AlignLeft className="w-3 h-3" /> 纯文本
                      </button>
                    </div>
                  )}

                  {!isReadOnly && onCellEdit && (
                    isEditingThis ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleSaveEdit(col.name)}
                          className="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[10px] font-semibold flex items-center gap-1 shadow"
                        >
                          <Check className="w-3 h-3" /> 保存
                        </button>
                        <button
                          onClick={() => setEditingColName(null)}
                          className="px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-[10px]"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleStartEdit(col.name, cellValStr)}
                        className="p-1 hover:bg-slate-700 text-slate-400 hover:text-amber-300 rounded transition-colors"
                        title="编辑此字段"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    )
                  )}

                  <button
                    onClick={() => handleCopy(col.name, cellValStr)}
                    className="p-1 hover:bg-slate-700 text-slate-400 hover:text-slate-100 rounded transition-colors"
                    title="复制此字段值"
                  >
                    {copiedField === col.name ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>

              {/* Field Content Body */}
              <div className="p-3">
                {isEditingThis ? (
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      rows={Math.max(3, Math.min(10, editValue.split('\n').length + 1))}
                      className="w-full bg-[#0a0b0d] border border-amber-500/60 rounded-lg p-2.5 font-mono text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-amber-500 leading-relaxed resize-y"
                    />
                  </div>
                ) : isNull ? (
                  <span className="italic text-slate-500 font-sans text-xs">NULL</span>
                ) : isLongText ? (
                  <div className="max-h-96 overflow-y-auto">
                    {activeTab === 'preview' && (
                      isJson(cellValStr) ? renderJsonPretty(cellValStr) : renderMarkdown(cellValStr)
                    )}
                    {activeTab === 'source' && (
                      <pre className="font-mono text-xs text-emerald-400 whitespace-pre-wrap leading-relaxed bg-[#0a0b0d] p-3 rounded-lg border border-slate-800/80">
                        {isJson(cellValStr) ? JSON.stringify(JSON.parse(cellValStr), null, 2) : cellValStr}
                      </pre>
                    )}
                    {activeTab === 'raw' && (
                      <div className="bg-[#0a0b0d] p-3 rounded-lg border border-slate-800/80 font-mono text-xs text-slate-300 whitespace-pre-wrap leading-relaxed select-all">
                        {cellValStr}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="font-mono text-xs text-slate-200 whitespace-pre-wrap break-all select-all">
                    {cellValStr}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 bg-[#1a1c22] border-t border-slate-800 text-[11px] text-slate-500 flex justify-between items-center flex-shrink-0 font-mono">
        <span>滑动查看全部字段列表</span>
        <span>Row Detail Inspector</span>
      </div>
    </div>
  );
};
