import React, { useState, useEffect } from 'react';
import { ConnectionConfig } from '../types';
import { Key, Plus, Edit3, Copy, Trash2, ShieldCheck, Sparkles, ChevronRight, Zap, Search, LayoutGrid, List, Download, Upload } from 'lucide-react';
import { exportEncryptedBundle, importEncryptedBundle } from '../services/ipc';
import { useAppStore } from '../store/useAppStore';

interface WelcomeScreenProps {
  connections: ConnectionConfig[];
  onSelectConnection: (conn: ConnectionConfig) => void;
  onNewConnection: () => void;
  onEditConnection: (conn: ConnectionConfig) => void;
  onDuplicateConnection: (conn: ConnectionConfig) => void;
  onDeleteConnection: (id: string) => void;
  onOpenAiSettings: () => void;
}


/**
 * 谛听 (DiTing Desk) 首创【神兽听音·星云盘罗盘 (Nebula Dock)】数据源选择器
 * 完全满足用户防呆要求：DEV 绿色水玻璃 / TEST 黄色水玻璃 / PROD 红色警示水玻璃与微风水波波纹！
 */
export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  connections,
  onSelectConnection,
  onNewConnection,
  onEditConnection,
  onDuplicateConnection,
  onDeleteConnection,
  onOpenAiSettings,
}) => {

  const [isEntering, setIsEntering] = useState(false);
  const [enteringConn, setEnteringConn] = useState<ConnectionConfig | null>(null);
  const [isExportingVault, setIsExportingVault] = useState(false);

  const { aiConfig, setAiConfig } = useAppStore();

  const handleExportVault = async () => {
    setIsExportingVault(true);
    try {
      const connsJson = JSON.stringify(connections);
      const savedSqlRaw = localStorage.getItem('diting_saved_sql_snippets') || '[]';

      // 备份包含：全量连接配置 + AI 参数 + 所有专属 SQL 脚本库
      const combinedAiConfigWithSnippets = JSON.stringify({
        ...aiConfig,
        _saved_sql_snippets: JSON.parse(savedSqlRaw),
      });

      const savedPath = await exportEncryptedBundle(connsJson, combinedAiConfigWithSnippets);
      alert(`🔐 全量配置已使用证书高强加密导出成功！\n\n文件保存路径：\n${savedPath}\n\n已加密包含：${connections.length} 个数据库连接配置 + AI Provider 密钥 + 所有已存 SQL 脚本库。`);
    } catch (err: any) {
      alert(`❌ 导出加密配置失败：${err.message || String(err)}`);
    } finally {
      setIsExportingVault(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const decrypted = await importEncryptedBundle(text);

      if (!decrypted || typeof decrypted !== 'object') {
        throw new Error('解密后的数据格式非法');
      }

      const importedConns = decrypted.connections as ConnectionConfig[];
      const importedAi = decrypted.ai_config;

      if (Array.isArray(importedConns) && importedConns.length > 0) {
        // 合并去重导入数据库连接
        const currentMap = new Map(connections.map((c) => [c.id, c]));
        importedConns.forEach((c) => currentMap.set(c.id, c));
        const mergedConns = Array.from(currentMap.values());
        localStorage.setItem('aidb_connections', JSON.stringify(mergedConns));
        useAppStore.setState({ connections: mergedConns });
      }

      if (importedAi && typeof importedAi === 'object') {
        const { _saved_sql_snippets, ...pureAiConfig } = importedAi;
        if (_saved_sql_snippets && Array.isArray(_saved_sql_snippets)) {
          // 合并已存 SQL 脚本库
          const currentSqlRaw = localStorage.getItem('diting_saved_sql_snippets');
          const currentSqls = currentSqlRaw ? JSON.parse(currentSqlRaw) : [];
          const snippetMap = new Map(currentSqls.map((s: any) => [s.id, s]));
          _saved_sql_snippets.forEach((s: any) => snippetMap.set(s.id, s));
          localStorage.setItem('diting_saved_sql_snippets', JSON.stringify(Array.from(snippetMap.values())));
        }
        await setAiConfig(pureAiConfig);
      }

      alert(`✅ 导入成功并已完成自动解密！\n\n已恢复 ${importedConns?.length || 0} 个数据库连接、AI 配置及绑定的已存 SQL 脚本库。`);
    } catch (err: any) {
      alert(`⛔ 导入失败：${err.message || String(err)}`);
    } finally {
      e.target.value = '';
    }
  };

  // 1. 海量数据源交互控制状态
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  // 动态收集所有已有的 Group 标签
  const allGroups = Array.from(
    new Set(connections.map((c) => c.group_name || '个人本地').concat(['PROD', 'TEST', 'DEV', 'SSH']))
  );

  // 过滤数据源列表
  const filteredConnections = connections.filter((conn) => {
    const matchesSearch =
      conn.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      conn.host.toLowerCase().includes(searchTerm.toLowerCase()) ||
      conn.database.toLowerCase().includes(searchTerm.toLowerCase());

    if (!matchesSearch) return false;

    if (selectedGroup === 'ALL') return true;
    if (selectedGroup === 'PROD') return conn.env_tag === 'PROD';
    if (selectedGroup === 'TEST') return conn.env_tag === 'TEST';
    if (selectedGroup === 'DEV') return conn.env_tag === 'DEV';
    if (selectedGroup === 'SSH') return conn.ssh_tunnel?.enabled;
    return (conn.group_name || '个人本地') === selectedGroup;
  });

  // 支持键盘上下键选择与 Enter 快速进入
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredConnections.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredConnections.length) % Math.max(1, filteredConnections.length));
      } else if (e.key === 'Enter' && filteredConnections[selectedIndex]) {
        e.preventDefault();
        handleEnterDb(filteredConnections[selectedIndex]);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('diting-search-input')?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredConnections, selectedIndex]);

  // 2. Liquid Glass 水玻璃水纹涟漪坐标状态
  const [ripplePos, setRipplePos] = useState<{ x: number; y: number } | null>(null);

  const handleEnterDb = async (conn: ConnectionConfig, event?: React.MouseEvent) => {
    if (event) {
      setRipplePos({
        x: event.clientX,
        y: event.clientY,
      });
    }
    setEnteringConn(conn);
    setIsEntering(true);
    setTimeout(async () => {
      try {
        await onSelectConnection(conn);
      } finally {
        setIsEntering(false);
        setEnteringConn(null);
      }
    }, 1100);
  };

  return (
    <div className="h-screen w-screen relative bg-[#060709] text-slate-100 select-none overflow-hidden font-sans flex flex-col justify-between">
      {/* macOS 顶级无缝透明拖拽区 */}
      <div className="h-10 w-full app-drag-region flex items-center justify-between px-4 z-50">
        <div className="text-[11px] font-mono text-slate-500 font-bold pl-16 flex items-center gap-1.5">
          <span>DiTing Desk · 谛听</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-amber-400 font-normal">
            {connections.length} 数据源
          </span>
        </div>
        <div className="app-no-drag flex items-center gap-2">
          <button
            onClick={onOpenAiSettings}
            className="px-3 py-1 bg-slate-900/80 hover:bg-slate-800 border border-slate-700/80 rounded-full text-[11px] text-amber-400 font-semibold flex items-center gap-1.5 backdrop-blur-md shadow-lg transition-all"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
            <span>设置 AI 引擎</span>
          </button>
        </div>
      </div>

      {/* 2. 背景 1:1 Gemini 经典梦幻湛蓝/天青色量子极光 (Blue Nebula Aurora) */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden flex items-center justify-center">
        <div className="absolute top-1/2 left-1/2 w-[850px] h-[850px] rounded-full bg-gradient-to-tr from-blue-600/35 via-cyan-500/25 to-indigo-600/30 animate-gemini-aurora" />
        <div className="absolute top-1/2 left-1/2 w-[600px] h-[600px] rounded-full bg-gradient-to-bl from-sky-400/30 via-emerald-500/15 to-blue-700/25 animate-gemini-aurora [animation-delay:-8s]" />
      </div>

      {/* 3. Liquid Glass 水玻璃水纹点击物理扩散层 (Water Ripple Effect) */}
      {ripplePos && isEntering && (
        <div
          className="fixed pointer-events-none z-40 animate-liquid-ripple bg-gradient-to-r from-blue-500/40 via-cyan-400/30 to-emerald-400/30 border border-cyan-300/50 shadow-2xl"
          style={{
            left: ripplePos.x - 150,
            top: ripplePos.y - 150,
            width: 300,
            height: 300,
          }}
        />
      )}

      {/* 4. 全屏 Liquid Glass 水玻璃物理沉浸式过场动画 */}
      {isEntering && (
        <div className="fixed inset-0 z-50 bg-[#060709]/80 backdrop-blur-3xl flex flex-col items-center justify-center space-y-6 transition-all duration-1000 animate-in fade-in zoom-in-95">
          <div className="relative">
            <div className="w-36 h-36 rounded-full border-2 border-cyan-400/50 border-t-blue-500 animate-spin shadow-[0_0_50px_rgba(59,130,246,0.5)]" />
            <img
              src="/diting_logo.png"
              alt="DiTing"
              className="w-24 h-24 rounded-full object-cover absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 shadow-2xl animate-pulse-glow"
            />
          </div>
          <div className="text-center space-y-2">
            <h3 className="text-xl font-black tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-cyan-200 via-blue-400 to-emerald-300">
              谛听神兽 · 听音入圣
            </h3>
            <p className="text-xs font-mono text-slate-300">
              正在物理解密与注入高能数据管道: <span className="text-amber-400 font-bold">{enteringConn?.name}</span>
            </p>
          </div>
        </div>
      )}

      {/* 4. 首页核心中心区域：谛听 Logo + 海量数据源星云控制台 (全自适应 flex 布局) */}
      <div className="flex-1 flex flex-col items-center justify-start relative z-10 px-6 pt-1 pb-4 max-w-6xl mx-auto w-full h-[calc(100vh-40px)] overflow-hidden">
        {/* 谛听 Logo Icon 容器 */}
        <div className="flex items-center gap-4 mb-2 shrink-0 cursor-pointer group">
          <div className="relative">
            <div className="absolute -inset-2 bg-gradient-to-r from-amber-500/30 via-emerald-500/30 to-purple-500/30 rounded-2xl blur-lg group-hover:opacity-100 opacity-70 transition-all duration-500" />
            <div className="w-12 h-12 relative rounded-2xl p-0.5 bg-gradient-to-tr from-amber-400 via-emerald-400 to-amber-200 shadow-xl">
              <img
                src="/diting_logo.png"
                alt="DiTing Divine Beast"
                className="w-full h-full object-cover rounded-[14px]"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-black tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-amber-100 via-amber-300 to-emerald-200 font-sans">
                谛 听 · DiTing PG AI
              </h1>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-400/30">
                PostgreSQL AI 专用版
              </span>
            </div>
            <p className="text-[11px] font-medium text-slate-400 tracking-wider flex items-center gap-1.5 mt-0.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>PostgreSQL 智能专家客户端 · 听音辨伪 · 洞察万物数据真相</span>
            </p>
          </div>
        </div>

        {/* 5. 海量数据源交互组件 (Nebula Connection Dock - 随窗口全自适应拉伸) */}
        <div className="w-full bg-[#11141a]/85 border border-slate-800/90 rounded-3xl p-5 backdrop-blur-2xl shadow-2xl flex flex-col flex-1 h-full min-h-0 overflow-hidden mb-2">
          {/* Top Control Bar: Search + Group Filters + View Mode + Add Button */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800/80 shrink-0">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[240px]">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-amber-400" />
              <input
                id="diting-search-input"
                type="text"
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setSelectedIndex(0);
                }}
                placeholder="搜索数据库名称、IP、数据库名... (⌘K / ⌘F)"
                className="w-full pl-9 pr-12 py-2 bg-slate-900/90 border border-slate-700/70 rounded-xl text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-500/80 shadow-inner"
              />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-mono font-bold text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">
                ⌘K
              </span>
            </div>

            {/* Filter Tags Group */}
            <div className="flex items-center gap-1.5 overflow-x-auto py-1 max-w-md">
              <button
                onClick={() => setSelectedGroup('ALL')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                  selectedGroup === 'ALL'
                    ? 'bg-amber-500 text-slate-950 shadow'
                    : 'bg-slate-900/80 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`}
              >
                全部 ({connections.length})
              </button>
              {allGroups.map((grp) => (
                <button
                  key={grp}
                  onClick={() => setSelectedGroup(grp)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all whitespace-nowrap ${
                    selectedGroup === grp
                      ? 'bg-amber-500 text-slate-950 font-bold shadow'
                      : 'bg-slate-900/80 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  {grp}
                </button>
              ))}
            </div>

            {/* View Switcher (Grid vs List) + Backup Export/Import + New Button */}
            <div className="flex items-center gap-2">
              <div className="flex items-center bg-slate-900/90 border border-slate-800 rounded-xl p-1">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-1.5 rounded-lg transition-colors ${
                    viewMode === 'grid' ? 'bg-amber-500/20 text-amber-400 font-bold' : 'text-slate-500 hover:text-slate-300'
                  }`}
                  title="网格矩阵模式"
                >
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-1.5 rounded-lg transition-colors ${
                    viewMode === 'list' ? 'bg-amber-500/20 text-amber-400 font-bold' : 'text-slate-500 hover:text-slate-300'
                  }`}
                  title="极速长列表模式"
                >
                  <List className="w-4 h-4" />
                </button>
              </div>

              {/* 导入加密备份 */}
              <label
                className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-all shadow"
                title="导入已加密的 .ditingvault 配置文件 (自动解密并同步)"
              >
                <Upload className="w-3.5 h-3.5 text-cyan-400" />
                <span>导入配置</span>
                <input
                  type="file"
                  accept=".ditingvault,.json"
                  className="hidden"
                  onChange={handleImportFile}
                />
              </label>

              {/* 导出加密备份 */}
              <button
                onClick={handleExportVault}
                disabled={isExportingVault}
                className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shadow"
                title="使用工业级证书密钥导出全量加密备份 (.ditingvault)"
              >
                <Download className={`w-3.5 h-3.5 text-emerald-400 ${isExportingVault ? 'animate-bounce' : ''}`} />
                <span>{isExportingVault ? '正在加密导出...' : '导出加密配置'}</span>
              </button>

              <button
                onClick={onNewConnection}
                className="px-3.5 py-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 rounded-xl text-xs font-bold flex items-center gap-1 shadow-lg shadow-amber-500/20 transition-all"
              >
                <Plus className="w-4 h-4 stroke-[3]" />
                <span>新建连接</span>
              </button>
            </div>
          </div>

          {/* Connection Cards Render Container */}
          <div className="flex-1 overflow-auto pt-3 px-2 pb-4">
            {filteredConnections.length > 0 ? (
              viewMode === 'grid' ? (
                /* 网格矩阵模式 GRID MODE (DEV 绿, TEST 黄, PROD 红 区分配色) */
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-1">
                  {filteredConnections.map((conn, idx) => {
                    const isSelected = idx === selectedIndex;
                    const env = conn.env_tag || 'DEV';

                    const cardStyleClass =
                      env === 'PROD'
                        ? 'liquid-glass-card-prod'
                        : env === 'TEST'
                        ? 'liquid-glass-card-test'
                        : 'liquid-glass-card-dev';

                    const breezeAnimClass =
                      env === 'PROD'
                        ? 'animate-breeze-prod'
                        : env === 'TEST'
                        ? 'animate-breeze-test'
                        : 'animate-breeze-dev';

                    return (
                      <div
                        key={conn.id}
                        onClick={(e) => handleEnterDb(conn, e)}
                        className={`group relative p-4 rounded-2xl cursor-pointer flex flex-col justify-between min-h-[145px] ${cardStyleClass} ${
                          isSelected
                            ? `ring-2 ${
                                env === 'PROD'
                                  ? 'ring-red-500 border-red-400'
                                  : env === 'TEST'
                                  ? 'ring-amber-500 border-amber-400'
                                  : 'ring-emerald-500 border-emerald-400'
                              } shadow-2xl scale-[1.02] ${breezeAnimClass}`
                            : `hover:${breezeAnimClass}`
                        }`}
                      >
                        <div className="space-y-2">
                          {/* Card Header: DB Icon + Title (break-all 可折行全显) + Environment Badge */}
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-start gap-2.5 min-w-0 flex-1">
                              <div
                                className={`w-8 h-8 rounded-lg flex items-center justify-center font-black text-[11px] text-white shadow-md shrink-0 mt-0.5 ${
                                  conn.db_type === 'postgres'
                                    ? 'bg-blue-600'
                                    : conn.db_type === 'mysql'
                                    ? 'bg-orange-500'
                                    : 'bg-emerald-600'
                                }`}
                              >
                                {conn.db_type === 'postgres' ? 'Pg' : conn.db_type === 'mysql' ? 'My' : 'Lite'}
                              </div>

                              <span className="font-bold text-xs text-slate-100 group-hover:text-amber-300 transition-colors leading-snug break-all line-clamp-2">
                                {conn.name}
                              </span>
                            </div>

                            {/* DEV 绿 Badge / TEST 黄 Badge / PROD 红 Badge */}
                            <span
                              className={`px-2 py-0.5 rounded text-[9px] font-extrabold border shadow-sm shrink-0 ${
                                env === 'PROD'
                                  ? 'bg-red-950/90 text-red-300 border-red-700/80 shadow-red-900/40 animate-pulse'
                                  : env === 'TEST'
                                  ? 'bg-amber-950/90 text-amber-300 border-amber-700/80 shadow-amber-900/40'
                                  : 'bg-emerald-950/90 text-emerald-300 border-emerald-700/80 shadow-emerald-900/40'
                              }`}
                            >
                              {env}
                            </span>
                          </div>

                          <div className="text-[11px] text-slate-400 font-mono break-all line-clamp-1">
                            {conn.host}:{conn.port}
                          </div>
                          <div className="text-[10px] text-slate-400 font-mono break-all line-clamp-1">
                            db: <strong className="text-slate-300 font-semibold">{conn.database}</strong>
                          </div>
                        </div>


                        {/* Card Footer Actions */}
                        <div className="flex items-center justify-between border-t border-slate-800/60 pt-2 text-[10px] text-slate-500">
                          <span className="truncate">{conn.group_name || '个人本地'}</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDuplicateConnection(conn);
                              }}
                              className="p-1 hover:text-cyan-400 hover:bg-slate-700 rounded transition-colors text-slate-400"
                              title="复制此连接配置"
                            >
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onEditConnection(conn);
                              }}
                              className="p-1 hover:text-amber-400 hover:bg-slate-700 rounded transition-colors text-slate-400"
                              title="编辑"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`确认要删除谛听连接 "${conn.name}" 吗？`)) {
                                  onDeleteConnection(conn.id);
                                }
                              }}
                              className="p-1 hover:text-red-400 hover:bg-slate-700 rounded transition-colors text-slate-400"
                              title="删除"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>

                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* 极速长列表模式 LIST MODE (重构：完全无损显示完整连接名称与信息) */
                <div className="space-y-2.5">
                  {filteredConnections.map((conn, idx) => {
                    const isSelected = idx === selectedIndex;
                    const env = conn.env_tag || 'DEV';
                    return (
                      <div
                        key={conn.id}
                        onClick={(e) => handleEnterDb(conn, e)}
                        className={`group p-3.5 rounded-2xl cursor-pointer transition-all border flex items-center justify-between gap-4 ${
                          isSelected
                            ? 'bg-slate-800/95 border-amber-400 ring-2 ring-amber-500/30 shadow-xl'
                            : 'bg-slate-900/70 hover:bg-slate-800/80 border-slate-800/90 hover:border-amber-500/40 shadow-sm'
                        }`}
                      >
                        {/* 左侧：图标 + 完整连接名 (主副双行排版 + 自动换行/折行保护) */}
                        <div className="flex items-center gap-3.5 min-w-0 flex-1">
                          <div
                            className={`w-9 h-9 rounded-xl flex items-center justify-center font-black text-xs text-white shadow-md shrink-0 ${
                              conn.db_type === 'postgres'
                                ? 'bg-blue-600'
                                : conn.db_type === 'mysql'
                                ? 'bg-orange-500'
                                : 'bg-emerald-600'
                            }`}
                          >
                            {conn.db_type === 'postgres' ? 'Pg' : conn.db_type === 'mysql' ? 'My' : 'Lite'}
                          </div>

                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              {/* 1. 完整无损名称 (支持 break-all 换行全显) */}
                              <span className="font-bold text-xs text-slate-100 group-hover:text-amber-300 transition-colors leading-tight break-all">
                                {conn.name}
                              </span>

                              {/* 2. DEV / TEST / PROD 环境防呆 Badge */}
                              <span
                                className={`px-2 py-0.5 rounded-md text-[9px] font-extrabold border shrink-0 ${
                                  env === 'PROD'
                                    ? 'bg-red-950 text-red-300 border-red-800 animate-pulse'
                                    : env === 'TEST'
                                    ? 'bg-amber-950 text-amber-300 border-amber-800'
                                    : 'bg-emerald-950 text-emerald-300 border-emerald-800'
                                }`}
                              >
                                {env}
                              </span>

                              {conn.ssh_tunnel?.enabled && (
                                <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-purple-950 text-purple-300 border border-purple-800 flex items-center gap-0.5 shrink-0">
                                  <Key className="w-2.5 h-2.5" /> SSH
                                </span>
                              )}
                            </div>

                            {/* 副标题：HOST + DATABASE */}
                            <div className="flex items-center gap-3 text-[11px] font-mono text-slate-400">
                              <span className="text-slate-400">{conn.host}:{conn.port}</span>
                              <span className="text-slate-500">•</span>
                              <span className="text-slate-400">db: <strong className="text-slate-300 font-semibold">{conn.database}</strong></span>
                            </div>
                          </div>
                        </div>

                        {/* 右侧：分组 + 操作按钮 */}
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-[10px] text-slate-400 font-semibold px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800">
                            {conn.group_name || '个人本地'}
                          </span>


                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDuplicateConnection(conn);
                              }}
                              className="p-1 hover:text-cyan-400 hover:bg-slate-700 rounded transition-colors text-slate-400"
                              title="复制此连接配置"
                            >
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onEditConnection(conn);
                              }}
                              className="p-1 hover:text-amber-400 hover:bg-slate-700 rounded transition-colors text-slate-400"
                              title="编辑"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`确认要删除谛听连接 "${conn.name}" 吗？`)) {
                                  onDeleteConnection(conn.id);
                                }
                              }}
                              className="p-1 hover:text-red-400 hover:bg-slate-700 rounded transition-colors text-slate-400"
                              title="删除"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                            <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-amber-400 transition-colors" />
                          </div>

                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            ) : (
              <div className="p-12 text-center text-xs text-slate-500 border border-dashed border-slate-800/80 rounded-2xl bg-slate-900/40">
                未找到匹配“{searchTerm}”的谛听数据源，按 `Esc` 或清空搜索栏重试。
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 6. 底部 Footer 状态条 */}
      <div className="py-2.5 px-6 border-t border-slate-800/60 flex items-center justify-between text-[11px] text-slate-500 relative z-10 bg-[#090b0e]/80 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
          <span>DiTing Engine Active (神兽谛听星云控制台运行中)</span>
        </div>
        <div className="font-mono text-slate-400 flex items-center gap-3">
          <span>支持键盘 <kbd className="px-1 py-0.5 bg-slate-800 rounded border border-slate-700 text-amber-400 text-[10px]">↑</kbd> <kbd className="px-1 py-0.5 bg-slate-800 rounded border border-slate-700 text-amber-400 text-[10px]">↓</kbd> <kbd className="px-1 py-0.5 bg-slate-800 rounded border border-slate-700 text-amber-400 text-[10px]">Enter</kbd> 快捷秒入</span>
          <span>v2.0.0</span>
        </div>
      </div>
    </div>
  );
};
