import React, { useState, useEffect } from 'react';
import { SchemaItem } from '../types';
import { getTableSchema } from '../services/ipc';
import { Table, Eye, Folder, ChevronRight, ChevronDown, RefreshCw, Layers } from 'lucide-react';

interface SchemaTreeProps {
  connId: string;
  database?: string;
  selectedTable?: string | null;
  onSelectTable: (tableName: string) => void;
  onDesignTable: (tableName: string) => void;
  onExportTable?: (tableName: string) => void;
  onExportDdl?: (tableName: string) => void;
}


/**
 * 1:1 比标 TablePlus / Navicat 树状导航组件
 * 支持多 Schema 层级折叠、表/视图分类展示、双击查看数据与右键快捷设计
 */
export const SchemaTree: React.FC<SchemaTreeProps> = ({
  connId,
  database,
  selectedTable,
  onSelectTable,
  onDesignTable,
  onExportTable,
  onExportDdl,
}) => {
  const [items, setItems] = useState<SchemaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [isTablesExpanded, setIsTablesExpanded] = useState(true);
  const [isViewsExpanded, setIsViewsExpanded] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tableName: string } | null>(null);

  const [schemaError, setSchemaError] = useState<string | null>(null);

  const fetchSchema = async () => {
    setLoading(true);
    setSchemaError(null);
    try {
      const data = await getTableSchema(connId);
      setItems(data || []);
    } catch (err: any) {
      console.error('Failed to fetch schema:', err);
      setSchemaError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (connId) {
      fetchSchema();
    }
  }, [connId, database]);

  const handleContextMenu = (e: React.MouseEvent, tableName: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tableName });
  };

  const closeContextMenu = () => setContextMenu(null);

  useEffect(() => {
    window.addEventListener('click', closeContextMenu);
    return () => window.removeEventListener('click', closeContextMenu);
  }, []);

  const tables = items.filter((i) => i.item_type === 'table');
  const views = items.filter((i) => i.item_type === 'view');

  return (
    <div className="h-full bg-slate-900 border-r border-slate-800 flex flex-col font-sans select-none text-slate-300">
      {/* Header */}
      <div className="p-3 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2 overflow-hidden">
          <Layers className="w-4 h-4 text-blue-400 shrink-0" />
          <div className="truncate">
            <span className="font-bold text-xs text-white">Schema Explorer</span>
            {database && (
              <span className="block text-[10px] text-emerald-400 font-mono font-semibold truncate">
                db: {database}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={fetchSchema}
          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition-colors shrink-0"
          title="刷新 Schema 树"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-blue-400' : ''}`} />
        </button>
      </div>

      {/* Tree Content */}
      <div className="flex-1 overflow-auto p-2 space-y-3">
        {schemaError && (
          <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-[11px] space-y-1">
            <div className="font-bold flex items-center gap-1">
              <span>⚠️ 加载元数据失败</span>
            </div>
            <div className="text-[10px] text-red-400/80 font-mono break-all">{schemaError}</div>
          </div>
        )}

        {/* Tables Section */}
        <div>
          <div
            onClick={() => setIsTablesExpanded(!isTablesExpanded)}
            className="flex items-center gap-1.5 p-1.5 hover:bg-slate-800/60 rounded cursor-pointer text-slate-400 font-bold text-[11px]"
          >
            {isTablesExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <Folder className="w-3.5 h-3.5 text-blue-400" />
            <span>Tables ({tables.length})</span>
          </div>

          {isTablesExpanded && (
            <div className="pl-4 space-y-0.5 mt-0.5">
              {tables.map((t) => {
                const isCurrentActive = selectedTable === t.name;
                return (
                  <div
                    key={t.name}
                    onClick={() => onSelectTable(t.name)}
                    onContextMenu={(e) => handleContextMenu(e, t.name)}
                    className={`flex items-center gap-2 p-1.5 rounded cursor-pointer font-mono text-[11px] transition-colors ${
                      isCurrentActive
                        ? 'bg-blue-600/30 text-blue-300 font-bold border border-blue-500/40 shadow-sm'
                        : 'text-slate-300 hover:bg-blue-600/15 hover:text-blue-200'
                    }`}
                  >
                    <Table className={`w-3.5 h-3.5 shrink-0 ${isCurrentActive ? 'text-blue-400' : 'text-slate-500'}`} />
                    <span className="truncate">{t.name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Views Section */}
        <div>
          <div
            onClick={() => setIsViewsExpanded(!isViewsExpanded)}
            className="flex items-center gap-1.5 p-1.5 hover:bg-slate-800/60 rounded cursor-pointer text-slate-400 font-bold text-[11px]"
          >
            {isViewsExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <Folder className="w-3.5 h-3.5 text-purple-400" />
            <span>Views ({views.length})</span>
          </div>

          {isViewsExpanded && (
            <div className="pl-4 space-y-0.5 mt-0.5">
              {views.map((v) => (
                <div
                  key={v.name}
                  onClick={() => onSelectTable(v.name)}
                  onContextMenu={(e) => handleContextMenu(e, v.name)}
                  className="flex items-center gap-2 p-1.5 hover:bg-purple-600/20 hover:text-purple-300 rounded cursor-pointer font-mono text-[11px]"
                >
                  <Eye className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                  <span className="truncate">{v.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right Click Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-[#171a21] border border-slate-700/90 rounded-xl shadow-2xl py-1.5 text-xs text-slate-200 w-48 font-sans backdrop-blur-xl"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div
            onClick={() => {
              onSelectTable(contextMenu.tableName);
              closeContextMenu();
            }}
            className="px-3 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center justify-between"
          >
            <span>Open Data (查看表数据)</span>
          </div>
          <div
            onClick={() => {
              onDesignTable(contextMenu.tableName);
              closeContextMenu();
            }}
            className="px-3 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center justify-between"
          >
            <span>Design Table (设计表结构)</span>
          </div>
          <div
            onClick={() => {
              if (onExportDdl) onExportDdl(contextMenu.tableName);
              closeContextMenu();
            }}
            className="px-3 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center justify-between border-t border-slate-800/80 text-amber-300 font-semibold"
          >
            <span>Export DDL (导出建表语句)</span>
          </div>
          <div
            onClick={() => {
              if (onExportTable) onExportTable(contextMenu.tableName);
              closeContextMenu();
            }}
            className="px-3 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center justify-between text-cyan-300 font-semibold"
          >
            <span>Export Data (导出全表数据)</span>
          </div>
        </div>
      )}
    </div>
  );
};
