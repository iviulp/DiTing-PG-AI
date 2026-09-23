import React, { useState, useEffect } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { explainPgError } from './utils/pgErrorHints';
import { ShortcutsHelpModal } from './components/ShortcutsHelpModal';
import { FilterBuilder, ColumnMetaLite } from './components/FilterBuilder';
import { getTableColumnsMetaData } from './services/ipc';
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
import { SafetyConfirmDialog } from './components/SafetyConfirmDialog';


import { ConnectionConfig } from './types';
import { executeSql, executeSqlWithGuard, onTunnelDisconnected, vaultConnectDb, vaultUpsertConnection, errToStr } from './services/ipc';
import { mapTunnelError } from './utils/tunnelError';
import { showAlert } from './services/appDialog';
import {
  quoteIdentifier,
  sanitizeIdentifier,
  escapeSqlLiteral
} from './utils/sqlEscape';
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
    setAiConfig,
    pendingSafetyConfirm,
    resolveSafetyConfirm,
    paging,
    browseTable,
    runQueryPaged,
    pagingSetFilters,
    clearPaging
  } = useAppStore();

  const [inWorkspace, setInWorkspace] = useState(false);
  const [sqlText, setSqlText] = useState("SELECT 1 AS status, 'Welcome to AIDB Desk' AS message;");
  const [isConnModalOpen, setIsConnModalOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<ConnectionConfig | null>(null);
  const [isAiSidebarOpen, setIsAiSidebarOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSavedSqlOpen, setIsSavedSqlOpen] = useState(false);
  const [isCliConsoleOpen, setIsCliConsoleOpen] = useState(false);
  // WP9-P2-9: 快捷键与功能速查表
  const [isShortcutsHelpOpen, setIsShortcutsHelpOpen] = useState(false);
  // WP10: 过滤构建器 (浏览表模式)
  const [isFilterBuilderOpen, setIsFilterBuilderOpen] = useState(false);
  const [browseColumns, setBrowseColumns] = useState<ColumnMetaLite[]>([]);
  const [tempAiConfig, setTempAiConfig] = useState(aiConfig);

  // New Management Modals State
  const [isProcessModalOpen, setIsProcessModalOpen] = useState(false);
  const [isDesignerOpen, setIsDesignerOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isUserMgmtOpen, setIsUserMgmtOpen] = useState(false);
  const [exportMode, setExportMode] = useState<'data' | 'ddl'>('data');
  const [headerContextMenu, setHeaderContextMenu] = useState<{ x: number; y: number } | null>(null);

  const [designerTable, setDesignerTable] = useState('users');

  // WP9-P1-9: 面板布局持久化 (react-resizable-panels v4 useDefaultLayout + localStorage)
  const mainLayout = useDefaultLayout({ id: 'aidb-main-h', storage: localStorage });
  const centerLayout = useDefaultLayout({ id: 'aidb-center-v', storage: localStorage });

  // WP9-P1-1: 全局快捷键 (抽取为可测 hook: Esc 关最上层弹窗 / Cmd+B 切 AI 侧栏 / Cmd+R 执行 SQL)
  useGlobalShortcuts({
    modals: [
      { isOpen: isFilterBuilderOpen, close: () => setIsFilterBuilderOpen(false) },
      { isOpen: isShortcutsHelpOpen, close: () => setIsShortcutsHelpOpen(false) },
      { isOpen: isUserMgmtOpen, close: () => setIsUserMgmtOpen(false) },
      { isOpen: isProcessModalOpen, close: () => setIsProcessModalOpen(false) },
      { isOpen: isDesignerOpen, close: () => setIsDesignerOpen(false) },
      { isOpen: isExportOpen, close: () => setIsExportOpen(false) },
      { isOpen: isSavedSqlOpen, close: () => setIsSavedSqlOpen(false) },
      { isOpen: isCliConsoleOpen, close: () => setIsCliConsoleOpen(false) },
      { isOpen: isSettingsOpen, close: () => setIsSettingsOpen(false) },
      { isOpen: isConnModalOpen, close: () => setIsConnModalOpen(false) },
    ],
    onExecute: (selectedSql?: string) => handleExecuteRef.current?.(selectedSql),
    onToggleAiSidebar: () => setIsAiSidebarOpen((v) => !v),
    // WP10: Cmd+←/→ 翻页 (分页模式且非加载态才处理; 返回 false 让 hook 不 preventDefault)
    onPage: (delta) => {
      const p = useAppStore.getState().paging;
      if (!p || p.loading) return false;
      const goto = useAppStore.getState().pagingGotoPage;
      goto(Math.max(1, p.page + delta));
      return true;
    },
  });

  // ref 同步: 每次 render 指向最新 handleExecute (定义在其下方, 但 effect 在 render 后执行故安全)
  useEffect(() => {
    handleExecuteRef.current = handleExecute;
  });



  // WP6: 启动引导 — localStorage 迁移 + 从 vault 拉取脱敏连接列表
  useEffect(() => {
    useAppStore.getState().bootstrapVaultData();
  }, []);

  useEffect(() => {
    loadAiConfig();
  }, [loadAiConfig]);

  // WP3: 监听隧道被动断开事件 → 显示断开角标 (重连成功后清除)
  const [tunnelDownConns, setTunnelDownConns] = useState<string[]>([]);
  useEffect(() => {
    const unlisten = onTunnelDisconnected((connId) => {
      setTunnelDownConns((prev) => (prev.includes(connId) ? prev : [...prev, connId]));
    });
    return unlisten;
  }, []);

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
      // WP6-S6: conn_id 寻址, 后端从 vault 取真实密码
      await vaultConnectDb(conn.id);
      useAppStore.setState({ errorMsg: null, queryResult: null });
      setInWorkspace(true);
      // WP3: 重连成功 → 清除隧道断开角标
      setTunnelDownConns((prev) => prev.filter((id) => id !== conn.id));
      await fetchDatabases(conn);
    } catch (err: any) {
      const rawMsg = errToStr(err);
      // WP3: 隧道错误码 → 友好中文文案 (code 形如 TUNNEL_AUTH_FAILED: xxx)
      const tunnelCodeMatch = rawMsg.match(/TUNNEL_[A-Z_]+/);
      const displayMsg = tunnelCodeMatch
        ? mapTunnelError(tunnelCodeMatch[0], rawMsg)
        : rawMsg;
      useAppStore.setState({
        errorMsg: `Failed to open connection "${conn.name}": ${displayMsg}`
      });
      showAlert(`数据库连接拒绝 (FATAL Error)：\n无法建立到 "${conn.name}" 的连接。\n原因：${displayMsg}`, { title: '连接失败', danger: true });
      throw err;
    }
  };

  const handleSwitchDatabase = async (newDb: string) => {
    if (!activeConn || newDb === activeDatabase) return;
    try {
      const updatedConfig = { ...activeConn, database: newDb };
      // WP6: 先加密落盘新 database, 再按 conn_id 重连 (密码不经前端)
      await vaultUpsertConnection(updatedConfig);
      await vaultConnectDb(updatedConfig.id);
      setActiveDatabase(newDb);
      await updateConnection(updatedConfig);
    } catch (err: any) {
      showAlert(`切换数据库到 [${newDb}] 失败：\n${errToStr(err)}`, { title: '切换失败', danger: true });
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

  // WP9-P1-1: 快捷键层通过 ref 调用最新 handleExecute (避免 effect 依赖爆炸)
  const handleExecuteRef = React.useRef<((selectedSql?: string) => Promise<void>) | null>(null);
  const handleExecute = async (selectedSql?: string) => {
    // 优先获取选中的 SQL；若未选中，则取主编辑区全部文本
    const sourceSql = (selectedSql !== undefined ? selectedSql : sqlText).trim();
    
    // 剥离全部注释
    const cleanSql = stripSqlComments(sourceSql);

    if (!cleanSql) {
      showAlert('当前有效 SQL 内容为空（或全为注释代码），请输入有效 SQL 语句后再执行！');
      return;
    }
    if (!activeConnId) return;

    // WP1: Critical 高危 SQL 通过全局确认框征得用户批准 (安全判定以后端为准)
    const confirmCritical = (payload: import('./types').SafetyBlockedPayload) =>
      new Promise<boolean>((resolve) => {
        useAppStore.setState({
          pendingSafetyConfirm: { connId: activeConnId, sql: cleanSql, payload, resolve }
        });
      });

    // 按分号 split 解析出多条独立的有效 SQL 语句
    const sqlStatements = cleanSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (sqlStatements.length === 0) return;

    if (sqlStatements.length === 1) {
      // 只有一条语句：按单查询流程执行并直接刷新主 DataGrid (runQuery 内部已带 guard)
      setResultTabs([]);
      setActiveResultTabId('');
      // WP10-D2 (用户拍板): 手写单条 SELECT 也自动分页 —
      // buildHandwrittenPaging 判定支持则走分页通道 (COUNT+LIMIT/OFFSET);
      // 不支持 (写操作/多语句/FOR UPDATE) 内部自动回退 runQuery, 原因已 console 明示
      const stmt = sqlStatements[0];
      const head = stmt.trim().toUpperCase();
      if (head.startsWith('SELECT') || head.startsWith('WITH')) {
        runQueryPaged(stmt);
      } else {
        clearPaging(); // 写操作退出分页模式
        runQuery(stmt);
      }
    } else {
      // 包含多条语句：逐条拆分执行并构建 Result Tabs 选项卡
      clearPaging(); // WP10: 多语句不分页, 退出分页模式
      useAppStore.setState({ isExecuting: true, errorMsg: null });
      const newTabs: import('./types').QueryResultTabItem[] = [];

      for (let i = 0; i < sqlStatements.length; i++) {
        const stmt = sqlStatements[i];
        // 抽取表名作为选项卡标题
        const fromMatch = stmt.match(/FROM\s+["`']?([a-zA-Z0-9_]+)["`']?/i);
        const titleName = fromMatch ? fromMatch[1] : `Query #${i + 1}`;

        try {
          const res = await executeSqlWithGuard(activeConnId, stmt, confirmCritical);
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
            error: errToStr(err)
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
    // WP6: addConnection/updateConnection 内部已 vaultConnectDb 刷新注册池 (含 read_only)
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
                    value={tempAiConfig.api_key === '__KEEP__' ? '' : tempAiConfig.api_key}
                    onChange={(e) => setTempAiConfig({ ...tempAiConfig, api_key: e.target.value })}
                    placeholder={tempAiConfig.key_tail4 ? `已保存 (****${tempAiConfig.key_tail4})，留空则不修改` : 'sk-...'}
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
            {/* WP3: 隧道断开角标 */}
            {activeConn && tunnelDownConns.includes(activeConn.id) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // WP9-P1-8: 一键重连 — 复用完整连接流程 (重建 SSH 隧道 + DB 连接)
                  handleSelectConnection(activeConn);
                }}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/15 border border-red-500/40 text-red-400 text-[10px] font-bold hover:bg-red-500/30 hover:text-red-300 transition-colors cursor-pointer"
                title="SSH 隧道已断开 — 点击一键重连"
                data-testid="tunnel-reconnect"
              >
                ⟳ 隧道断开·点击重连
              </button>
            )}
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

          {/* WP9-P2-9: 快捷键与功能速查表 */}
          <button
            onClick={() => setIsShortcutsHelpOpen(true)}
            className="p-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-300"
            title="快捷键与功能速查 (?)"
            data-testid="shortcuts-help-btn"
          >
            <span className="text-xs font-bold leading-none">?</span>
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
        <div className="bg-red-900/80 border-b border-red-700 text-red-200 px-4 py-1.5 text-xs flex justify-between items-center gap-3">
          <span className="truncate font-mono" title={explainPgError(errorMsg) ? `${errorMsg}\n\n💡 ${explainPgError(errorMsg)!.explain} ${explainPgError(errorMsg)!.suggestion}` : errorMsg}>
            ⚠️ {errorMsg}
            {explainPgError(errorMsg) && (
              <span className="ml-2 text-red-300/80 font-sans" data-testid="banner-error-hint">💡 {explainPgError(errorMsg)!.explain}</span>
            )}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {/* WP9-P2-5: 闭环入口 — 打开 AI 侧栏 (侧栏内 currentError 驱动"一键修复此错误") */}
            <button
              onClick={() => setIsAiSidebarOpen(true)}
              className="px-2 py-0.5 bg-red-700/60 hover:bg-red-600 rounded text-[10px] font-bold text-red-100 border border-red-500/50 transition-colors"
              data-testid="ai-explain-error"
              title="打开 AI 侧栏分析并修复此错误"
            >
              🤖 让 AI 解释此错误
            </button>
            <button onClick={() => useAppStore.setState({ errorMsg: null })}>✕</button>
          </div>
        </div>
      )}

      {/* Main Workspace Layout (全自由 0-100% 拖拽编排) */}
      <div className="flex-1 overflow-hidden">
        <Group
          orientation="horizontal"
          defaultLayout={mainLayout.defaultLayout}
          onLayoutChanged={mainLayout.onLayoutChanged}
        >
          {/* Left Pane: Schema Tree Explorer */}
          <Panel defaultSize={20} minSize={0}>
            <SchemaTree
              key={`${activeConnId}_${activeDatabase}`}
              connId={activeConnId || ''}
              database={activeDatabase || activeConn?.database}
              selectedTable={designerTable}
              onSelectTable={(tbl) => {
                setDesignerTable(tbl);
                // WP10: 单击表 → 浏览表模式 (估算→COUNT→第1页, 翻页自动发 SQL)
                const [schema, table] = tbl.includes('.')
                  ? [tbl.split('.')[0], tbl.split('.').slice(1).join('.')]
                  : ['public', tbl];
                setSqlText(`SELECT * FROM ${tbl.includes('.') ? tbl.split('.').map((seg) => quoteIdentifier(seg)).join('.') : quoteIdentifier(tbl)} LIMIT 100;`);
                browseTable(schema, table);
                // 列元数据异步带出 (FilterBuilder 列名下拉用)
                getTableColumnsMetaData(activeConnId || '', table, schema)
                  .then((cols) => setBrowseColumns((cols || []).map((c: any) => ({
                    column_name: c.column_name ?? String(c[0]?.val ?? ''),
                    data_type: c.data_type ?? String(c[1]?.val ?? ''),
                    column_comment: c.column_comment ?? (c[3]?.val ?? null),
                  }))))
                  .catch(() => setBrowseColumns([])); // 元数据失败 → FilterBuilder 内明示, 不假数据
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
            <Group
              orientation="vertical"
              defaultLayout={centerLayout.defaultLayout}
              onLayoutChanged={centerLayout.onLayoutChanged}
            >
              {/* Top Half: Monaco SQL Editor */}
              <Panel defaultSize={45} minSize={0}>
                <div className="h-full w-full bg-[#111318]">
                  <SqlEditor
                    value={sqlText}
                    onChange={(val) => setSqlText(val)}
                    onExecute={handleExecute}
                  />
                </div>
              </Panel>

              <Separator className="h-1 bg-[#1c202a] hover:bg-blue-500 transition-colors cursor-row-resize flex items-center justify-center" />

              {/* Bottom Half: Data Grid Results */}
              <Panel defaultSize={55} minSize={0}>
                <div className="h-full w-full bg-[#0d0f14]">
                  <DataGrid
                    result={queryResult}
                    error={errorMsg}
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
                    onOpenFilter={() => setIsFilterBuilderOpen(true)}
                    onCommitChanges={async ({ edits, addedRows, deletedRowIndices }) => {
                      if (!queryResult || !activeConnId) return;

                      // 尝试定位表名 (从 sqlText 中正则匹配 SELECT ... FROM "tableName" 或 tableName)
                      const fromMatch = sqlText.match(/FROM\s+["`']?([a-zA-Z0-9_.]+)["`']?/i);
                      let targetTable = fromMatch ? fromMatch[1].replace(/["`']/g, '') : null;
                      if (!targetTable || targetTable.toLowerCase() === 'dual') {
                        targetTable = designerTable;
                      }

                      if (!targetTable) {
                        showAlert('无法从当前查询或选中数据集中自动匹配目标数据表，请确认查询语句包含 FROM 对应数据表。');
                        return;
                      }

                      // 寻找主键列 (默认为 id 列，或第一列)
                      const pkCol = queryResult.columns.find((c) => c.name.toLowerCase() === 'id') || queryResult.columns[0];
                      if (!pkCol) {
                        showAlert('未检测到唯一标识列 (如 id)，无法生成精确的回写 SQL。');
                        return;
                      }

                      // WP4 步骤5: 删除局部转义函数, 统一使用 src/utils/sqlEscape.ts (含控制字符拒绝)
                      let cleanTable: string;
                      try {
                        cleanTable = sanitizeIdentifier(targetTable);
                      } catch (e: any) {
                        showAlert(`目标表名含非法字符, 无法生成回写 SQL: ${errToStr(e)}`, { title: 'SQL 生成失败', danger: true });
                        return;
                      }
                      const cleanPkCol = sanitizeIdentifier(pkCol.name);
                      // 值转义: 数字须为有限数 (排除 NaN/Infinity), 否则走字符串转义路径
                      const sqlVal = (v: unknown): string =>
                        typeof v === 'number' && Number.isFinite(v)
                          ? String(v)
                          : `'${escapeSqlLiteral(String(v))}'`;

                      const sqlStatements: string[] = [];
                      // WP4 会议八 P1: 值含控制字符被 escapeSqlLiteral 拒绝时 → 提示且不丢编辑态
                      try {
                      // 1. 处理删除行 (DELETE FROM "tbl" WHERE "id" = val)
                      deletedRowIndices.forEach((rIdx) => {
                        const row = queryResult.rows[rIdx];
                        if (row) {
                          const pkCell = row.find((_, cIdx) => queryResult.columns[cIdx]?.name === pkCol.name);
                          if (pkCell) {
                            const val = sqlVal(pkCell.val);
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
                            const formattedVal = newVal === 'NULL' ? 'NULL' : sqlVal(newVal);
                            setClauses.push(`"${sanitizeIdentifier(col.name)}" = ${formattedVal}`);
                          }
                        });

                        if (setClauses.length > 0) {
                          const pkVal = sqlVal(pkCell.val);
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
                            vals.push(sqlVal(val));
                          }
                        });
                        if (cols.length > 0) {
                          sqlStatements.push(`INSERT INTO "${cleanTable}" (${cols.join(', ')}) VALUES (${vals.join(', ')});`);
                        }
                      });
                      } catch (e: any) {
                        showAlert(`变更值含非法字符, 未生成回写 SQL (编辑内容已保留): ${errToStr(e)}`, { title: 'SQL 生成失败', danger: true });
                        return;
                      }

                      if (sqlStatements.length > 0) {
                        try {
                          for (const stmt of sqlStatements) {
                            await runQuery(stmt);
                          }
                          showAlert(`成功将 ${sqlStatements.length} 条变更写入数据库！`, { title: '写入成功' });
                          await runQuery(sqlText);
                        } catch (err: any) {
                          showAlert(`数据库执行变更失败: ${errToStr(err)}`, { title: '执行失败', danger: true });
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
                  onExecuteSql={(sql) => handleExecute(sql)}
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
                  value={tempAiConfig.api_key === '__KEEP__' ? '' : tempAiConfig.api_key}
                  onChange={(e) => setTempAiConfig({ ...tempAiConfig, api_key: e.target.value })}
                  placeholder={tempAiConfig.key_tail4 ? `已保存 (****${tempAiConfig.key_tail4})，留空则不修改` : 'sk-...'}
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

      {/* WP1: 全局 Critical 高危 SQL 二次确认对话框 */}
      {pendingSafetyConfirm && (
        <SafetyConfirmDialog
          payload={pendingSafetyConfirm.payload}
          sql={pendingSafetyConfirm.sql}
          connName={connections.find((c) => c.id === pendingSafetyConfirm.connId)?.name}
          envTag={connections.find((c) => c.id === pendingSafetyConfirm.connId)?.env_tag}
          onApprove={() => resolveSafetyConfirm(true)}
          onReject={() => resolveSafetyConfirm(false)}
        />
      )}
      {/* WP9-P2-9: 快捷键与功能速查表 */}
      <ShortcutsHelpModal isOpen={isShortcutsHelpOpen} onClose={() => setIsShortcutsHelpOpen(false)} />

      {/* WP10: 可视化过滤构建器 (浏览表模式, 列名自动带出) */}
      {paging?.mode === 'table' && (
        <FilterBuilder
          isOpen={isFilterBuilderOpen}
          onClose={() => setIsFilterBuilderOpen(false)}
          columns={browseColumns}
          initialFilters={paging.filters}
          initialCombinator={paging.combinator}
          onApply={(filters, combinator) => { pagingSetFilters(filters, combinator); }}
        />
      )}
    </div>
  );
};

export default App;
