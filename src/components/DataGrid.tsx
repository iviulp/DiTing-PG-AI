import React, { useState, useEffect, useMemo } from 'react';
import { QueryResult, QueryResultTabItem } from '../types';
import { Table, Zap, ShieldCheck, Save, RotateCcw, Plus, Trash2, CheckCircle2, Eye, ArrowUp, ArrowDown, ArrowUpDown, AlertTriangle } from 'lucide-react';
import { RowDetailDrawer } from './RowDetailDrawer';

interface DataGridProps {
  result: QueryResult | null;
  resultTabs?: QueryResultTabItem[];
  activeTabId?: string;
  onSelectTab?: (tabId: string) => void;
  isExecuting: boolean;
  tableName?: string;
  onCommitChanges?: (changes: {
    edits: Record<string, string>;
    addedRows: Record<string, string>[];
    deletedRowIndices: number[];
  }) => void;
}

export const DataGrid: React.FC<DataGridProps> = ({
  result,
  resultTabs = [],
  activeTabId,
  onSelectTab,
  isExecuting,
  tableName,
  onCommitChanges
}) => {
  // 暂存修改区: { "rowIndex_colName": "newValue" } (rowIndex < originalLength 表示修改原行，>= originalLength 表示新增行)
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; colName: string } | null>(null);

  // 排序状态: { colName: string, direction: 'asc' | 'desc' } | null
  const [sortState, setSortState] = useState<{ colName: string; direction: 'asc' | 'desc' } | null>(null);

  // 标记待删除行索引集合
  const [pendingDeletions, setPendingDeletions] = useState<Set<number>>(new Set());

  // 新增行的列表：每个新增行为 Column-Value 的 Map
  const [addedRows, setAddedRows] = useState<Record<string, string>[]>([]);

  // 选中的行索引 (用于右键和操作)
  const [selectedRowIdx, setSelectedRowIdx] = useState<number | null>(null);

  // 快捷复制列字段名反馈状态
  const [copiedColName, setCopiedColName] = useState<string | null>(null);

  // 详情 Drawer 打开状态
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [drawerRowIndex, setDrawerRowIndex] = useState<number>(0);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    rowIdx: number;
  } | null>(null);

  // 清空所有状态当 result 变更
  useEffect(() => {
    setEdits({});
    setEditingCell(null);
    setPendingDeletions(new Set());
    setAddedRows([]);
    setSelectedRowIdx(null);
    setContextMenu(null);
    setSortState(null);
  }, [result]);

  // 点击页面其他区域关闭右键菜单
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  // 监听 ⌘S / Ctrl+S 物理快捷键，自动提交修改
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleCommit();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [edits, pendingDeletions, addedRows]);

  const handleCellDoubleClick = (rowIdx: number, colName: string) => {
    // 标记删除了的行不能编辑
    if (pendingDeletions.has(rowIdx)) return;
    setEditingCell({ rowIdx, colName });
  };

  const handleCellChange = (rowIdx: number, colName: string, val: string) => {
    const originalLength = result?.rows.length || 0;
    if (rowIdx >= originalLength) {
      // 修改的是新增行
      const newRowOffset = rowIdx - originalLength;
      setAddedRows((prev) => {
        const next = [...prev];
        next[newRowOffset] = { ...next[newRowOffset], [colName]: val };
        return next;
      });
    } else {
      // 修改的是原数据行
      const key = `${rowIdx}_${colName}`;
      setEdits((prev) => ({ ...prev, [key]: val }));
    }
  };

  // 添加新行
  const handleAddRow = () => {
    if (!result) return;
    const emptyRow: Record<string, string> = {};
    result.columns.forEach((col) => {
      emptyRow[col.name] = '';
    });
    setAddedRows((prev) => [...prev, emptyRow]);
  };

  // 标记/取消标记删除选中行
  const toggleMarkDeleteRow = (rowIdx: number) => {
    const originalLength = result?.rows.length || 0;
    if (rowIdx >= originalLength) {
      // 如果是未提交的新增行，直接移除该新增行
      const newRowOffset = rowIdx - originalLength;
      setAddedRows((prev) => prev.filter((_, idx) => idx !== newRowOffset));
    } else {
      setPendingDeletions((prev) => {
        const next = new Set(prev);
        if (next.has(rowIdx)) {
          next.delete(rowIdx);
        } else {
          next.add(rowIdx);
        }
        return next;
      });
    }
  };

  // 切换表头字段排序逻辑 (未排序 -> 升序 asc -> 降序 desc -> 重置 null)
  const handleSortColumn = (colName: string) => {
    setSortState((prev) => {
      if (!prev || prev.colName !== colName) {
        return { colName, direction: 'asc' };
      }
      if (prev.direction === 'asc') {
        return { colName, direction: 'desc' };
      }
      return null;
    });
  };

  // 根据 sortState 计算排序后的行数组与原始索引映射
  const sortedOriginalRows = useMemo(() => {
    if (!result) return [];
    const rowsWithIdx = result.rows.map((row, origIdx) => ({ row, origIdx }));

    if (!sortState) return rowsWithIdx;

    const colIndex = result.columns.findIndex((c) => c.name === sortState.colName);
    if (colIndex === -1) return rowsWithIdx;

    return [...rowsWithIdx].sort((a, b) => {
      const keyA = `${a.origIdx}_${sortState.colName}`;
      const keyB = `${b.origIdx}_${sortState.colName}`;

      const valA = keyA in edits ? edits[keyA] : a.row[colIndex]?.val;
      const valB = keyB in edits ? edits[keyB] : b.row[colIndex]?.val;

      if (valA === null || valA === undefined || valA === 'NULL') return 1;
      if (valB === null || valB === undefined || valB === 'NULL') return -1;

      // 尝试按数字排序
      const numA = Number(valA);
      const numB = Number(valB);

      let cmp = 0;
      if (!isNaN(numA) && !isNaN(numB)) {
        cmp = numA - numB;
      } else {
        cmp = String(valA).localeCompare(String(valB));
      }

      return sortState.direction === 'asc' ? cmp : -cmp;
    });
  }, [result, sortState, edits]);

  const handleContextMenu = (e: React.MouseEvent, rowIdx: number) => {
    e.preventDefault();
    setSelectedRowIdx(rowIdx);
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      rowIdx,
    });
  };

  const handleDiscard = () => {
    setEdits({});
    setEditingCell(null);
    setPendingDeletions(new Set());
    setAddedRows([]);
  };

  const handleCommit = async () => {
    const editCount = Object.keys(edits).length;
    const deleteCount = pendingDeletions.size;
    const addCount = addedRows.length;
    const totalChanges = editCount + deleteCount + addCount;

    if (totalChanges === 0) return;

    try {
      if (onCommitChanges) {
        await onCommitChanges({
          edits,
          addedRows,
          deletedRowIndices: Array.from(pendingDeletions),
        });
      }
      setEdits({});
      setEditingCell(null);
      setPendingDeletions(new Set());
      setAddedRows([]);
    } catch (err: any) {
      alert(`提交变更到数据库失败: ${err.message || String(err)}`);
    }
  };

  if (isExecuting) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#0d1015] text-slate-400">
        <div className="flex items-center gap-2 px-4 py-2 bg-slate-900/90 rounded-2xl border border-slate-800 shadow-xl animate-pulse">
          <Zap className="w-4 h-4 text-amber-400 fill-current" />
          <span className="text-xs font-semibold text-slate-200">
            Executing query on remote server...
          </span>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-[#0d0f14] text-slate-500 text-xs select-none">
        <Table className="w-8 h-8 text-slate-700 mb-2" />
        <span>No dataset executed yet. Run a SQL query to inspect results.</span>
      </div>
    );
  }

  const editCount = Object.keys(edits).length;
  const deleteCount = pendingDeletions.size;
  const addCount = addedRows.length;
  const totalUnsaved = editCount + deleteCount + addCount;
  const originalLength = result.rows.length;

  return (
    <div className="h-full w-full flex flex-col bg-[#0d0f14] text-xs relative overflow-hidden">
      {/* 1. Multi-Result Tabs Bar (多 SQL 执行选项卡指示器) */}
      {resultTabs && resultTabs.length > 1 && (
        <div className="bg-[#090b0e] border-b border-[#1c202a] flex items-center gap-1 px-3 pt-1.5 overflow-x-auto select-none font-sans">
          {resultTabs.map((tab, idx) => {
            const isActive = tab.id === activeTabId;
            const hasError = !!tab.error;

            return (
              <button
                key={tab.id}
                onClick={() => onSelectTab && onSelectTab(tab.id)}
                className={`px-3 py-1.5 rounded-t-lg text-xs font-semibold flex items-center gap-2 border-t border-x transition-all truncate max-w-[200px] ${
                  isActive
                    ? 'bg-[#181a1d] border-slate-700 text-amber-400 border-b-transparent shadow'
                    : 'bg-[#1b1e25]/60 border-transparent text-slate-400 hover:text-slate-200 hover:bg-[#1f222b]'
                }`}
                title={tab.sql}
              >
                {hasError ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                ) : (
                  <Zap className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-amber-400 fill-amber-400' : 'text-slate-500'}`} />
                )}
                <span className="truncate">{tab.title || `Result #${idx + 1}`}</span>
                {tab.result && (
                  <span className="text-[10px] opacity-70 font-mono font-normal">
                    ({tab.result.rows.length})
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Table Action / Metadata Toolbar */}
      <div className="px-4 py-2 bg-[#12141a] border-b border-[#1c202a] flex justify-between items-center text-slate-300">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
            <span className="font-bold text-slate-100">
              {result.rows.length + addedRows.length}
            </span>
            <span className="text-slate-400">
              rows total ({result.rows.length} fetched{addedRows.length > 0 ? `, +${addedRows.length} new` : ''}, {result.elapsed_ms.toFixed(2)} ms)
            </span>
          </div>

          <button
            onClick={handleAddRow}
            className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-[11px] font-semibold flex items-center gap-1 shadow transition-colors"
            title="增加新行 (Add Row)"
          >
            <Plus className="w-3.5 h-3.5" /> 增加行
          </button>

          <button
            disabled={selectedRowIdx === null}
            onClick={() => {
              if (selectedRowIdx !== null) {
                setDrawerRowIndex(selectedRowIdx);
                setIsDrawerOpen(true);
              }
            }}
            className="px-2.5 py-1 bg-[#1a1d26] hover:bg-[#222733] disabled:opacity-40 text-slate-300 rounded text-[11px] font-semibold flex items-center gap-1 shadow transition-colors border border-[#272d3b]"
            title="查看并编辑当前选中行的完整列信息"
          >
            <Eye className="w-3.5 h-3.5 text-amber-400" /> 查看行详情
          </button>

          {/* 实时未保存修改统计面板 (Dirty Changes Bar) */}
          {totalUnsaved > 0 && (
            <div className="flex items-center gap-2 px-2.5 py-0.5 bg-amber-500/15 border border-amber-500/30 rounded text-amber-300 text-xs animate-pulse">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>
                {totalUnsaved} 处修改未保存 ({editCount} 改动, {deleteCount} 删除, {addCount} 新增)
              </span>
              <button
                onClick={handleCommit}
                className="ml-1 px-2 py-0.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded flex items-center gap-1 shadow"
              >
                <Save className="w-3 h-3" /> 确认提交 (⌘S)
              </button>
              <button
                onClick={handleDiscard}
                className="p-0.5 text-amber-300 hover:text-white"
                title="放弃所有修改"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {result.is_read_only && (
          <span className="px-2 py-0.5 bg-amber-950/80 text-amber-300 rounded text-[10px] font-bold border border-amber-800 flex items-center gap-1">
            <ShieldCheck className="w-3 h-3" /> READ-ONLY MODE
          </span>
        )}
      </div>

      {/* Main Table Grid */}
      <div className="flex-1 overflow-auto bg-[#0d0f14]">
        <table className="w-full text-left border-collapse font-sans">
          <thead>
            <tr className="bg-[#141720] text-slate-200 border-b border-[#1c202a] sticky top-0 shadow z-10 font-mono">
              <th className="px-3 py-2 font-mono text-[11px] border-r border-[#1c202a] w-12 text-center text-slate-500 font-normal select-none">
                #
              </th>
              {result.columns.map((col, idx) => {
                const isSorted = sortState?.colName === col.name;
                const isAsc = sortState?.direction === 'asc';
                const isCopied = copiedColName === col.name;

                return (
                  <th
                    key={idx}
                    className={`px-3.5 py-2 font-bold border-r border-slate-200 dark:border-slate-800 select-none group transition-colors ${
                      isSorted ? 'bg-amber-500/10 text-amber-400' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1 min-w-0">
                        {/* 点击字段名直接自动复制字段名到剪贴板 */}
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(col.name);
                            setCopiedColName(col.name);
                            setTimeout(() => setCopiedColName(null), 1500);
                          }}
                          className={`truncate cursor-pointer px-1 py-0.5 rounded transition-all ${
                            isCopied
                              ? 'bg-emerald-500 text-white font-extrabold shadow'
                              : isSorted
                              ? 'text-amber-400 font-extrabold hover:underline'
                              : 'hover:text-amber-400 hover:bg-slate-200 dark:hover:bg-slate-700/80 hover:underline'
                          }`}
                          title={isCopied ? '已复制字段名!' : `点击直接复制字段名 "${col.name}" 到剪贴板`}
                        >
                          {isCopied ? '已复制!' : col.name}
                        </span>
                        <span className="text-[10px] text-slate-400 font-mono font-normal shrink-0">
                          ({col.data_type.toLowerCase()})
                        </span>
                      </div>

                      {/* 动态排序图标指示器 (点击右侧图标区域进行排序) */}
                      <div
                        onClick={() => handleSortColumn(col.name)}
                        className="shrink-0 flex items-center cursor-pointer p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors"
                        title={`点击按 ${col.name} 排序 (${isSorted ? (isAsc ? '当前: 升序 -> 点击降序' : '当前: 降序 -> 点击重置') : '点击升序'})`}
                      >
                        {isSorted ? (
                          isAsc ? (
                            <ArrowUp className="w-3.5 h-3.5 text-amber-400 font-bold" />
                          ) : (
                            <ArrowDown className="w-3.5 h-3.5 text-amber-400 font-bold" />
                          )
                        ) : (
                          <ArrowUpDown className="w-3 h-3 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono text-[12px]">
            {/* 1. 原数据库行 (支持智能多数据类型表头列排序) */}
            {sortedOriginalRows.map(({ row, origIdx: rIdx }, displayIdx) => {
              const isMarkedDeleted = pendingDeletions.has(rIdx);
              const isSelected = selectedRowIdx === rIdx;

              return (
                <tr
                  key={`orig_${rIdx}`}
                  onContextMenu={(e) => handleContextMenu(e, rIdx)}
                  onClick={() => {
                    if (selectedRowIdx === rIdx && isDrawerOpen) {
                      // 再次点击同一行：取消详情页的展示
                      setIsDrawerOpen(false);
                      setSelectedRowIdx(null);
                    } else {
                      // 第一次点击或点击其他行：选中并打开详情页
                      setSelectedRowIdx(rIdx);
                      setDrawerRowIndex(rIdx);
                      setIsDrawerOpen(true);
                    }
                  }}
                  className={`transition-colors border-b border-[#181c25] ${
                    isMarkedDeleted
                      ? 'bg-red-950/40 text-red-400 line-through decoration-red-500'
                      : isSelected
                      ? 'bg-blue-600/25 border-l-2 border-l-amber-400 text-white'
                      : rIdx % 2 === 0
                      ? 'bg-[#0d0f14]'
                      : 'bg-[#101218]'
                  } hover:bg-[#191d27] cursor-pointer`}
                >
                  <td className="px-3 py-2 border-r border-[#181c25] text-center text-slate-500 text-[11px] font-mono select-none relative">
                    {isMarkedDeleted ? (
                      <span className="text-red-500 font-bold" title="已标记删除">✕</span>
                    ) : (
                      displayIdx + 1
                    )}
                  </td>
                  {row.map((cell, cIdx) => {
                    const colName = result.columns[cIdx]?.name || `col_${cIdx}`;
                    const key = `${rIdx}_${colName}`;
                    const isModified = key in edits;
                    const displayVal = isModified ? edits[key] : String(cell.val);
                    const isEditing = editingCell?.rowIdx === rIdx && editingCell?.colName === colName;
                    const isNull = displayVal === 'NULL';

                    return (
                      <td
                        key={cIdx}
                        onDoubleClick={() => handleCellDoubleClick(rIdx, colName)}
                        className={`px-3 py-1.5 border-r border-[#181c25] whitespace-nowrap max-w-xs truncate h-9 box-border ${
                          isMarkedDeleted
                            ? 'opacity-60 line-through'
                            : isModified
                            ? 'bg-amber-500/20 text-amber-300 font-bold'
                            : isNull
                            ? 'text-slate-600 italic font-sans text-[11px]'
                            : 'text-slate-200'
                        }`}
                        title={displayVal}
                      >
                        {isEditing ? (
                          <input
                            type="text"
                            autoFocus
                            value={displayVal}
                            onChange={(e) => handleCellChange(rIdx, colName, e.target.value)}
                            onBlur={() => setEditingCell(null)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') setEditingCell(null);
                            }}
                            className="w-full h-full bg-slate-900 border border-blue-500 px-2 py-0 text-white font-mono text-xs rounded focus:outline-none box-border"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center">{displayVal}</div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {/* 2. 待提交的新增行 */}
            {addedRows.map((addedRow, aIdx) => {
              const rIdx = originalLength + aIdx;
              const isSelected = selectedRowIdx === rIdx;

              return (
                <tr
                  key={`add_${aIdx}`}
                  onContextMenu={(e) => handleContextMenu(e, rIdx)}
                  onClick={() => {
                    if (selectedRowIdx === rIdx && isDrawerOpen) {
                      // 再次点击同一行：取消详情页的展示
                      setIsDrawerOpen(false);
                      setSelectedRowIdx(null);
                    } else {
                      // 第一次点击或点击其他行：选中并打开详情页
                      setSelectedRowIdx(rIdx);
                      setDrawerRowIndex(rIdx);
                      setIsDrawerOpen(true);
                    }
                  }}
                  className={`bg-emerald-950/30 text-emerald-300 border-l-2 border-l-emerald-500 ${
                    isSelected ? 'bg-emerald-900/50' : ''
                  } hover:bg-emerald-900/40 cursor-pointer`}
                >
                  <td className="px-3 py-2 border-r border-slate-200 dark:border-slate-800 text-center text-emerald-400 text-[11px] font-mono select-none font-bold">
                    +
                  </td>
                  {result.columns.map((col, cIdx) => {
                    const colName = col.name;
                    const displayVal = addedRow[colName] ?? '';
                    const isEditing = editingCell?.rowIdx === rIdx && editingCell?.colName === colName;

                    return (
                      <td
                        key={cIdx}
                        onDoubleClick={() => handleCellDoubleClick(rIdx, colName)}
                        className="px-3 py-1.5 border-r border-slate-200 dark:border-slate-800 whitespace-nowrap max-w-xs truncate h-9 box-border"
                        title={displayVal}
                      >
                        {isEditing ? (
                          <input
                            type="text"
                            autoFocus
                            value={displayVal}
                            onChange={(e) => handleCellChange(rIdx, colName, e.target.value)}
                            onBlur={() => setEditingCell(null)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') setEditingCell(null);
                            }}
                            className="w-full h-full bg-slate-900 border border-emerald-500 px-2 py-0 text-white font-mono text-xs rounded focus:outline-none box-border"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center text-emerald-200 italic">
                            {displayVal || <span className="text-emerald-600/70 font-sans text-[11px]">点击编辑新值...</span>}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 右键菜单 Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl py-1 text-xs text-slate-200 w-44 font-sans backdrop-blur-md"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            onClick={() => {
              setDrawerRowIndex(contextMenu.rowIdx);
              setIsDrawerOpen(true);
              setContextMenu(null);
            }}
            className="px-3 py-1.5 hover:bg-amber-600 hover:text-white cursor-pointer flex items-center gap-2 font-medium border-t border-slate-800 text-amber-300"
          >
            <Eye className="w-3.5 h-3.5 text-amber-400" />
            <span>查看完整行详情</span>
          </div>

          <div
            onClick={() => {
              handleAddRow();
              setContextMenu(null);
            }}
            className="px-3 py-1.5 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center gap-2 font-medium"
          >
            <Plus className="w-3.5 h-3.5 text-blue-400" />
            <span>增加新行</span>
          </div>

          <div
            onClick={() => {
              toggleMarkDeleteRow(contextMenu.rowIdx);
              setContextMenu(null);
            }}
            className="px-3 py-1.5 hover:bg-red-600 hover:text-white cursor-pointer flex items-center gap-2 font-medium border-t border-slate-800"
          >
            <Trash2 className="w-3.5 h-3.5 text-red-400" />
            <span>
              {contextMenu.rowIdx >= originalLength
                ? '移除此新增行'
                : pendingDeletions.has(contextMenu.rowIdx)
                ? '取消标记删除'
                : '标记删除选中行'}
            </span>
          </div>

          {totalUnsaved > 0 && (
            <div
              onClick={() => {
                handleCommit();
                setContextMenu(null);
              }}
              className="px-3 py-1.5 hover:bg-emerald-600 hover:text-white cursor-pointer flex items-center gap-2 font-semibold border-t border-slate-800 text-emerald-400"
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>手动确认并提交</span>
            </div>
          )}
        </div>
      )}

      {/* Row Detail Drawer Side Panel */}
      {isDrawerOpen && result && (
        <RowDetailDrawer
          isOpen={isDrawerOpen}
          onClose={() => setIsDrawerOpen(false)}
          columns={result.columns}
          tableName={tableName}
          rowIndex={drawerRowIndex}
          rowData={
            drawerRowIndex < originalLength
              ? result.columns.map((col, idx) => {
                  const key = `${drawerRowIndex}_${col.name}`;
                  const isModified = key in edits;
                  const rawVal = result.rows[drawerRowIndex][idx]?.val;
                  return { val: isModified ? edits[key] : rawVal };
                })
              : result.columns.map((col) => ({
                  val: addedRows[drawerRowIndex - originalLength]?.[col.name] ?? ''
                }))
          }
          isReadOnly={result.is_read_only}
          onCellEdit={(colName, newVal) => {
            handleCellChange(drawerRowIndex, colName, newVal);
          }}
        />
      )}
    </div>
  );
};

