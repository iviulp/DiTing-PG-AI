import React, { useState, useEffect } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useAppStore } from './store/useAppStore';
import { WelcomeScreen } from './components/WelcomeScreen';
import { SqlEditor } from './components/SqlEditor';
import { DataGrid } from './components/DataGrid';
import { AiSidebar } from './components/AiSidebar';
import { ConnectionModal } from './components/ConnectionModal';
import { SchemaTree } from './components/SchemaTree';
import { ProcessListModal } from './components/ProcessListModal';
import { TableDesignerModal } from './components/TableDesignerModal';
import { ExportWizardModal } from './components/ExportWizardModal';
import { UserManagementModal } from './components/UserManagementModal';
import { SavedSqlModal } from './components/SavedSqlModal';
import { CliConsoleModal } from './components/CliConsoleModal';


import { ConnectionConfig } from './types';
import { connectDb, executeSql } from './services/ipc';
import {
  Database,
  Play,
  Settings,
  UserCheck,
  AlertTriangle,
  SidebarClose,
  SidebarOpen,
  ArrowLeft,
  Server,
  Activity,
  Download,
  Users,
  Bookmark,
  Terminal
} from 'lucide-react';




export const App: React.FC = () => {
  const {
    connections,
    activeConnId,
    setActiveConn,
    addConnection,
    updateConnection,
    deleteConnection,
    queryResult,
    runQuery,
    isExecuting,
    errorMsg,
    loadAiConfig,
    aiConfig,
    setAiConfig
  } = useAppStore();

  const [inWorkspace, setInWorkspace] = useState(false);
  const [sqlText, setSqlText] = useState("SELECT 1 AS status, 'Welcome to AIDB Desk' AS message;");
  const [isConnModalOpen, setIsConnModalOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<ConnectionConfig | null>(null);
  const [isAiSidebarOpen, setIsAiSidebarOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSavedSqlOpen, setIsSavedSqlOpen] = useState(false);
  const [isCliConsoleOpen, setIsCliConsoleOpen] = useState(false);
  const [tempAiConfig, setTempAiConfig] = useState(aiConfig);

  // New Management Modals State
  const [isProcessModalOpen, setIsProcessModalOpen] = useState(false);
  const [isDesignerOpen, setIsDesignerOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isUserMgmtOpen, setIsUserMgmtOpen] = useState(false);
  const [exportMode, setExportMode] = useState<'data' | 'ddl'>('data');
  const [headerContextMenu, setHeaderContextMenu] = useState<{ x: number; y: number } | null>(null);

  const [designerTable, setDesignerTable] = useState('users');



  useEffect(() => {
    loadAiConfig();
  }, [loadAiConfig]);

  const activeConn = connections.find((c) => c.id === activeConnId);
  const [databases, setDatabases] = useState<string[]>([]);
  const [activeDatabase, setActiveDatabase] = useState<string>('');

  const fetchDatabases = async (conn: ConnectionConfig) => {
    try {
      const sql = "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;";
      const res = await executeSql(conn.id, sql);
      if (res && res.rows) {
        const dbs = res.rows.map((r) => String(r[0]?.val || '')).filter(Boolean);
        setDatabases(dbs);
      }
    } catch (e) {
      console.warn('Failed to list databases:', e);
    }
  };

  const handleSelectConnection = async (conn: ConnectionConfig) => {
    setActiveConn(conn.id);
    setActiveDatabase(conn.database);
    // 进入工作区时重置默认 SQL，避免上一次执行残留或语法误判
    setSqlText(`-- Connected to: ${conn.name} (${conn.database})\nSELECT * FROM "information_schema"."tables" WHERE table_schema NOT IN ('information_schema', 'pg_catalog') LIMIT 50;`);
    try {
      await connectDb(conn);
      useAppStore.setState({ errorMsg: null, queryResult: null });
      setInWorkspace(true);
      await fetchDatabases(conn);
    } catch (err: any) {
      useAppStore.setState({
        errorMsg: `Failed to open connection "${conn.name}": ${err.message || String(err)}`
      });
      alert(`⛔ 数据库连接拒绝 (FATAL Error)：\n无法建立到 "${conn.name}" 的连接。\n原因：${err.message || String(err)}`);
      throw err;
    }
  };

  const handleSwitchDatabase = async (newDb: string) => {
    if (!activeConn || newDb === activeDatabase) return;
    try {
      const updatedConfig = { ...activeConn, database: newDb };
      await connectDb(updatedConfig);
      setActiveDatabase(newDb);
      // 同时更新当前连接对象的内存配置
      await updateConnection(updatedConfig);
    } catch (err: any) {
      alert(`切换数据库到 [${newDb}] 失败：\n${err.message || String(err)}`);
    }
  };


  // 多结果集选项卡状态 (Multi Result Tabs)
  const [resultTabs, setResultTabs] = useState<import('./types').QueryResultTabItem[]>([]);
  const [activeResultTabId, setActiveResultTabId] = useState<string>('');

  // 辅助函数：严格剥离 SQL 注释 (-- 单行注释 与 /* 多行注释 */)
  const stripSqlComments = (sql: string): string => {
    // 移除 /* ... */ 多行注释
    let clean = sql.replace(/\/\*[\s\S]*?\*\//g, '');
    // 移除 -- 单行注释
    clean = clean
      .split('\n')
      .map((line) => {
        const commentIdx = line.indexOf('--');
        return commentIdx >= 0 ? line.slice(0, commentIdx) : line;
      })
      .join('\n');
    return clean.trim();
  };

  const handleExecute = async (selectedSql?: string) => {
    // 优先获取选中的 SQL；若未选中，则取主编辑区全部文本
    const sourceSql = (selectedSql !== undefined ? selectedSql : sqlText).trim();
    
    // 剥离全部注释
    const cleanSql = stripSqlComments(sourceSql);

    if (!cleanSql) {
      alert('💡 提示：当前有效 SQL 内容为空（或全为注释代码），请输入有效 SQL 语句后再执行！');
      return;
    }
    if (!activeConnId) return;

    // 按分号 split 解析出多条独立的有效 SQL 语句
    const sqlStatements = cleanSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (sqlStatements.length === 0) return;

    if (sqlStatements.length === 1) {
      // 只有一条语句：按单查询流程执行并直接刷新主 DataGrid
      setResultTabs([]);
      setActiveResultTabId('');
      runQuery(sqlStatements[0]);
    } else {
      // 包含多条语句：逐条拆分执行并构建 Result Tabs 选项卡
      useAppStore.setState({ isExecuting: true, errorMsg: null });
      const newTabs: import('./types').QueryResultTabItem[] = [];

      for (let i = 0; i < sqlStatements.length; i++) {
        const stmt = sqlStatements[i];
        // 抽取表名作为选项卡标题
        const fromMatch = stmt.match(/FROM\s+["`']?([a-zA-Z0-9_]+)["`']?/i);
        const titleName = fromMatch ? fromMatch[1] : `Query #${i + 1}`;

        try {
          const res = await executeSql(activeConnId, stmt);
          newTabs.push({
            id: `tab_${i}_${Date.now()}`,
            title: titleName,
            sql: stmt,
            result: res,
            error: null
          });
        } catch (err: any) {
          newTabs.push({
            id: `tab_${i}_${Date.now()}`,
            title: `${titleName} (Err)`,
            sql: stmt,
            result: null,
            error: err.message || String(err)
          });
        }
      }

      useAppStore.setState({ isExecuting: false });
      setResultTabs(newTabs);
      if (newTabs.length > 0) {
        setActiveResultTabId(newTabs[0].id);
        if (newTabs[0].result) {
          useAppStore.setState({ queryResult: newTabs[0].result, errorMsg: null });
        } else if (newTabs[0].error) {
          useAppStore.setState({ queryResult: null, errorMsg: newTabs[0].error });
        }
      }
    }
  };

  const [isDuplicateModal, setIsDuplicateModal] = useState(false);

  const handleSaveConnection = async (config: ConnectionConfig, isDuplicate?: boolean) => {
    if (editingConn && !isDuplicateModal && !isDuplicate) {
      await updateConnection(config);
    } else {
      await addConnection(config);
    }
    // 强制调用 connectDb 刷新后端 Rust 注册池中的 ReadOnly 配置
    try {
      await connectDb(config);
    } catch (err: any) {
      console.warn('Backend connectDb refresh warning:', err);
    }
    setEditingConn(null);
    setIsDuplicateModal(false);
  };



  // 1. 若未进入工作区，渲染 1:1 比标 TablePlus 的【欢迎与连接管理首页】
  if (!inWorkspace) {
    return (
      <>
        <WelcomeScreen
          connections={connections}
          onSelectConnection={handleSelectConnection}
          onNewConnection={() => {
            setEditingConn(null);
            setIsDuplicateModal(false);
            setIsConnModalOpen(true);
          }}
          onEditConnection={(conn) => {
            setEditingConn(conn);
            setIsDuplicateModal(false);
            setIsConnModalOpen(true);
          }}
          onDuplicateConnection={(conn) => {
            // 复制连接：拷贝当前配置并自动追加 (Copy) 标识
            const duplicatedConfig: ConnectionConfig = {
              ...conn,
              id: `conn_${Date.now()}`,
              name: `${conn.name} (Copy)`,
            };
            setEditingConn(duplicatedConfig);
            setIsDuplicateModal(true);
            setIsConnModalOpen(true);
          }}
          onDeleteConnection={(id) => deleteConnection(id)}

          onOpenAiSettings={() => {
            setTempAiConfig(aiConfig);
            setIsSettingsOpen(true);
          }}
        />

        <ConnectionModal
          isOpen={isConnModalOpen}
          editingConfig={editingConn}
          isDuplicate={isDuplicateModal}
          onClose={() => {
            setIsConnModalOpen(false);
            setEditingConn(null);
            setIsDuplicateModal(false);
          }}
          onSave={handleSaveConnection}
        />


        {/* AI Provider Settings Modal */}
        {isSettingsOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md p-5 text-slate-200 text-xs space-y-4 shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <span className="font-semibold text-sm text-white flex items-center gap-2">
                  <Server className="w-4 h-4 text-amber-500" />
                  AI Provider Configuration (Rig Engine)
                </span>
                <button onClick={() => setIsSettingsOpen(false)}>✕</button>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-slate-400 mb-1">Provider Name</label>
                  <input
                    type="text"
                    value={tempAiConfig.provider_name}
                    onChange={(e) => setTempAiConfig({ ...tempAiConfig, provider_name: e.target.value })}
                    className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Custom BaseURL</label>
                  <input
                    type="text"
                    value={tempAiConfig.base_url}
                    onChange={(e) => setTempAiConfig({ ...tempAiConfig, base_url: e.target.value })}
                    placeholder="https://api.openai.com/v1 or http://localhost:11434/v1"
                    className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">API Key</label>
                  <input
                    type="password"
                    value={tempAiConfig.api_key}
                    onChange={(e) => setTempAiConfig({ ...tempAiConfig, api_key: e.target.value })}
                    placeholder="sk-..."
                    className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Model Name</label>
                  <input
                    type="text"
                    value={tempAiConfig.model_name}
                    onChange={(e) => setTempAiConfig({ ...tempAiConfig, model_name: e.target.value })}
                    placeholder="gpt-4o-mini, deepseek-coder, llama3"
                    className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-slate-100"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-300"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    await setAiConfig(tempAiConfig);
                    setIsSettingsOpen(false);
                  }}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium"
                >
                  Save AI Settings
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // 2. 已进入工作区 Workspace 视窗
  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 select-none overflow-hidden font-sans">
      {/* 顶部 Header / Connection Toolbar (环境防呆高亮 + macOS 隐藏式无缝拖拽) */}
      <header
        className={`h-11 border-b px-3 flex items-center justify-between transition-colors app-drag-region ${
          activeConn?.env_tag === 'PROD'
            ? 'bg-red-950/90 border-red-800/80'
            : 'bg-slate-900 border-slate-800'
        }`}
      >
        <div className="flex items-center gap-3 pl-16 app-no-drag">
          <button
            onClick={() => setInWorkspace(false)}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white"
            title="Back to Welcome Screen"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>


          <div
            onContextMenu={(e) => {
              e.preventDefault();
              setHeaderContextMenu({ x: e.clientX, y: e.clientY });
            }}
            onClick={() => setHeaderContextMenu(null)}
            className="flex items-center gap-1.5 font-bold text-sm text-blue-400 cursor-pointer hover:bg-slate-800/60 px-2 py-1 rounded-lg transition-colors border border-transparent hover:border-slate-700/60"
            title="右键查看数据库管理与用户权限控制"
          >
            <Database className="w-4 h-4 text-blue-400" />
            <span>{activeConn?.name}</span>
          </div>

          {/* Database Switcher */}
          {databases.length > 0 && (
            <div className="flex items-center gap-1 bg-slate-950/80 px-2 py-1 rounded-lg border border-slate-700/60 text-xs font-mono">
              <span className="text-slate-500 font-sans text-[11px]">DB:</span>
              <select
                value={activeDatabase || activeConn?.database}
                onChange={(e) => handleSwitchDatabase(e.target.value)}
                className="bg-transparent text-emerald-400 font-bold outline-none cursor-pointer hover:text-emerald-300"
              >
                {databases.map((db) => (
                  <option key={db} value={db} className="bg-slate-900 text-slate-200">
                    {db}
                  </option>
                ))}
              </select>
            </div>
          )}

          {headerContextMenu && (
            <div
              className="fixed z-50 bg-[#171a21] border border-slate-700/90 rounded-xl shadow-2xl py-1 text-xs text-slate-200 w-52 font-sans backdrop-blur-xl"
              style={{ top: headerContextMenu.y, left: headerContextMenu.x }}
              onClick={() => setHeaderContextMenu(null)}
            >
              <div
                onClick={() => setIsUserMgmtOpen(true)}
                className="px-3.5 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center gap-2 font-semibold text-blue-300"
              >
                <Users className="w-4 h-4 text-blue-400" />
                <span>User & Privileges (用户权限管理)</span>
              </div>
              <div
                onClick={() => setIsProcessModalOpen(true)}
                className="px-3.5 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center gap-2 font-semibold border-t border-slate-800/80"
              >
                <Activity className="w-4 h-4 text-amber-400" />
                <span>Process & Locks (进程与锁监控)</span>
              </div>
            </div>
          )}


          {activeConn?.env_tag === 'PROD' && (
            <div className="flex items-center gap-1 text-[11px] font-bold text-red-300 bg-red-900/60 px-2 py-0.5 rounded border border-red-700/60 animate-pulse">
              <AlertTriangle className="w-3.5 h-3.5" />
              PRODUCTION ENVIRONMENT
            </div>
          )}
        </div>

        {/* Header Right Actions */}
        <div className="flex items-center gap-2 text-xs app-no-drag">

          <button
            onClick={() => handleExecute()}
            disabled={isExecuting}
            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium flex items-center gap-1.5 shadow-sm disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            Run (Cmd+Enter)
          </button>

          <button
            onClick={() => setIsCliConsoleOpen(true)}
            className="px-2.5 py-1 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 rounded text-emerald-300 flex items-center gap-1.5 font-bold shadow-sm transition-all"
            title="开启 100% 离线原生 PostgreSQL CLI 交互终端 (psql 控制台)"
          >
            <Terminal className="w-3.5 h-3.5 text-emerald-400" />
            <span>CLI 终端</span>
          </button>

          <button
            onClick={() => setIsSavedSqlOpen(true)}
            className="px-2.5 py-1 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 rounded text-amber-300 flex items-center gap-1.5 font-bold shadow-sm transition-all"
            title="查看与管理当前连接专属的已存 SQL 脚本库"
          >
            <Bookmark className="w-3.5 h-3.5 text-amber-400 fill-amber-400/20" />
            <span>已存 SQL 库</span>
          </button>

          <button
            onClick={() => setIsProcessModalOpen(true)}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-300 flex items-center gap-1 font-semibold"
            title="Database Process & Lock Inspector"
          >
            <Activity className="w-3.5 h-3.5 text-emerald-400" />
            <span>Process List</span>
          </button>

          <button
            onClick={() => setIsExportOpen(true)}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-300 flex items-center gap-1 font-semibold"
            title="Export Data Wizard"
          >
            <Download className="w-3.5 h-3.5 text-blue-400" />
            <span>Export</span>
          </button>

          <button
            onClick={() => {
              setTempAiConfig(aiConfig);
              setIsSettingsOpen(true);
            }}
            className="p-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-300"
            title="AI Provider Settings"
          >
            <Settings className="w-4 h-4" />
          </button>

          <button
            onClick={() => setIsAiSidebarOpen(!isAiSidebarOpen)}
            className="p-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-300"
          >
            {isAiSidebarOpen ? <SidebarClose className="w-4 h-4" /> : <SidebarOpen className="w-4 h-4" />}
          </button>
        </div>

      </header>

      {/* Error Alert Banner */}
      {errorMsg && (
        <div className="bg-red-900/80 border-b border-red-700 text-red-200 px-4 py-1.5 text-xs flex justify-between items-center">
          <span>⚠️ {errorMsg}</span>
          <button onClick={() => useAppStore.setState({ errorMsg: null })}>✕</button>
        </div>
      )}

      {/* Main Workspace Layout (全自由 0-100% 拖拽编排) */}
      <div className="flex-1 overflow-hidden">
        <Group orientation="horizontal">
          {/* Left Pane: Schema Tree Explorer */}
          <Panel defaultSize={20} minSize={0}>
            <SchemaTree
              key={`${activeConnId}_${activeDatabase}`}
              connId={activeConnId || ''}
              database={activeDatabase || activeConn?.database}
              selectedTable={designerTable}
              onSelectTable={(tbl) => {
                setDesignerTable(tbl);
                setSqlText(`SELECT * FROM "${tbl}" LIMIT 100;`);
                runQuery(`SELECT * FROM "${tbl}" LIMIT 100;`);
              }}
              onDesignTable={(tbl) => {
                setDesignerTable(tbl);
                setIsDesignerOpen(true);
              }}
              onExportTable={(tbl) => {
                setDesignerTable(tbl);
                setExportMode('data');
                setIsExportOpen(true);
              }}
              onExportDdl={(tbl) => {
                setDesignerTable(tbl);
                setExportMode('ddl');
                setIsExportOpen(true);
              }}
            />



          </Panel>

          <Separator className="w-1.5 bg-slate-800 hover:bg-blue-500 transition-colors cursor-col-resize flex items-center justify-center" />

          {/* Center Pane: Monaco SQL Editor + Data Grid Split Pane */}
          <Panel defaultSize={55} minSize={0}>
            <Group orientation="vertical">
              {/* Top Half: Monaco SQL Editor */}
              <Panel defaultSize={45} minSize={0}>
                <div className="h-full p-2">
                  <SqlEditor
                    value={sqlText}
                    onChange={(val) => setSqlText(val)}
                    onExecute={handleExecute}
                  />
                </div>
              </Panel>

              <Separator className="h-1.5 bg-slate-800 hover:bg-blue-500 transition-colors cursor-row-resize flex items-center justify-center" />

              {/* Bottom Half: Data Grid Results */}
              <Panel defaultSize={55} minSize={0}>
                <div className="h-full p-2">
                  <DataGrid
                    result={queryResult}
                    resultTabs={resultTabs}
                    activeTabId={activeResultTabId}
                    onSelectTab={(tabId) => {
                      setActiveResultTabId(tabId);
                      const targetTab = resultTabs.find((t) => t.id === tabId);
                      if (targetTab) {
                        if (targetTab.result) {
                          useAppStore.setState({ queryResult: targetTab.result, errorMsg: null });
                        } else if (targetTab.error) {
                          useAppStore.setState({ queryResult: null, errorMsg: targetTab.error });
                        }
                      }
                    }}
                    isExecuting={isExecuting}
                    tableName={designerTable || 'table'}
                    onCommitChanges={async ({ edits, addedRows, deletedRowIndices }) => {
                      if (!queryResult || !activeConnId) return;

                      // 尝试定位表名 (从 sqlText 中正则匹配 SELECT ... FROM "tableName" 或 tableName)
                      const fromMatch = sqlText.match(/FROM\s+["`']?([a-zA-Z0-9_.]+ Vacation|["`']?[a-zA-Z0-9_.]+)["`']?/i) || sqlText.match(/FROM\s+["`']?([a-zA-Z0-9_]+)/i);
                      let targetTable = fromMatch ? fromMatch[1].replace(/["`']/g, '') : null;
                      if (!targetTable || targetTable.toLowerCase() === 'dual') {
                        targetTable = designerTable;
                      }

                      if (!targetTable) {
                        alert('无法从当前查询或选中数据集中自动匹配目标数据表，请确认查询语句包含 FROM 对应数据表。');
                        return;
                      }

                      // 寻找主键列 (默认为 id 列，或第一列)
                      const pkCol = queryResult.columns.find((c) => c.name.toLowerCase() === 'id') || queryResult.columns[0];
                      if (!pkCol) {
                        alert('未检测到唯一标识列 (如 id)，无法生成精确的回写 SQL。');
                        return;
                      }

                      // 安全脱敏辅助工具：转义表名/列名中的双引号，防止 SQL 注入
                      const sanitizeIdentifier = (name: string) => name.replace(/"/g, '""');
                      const escapeSqlString = (str: string) => str.replace(/'/g, "''");

                      const cleanTable = sanitizeIdentifier(targetTable);
                      const cleanPkCol = sanitizeIdentifier(pkCol.name);

                      const sqlStatements: string[] = [];

                      // 1. 处理删除行 (DELETE FROM "tbl" WHERE "id" = val)
                      deletedRowIndices.forEach((rIdx) => {
                        const row = queryResult.rows[rIdx];
                        if (row) {
                          const pkCell = row.find((_, cIdx) => queryResult.columns[cIdx]?.name === pkCol.name);
                          if (pkCell) {
                            const val = typeof pkCell.val === 'number' ? pkCell.val : `'${escapeSqlString(String(pkCell.val))}'`;
                            sqlStatements.push(`DELETE FROM "${cleanTable}" WHERE "${cleanPkCol}" = ${val};`);
                          }
                        }
                      });

                      // 2. 处理修改行 (UPDATE "tbl" SET ... WHERE "id" = val)
                      const editedRowIndices = new Set<number>();
                      Object.keys(edits).forEach((key) => {
                        const [rIdxStr] = key.split('_');
                        editedRowIndices.add(parseInt(rIdxStr, 10));
                      });

                      editedRowIndices.forEach((rIdx) => {
                        if (deletedRowIndices.includes(rIdx)) return; // 标记删除的不再 UPDATE
                        const row = queryResult.rows[rIdx];
                        if (!row) return;

                        const pkCell = row.find((_, cIdx) => queryResult.columns[cIdx]?.name === pkCol.name);
                        if (!pkCell) return;

                        const setClauses: string[] = [];
                        queryResult.columns.forEach((col) => {
                          const key = `${rIdx}_${col.name}`;
                          if (key in edits) {
                            const newVal = edits[key];
                            const formattedVal = newVal === 'NULL' ? 'NULL' : `'${escapeSqlString(newVal)}'`;
                            setClauses.push(`"${sanitizeIdentifier(col.name)}" = ${formattedVal}`);
                          }
                        });

                        if (setClauses.length > 0) {
                          const pkVal = typeof pkCell.val === 'number' ? pkCell.val : `'${escapeSqlString(String(pkCell.val))}'`;
                          sqlStatements.push(`UPDATE "${cleanTable}" SET ${setClauses.join(', ')} WHERE "${cleanPkCol}" = ${pkVal};`);
                        }
                      });

                      // 3. 处理新增行 (INSERT INTO "tbl" (...) VALUES (...))
                      addedRows.forEach((rowMap) => {
                        const cols: string[] = [];
                        const vals: string[] = [];
                        Object.entries(rowMap).forEach(([colName, val]) => {
                          if (val !== undefined && val !== '') {
                            cols.push(`"${sanitizeIdentifier(colName)}"`);
                            vals.push(`'${escapeSqlString(val)}'`);
                          }
                        });
                        if (cols.length > 0) {
                          sqlStatements.push(`INSERT INTO "${cleanTable}" (${cols.join(', ')}) VALUES (${vals.join(', ')});`);
                        }
                      });

                      if (sqlStatements.length > 0) {
                        try {
                          for (const stmt of sqlStatements) {
                            await runQuery(stmt);
                          }
                          alert(`成功将 ${sqlStatements.length} 条变更写入数据库！`);
                          await runQuery(sqlText);
                        } catch (err: any) {
                          alert(`数据库执行变更失败: ${err.message || String(err)}`);
                        }
                      }
                    }}
                  />
                </div>
              </Panel>
            </Group>
          </Panel>

          {/* Right Pane: AI Copilot Sidebar */}
          {isAiSidebarOpen && (
            <>
              <Separator className="w-1.5 bg-slate-800 hover:bg-blue-500 transition-colors cursor-col-resize flex items-center justify-center" />
              <Panel defaultSize={25} minSize={0}>
                <AiSidebar
                  onInsertSql={(sql) => setSqlText(sql)}
                  currentSql={sqlText}
                  currentError={errorMsg}
                  activeDatabase={activeDatabase || activeConn?.database}
                />
              </Panel>
            </>
          )}
        </Group>
      </div>





      {/* Process & Lock Inspector Modal */}
      <ProcessListModal
        isOpen={isProcessModalOpen}
        connId={activeConnId || ''}
        onClose={() => setIsProcessModalOpen(false)}
      />

      {/* Table Designer Modal */}
      <TableDesignerModal
        isOpen={isDesignerOpen}
        tableName={designerTable}
        onClose={() => setIsDesignerOpen(false)}
      />

      {/* Export Wizard Modal (支持数据与 DDL 粒子轨迹方程导出) */}
      <ExportWizardModal
        isOpen={isExportOpen}
        connId={activeConnId || ''}
        tableName={designerTable || 'user'}
        queryResult={queryResult}
        initialMode={exportMode}
        onClose={() => setIsExportOpen(false)}
      />

      {/* Database User & Role Privileges Management Center */}
      {/* User Management & ACL Privileges Modal */}
      <UserManagementModal
        isOpen={isUserMgmtOpen}
        connId={activeConnId || ''}
        connName={activeConn?.name || ''}
        onClose={() => setIsUserMgmtOpen(false)}
      />

      {/* Saved SQL Snippet Manager Modal */}
      <SavedSqlModal
        isOpen={isSavedSqlOpen}
        connId={activeConnId || ''}
        connName={activeConn?.name || ''}
        activeDatabase={activeDatabase || activeConn?.database}
        currentSql={sqlText}
        onClose={() => setIsSavedSqlOpen(false)}
        onOpenSql={(sql, mode) => {
          if (mode === 'replace') {
            setSqlText(sql);
          } else if (mode === 'append') {
            setSqlText((prev) => (prev && prev.trim() ? `${prev.trim()}\n\n${sql}` : sql));
          } else if (mode === 'run') {
            // 直接执行，不破坏主编辑区正在编写的代码
            handleExecute(sql);
          }
        }}
      />

      {/* 100% 离线内置原生 PostgreSQL CLI 交互控制台 */}
      <CliConsoleModal
        isOpen={isCliConsoleOpen}
        connId={activeConnId || ''}
        connName={activeConn?.name || ''}
        activeDatabase={activeDatabase || activeConn?.database}
        user={activeConn?.user || 'postgres'}
        onClose={() => setIsCliConsoleOpen(false)}
        onApplySqlToEditor={(sql) => {
          setSqlText(sql);
        }}
      />







      {/* Footer Bar */}
      <footer className="h-6 bg-slate-950 border-t border-slate-800 px-3 flex justify-between items-center text-[10px] text-slate-500">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-slate-400">
            <UserCheck className="w-3 h-3 text-emerald-400" />
            User: Alex (Unlocked)
          </span>
          <span>Vault: AES-256 Encrypted</span>
        </div>
        <div>AIDB Desk v2.0 (Open Source Edition)</div>
      </footer>

      {/* Connection Modal */}
      <ConnectionModal
        isOpen={isConnModalOpen}
        editingConfig={editingConn}
        onClose={() => {
          setIsConnModalOpen(false);
          setEditingConn(null);
        }}
        onSave={handleSaveConnection}
      />

      {/* Settings Modal (Custom AI BaseURL Config) */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md p-5 text-slate-200 text-xs space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <span className="font-semibold text-sm text-white flex items-center gap-2">
                <Server className="w-4 h-4 text-amber-500" />
                AI Provider Configuration (Rig Engine)
              </span>
              <button onClick={() => setIsSettingsOpen(false)}>✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-slate-400 mb-1">Provider Name</label>
                <input
                  type="text"
                  value={tempAiConfig.provider_name}
                  onChange={(e) => setTempAiConfig({ ...tempAiConfig, provider_name: e.target.value })}
                  className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-slate-100"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Custom BaseURL</label>
                <input
                  type="text"
                  value={tempAiConfig.base_url}
                  onChange={(e) => setTempAiConfig({ ...tempAiConfig, base_url: e.target.value })}
                  placeholder="https://api.openai.com/v1 or http://localhost:11434/v1"
                  className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-slate-100"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">API Key</label>
                <input
                  type="password"
                  value={tempAiConfig.api_key}
                  onChange={(e) => setTempAiConfig({ ...tempAiConfig, api_key: e.target.value })}
                  placeholder="sk-..."
                  className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-slate-100"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Model Name</label>
                <input
                  type="text"
                  value={tempAiConfig.model_name}
                  onChange={(e) => setTempAiConfig({ ...tempAiConfig, model_name: e.target.value })}
                  placeholder="gpt-4o-mini, deepseek-coder, llama3"
                  className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-slate-100"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-300"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await setAiConfig(tempAiConfig);
                  setIsSettingsOpen(false);
                }}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium"
              >
                Save AI Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
